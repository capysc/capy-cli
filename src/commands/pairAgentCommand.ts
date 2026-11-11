/**
 * `capy pair` in agent mode (docs/basic-pair.md): short runs instead of one process held open.
 *
 * 1. Start run, `capy pair --email <email>`: asks for the grant, saves the pending grant
 *    (`auth/pairing/pendingGrant.ts`), prints ONE refusal with a `link` elicitation and exits 3 at once. No polling.
 * 2. Wait run, `capy pair --wait`: polls the pending grant for at most `PAIR_WAIT_CEILING_MS`. Approved: the
 *    approving account is compared with the expected one (the anti-phishing check: a stranger who approves the
 *    link with their own account is refused by code, and nothing is installed); then the same post-approval path
 *    the terminal flow runs (`finishPairing`). Still pending: exit 3 again with the same `link`.
 * 3. No expected account known (no `--email`): exit 3 with a `form` asking for the email,
 *    before any request is made. The agent never fills that in itself.
 * 4. `capy pair --cancel` removes the pending grant.
 *
 * stdout is JSON only, and every stop carries a code. Terminal behaviour is untouched: `pairEntry.ts` sends only
 * agent mode here (`json`, no terminal, or one of the new flags).
 */
import { authorizeDevice, pollDeviceTokenOnce, type DeviceTokenExchange } from '../auth/deviceGrant';
import {
  readPendingPairGrant,
  removePendingPairGrant,
  savePendingPairGrant,
  type PendingPairGrant,
} from '../auth/pairing/pendingGrant';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { resolveActiveUrl } from '../config/profileConfig';
import { generatePairKeyPair } from '../crypto/pairCrypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { ElicitationForm, ElicitationLink } from '../ui/elicitation';
import { pairEmailDisplay } from '../ui/elicitationDisplay';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { PAIR_DEFAULT_PURPOSE, finishPairing, type PairOptions } from './pairCommand';
import { refuseError } from './pairingRefusal';
import { refuse, settle, type Refusal } from './refusal';

/** How long one `capy pair --wait` run polls before it says "still waiting". */
export const PAIR_WAIT_CEILING_MS = 30_000;

export interface PairAgentOptions extends PairOptions {
  /** `--email`: the account expected to approve. */
  readonly email?: string;
  /** `--wait`: poll the pending grant. */
  readonly wait?: boolean;
  /** `--cancel`: drop the pending grant. */
  readonly cancel?: boolean;
}

/** Clock and sleep, injectable so tests never really wait. */
export interface PairAgentDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly ceilingMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The email comparison key: trimmed and lower-cased, compared for exact equality. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The binary this process was invoked as (`capy`, `capy-dev`, `capy-staging`). */
function binName(devMode: boolean): string {
  return process.env.CAPY_BIN_NAME ?? (devMode ? 'capy-dev' : 'capy');
}

/** Who must approve: the `--email` value, normalized. Null when none was given. */
function expectedOf(options: PairAgentOptions): string | null {
  const email = options.email === undefined ? '' : normalizeEmail(options.email);
  return email || null;
}

/** Whether the approving account is the expected one: the email, compared after trim and lower-casing. */
export function accountMatches(grant: Pick<PendingPairGrant, 'expectedEmail'>, user: { readonly email: string }): boolean {
  return normalizeEmail(user.email) === grant.expectedEmail;
}

const EMAIL_QUESTION = 'Which email will approve this pairing?'; // COPY-FLAG

function emailForm(bin: string): ElicitationForm {
  return {
    kind: 'form',
    question: EMAIL_QUESTION,
    details: {},
    display: pairEmailDisplay(),
    fields: [{ name: 'email', type: 'string', pattern: '^[^\\s@]+@[^\\s@]+$', question: EMAIL_QUESTION }],
    answer: { rerun: `${bin} pair --email <email>` },
  };
}

function linkElicitation(grant: PendingPairGrant, bin: string): ElicitationLink {
  return {
    kind: 'link',
    url: grant.deviceLink,
    code: grant.userCode,
    purpose: grant.purpose,
    expires_at: grant.expiresAt,
    answer: { wait: `${bin} pair --wait` },
  };
}

function linkRefusal(code: string, message: string, grant: PendingPairGrant, bin: string): Refusal {
  return { code, message, exitCode: EXIT_NEEDS_INPUT, extra: { elicitation: linkElicitation(grant, bin) } };
}

type Outcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly body: Readonly<Record<string, unknown>> };

async function startRun(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  const devMode = options.devMode === true;
  const bin = binName(devMode);
  const expected = expectedOf(options);
  if (!expected) {
    return {
      kind: 'refusal',
      refusal: {
        code: ERROR_CODES.PAIR_EMAIL_REQUIRED,
        message: 'An email is needed to pair.', // COPY-FLAG
        exitCode: EXIT_NEEDS_INPUT,
        extra: { elicitation: emailForm(bin) },
      },
    };
  }
  const now = deps.now ?? Date.now;
  const apiUrl = options.apiUrl || resolveActiveUrl(devMode);
  const keyPair = generatePairKeyPair();
  const authorize = await authorizeDevice(apiUrl, keyPair.publicKey);
  const grant: PendingPairGrant = {
    deviceCode: authorize.device_code,
    keyPair,
    userCode: authorize.user_code,
    deviceLink: `${resolveKeepOrigin()}/device?code=${encodeURIComponent(authorize.user_code)}`,
    expectedEmail: expected,
    force: options.force === true,
    apiUrl,
    purpose: PAIR_DEFAULT_PURPOSE,
    expiresAt: authorize.expires_at ?? new Date(now() + authorize.expires_in * 1000).toISOString(),
    intervalSeconds: authorize.interval,
  };
  savePendingPairGrant(grant);
  return {
    kind: 'refusal',
    refusal: linkRefusal(ERROR_CODES.PAIR_APPROVAL_PENDING, 'Waiting for approval.', grant, bin), // COPY-FLAG
  };
}

type WaitStep =
  | { readonly kind: 'approved'; readonly exchange: DeviceTokenExchange }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'waiting'; readonly intervalMs: number };

/**
 * Polls at the grant's interval (+5s on every `slow_down`, as `pollDeviceToken` does) until approval, expiry,
 * denial or the deadline. Recursive, like `pollDeviceToken`: each tick is a fresh call with the interval to use.
 * The first poll is immediate; after the last poll that fits, it waits one interval more before it gives up, so
 * the next `--wait` run never polls sooner than the interval after this one's last poll.
 */
async function pollUntil(grant: PendingPairGrant, deadline: number, deps: Required<Pick<PairAgentDeps, 'sleep' | 'now'>>): Promise<WaitStep> {
  const expiresAtMs = Date.parse(grant.expiresAt);
  const tick = async (intervalMs: number): Promise<WaitStep> => {
    if (deps.now() >= expiresAtMs) return { kind: 'expired' };
    const result = await pollDeviceTokenOnce(grant.apiUrl, grant.deviceCode);
    switch (result.status) {
      case 'success':
        return { kind: 'approved', exchange: result };
      case 'expired':
        return { kind: 'expired' };
      case 'denied':
        return { kind: 'denied' };
      case 'slow_down':
        return next(intervalMs + 5000);
      case 'pending':
        return next(intervalMs);
    }
  };
  const next = async (intervalMs: number): Promise<WaitStep> => {
    const fits = deps.now() + intervalMs < deadline;
    await deps.sleep(intervalMs);
    return fits ? tick(intervalMs) : { kind: 'waiting', intervalMs };
  };
  return tick(grant.intervalSeconds * 1000);
}

async function completeApproved(grant: PendingPairGrant, exchange: DeviceTokenExchange, options: PairAgentOptions): Promise<Outcome> {
  // The grant is spent either way: its device code was just exchanged, so nothing is left to wait for.
  removePendingPairGrant();
  if (!accountMatches(grant, exchange.user)) {
    throw new CapyError(
      'The approving account is not the expected one. No session or keys were installed.', // COPY-FLAG
      ERROR_CODES.PAIR_ACCOUNT_MISMATCH,
    );
  }
  const { paired } = await finishPairing(exchange, grant.keyPair, grant.deviceCode, {
    json: true,
    force: grant.force,
    apiUrl: grant.apiUrl,
    devMode: options.devMode === true,
  });
  return { kind: 'done', body: { ok: true, user_id: exchange.user.id, paired } };
}

async function waitRun(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  const grant = readPendingPairGrant();
  if (!grant) {
    throw new CapyError('No pairing is waiting. Start a new one.', ERROR_CODES.PAIR_NOT_PENDING); // COPY-FLAG
  }
  const now = deps.now ?? Date.now;
  const step = await pollUntil(grant, now() + (deps.ceilingMs ?? PAIR_WAIT_CEILING_MS), { sleep: deps.sleep ?? defaultSleep, now });
  switch (step.kind) {
    case 'approved':
      return completeApproved(grant, step.exchange, options);
    case 'expired':
      removePendingPairGrant();
      throw new CapyError('Device pairing expired before it was approved', ERROR_CODES.PAIR_EXPIRED);
    case 'denied':
      removePendingPairGrant();
      throw new CapyError('Device pairing was denied', ERROR_CODES.PAIR_DENIED);
    case 'waiting': {
      const kept: PendingPairGrant = { ...grant, intervalSeconds: step.intervalMs / 1000 };
      if (kept.intervalSeconds !== grant.intervalSeconds) savePendingPairGrant(kept);
      return {
        kind: 'refusal',
        refusal: linkRefusal(ERROR_CODES.PAIR_STILL_WAITING, 'Still waiting for approval.', kept, binName(options.devMode === true)), // COPY-FLAG
      };
    }
  }
}

function cancelRun(): Outcome {
  removePendingPairGrant();
  return { kind: 'done', body: { ok: true, code: ERROR_CODES.PAIR_CANCELLED } };
}

async function run(options: PairAgentOptions, deps: PairAgentDeps): Promise<Outcome> {
  if (options.cancel) return cancelRun();
  if (options.wait) return waitRun(options, deps);
  return startRun(options, deps);
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
