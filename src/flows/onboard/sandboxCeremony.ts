/**
 * The in-process broker ceremony for `capy onboard --broker-ceremony`
 * (CAP-451 §8/§9 CP2).
 *
 * A sandboxed MCP-driven run has no browser and no session of its own. Under
 * `--broker-ceremony` the driver (`./driver.ts`) intercepts the ONE screen
 * this build knows how to run itself — `sandbox_session`, the flow-owned
 * ceremony connection the service mints for the instance (S1-resume-ceremony:
 * re-asking returns the same `connection_id`/`user_code`, never a new one) —
 * instead of stopping and handing the URL back to a caller that cannot open
 * it. This module is that ceremony: mint the request fragment, relay the URL
 * through the existing handoff seam, long-poll the connection's sealed
 * answer with the FLOW's own secret as the poll secret (the service's
 * `mintCeremony` sets the connection's `poll_secret` to the flow secret —
 * "the one party that holds it... can poll `/connections/:id/result` with
 * the credential it already has"), and act on what comes back.
 *
 * REQUIRED, and why it matters: this is the flow instance's OWN connection,
 * never a private side connection this process mints itself. A hosted MCP
 * relaying the same flow later (`GET /flows/:id/next`) sees the identical
 * `sandbox_session` step and can mirror the identical link — a private
 * connection would leave it nothing to mirror.
 *
 * The sealed answer's plaintext is the existing `sandbox-session` completion
 * shape (`{v:1, flow:'sandbox-session', ok:true, user, refresh_token,
 * organizations, sessions?}`) plus an OPTIONAL `first_run`, parsed strictly:
 * an unknown `kind`, a missing required field, or half of a strict pair
 * (`credential_id`/`prf_output`) is a refusal, and nothing in the envelope is
 * acted on. `{ok:false, code:'declined'}` and expiry/timeout map onto the
 * SAME step-outcome codes the flow contract already knows how to turn into
 * `blocked{ceremony_declined}` / `blocked{ceremony_expired}`
 * (`../contract/steps.json`'s `blocked_reasons`) — this file mints no new
 * contract vocabulary, only the codes that vocabulary already names.
 */
import { existsSync, readdirSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { getGlobalCapyDir } from '../../config/globalConfig';
import { ERROR_CODES, SessionStore } from '../../types/index';
import { ConnectionKeypair, openEnvelope } from '../../service/brokerEnvelope';
import { SessionStorageBackend } from '../../auth/session/backend';
import { FileSessionStorageBackend } from '../../auth/session/fileBackend';
import { generatePrfSalt } from '../../auth/deviceKey/crypto';
import { emitHandoffUrlEvent } from '../../ui/handoffEvent';
import { isOnboardJsonMode } from '../../ui/webMode';
import { codeFor, codeForSilentAuthFailure, StepResult } from './executors';
import { FlowStep } from '../validate';

/**
 * step_outcome codes for this ceremony. Mirrors the MCP's own AUTH_CODES for
 * the identical concepts (`packages/mcp/src/auth/codes.ts`) — the flow
 * contract's `blocked_reasons.ceremony_declined`/`ceremony_expired`/
 * `service_error`/`network_error` (`../contract/steps.json`) already list
 * these exact strings in their `from_codes`, so reusing them (rather than
 * minting a parallel vocabulary) is what makes the existing mapping apply
 * with zero contract or service changes.
 */
export const CEREMONY_CODES = {
  DECLINED: 'BOOTSTRAP_DECLINED',
  EXPIRED: 'BOOTSTRAP_EXPIRED',
  TIMEOUT: 'BOOTSTRAP_TIMEOUT',
  CONSUMED: 'BOOTSTRAP_CONSUMED',
  SERVICE_ERROR: 'BOOTSTRAP_SERVICE_ERROR',
  BAD_ENVELOPE: 'BOOTSTRAP_BAD_ENVELOPE',
  NETWORK_ERROR: 'BOOTSTRAP_NETWORK_ERROR',
  /**
   * `ceremonyWorker.ts`'s own failure mode, not `runSandboxCeremony`'s: the
   * detached worker never actually started (ENOENT, EACCES, ... from
   * `spawn`) — there is no ceremony to time out, decline, or poll at all.
   * Reported the same way as any other coded ceremony failure so the driver
   * (and the flow service) fold it into this step's outcome exactly like a
   * genuinely-run-but-failed ceremony, rather than crashing the process that
   * was about to print the `--json` envelope.
   */
  SPAWN_FAILED: 'BOOTSTRAP_SPAWN_FAILED',
} as const;

/** 15-minute ceiling — long enough for a human to notice a notification on another device. */
export const CEREMONY_DEADLINE_MS = 15 * 60_000;
const WAIT_SECONDS = 25; // openapi max for wait_seconds
const POLL_GAP_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. The request fragment
// ---------------------------------------------------------------------------

/** No local.key/key.enc for ANY org, ANY user, on this machine — computed before any identity is known. */
export function hasAnyLocalKeyMaterial(): boolean {
  const orgsDir = join(getGlobalCapyDir(), 'orgs');
  let orgIds: string[];
  try {
    orgIds = readdirSync(orgsDir);
  } catch {
    return false;
  }
  for (const orgId of orgIds) {
    const usersDir = join(orgsDir, orgId, 'users');
    let userIds: string[];
    try {
      userIds = readdirSync(usersDir);
    } catch {
      continue;
    }
    for (const userId of userIds) {
      if (existsSync(join(usersDir, userId, 'local.key'))) return true;
      if (existsSync(join(usersDir, userId, 'key.enc'))) return true;
    }
  }
  return false;
}

/**
 * base64url(JSON), unpadded — byte-identical encoding to
 * `brokerCeremonyTransport.ts`'s `encodeCeremonyFragment` (Node's
 * `base64url` Buffer encoding already omits padding).
 */
function encodeFragment(payload: unknown): string {
  return `#r=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/**
 * The `sandbox_session` screen's URL with this ceremony's request fragment
 * appended.
 *
 * `presetPrfSalt`, when given, is embedded instead of minting a fresh one —
 * so the caller (`runSandboxCeremony`) can hold on to the EXACT salt the
 * browser's `create_org` device-key ceremony will run its WebAuthn PRF
 * extension against, and later hand that same salt to the CANNED
 * enrollment path instead of letting it mint an unrelated second one (see
 * `enrollDoor`'s doc in `../../auth/deviceKey/onboarding.ts` for the bug
 * this closes). Optional and defaults to a fresh mint so every existing
 * caller — this function's own unit test included — is unaffected.
 */
export function buildCeremonyUrl(step: FlowStep, machineName?: string, presetPrfSalt?: Buffer): string {
  const fragment = encodeFragment({
    v: 1,
    flow: 'sandbox-session',
    first_run: {
      prf_salt: (presetPrfSalt ?? generatePrfSalt()).toString('base64'),
      no_local_key_material: !hasAnyLocalKeyMaterial(),
      machine_name: machineName ?? hostname(),
    },
  });
  return `${step.url}${fragment}`;
}

// ---------------------------------------------------------------------------
// 2. The long-poll
// ---------------------------------------------------------------------------

export type PollResult =
  | { kind: 'answered'; plaintext: string }
  | { kind: 'expired' }
  | { kind: 'consumed' }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'service'; status: number; code?: string }
  | { kind: 'bad_envelope' };

/**
 * Long-poll `GET /connections/:id/result` with the FLOW's own secret as the
 * connection's poll secret — never a second connection, never a second
 * secret (service `flows/store.ts` `mintCeremony`: "its poll_secret IS the
 * flow secret"). Mirrors the MCP's `SandboxBootstrapClient.awaitAnswer`
 * (`packages/mcp/src/auth/broker/client.ts`), against the flow-owned
 * connection rather than one this process created.
 */
export async function pollSandboxConnection(opts: {
  serviceUrl: string;
  connectionId: string;
  flowSecret: string;
  keypair: ConnectionKeypair;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PollResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.deadlineMs ?? CEREMONY_DEADLINE_MS);
  const headers = { 'X-Connection-Secret': opts.flowSecret };

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetchImpl(
        `${opts.serviceUrl}/connections/${opts.connectionId}/result?wait_seconds=${WAIT_SECONDS}`,
        { method: 'GET', headers },
      );
    } catch {
      return { kind: 'network' };
    }

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.status === 'answered' && typeof body.ciphertext === 'string') {
        const opened = openEnvelope({
          ciphertextB64: body.ciphertext,
          connectionId: opts.connectionId,
          keypair: opts.keypair,
        });
        if (!opened.ok) return { kind: 'bad_envelope' };
        return { kind: 'answered', plaintext: opened.plaintext };
      }
      if (Date.now() < deadline) await sleep(POLL_GAP_MS);
      continue;
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 410) return { kind: 'expired' };
    if (res.status === 409) return { kind: 'consumed' };
    return { kind: 'service', status: res.status, code: body.code as string | undefined };
  }

  return { kind: 'timeout' };
}

function codeForPollFailure(poll: Exclude<PollResult, { kind: 'answered' }>): string {
  switch (poll.kind) {
    case 'expired':
      return CEREMONY_CODES.EXPIRED;
    case 'consumed':
      return CEREMONY_CODES.CONSUMED;
    case 'timeout':
      return CEREMONY_CODES.TIMEOUT;
    case 'network':
      return CEREMONY_CODES.NETWORK_ERROR;
    case 'bad_envelope':
      return CEREMONY_CODES.BAD_ENVELOPE;
    case 'service':
      return CEREMONY_CODES.SERVICE_ERROR;
  }
}

// ---------------------------------------------------------------------------
// 3. Strict envelope parsing
// ---------------------------------------------------------------------------

export type SandboxSessionFirstRun =
  | {
      kind: 'create_org';
      name: string;
      phrase: string;
      credentialId?: string;
      prfOutput?: string;
      backupEligible?: boolean;
      backupState?: boolean;
    }
  | { kind: 'select_org'; orgId: string }
  | { kind: 'unlock'; credentialId: string; prfOutput: string }
  | { kind: 'none' };

export interface SandboxSessionAnswer {
  refreshToken: string;
  user: { id: string; email?: string; first_name?: string | null; last_name?: string | null };
  organizations: Array<{ id: string; workos_org_id: string; name: string }>;
  sessions?: Record<string, { access_token: string; expires_at: number }>;
  firstRun: SandboxSessionFirstRun;
}

export type ParsedAnswer = { ok: true; answer: SandboxSessionAnswer } | { ok: false; code: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `undefined` first_run means "no case applies" — a legitimate answer, treated as `{kind:'none'}`. */
function parseFirstRun(raw: unknown): SandboxSessionFirstRun | null {
  if (raw === undefined) return { kind: 'none' };
  if (!isRecord(raw)) return null;

  if (raw.kind === 'create_org') {
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) return null;
    if (typeof raw.phrase !== 'string' || raw.phrase.trim().length === 0) return null;
    const hasCredentialId = typeof raw.credential_id === 'string';
    const hasPrfOutput = typeof raw.prf_output === 'string';
    // Strict pair: both or neither, never half.
    if (hasCredentialId !== hasPrfOutput) return null;
    if (raw.backup_eligible !== undefined && typeof raw.backup_eligible !== 'boolean') return null;
    if (raw.backup_state !== undefined && typeof raw.backup_state !== 'boolean') return null;
    return {
      kind: 'create_org',
      name: raw.name,
      phrase: raw.phrase,
      ...(hasCredentialId && hasPrfOutput
        ? {
            credentialId: raw.credential_id as string,
            prfOutput: raw.prf_output as string,
            backupEligible: (raw.backup_eligible as boolean | undefined) ?? false,
            backupState: (raw.backup_state as boolean | undefined) ?? false,
          }
        : {}),
    };
  }

  if (raw.kind === 'select_org') {
    if (typeof raw.org_id !== 'string' || raw.org_id.length === 0) return null;
    return { kind: 'select_org', orgId: raw.org_id };
  }

  if (raw.kind === 'unlock') {
    if (typeof raw.credential_id !== 'string' || raw.credential_id.length === 0) return null;
    if (typeof raw.prf_output !== 'string' || raw.prf_output.length === 0) return null;
    return { kind: 'unlock', credentialId: raw.credential_id, prfOutput: raw.prf_output };
  }

  if (raw.kind === 'none') return { kind: 'none' };

  // Unknown kind — refused, not ignored.
  return null;
}

/**
 * Parse the sealed answer's plaintext STRICTLY: unknown fields elsewhere are
 * tolerated (this is a completion payload, not a contract step), but every
 * required field must be present and correctly typed, and `first_run`, when
 * present, must be exactly one of the closed kinds. Anything that doesn't
 * parse this way is `{ok:false, code:FLOW_ENVELOPE_INVALID}` — nothing in a
 * malformed envelope is ever partially acted on.
 */
export function parseSandboxSessionAnswer(plaintext: string): ParsedAnswer {
  const INVALID: string = ERROR_CODES.FLOW_ENVELOPE_INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { ok: false, code: INVALID };
  }
  if (!isRecord(parsed)) return { ok: false, code: INVALID };
  if (parsed.v !== 1 || parsed.flow !== 'sandbox-session') return { ok: false, code: INVALID };

  if (parsed.ok === false) {
    // The only declared failure shape: {ok:false, code:'declined'}.
    return parsed.code === 'declined' ? { ok: false, code: CEREMONY_CODES.DECLINED } : { ok: false, code: INVALID };
  }
  if (parsed.ok !== true) return { ok: false, code: INVALID };

  const user = parsed.user;
  if (!isRecord(user) || typeof user.id !== 'string' || user.id.length === 0) return { ok: false, code: INVALID };
  if (user.email !== undefined && typeof user.email !== 'string') return { ok: false, code: INVALID };
  if (user.first_name !== undefined && user.first_name !== null && typeof user.first_name !== 'string') {
    return { ok: false, code: INVALID };
  }
  if (user.last_name !== undefined && user.last_name !== null && typeof user.last_name !== 'string') {
    return { ok: false, code: INVALID };
  }

  if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length === 0) {
    return { ok: false, code: INVALID };
  }

  const orgsRaw = parsed.organizations;
  if (orgsRaw !== undefined && !Array.isArray(orgsRaw)) return { ok: false, code: INVALID };
  const organizations: SandboxSessionAnswer['organizations'] = [];
  for (const o of (orgsRaw as unknown[] | undefined) ?? []) {
    if (
      !isRecord(o) ||
      typeof o.id !== 'string' ||
      typeof o.workos_org_id !== 'string' ||
      typeof o.name !== 'string'
    ) {
      return { ok: false, code: INVALID };
    }
    organizations.push({ id: o.id, workos_org_id: o.workos_org_id, name: o.name });
  }

  let sessions: SandboxSessionAnswer['sessions'];
  if (parsed.sessions !== undefined) {
    if (!isRecord(parsed.sessions)) return { ok: false, code: INVALID };
    sessions = {};
    for (const [orgId, s] of Object.entries(parsed.sessions)) {
      if (!isRecord(s) || typeof s.access_token !== 'string' || typeof s.expires_at !== 'number') {
        return { ok: false, code: INVALID };
      }
      sessions[orgId] = { access_token: s.access_token, expires_at: s.expires_at };
    }
  }

  const firstRun = parseFirstRun(parsed.first_run);
  if (firstRun === null) return { ok: false, code: INVALID };

  return {
    ok: true,
    answer: {
      refreshToken: parsed.refresh_token,
      user: {
        id: user.id,
        email: typeof user.email === 'string' ? user.email : undefined,
        first_name: user.first_name as string | null | undefined,
        last_name: user.last_name as string | null | undefined,
      },
      organizations,
      sessions,
      firstRun,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Acting on first_run
// ---------------------------------------------------------------------------

interface FirstRunOutcome {
  ok: boolean;
  code?: string;
  orgId?: string;
  token?: string;
}

/**
 * Dispatch on `answer.firstRun.kind`, then settle a usable bearer through the
 * SAME `AuthService` the rest of the CLI uses — `authenticateSilent` reuses
 * `refreshForOrg` for `select_org`/`unlock`/`none`, and the org-less branch
 * (§7.1.1) for the (should-not-happen) case of zero orgs after `none`.
 */
async function applyFirstRun(opts: {
  answer: SandboxSessionAnswer;
  backend: SessionStorageBackend;
  serviceUrl: string;
  devMode: boolean;
  /**
   * The EXACT salt embedded in this ceremony's own request fragment
   * (`buildCeremonyUrl`) — the one the browser's `create_org` device-key
   * stop actually ran its WebAuthn PRF extension against. Required for the
   * `create_org` branch's canned enrollment to derive a wrap KEK that a
   * later unlock can ever reproduce; see `enrollDoor`'s doc.
   */
  prfSalt: Buffer;
}): Promise<FirstRunOutcome> {
  const { AuthService } = await import('../../auth/authService');
  const { ServiceClient } = await import('../../service/serviceClient');
  const authService = new AuthService(opts.serviceUrl, opts.devMode, opts.answer.user.id, opts.backend);
  const serviceClient = new ServiceClient(opts.serviceUrl, opts.devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const fr = opts.answer.firstRun;
  let orgId: string | undefined;

  if (fr.kind === 'create_org') {
    try {
      const { createOrganizationFromEnvelope } = await import('../../commands/orgCreation');
      const org = await createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: opts.answer.refreshToken,
        userId: opts.answer.user.id,
        userEmail: opts.answer.user.email,
        name: fr.name,
        phrase: fr.phrase,
        prf:
          fr.credentialId && fr.prfOutput
            ? {
                credentialId: fr.credentialId,
                prfOutput: fr.prfOutput,
                backupEligible: fr.backupEligible ?? false,
                backupState: fr.backupState ?? false,
                prfSalt: opts.prfSalt,
              }
            : undefined,
      });
      orgId = org.id;
    } catch (err) {
      return { ok: false, code: codeFor(err) };
    }
  } else if (fr.kind === 'select_org') {
    // The picked org MUST be one the envelope itself named — a foreign
    // org_id (typo, stale answer, tampering) is refused rather than
    // silently pinning something the rest of the answer never vouched for.
    const target = opts.answer.organizations.find((o) => o.id === fr.orgId);
    if (!target) {
      return { ok: false, code: ERROR_CODES.FLOW_ENVELOPE_INVALID };
    }
    orgId = target.id;
  } else if (fr.kind === 'unlock') {
    // `unlock` only makes sense for the "1 org, key not on device" row of
    // the gate table — an envelope claiming it with zero or several orgs is
    // internally inconsistent (which one would the ceremony have run
    // against?) and is refused rather than guessing organizations[0].
    if (opts.answer.organizations.length !== 1) {
      return { ok: false, code: ERROR_CODES.FLOW_ENVELOPE_INVALID };
    }
    orgId = opts.answer.organizations[0].id;
    try {
      // Pin the org BEFORE any service call this branch makes. `authService`
      // is a BRAND NEW instance (constructed a few lines up) whose
      // `currentOrgId` starts null — `serviceClient`'s token provider
      // (`authService.getValidToken()`) returns null until something sets
      // it, so `deps.ops.listWrappers()` below (the top-level, non-org-scoped
      // op `runUnlock` calls FIRST, before `opsForOrg`'s own per-call
      // `authenticateSilent`) would otherwise go out with no Authorization
      // header at all — a 401 `runUnlock` cannot distinguish from a genuine
      // ceremony failure, silently swallowed by the catch below and
      // misreported downstream as "key not on device". The refresh_token
      // this envelope carries is already on `authService`'s session (written
      // to the backend just above, in the caller) — this just spends it.
      const pinned = await authService.authenticateSilent(orgId);
      if (!pinned.success) {
        throw new Error(`could not pin org before unlock: ${pinned.error_code ?? pinned.error ?? 'unknown'}`);
      }
      const { createDeviceKeyServiceOps } = await import('../../auth/deviceKey/serviceOps');
      const { runUnlock } = await import('../../auth/deviceKey/onboarding');
      const { cannedUnlockTransport } = await import('../../auth/deviceKey/cannedCeremony');
      const { ops, opsForOrg } = createDeviceKeyServiceOps(serviceClient, authService);
      await runUnlock({
        userId: opts.answer.user.id,
        userEmail: opts.answer.user.email,
        organizations: opts.answer.organizations,
        activeOrgId: orgId,
        ceremony: cannedUnlockTransport({ credentialId: fr.credentialId, prfOutput: fr.prfOutput }),
        ops,
        opsForOrg,
      });
    } catch {
      // Best-effort: a failed unlock (ceremony refusal, org-pin failure, a
      // genuine service error) leaves the org exactly as unreachable as it
      // was — the next step's own key check (`unlock_org_key`) reports
      // KEY_NOT_ON_DEVICE, same as any other Case C failure.
    }
  } else {
    // 'none' — key already on this device. Same internal-consistency
    // requirement as `unlock`: exactly one org, or there is nothing this
    // kind can legitimately mean.
    if (opts.answer.organizations.length !== 1) {
      return { ok: false, code: ERROR_CODES.FLOW_ENVELOPE_INVALID };
    }
    orgId = opts.answer.organizations[0].id;
  }

  // Settle a REAL, org-scoped bearer for the org this branch just resolved —
  // never report success with an org-less or absent token standing in for
  // it. A failure here (e.g. a moment of WorkOS role-propagation lag right
  // after `create_org`) is surfaced as a coded failure rather than silently
  // handed back as `ok:true` with `token:undefined`: the caller (driver.ts)
  // would otherwise carry on with no bearer update at all, so `write_keep_lock`
  // — reached next — would run its encrypt-and-push under whatever STALE
  // bearer it can scrounge up (org-less, or none), and 403 on the push AFTER
  // already having encrypted .env. No sleep/retry here — see this function's
  // module doc; a caller that wants one drives it by re-asking the flow.
  const settled = await authService.authenticateSilent(orgId);
  if (!settled.success) {
    return { ok: false, code: codeForSilentAuthFailure(settled.error_code) };
  }
  const token = (await authService.getValidToken())?.access_token ?? settled._orgless_access_token;
  if (!token) {
    return { ok: false, code: ERROR_CODES.SERVICE_ERROR };
  }

  return { ok: true, orgId, token };
}

// ---------------------------------------------------------------------------
// 5. Orchestration
// ---------------------------------------------------------------------------

export interface SandboxCeremonyOptions {
  /** The validated `screen: sandbox_session` step. */
  step: FlowStep;
  /** This process's own ephemeral keypair — its pubkey was the flow's `client_pubkey` at creation. */
  keypair: ConnectionKeypair;
  /** The flow's own secret — doubles as this connection's poll secret. */
  flowSecret: string;
  serviceUrl: string;
  devMode: boolean;
  machineName?: string;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; production default is the real `~/.capy` file backend. */
  sessionBackend?: SessionStorageBackend;
  /**
   * The directory this onboard flow is running against. Required so this
   * ceremony can write `.capy/sync-state`'s user_id the same way the
   * ordinary `authenticate` local_action's `publish()` does
   * (`../onboard/executors/index.ts`) — under `--broker-ceremony` this
   * screen REPLACES that local_action (the service never issues it), so
   * without this write nothing in THIS process, or a later one resuming the
   * same directory (the `--confirm` invocation), can find the session file
   * deterministically — every reader falls back to `discover()`'s
   * first-file-that-parses scan instead of the specific user this ceremony
   * just authenticated.
   */
  targetDir: string;
  /**
   * The exact PRF salt already embedded in the URL a caller showed the human
   * — set by the detached ceremony worker (`ceremonyWorker.ts`), whose
   * parent minted this salt BEFORE spawning it and built the human-facing
   * URL from it. Optional and defaults to a fresh mint so every existing
   * caller (this function's own unit tests included, which build their own
   * URL out of band and never pass this) is byte-for-byte unaffected.
   */
  presetPrfSalt?: Buffer;
}

export interface SandboxCeremonyOutcome {
  result: StepResult;
  /** Handed to `ctx.onSession` exactly as an executor's would be — present only on success with a bearer. */
  session?: { token: string; userId: string };
}

export async function runSandboxCeremony(opts: SandboxCeremonyOptions): Promise<SandboxCeremonyOutcome> {
  // Minted ONCE, here, and reused for both the URL the browser's `create_org`
  // device-key stop runs its WebAuthn PRF extension against AND (below,
  // via applyFirstRun) the canned enrollment's wrap KEK — never minted a
  // second time independently. See `enrollDoor`'s doc in
  // `../../auth/deviceKey/onboarding.ts` for the bug this closes.
  const prfSalt = opts.presetPrfSalt ?? generatePrfSalt();
  const url = buildCeremonyUrl(opts.step, opts.machineName, prfSalt);
  const userCode = typeof opts.step.params.user_code === 'string' ? opts.step.params.user_code : undefined;
  emitHandoffUrlEvent(url, 'onboard', { userCode });

  // This ceremony has no human line above it the way `onboardCommand.ts`'s
  // `surfaceScreen` does — under `--broker-ceremony` the caller is normally
  // a sandboxed agent reading only the event above. The one exception: a
  // human running `--broker-ceremony` directly at a real terminal (unlikely,
  // but nothing stops it) still needs the RFC-8628 anti-phishing code
  // (`shared/flows/steps.json`'s `sandbox_session.params_schema.user_code`:
  // "not a secret and MUST be shown to the human") to compare against the
  // page — printed with the EXACT SAME copy function `surfaceScreen` uses,
  // never a second hand-written copy of that sentence to drift out of sync.
  // Gated on the SAME TTY check `emitHandoffUrlEvent` itself uses, and
  // additionally never in `--json` mode, so an agent's parseable stdout
  // never gets an extra human-prose line it didn't ask for.
  if (process.stdout.isTTY && !isOnboardJsonMode()) {
    const { describeScreen } = await import('./copy');
    console.log(`\n${describeScreen('sandbox_session', opts.step.params)}`);
    console.log(`\n  ${url}\n`);
  }

  const connectionId = opts.step.params.connection_id as string;
  const poll = await pollSandboxConnection({
    serviceUrl: opts.serviceUrl,
    connectionId,
    flowSecret: opts.flowSecret,
    keypair: opts.keypair,
    deadlineMs: opts.deadlineMs,
    fetchImpl: opts.fetchImpl,
  });

  if (poll.kind !== 'answered') {
    return { result: { outcome: 'failed', code: codeForPollFailure(poll) } };
  }

  const parsed = parseSandboxSessionAnswer(poll.plaintext);
  if (!parsed.ok) {
    return { result: { outcome: 'failed', code: parsed.code } };
  }

  const { answer } = parsed;

  // Write the CLI's OWN session store — the same writer a normal login
  // uses, which overwrites for this user (SPEC "stale session file wins" is
  // moot for this tool: the CLI is the sole holder, see HANDOFF §9 row 10).
  const backend = opts.sessionBackend ?? new FileSessionStorageBackend();
  const session: SessionStore = {
    version: 2,
    user_id: answer.user.id,
    user_email: answer.user.email,
    user_first_name: answer.user.first_name ?? null,
    user_last_name: answer.user.last_name ?? null,
    refresh_token: answer.refreshToken,
    organizations: answer.organizations,
    sessions: answer.sessions ?? {},
  };
  backend.save(session, answer.user.id);

  // Mirror the `authenticate` local_action's own `publish()` (this screen
  // REPLACES it under --broker-ceremony, so nothing else in this run ever
  // does this write) — see SandboxCeremonyOptions.targetDir's own doc.
  const { ProjectManager } = await import('../../core/projectManager');
  const projectManager = new ProjectManager(opts.targetDir);
  projectManager.writeSyncStateUserId(answer.user.id);

  const firstRun = await applyFirstRun({
    answer,
    backend,
    serviceUrl: opts.serviceUrl,
    devMode: opts.devMode,
    prfSalt,
  });
  if (!firstRun.ok) {
    return { result: { outcome: 'failed', code: firstRun.code } };
  }

  // Same reasoning as the user_id write above: `capyCommand.ts`'s own org
  // hint resolution (`runInitialization`'s orgHint) reads sync-state's
  // org_id as ITS fallback when a pinned org isn't threaded through — this
  // is what makes that fallback actually point at the org this ceremony
  // just resolved, rather than nothing.
  if (firstRun.orgId) {
    projectManager.writeSyncStateOrgId(firstRun.orgId);
  }

  return {
    result: { outcome: 'ok', result: firstRun.orgId ? { org_id: firstRun.orgId } : undefined },
    session: firstRun.token ? { token: firstRun.token, userId: answer.user.id } : undefined,
  };
}
