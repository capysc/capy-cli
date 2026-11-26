/**
 * `capy pair` in agent mode: short runs instead of one process held open.
 *
 * 1. Start run, `capy pair --json`: asks for the grant, saves the pending grant
 *    (`auth/pairing/pendingGrant.ts`), prints ONE refusal with a `link` elicitation and exits 3 at once. No polling.
 *    The link carries a QR of the approval URL (text, and a PNG file with the same bytes as a data URI). The PNG is a
 *    temp file recorded in the pending grant and removed wherever the grant is removed.
 * 2. Wait run, `capy pair --wait`: polls the pending grant until something changes, up to its expiry and for at most
 *    `PAIR_WAIT_CEILING_MS` (CAP-899). Approved: the
 *    service asks for the one-time code (step 4) before it hands anything over; then the same post-approval path
 *    the terminal flow runs (`finishPairing`). Still pending: exit 3 again with the same `link`, its QR cut down to the
 *    PNG's file path (no text, no data URI) so the answer stays small.
 * 3. No email is ever asked. The anti-phishing check is the one-time code below: only the person who approved in Keep
 *    can see it, so a stranger who approves a phished link cannot finish the pairing.
 * 4. Once the human approves in Keep, Keep shows them a one-time code (CAP-877) and the wait run answers
 *    PAIR_CODE_REQUIRED with a `form` asking for it. The human pastes it into the chat, and `capy pair --wait --code
 *    <code>` sends it; a wrong one answers PAIR_CODE_MISMATCH with the form again. The agent never makes the code up:
 *    only the person who approved can see it, which is what stops a phished approval from installing anything.
 * 5. A grant that expires before it is approved is replaced (CAP-885): the wait run starts a fresh pairing with the same
 *    scope and intent and answers PAIR_LINK_RENEWED with the new link, so a slow human never sees pairing die. The agent
 *    shows the new link and code and runs the wait again.
 * 6. `capy pair --cancel` removes the pending grant.
 *
 * stdout is JSON only, and every stop carries a code. Terminal behaviour is untouched: `pairEntry.ts` sends only
 * agent mode here (`json`, no terminal, or one of the new flags).
 */
import { existsSync } from 'fs';
import { authorizeDevice, pairAccessDenied, pairCodeFailed, pollDeviceTokenOnce, type DeviceAuthorizeResult, type DeviceTokenExchange, type DeviceTokenPoll } from '../auth/deviceGrant';
import {
  readPendingPairGrant,
  removePendingPairGrant,
  savePendingPairGrant,
  sweepExpiredPendingPairGrant,
  type PendingPairGrant,
} from '../auth/pairing/pendingGrant';
import { pairApprovalLink, resolvePairScope, type PairScope } from '../auth/pairing/pairScope';
import type { PairingIntent } from '../auth/deviceGrant';
import { pairKeyFingerprint } from '../crypto/pairFingerprint';
import { resolveActiveUrl } from '../config/profileConfig';
import { generatePairKeyPair } from '../crypto/pairCrypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { ElicitationConfirm, ElicitationForm, ElicitationLink, ElicitationLinkQr } from '../ui/elicitation';
import { pairCodeDisplay } from '../ui/elicitationDisplay';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { createPairingQrImage, PAIR_LINK_INSTRUCTIONS, removePairingQrImage, type PairingQrImage } from '../ui/pairingPresentation';
import { buildTerminalQr } from '../ui/terminalQr';
import { binName } from './binName';
import { finishPairing, pairIntent, pairPurpose, type PairOptions } from './pairCommand';
import { refuseError } from './pairingRefusal';
import { refuse, settle, type Refusal } from './refusal';

/**
 * The longest one `capy pair --wait` run waits (CAP-899). A run returns only when something changes: approval, a
 * renewed link once the old one expires, a denial or an error. Every "still waiting" answer is a turn on which an agent
 * may stop (run 9b: two 30-second waits, then the agent ended its turn and nothing renewed), so a run waits out the
 * whole link. Nine minutes keeps it under common agent tool limits (Claude Code allows ten); a link that lives longer
 * gets PAIR_STILL_WAITING at the cap.
 */
export const PAIR_WAIT_CEILING_MS = 9 * 60_000;
/**
 * CAP-913 (Vincent, 2026-11-26: "repeat 4 times max"): a pairing's link is renewed at most this many times, so an
 * unapproved pairing shows 5 links in all. When the last one expires the wait stops and asks whether to start again.
 */
export const PAIR_MAX_RENEWALS = 4;

/** The longest one device-token poll may take; a poll that takes longer is a poll error (the pending grant is kept). */
export const PAIR_POLL_TIMEOUT_MS = 10_000;

export interface PairAgentOptions extends PairOptions {
  /** `--wait`: poll the pending grant. */
  readonly wait?: boolean;
  /** `--cancel`: drop the pending grant. */
  readonly cancel?: boolean;
  /** `--code` (with `--wait`): the one-time code Keep showed the approver, as the human gave it. */
  readonly code?: string;
  /**
   * Internal (capy setup, CAP-902): when the service says the pairing is gone, drop it and refuse with PAIR_EXPIRED
   * instead of renewing, so a caller that may already be signed in decides whether a new pairing is needed.
   */
  readonly noRenew?: boolean;
}

/** Clock and sleep, injectable so tests never really wait. */
export interface PairAgentDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly ceilingMs?: number;
  /** Per-request bound for a device-token poll. Defaults to `PAIR_POLL_TIMEOUT_MS`. */
  readonly pollTimeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CODE_QUESTION = 'What code does Keep show after you approve?'; // COPY-FLAG
const CODE_DESCRIPTION = 'Keep shows a one-time code once you approve. Paste it here. Only you can see it.'; // COPY-FLAG
/**
 * What the code field accepts: the four characters Keep shows (CAP-890), or eight from a service before it, typed
 * loosely (case, spaces and a dash are fine).
 */
const CODE_PATTERN = '^[0-9A-Za-z][0-9A-Za-z -]{2,10}[0-9A-Za-z]$';

/** The form that asks for the one-time code. The rerun is the same wait, with the code. */
function codeForm(bin: string, attemptsLeft: number | null): ElicitationForm {
  return {
    kind: 'form',
    question: CODE_QUESTION,
    details: attemptsLeft === null ? {} : { attempts_left: attemptsLeft },
    display: pairCodeDisplay(attemptsLeft),
    fields: [{ name: 'code', type: 'string', pattern: CODE_PATTERN, question: CODE_QUESTION, description: CODE_DESCRIPTION }],
    answer: { rerun: `${bin} pair --wait --code <code>` },
  };
}

function linkElicitation(grant: PendingPairGrant, bin: string, qr: ElicitationLinkQr | null): ElicitationLink {
  return {
    kind: 'link',
    url: grant.deviceLink,
    code: grant.userCode,
    fingerprint: pairKeyFingerprint(grant.keyPair.publicKey),
    purpose: grant.purpose,
    expires_at: grant.expiresAt,
    ...(qr ? { qr } : {}),
    instructions: PAIR_LINK_INSTRUCTIONS,
    answer: { wait: `${bin} pair --wait` },
  };
}

function linkRefusal(code: string, message: string, grant: PendingPairGrant, bin: string, qr: ElicitationLinkQr | null): Refusal {
  return { code, message, exitCode: EXIT_NEEDS_INPUT, extra: { elicitation: linkElicitation(grant, bin, qr) } };
}

/**
 * The QR is an accelerant, never the only path: the link and code are always in the elicitation. A QR that cannot be
 * made is left out and the pairing goes on. `buildTerminalQr` renders off a TTY and with NO_COLOR set (it has no
 * terminal checks), unlike `renderTerminalQr`, which the terminal flow uses and which stays as it was.
 */
async function tryQrImage(approvalUrl: string): Promise<PairingQrImage | null> {
  try {
    return await createPairingQrImage(approvalUrl);
  } catch {
    return null;
  }
}

function tryQrText(approvalUrl: string): string | null {
  try {
    return buildTerminalQr(approvalUrl).text;
  } catch {
    return null;
  }
}

/** The QR of a start run: text, and the PNG with its data URI. `null` when neither could be made. */
function startQr(approvalUrl: string, image: PairingQrImage | null): ElicitationLinkQr | null {
  const text = tryQrText(approvalUrl);
  if (text === null && image === null) return null;
  return { ...(text !== null ? { text } : {}), ...(image ? { image } : {}) };
}

/** The QR of a still-waiting answer: only the PNG's file path, and only while that file exists. No text, no data URI. */
function waitQr(grant: PendingPairGrant): ElicitationLinkQr | null {
  if (grant.qrFile === undefined || !existsSync(grant.qrFile)) return null;
  return { image: { mime_type: 'image/png', file: grant.qrFile } };
}

/** Saves the grant; when that fails its QR file is removed too, so nothing is left behind. */
function saveOrDiscardQr(grant: PendingPairGrant): void {
  try {
    savePendingPairGrant(grant);
  } catch (error) {
    if (grant.qrFile !== undefined) removePairingQrImage(grant.qrFile);
    throw error;
  }
}

export type PairAgentOutcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly body: Readonly<Record<string, unknown>> };

type Outcome = PairAgentOutcome;

/** What `authorizeDevice` answered is checked before anything is saved: a grant that could never be polled or expire is refused. */
function malformedAuthorize(): CapyError {
  return new CapyError('The pairing response is malformed.', ERROR_CODES.INVALID_FORMAT); // COPY-FLAG
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The ISO expiry of a grant: the service's own `expires_at` when it sent one, otherwise now plus `expires_in`. Throws when neither is usable. */
function expiryOf(authorize: DeviceAuthorizeResult, nowMs: number): string {
  if (authorize.expires_at !== undefined) {
    const at = typeof authorize.expires_at === 'string' ? Date.parse(authorize.expires_at) : Number.NaN;
    if (Number.isNaN(at)) throw malformedAuthorize();
    return new Date(at).toISOString();
  }
  if (!isPositiveNumber(authorize.expires_in)) throw malformedAuthorize();
  const at = new Date(nowMs + authorize.expires_in * 1000);
  // A number too large to be a date is as unusable as a missing one.
  if (Number.isNaN(at.getTime())) throw malformedAuthorize();
  return at.toISOString();
}

/** What a fresh grant is made from: the start run's options, or the expired grant it replaces (CAP-885). */
interface GrantRequest {
  readonly apiUrl: string;
  readonly scope: PairScope;
  readonly intent: PairingIntent;
  readonly force: boolean;
  /** How many renewals came before this grant (CAP-913): 0 for a start run. */
  readonly renewals: number;
}

/**
 * Asks the service for a grant and saves it as the pending one, replacing (and cleaning up after) any previous grant.
 * Answers the grant and the full QR (text, and the PNG with its data URI) for a link the human has not seen yet.
 */
async function issueGrant(request: GrantRequest, deps: PairAgentDeps): Promise<{ readonly grant: PendingPairGrant; readonly qr: ElicitationLinkQr | null }> {
  const now = deps.now ?? Date.now;
  const { apiUrl, scope, intent } = request;
  const keyPair = generatePairKeyPair();
  const authorize = await authorizeDevice(apiUrl, keyPair.publicKey, scope, intent);
  const authorizedAt = now();
  if (typeof authorize.device_code !== 'string' || !authorize.device_code
    || typeof authorize.user_code !== 'string' || !authorize.user_code
    || !isPositiveNumber(authorize.interval)) {
    throw malformedAuthorize();
  }
  const deviceLink = pairApprovalLink(scope, authorize.user_code);
  // Everything that can throw is settled before the PNG exists, so a refusal never leaves one behind.
  const expiresAt = expiryOf(authorize, authorizedAt);
  const previous = readPendingPairGrant();
  const image = await tryQrImage(deviceLink);
  const grant: PendingPairGrant = {
    deviceCode: authorize.device_code,
    keyPair,
    userCode: authorize.user_code,
    deviceLink,
    force: request.force,
    apiUrl,
    purpose: pairPurpose(scope, intent),
    expiresAt,
    intervalSeconds: authorize.interval,
    // Like the terminal flow, the first "approved yet?" check waits one interval after the authorization.
    nextPollAt: authorizedAt + authorize.interval * 1000,
    ...(image ? { qrFile: image.file } : {}),
    mode: scope.mode,
    renew: {
      scope,
      ...(intent.title ? { intentTitle: intent.title } : {}),
      ...(intent.description ? { intentDescription: intent.description } : {}),
    },
    ...(request.renewals > 0 ? { renewals: request.renewals } : {}),
  };
  saveOrDiscardQr(grant);
  // The new grant replaced the old one: the old one's QR file goes with it.
  if (previous?.qrFile !== undefined && previous.qrFile !== grant.qrFile) removePairingQrImage(previous.qrFile);
  return { grant, qr: startQr(deviceLink, image) };
}

async function startRun(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  const devMode = options.devMode === true;
  const { grant, qr } = await issueGrant({
    apiUrl: options.apiUrl || resolveActiveUrl(devMode),
    scope: resolvePairScope(options),
    intent: pairIntent(options),
    force: options.force === true,
    renewals: 0,
  }, deps);
  return {
    kind: 'refusal',
    refusal: linkRefusal(ERROR_CODES.PAIR_APPROVAL_PENDING, 'Waiting for approval.', grant, binName(devMode), qr), // COPY-FLAG
  };
}

/**
 * CAP-885: a slow human never sees pairing die. A grant that expired before it was approved is replaced by a fresh one
 * with the same scope and intent, and the wait answers PAIR_LINK_RENEWED with the new link (and its full QR) for the
 * agent to show. A grant from an earlier build has no `renew` and simply expires.
 */
async function renewExpired(grant: PendingPairGrant, options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  if (!grant.renew) {
    removePendingPairGrant();
    throw new CapyError('Device pairing expired before it was approved', ERROR_CODES.PAIR_EXPIRED); // COPY-FLAG
  }
  const renewals = grant.renewals ?? 0;
  if (renewals >= PAIR_MAX_RENEWALS) return renewalsUsedUp(options);
  const { grant: fresh, qr } = await issueGrant({
    apiUrl: grant.apiUrl,
    scope: grant.renew.scope,
    intent: {
      ...(grant.renew.intentTitle ? { title: grant.renew.intentTitle } : {}),
      ...(grant.renew.intentDescription ? { description: grant.renew.intentDescription } : {}),
    },
    force: grant.force,
    renewals: renewals + 1,
  }, deps);
  return {
    kind: 'refusal',
    refusal: linkRefusal(ERROR_CODES.PAIR_LINK_RENEWED, 'The last link expired before it was approved, so here is a new one. Nothing was installed.', fresh, binName(options.devMode === true), qr), // COPY-FLAG
  };
}

/**
 * CAP-913: the last allowed link expired too. The pairing is dropped, and the agent asks the human whether to start
 * again: `answer.yes` starts a fresh pairing with a new count. Nothing was installed.
 */
function renewalsUsedUp(options: PairAgentOptions): Outcome {
  removePendingPairGrant();
  const bin = binName(options.devMode === true);
  const links = PAIR_MAX_RENEWALS + 1;
  const question = `The pairing link expired ${links} times without being approved. Start again with a new link?`; // COPY-FLAG
  const elicitation: ElicitationConfirm = {
    kind: 'confirm',
    question,
    details: { links_shown: links },
    display: `Nothing was installed. ${links} pairing links expired before anyone approved one.`, // COPY-FLAG
    answer: { yes: `${bin} pair --json` },
  };
  return {
    kind: 'refusal',
    refusal: {
      code: ERROR_CODES.PAIR_EXPIRED,
      message: `The pairing link expired ${links} times without being approved, so the CLI stopped making new ones. Nothing was installed.`, // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation },
    },
  };
}

type WaitStep =
  | { readonly kind: 'approved'; readonly exchange: DeviceTokenExchange }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'confirm'; readonly mismatch: boolean; readonly attemptsLeft: number | null }
  | { readonly kind: 'confirmation_failed' }
  | { readonly kind: 'waiting'; readonly intervalMs: number; readonly nextPollAt: number };

type Clock = Required<Pick<PairAgentDeps, 'sleep' | 'now'>>;

/**
 * One poll, bounded by an `AbortSignal` timeout. A timed-out poll, like any other transport failure, is a coded
 * `NETWORK_ERROR` and the pending grant is kept, so the agent can wait again. Errors the service itself coded pass through.
 */
async function pollOnceBounded(grant: PendingPairGrant, timeoutMs: number, confirmationCode: string | undefined): Promise<DeviceTokenPoll> {
  try {
    return await pollDeviceTokenOnce(grant.apiUrl, grant.deviceCode, { signal: AbortSignal.timeout(timeoutMs), confirmationCode });
  } catch (error) {
    if (error instanceof CapyError) throw error;
    throw new CapyError('The pairing check could not reach the service. The pairing is still pending.', ERROR_CODES.NETWORK_ERROR); // COPY-FLAG
  }
}

/**
 * Polls at the grant's interval (+5s on every `slow_down`, as `pollDeviceToken` does) until approval, expiry, denial
 * or the ceiling, and never sleeps past the ceiling. When the grant's own expiry comes before the next poll and within
 * the ceiling, the run sleeps until that moment and answers `expired`, so the caller renews the link (CAP-899).
 *
 * The first poll waits until the grant's `nextPollAt` (set by the start run, then by each wait run), so back-to-back runs never poll before
 * the interval is up. After a poll, the next one is scheduled at now + interval: if that is before the deadline the run
 * sleeps until then and polls; otherwise it stops, sleeping on to the deadline first unless the interval alone is at
 * least the ceiling (then it returns at once). Either way the earliest next poll time is handed back to be saved.
 * Each request is bounded by `pollTimeoutMs`, shortened so it cannot run past the deadline.
 */
async function pollUntil(
  grant: PendingPairGrant,
  ceilingMs: number,
  pollTimeoutMs: number,
  clock: Clock,
  confirmationCode?: string,
  remember?: (intervalMs: number, nextPollAt: number) => void,
): Promise<WaitStep> {
  const startedAt = clock.now();
  const deadline = startedAt + ceilingMs;
  const expiresAtMs = Date.parse(grant.expiresAt);
  // Past its own expiry the grant is over, whether or not this run would get to poll. A pasted code is the exception
  // (CAP-902): the human approved, so the service may still hold the approval; it is sent once and the service decides.
  if (startedAt >= expiresAtMs && confirmationCode === undefined) return { kind: 'expired' };
  const sleepUntil = async (at: number): Promise<void> => {
    const ms = at - clock.now();
    if (ms > 0) await clock.sleep(ms);
  };
  const schedule = async (intervalMs: number, at: number): Promise<WaitStep> => {
    // CAP-902: a pasted code is always sent once, at once, before any expiry check.
    if (confirmationCode !== undefined && !codeSent) return poll(intervalMs);
    // CAP-899: the link runs out before the next poll and within this run, so wait for that moment and renew it then.
    if (confirmationCode === undefined && at >= expiresAtMs && expiresAtMs <= deadline) {
      await sleepUntil(expiresAtMs);
      return { kind: 'expired' };
    }
    if (at < deadline) {
      // CAP-899: a run can now wait minutes, and the agent's tool may kill it; the next run must still never poll early.
      remember?.(intervalMs, at);
      await sleepUntil(at);
      return poll(intervalMs);
    }
    if (intervalMs < ceilingMs) await sleepUntil(deadline);
    return { kind: 'waiting', intervalMs, nextPollAt: at };
  };
  let codeSent = false;
  const poll = async (intervalMs: number): Promise<WaitStep> => {
    codeSent = true;
    // With a code, only the service's answer ends the grant (CAP-902): it may still hold the approval.
    if (clock.now() >= expiresAtMs && confirmationCode === undefined) return { kind: 'expired' };
    const timeout = Math.min(pollTimeoutMs, Math.max(deadline - clock.now(), 1000));
    const result = await pollOnceBounded(grant, timeout, confirmationCode);
    switch (result.status) {
      case 'confirm':
        return { kind: 'confirm', mismatch: result.mismatch, attemptsLeft: result.attemptsLeft };
      case 'confirmation_failed':
        return { kind: 'confirmation_failed' };
      case 'success':
        return { kind: 'approved', exchange: result };
      case 'expired':
        return { kind: 'expired' };
      case 'denied':
        return { kind: 'denied' };
      case 'forbidden':
        return { kind: 'forbidden' };
      case 'slow_down':
        return schedule(intervalMs + 5000, clock.now() + intervalMs + 5000);
      case 'pending':
        return schedule(intervalMs, clock.now() + intervalMs);
    }
  };
  // A code the human just gave is checked at once: the service already answered for this grant, so this is no early poll.
  return schedule(grant.intervalSeconds * 1000, confirmationCode ? 0 : grant.nextPollAt ?? 0);
}

async function completeApproved(grant: PendingPairGrant, exchange: DeviceTokenExchange, options: PairAgentOptions): Promise<Outcome> {
  // The grant is spent either way: its device code was just exchanged, so nothing is left to wait for.
  removePendingPairGrant();
  const { paired, keys } = await finishPairing(exchange, grant.keyPair, grant.deviceCode, {
    json: true,
    force: grant.force,
    apiUrl: grant.apiUrl,
    devMode: options.devMode === true,
  }, grant);
  return { kind: 'done', body: { ok: true, user_id: exchange.user.id, paired, keys } };
}

async function waitRun(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  const grant = readPendingPairGrant();
  if (!grant) {
    throw new CapyError('No pairing is waiting. Start a new one.', ERROR_CODES.PAIR_NOT_PENDING); // COPY-FLAG
  }
  const now = deps.now ?? Date.now;
  const code = options.code?.trim() || undefined;
  const step = await pollUntil(grant, deps.ceilingMs ?? PAIR_WAIT_CEILING_MS, deps.pollTimeoutMs ?? PAIR_POLL_TIMEOUT_MS, { sleep: deps.sleep ?? defaultSleep, now }, code, (intervalMs, nextPollAt) => savePendingPairGrant({ ...grant, intervalSeconds: intervalMs / 1000, nextPollAt }));
  switch (step.kind) {
    case 'approved':
      return completeApproved(grant, step.exchange, options);
    case 'expired':
      if (options.noRenew === true) {
        removePendingPairGrant();
        throw new CapyError('Device pairing expired before it was approved', ERROR_CODES.PAIR_EXPIRED); // COPY-FLAG
      }
      return renewExpired(grant, options, deps);
    case 'denied':
      removePendingPairGrant();
      throw new CapyError('Device pairing was denied', ERROR_CODES.PAIR_DENIED); // COPY-FLAG
    case 'forbidden':
      removePendingPairGrant();
      throw pairAccessDenied();
    case 'confirmation_failed':
      removePendingPairGrant();
      throw pairCodeFailed();
    case 'confirm':
      // The grant stays: the next run sends the code.
      return {
        kind: 'refusal',
        refusal: {
          code: step.mismatch ? ERROR_CODES.PAIR_CODE_MISMATCH : ERROR_CODES.PAIR_CODE_REQUIRED,
          message: step.mismatch ? 'That code did not match the one Keep shows. Nothing was installed.' : 'Approved in Keep. The code Keep shows is needed before anything is installed.', // COPY-FLAG
          exitCode: EXIT_NEEDS_INPUT,
          extra: { elicitation: codeForm(binName(options.devMode === true), step.attemptsLeft) },
        },
      };
    case 'waiting': {
      const kept: PendingPairGrant = { ...grant, intervalSeconds: step.intervalMs / 1000, nextPollAt: step.nextPollAt };
      savePendingPairGrant(kept);
      return {
        kind: 'refusal',
        refusal: linkRefusal(ERROR_CODES.PAIR_STILL_WAITING, 'Still waiting for approval.', kept, binName(options.devMode === true), waitQr(kept)), // COPY-FLAG
      };
    }
  }
}

function cancelRun(): Outcome {
  removePendingPairGrant();
  return { kind: 'done', body: { ok: true, status: 'cancelled' } };
}

/**
 * An expired pending grant is deleted first, on every agent-mode run but `--wait`: that run finds it itself and
 * replaces it with a fresh pairing (`PAIR_LINK_RENEWED`, CAP-885).
 */
async function run(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  if (!options.wait) sweepExpiredPendingPairGrant((deps.now ?? Date.now)());
  if (options.cancel) return cancelRun();
  if (options.wait) return waitRun(options, deps);
  return startRun(options, deps);
}

/**
 * Agent-mode `capy pair` as a step of another command (`capy setup`): the same run, with what it would print or refuse
 * handed back instead. Nothing is printed and the process never exits here.
 */
export async function pairAgentOutcome(options: PairAgentOptions = {}, deps: PairAgentDeps = {}): Promise<PairAgentOutcome> {
  const settled = await settle(() => run(options, deps));
  if (settled.ok) return settled.value;
  const err = settled.error;
  return {
    kind: 'refusal',
    refusal: err instanceof CapyError
      ? { code: err.code, message: err.message, exitCode: 1 }
      : { code: ERROR_CODES.SERVICE_ERROR, message: err instanceof Error ? err.message : String(err), exitCode: 1 },
  };
}

/**
 * Agent-mode `capy pair`. The outcome is computed first and printed after, so a refusal's `process.exit` is never
 * caught by the code that raised it. stdout is only ever the one JSON object.
 */
export async function pairAgentCommand(options: PairAgentOptions = {}, deps: PairAgentDeps = {}): Promise<void> {
  const settled = await settle(() => run(options, deps));
  if (!settled.ok) return refuseError(settled.error, true);
  const outcome = settled.value;
  if (outcome.kind === 'refusal') return refuse(true, outcome.refusal);
  console.log(JSON.stringify(outcome.body, null, 2));
}
