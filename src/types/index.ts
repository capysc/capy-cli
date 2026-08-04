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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
