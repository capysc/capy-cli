import type { AuthFailureReason as ScreenAuthFailureReason } from '../ui/screens/contract';

/**
 * Marker for an env var that was provisioned by a `capy connect <provider>`
 * flow. Lives on the per-branch variable entry so different branches can
 * point at different provider accounts/modes (dev → sandbox, main → live).
 *
 * Connectors are distinct from deploy integrations (cf-workers, vercel,
 * etc.): connectors INGEST a credential into one env var, deploy integrations
 * EGRESS the whole .env to a platform. Don't conflate them — deploy
 * integrations live in `.capy/config`, not here.
 */
export interface ConnectorMetadata {
  /** Provider name registered in connectors/registry.ts (e.g. 'stripe'). */
  provider: string;
  /** How the credential was obtained — provider-specific semantics. */
  source: string;
  /** Provider-specific mode label (e.g. 'test'/'live' for Stripe). */
  mode?: string;
  /** Provider account identifier the credential is scoped to. */
  account_id?: string;
  /** Unix seconds; set by providers whose credentials expire. */
  expires_at?: number;
  /** Unix seconds, set when the connector first wrote this var. */
  created_at: number;
  /** Unix seconds, updated on each successful rotate. */
  rotated_at?: number;
  /** `abc…xyz`-style snippet of the credential value; never the plaintext. */
  fingerprint: string;
  /**
   * The credential's type prefix — `sk_test_`, `rk_live_` — recorded so the
   * screens can name it without the value in hand.
   *
   * `fingerprint` cannot stand in: it keeps three characters, so `sk_` and
   * `sk_test_` collapse to the same thing and a live key stops being
   * distinguishable from a test one at exactly the confirmation that exists to
   * distinguish them. Recorded at connect and refreshed at rotate; absent on
   * entries written before this field existed, which is why it is optional.
   */
  key_prefix?: string;
}

/** v3 keep.lock variable entry — per-branch value hashes */
export interface KeepVariableEntry {
  resource_id: string;
  branch?: string;
  value_hash: string;
  /**
   * ISO8601 UTC — when this branch's value last changed. Server-assigned on
   * push (the server diffs value_hash against its stored copy and discards
   * anything the client sends); the CLI only ever passes it through.
   * Excluded from computeKeepHash. Absent = unknown (predates tracking, or
   * local-only project).
   */
  changed_at?: string;
  /** Set when this variable was provisioned by `capy connect <provider>`. */
  connector?: ConnectorMetadata;
}

export interface KeepFile {
  version: string;
  org_id: string;
  project_id: string;
  project_name: string;
  variables: Record<string, KeepVariableEntry[]>;
}

export interface EnvVariable {
  name: string;
  value: string;
  source: 'local' | 'remote' | 'both';
  encrypted: boolean;
}

export interface ProjectState {
  initialized: boolean;
  hasKeepFile: boolean;
  hasEnvFile: boolean;
  projectName?: string;
  organizationId?: string;
  projectId?: string;
  /** Best-effort derived branch; null when no local signal exists (see ProjectManager.deriveActiveBranch). */
  activeBranch: string | null;
  userId?: string;
}

export interface Branch {
  id: string;
  name: string;
  project_id: string;
  is_protected: boolean;
  created_at?: string;
}

export interface SyncResult {
  success: boolean;
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  errors: string[];
  totalVariables: number;
}

export interface ChangeSet {
  newLocal: EnvVariable[];
  newRemote: EnvVariable[];
  conflicts: ConflictVariable[];
  unchanged: EnvVariable[];
  deleted: EnvVariable[]; // Variables marked as capy:deleted on remote
  deletedLocal: EnvVariable[]; // Variables deleted locally (in sync state but not in local .env)
}

export interface SyncState {
  last_sync: string;
  synced_variables: string[];
  user_id?: string;
  org_id?: string;
  keep_hash?: string | Record<string, string>;
}

/** Read the keep_hash for a specific branch from sync-state (backwards compat with old string format). */
export function getSyncKeepHash(syncState: SyncState | null | undefined, branch: string): string | undefined {
  if (!syncState?.keep_hash) return undefined;
  if (typeof syncState.keep_hash === 'string') return syncState.keep_hash;
  return syncState.keep_hash[branch];
}

/** Build an updated keep_hash record with the given branch's hash set. */
export function setSyncKeepHash(
  syncState: SyncState | null | undefined,
  branch: string,
  hash: string,
): Record<string, string> {
  const existing =
    syncState?.keep_hash && typeof syncState.keep_hash === 'object'
      ? syncState.keep_hash
      : {};
  return { ...existing, [branch]: hash };
}

export interface ConflictVariable {
  name: string;
  localValue: string;
  remoteValue: string;
  isNew?: boolean; // True if local value has a different resource_id than remote
}

export interface UserDecisions {
  pushVariables: string[];
  pullVariables: string[];
  keepLocal: string[];
  keepRemote: string[];
  deleteLocal: string[]; // Variables to delete from local .env
  deleteRemote: string[]; // Variables to delete from remote (push deletion)
}

export interface Organization {
  id: string;
  workos_org_id: string;
  name: string;
}

/**
 * Why a silent authentication attempt failed, as a code rather than a
 * sentence. `error` on `AuthResult` is for display; this is what callers
 * branch on when they need to pick a recovery — notably, only some of these
 * are fixed by signing in again. `no_session` means nothing was cached to
 * refresh in the first place; the rest come from `RefreshFailureReason`.
 */
export type SilentAuthFailureCode =
  | 'session_ended'
  | 'org_not_found'
  | 'server_error'
  | 'network'
  | 'no_session';

/**
 * The same vocabulary crosses the wire to the browser screens as
 * `AuthFailureReason`, where it decides whether the page draws a sign-in
 * button — so a member added on one side and not the other would render the
 * wrong recovery rather than fail. The two declarations sit either side of a
 * package boundary and cannot share a definition; this pair of assignments is
 * what stops them drifting, and it fails at `tsc`, not at runtime.
 */
type AssertNever<T extends never> = T;
export type SilentAuthCodeMatchesScreenContract = [
  AssertNever<Exclude<SilentAuthFailureCode, ScreenAuthFailureReason>>,
  AssertNever<Exclude<ScreenAuthFailureReason, SilentAuthFailureCode>>,
];

export interface AuthResult {
  success: boolean;
  organization_id?: string;
  organization_name?: string;
  user_id?: string;
  user_email?: string;
  user_first_name?: string | null;
  user_last_name?: string | null;
  organizations?: Organization[];
  error?: string;
  /** Machine-readable companion to `error`. Branch on this, never on `error`. */
  error_code?: SilentAuthFailureCode;
  /** WorkOS refresh token for use with createOrganization when org selection is pending */
  _refresh_token?: string;
  /** How the token was obtained: 'cached', 'refreshed', or 'oauth' */
  _auth_method?: 'cached' | 'refreshed' | 'oauth';
  /**
   * CAP-375 Wave-B org-less access token (`scope:"user"`) — present only
   * when the exchange resolved to a genuinely zero-org identity (no org_id
   * claim, no known-org match, `organizations.length === 0`). Used to
   * create an org-less connection broker channel for the Case-A device-key
   * ceremony (CAP-382); never written to SessionStore (transient, this
   * process's lifetime only — the org-scoped session created moments later
   * supersedes it for everything else).
   */
  _orgless_access_token?: string;
}

export interface DecryptResponse {
  env_content: string;
  decrypt_key: string;
  expires_at: string;
  keep_hash?: string;
  latest_keep_hash?: string;
  /**
   * The latest keep.json from the server. Only present when the request omitted
   * keep_hash (i.e. asked for "give me latest"). The client uses this to self-heal
   * a stale local keep.lock and to bootstrap a fresh checkout.
   */
  keep_file?: string;
}

export interface OrgKeyFile {
  version: string;
  org_id: string;
  encrypted_master_key: string;
  wrapping_method: 'auth_token' | 'service_cosign' | 'local_root';
  created_at: string;
}

export interface ServiceToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  organization_id: string;
  user_id: string;
  user_email?: string;
  user_first_name?: string | null;
  user_last_name?: string | null;
  organizations?: Organization[];
}

export interface OrgSession {
  access_token: string;
  expires_at: number;
}

export interface SessionStore {
  version: 2;
  user_id: string;
  user_email?: string;
  user_first_name?: string | null;
  user_last_name?: string | null;
  refresh_token: string;
  organizations: Organization[];
  sessions: Record<string, OrgSession>;
}

export interface CliOptions {
  envPath?: string;
  verbose?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Render bare `capy`'s interactive steps (init trainstops / sync conflict resolver)
   *  in a local browser instead of TTY prompts. Lazy: the browser only opens when an
   *  interactive decision is actually reached (a clean sync stays terminal-only). */
  web?: boolean;
}

export interface ProjectInitResult {
  org_id: string;
  project_id: string;
  project_name: string;
  created: boolean;
}

export interface PushResult {
  success: boolean;
  variables: Record<string, {
    resource_id: string;
    value_hash?: string;
  }>;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface CliConfig {
  apiUrl: string;
  authTimeout: number;
  logLevel: LogLevel;
}

export class CapyError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'CapyError';
  }
}

// NOTE: duplicated verbatim in service/src/errorCodes.ts "for now" — keep in
// sync until cli (a submodule) and @capy/service share a module. Per cardinal
// Rule 4, control flow keys off these codes, never off message text.
export const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  NO_ENV_FILE: 'NO_ENV_FILE',
  NO_KEEP_FILE: 'NO_KEEP_FILE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MEMBERSHIP_REVOKED: 'MEMBERSHIP_REVOKED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',
  // AES-GCM auth-tag failure: wrong decryption key for this ciphertext.
  DECRYPT_KEY_MISMATCH: 'DECRYPT_KEY_MISMATCH',
  INVALID_FORMAT: 'INVALID_FORMAT',
  CONFLICT_RESOLUTION: 'CONFLICT_RESOLUTION',
  SERVICE_ERROR: 'SERVICE_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  // not-found family — replaces server-prose string matching in serviceClient
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  // No .env header, no .capy/branch, and no unambiguous local fallback.
  NO_ACTIVE_BRANCH: 'NO_ACTIVE_BRANCH',
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  NO_SECRETS: 'NO_SECRETS',
  DEPLOY_TOKEN_NOT_FOUND: 'DEPLOY_TOKEN_NOT_FOUND',
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  LOCAL_KEY_BACKEND_ERROR: 'LOCAL_KEY_BACKEND_ERROR',
  /**
   * The account can reach this organization, but this device holds no key for
   * it — the invite has never been redeemed here, and the device-key unlock
   * ceremony did not (or could not) run.
   *
   * Minted as its own code rather than reusing AUTH_FAILED: the remedy is an
   * invite code from an owner, not signing in again, and a caller that cannot
   * tell the two apart sends people into a browser round-trip that can never
   * succeed. Nothing may distinguish them by reading the message.
   */
  KEY_NOT_ON_DEVICE: 'KEY_NOT_ON_DEVICE',
  /**
   * The onboarding plan that would be applied now is not the plan that was
   * approved — the files moved under it. Refusing is the point: an approval of
   * one set of edits is not an approval of a different one.
   */
  PLAN_CHANGED: 'PLAN_CHANGED',
  // Local-state refusals: the command cannot start because this directory,
  // this branch or this build does not hold what it needs. Nothing has been
  // asked of the service yet, so none of these is a SERVICE_ERROR — and each
  // one used to be a bare `console.error` + `process.exit(1)`, which under
  // `--web` is a decision reported to a stream nobody is reading.
  /** The branch has no connector-managed credentials, so there is nothing to rotate. */
  NO_MANAGED_KEYS: 'NO_MANAGED_KEYS',
  /** The branch has no variables at all yet. */
  NO_VARIABLES: 'NO_VARIABLES',
  /** The named variable is not in the environment on this branch. */
  VARIABLE_NOT_FOUND: 'VARIABLE_NOT_FOUND',
  /** No connector integrations are registered in this build. */
  NO_CONNECTORS: 'NO_CONNECTORS',
  /** `capy-dev` reached a live-mode credential. Dev never touches live. */
  DEV_LIVE_FIREWALL: 'DEV_LIVE_FIREWALL',
  // Wrapper-endpoint server codes (CAP-379/CAP-380). Mirrored from
  // service/src/errorCodes.ts, same convention as the codes above. The first
  // three are minted as top-level CapyError codes via SERVER_CODES; the last
  // two ride on 403s as `details.code` (the MEMBERSHIP_REVOKED convention).
  WRAPPER_NOT_FOUND: 'WRAPPER_NOT_FOUND',
  WRAPPER_CONFLICT: 'WRAPPER_CONFLICT',
  WRAPPER_INVARIANT_VIOLATION: 'WRAPPER_INVARIANT_VIOLATION',
  /** 403 details.code: token too old for a sensitive wrapper endpoint — force a refresh and retry ONCE (remediation=refresh_and_retry). */
  FRESH_AUTH_REQUIRED: 'FRESH_AUTH_REQUIRED',
  /** 403 details.code: wrapper enrollment requires a verified email. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  // Device-key onboarding codes (CAP-380, client-side).
  /** The WebAuthn ceremony did not produce a usable PRF result; details carry the ceremony's own code. */
  DEVICE_KEY_CEREMONY_FAILED: 'DEVICE_KEY_CEREMONY_FAILED',
  /** AES-GCM auth failure unwrapping wrapped_k_local — wrong PRF output / credential / blob. */
  DEVICE_KEY_UNWRAP_FAILED: 'DEVICE_KEY_UNWRAP_FAILED',
  /** A wrapper row's kdf_version is newer than this binary understands. */
  DEVICE_KEY_KDF_UNSUPPORTED: 'DEVICE_KEY_KDF_UNSUPPORTED',
  /** Onboarding lost the local.key create race to a DIFFERENT root — refused to overwrite. */
  LOCAL_ROOT_CONFLICT: 'LOCAL_ROOT_CONFLICT',
  // Broker-backed ceremony transport codes (CAP-382, client-side only — the
  // page-side caps these mirror never reach the service, so no server-side
  // twin is needed). Thrown, not folded into CeremonyFailureCode, because
  // they are structural bugs in the request the CLI built, not a ceremony
  // outcome a human chose.
  /** requestUnlock's candidate list exceeds the ceremony page's MAX_UNLOCK_CANDIDATES cap. */
  DEVICE_KEY_TOO_MANY_CANDIDATES: 'DEVICE_KEY_TOO_MANY_CANDIDATES',
  /** The encoded ceremony request exceeds the ceremony page's 16 KiB fragment cap. */
  DEVICE_KEY_FRAGMENT_TOO_LARGE: 'DEVICE_KEY_FRAGMENT_TOO_LARGE',
  /** A candidate's credential id exceeds the ceremony page's 1400-char cap. */
  DEVICE_KEY_CREDENTIAL_ID_TOO_LONG: 'DEVICE_KEY_CREDENTIAL_ID_TOO_LONG',
  /**
   * Final-gate BLOCKER-2: `GET /doors` 404'd — synthesized CLIENT-SIDE by
   * ServiceClient.listDoors() (never sent by the server), for the case where
   * the CLI is talking to a service build that doesn't have the doors route
   * yet. A capability gap, not a "no doors" answer (that's a 200 with an
   * empty array) — kept distinct from generic SERVICE_ERROR so `capy doors`
   * can name the real cause instead of a bare request failure.
   */
  DOORS_NOT_SUPPORTED: 'DOORS_NOT_SUPPORTED',
  // Sandbox grant codes (CAP-384, client-side only). A grant is an in-memory,
  // per-chat key holder — see src/auth/deviceKey/grantHolder.ts's header for
  // the full design. These are never sent by the server: the grant daemon and
  // its client live entirely inside the CLI.
  /** No grant daemon is reachable at the configured socket (never started, or the process died). */
  DEVICE_KEY_GRANT_NOT_FOUND: 'DEVICE_KEY_GRANT_NOT_FOUND',
  /** The grant daemon is reachable but its TTL has elapsed; it has discarded the key material. Re-run `capy device-key grant`. */
  DEVICE_KEY_GRANT_EXPIRED: 'DEVICE_KEY_GRANT_EXPIRED',
  // CAP-402 (client-side only). Two independent gates: one on where a
  // one-time recovery phrase may be RENDERED, one on whether Case A's
  // ephemeral-environment mint may be left half-finished on disk.
  /**
   * A caller tried to render a one-time recovery phrase (org creation,
   * local-only setup) with no real TTY to read it from — an agent/piped/CI
   * invocation, or any other non-interactive run. Printing it there would
   * hand a master-key-equivalent secret to whatever is capturing stdout.
   * Refused rather than downgraded; see recoveryPhrase.ts's docblock.
   */
  RECOVERY_PHRASE_UNSAFE_SURFACE: 'RECOVERY_PHRASE_UNSAFE_SURFACE',
  /**
   * `capy transport`'s non-`--web` path tried to print a redeem code — a
   * bearer credential wrapping this account's org master key — with no real
   * TTY to read it from. Same failure class and same fix shape as
   * RECOVERY_PHRASE_UNSAFE_SURFACE, kept as a separate code because it is a
   * different artifact (a short-lived wrapped credential, not the seed
   * phrase) — see transportCommand.ts's own pre-existing SECURITY comment,
   * which named this exact risk before CAP-402 closed it.
   */
  TRANSPORT_CODE_UNSAFE_SURFACE: 'TRANSPORT_CODE_UNSAFE_SURFACE',
  /**
   * Case A's mint→ceremony→upload sequence did not complete in an
   * ephemeral environment (CAPY_DEVICE_KEY_GRANT_SOCKET set — see
   * ephemeral.ts). Any local.key/key.enc this call minted has already been
   * deleted (see globalConfig.deleteLocalKeyMaterial) rather than left
   * stranded on a disk that will not outlive this process — the seed
   * phrase, if the caller could safely show it, is the only remaining copy.
   */
  DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE: 'DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE',
  // CAP-409 (client-side only). `capy pair`'s RFC 8628-style device-pairing
  // flow. The bootstrap connection's own `expires_at` passed with no answer
  // ever delivered — distinct from a CeremonyFailureCode (those come from the
  // approving device actively declining/erroring; this is nobody ever
  // showing up in time). Mirrors DEVICE_KEY_GRANT_EXPIRED's shape: a coded,
  // non-string signal an orchestrator can branch on (Rule 4).
  PAIR_CODE_EXPIRED: 'PAIR_CODE_EXPIRED',
  // "first-run in one sweep" (client-side only). The in-process broker
  // ceremony `capy onboard --broker-ceremony` runs inside `authenticate`.
  /**
   * Under a flow-driven run with no wizard/inquirer stops allowed (a
   * sandboxed broker-ceremony caller has no TTY and no browser to render
   * one in), the ordinary init path would otherwise have shown an org
   * picker, an org-create wizard, a project picker, or a project-name
   * prompt. Reaching any of those under the flow is a refusal, never
   * `openScreen`/inquirer — see capyCommand.ts's flow-driven init.
   */
  FLOW_STOP_UNREACHABLE: 'FLOW_STOP_UNREACHABLE',
  /**
   * The broker ceremony's sealed answer for `first_run.kind:'create_org'`
   * carried a phrase that does not pass the same BIP39 (24-word, wordlist,
   * checksum) validation the CLI applies to phrase entry everywhere else.
   * The organization is NOT created — refused before `/auth/create-org`.
   */
  INVALID_RECOVERY_PHRASE: 'INVALID_RECOVERY_PHRASE',
  /**
   * The broker ceremony's sealed answer did not parse as the strict
   * sandbox-session envelope: an unknown `first_run.kind`, a required field
   * missing, or one half of a strict pair (`credential_id`/`prf_output`)
   * present without the other. Nothing in the envelope is acted on.
   */
  FLOW_ENVELOPE_INVALID: 'FLOW_ENVELOPE_INVALID',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
