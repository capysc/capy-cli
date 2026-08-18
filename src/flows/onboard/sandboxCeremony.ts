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
import { codeFor, StepResult } from './executors';
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

/** The `sandbox_session` screen's URL with this ceremony's request fragment appended. */
export function buildCeremonyUrl(step: FlowStep, machineName?: string): string {
  const fragment = encodeFragment({
    v: 1,
    flow: 'sandbox-session',
    first_run: {
      prf_salt: generatePrfSalt().toString('base64'),
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
      // Best-effort: a failed unlock leaves the org exactly as unreachable
      // as it was — the next step's own key check (`unlock_org_key`)
      // reports KEY_NOT_ON_DEVICE, same as any other Case C failure.
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

  const settled = await authService.authenticateSilent(orgId);
  const token = settled.success
    ? ((await authService.getValidToken())?.access_token ?? settled._orgless_access_token)
    : undefined;

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
}

export interface SandboxCeremonyOutcome {
  result: StepResult;
  /** Handed to `ctx.onSession` exactly as an executor's would be — present only on success with a bearer. */
  session?: { token: string; userId: string };
}

export async function runSandboxCeremony(opts: SandboxCeremonyOptions): Promise<SandboxCeremonyOutcome> {
  const url = buildCeremonyUrl(opts.step, opts.machineName);
  emitHandoffUrlEvent(url, 'onboard');

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

  const firstRun = await applyFirstRun({
    answer,
    backend,
    serviceUrl: opts.serviceUrl,
    devMode: opts.devMode,
  });
  if (!firstRun.ok) {
    return { result: { outcome: 'failed', code: firstRun.code } };
  }

  return {
    result: { outcome: 'ok', result: firstRun.orgId ? { org_id: firstRun.orgId } : undefined },
    session: firstRun.token ? { token: firstRun.token, userId: answer.user.id } : undefined,
  };
}
