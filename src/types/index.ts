import type { AuthFailureReason as ScreenAuthFailureReason } from '../ui/screens/contract';

/**
 * Marker for an env var that was provisioned by a `capy connect <provider>`
 * flow. Lives on the per-branch variable entry so different branches can
 * point at different provider accounts/modes (dev → sandbox, main → live).
 *
 * "Integration" (CAP-679) is the umbrella term for both directions below —
 * connectors and targets are its two halves, never conflated:
 *   - Connector (this type): brings a value IN (Dokploy import, Stripe,
 *     WorkOS). Lives on the entry as `connector` (singular).
 *   - Target (`KeepVariableEntry.targets`, below): pushes values OUT
 *     (`capy deploy` platforms). Intent lives in `.capy/deploy.json`; the
 *     FACTS of what was actually delivered live here, in keep.lock.
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
  /**
   * Dokploy import only: which Application the credential came from. Absent
   * for every other provider, and absent for a Compose import — see
   * `compose_id`, its sibling field for that source.
   */
  application_id?: string;
  /**
   * Dokploy import only: which Compose service the credential came from.
   * Mutually exclusive with `application_id` on the same entry — a dokploy
   * import sets exactly one of the two, matching the source it actually read.
   */
  compose_id?: string;
  /**
   * Dokploy import only: ISO8601 UTC when `capy connect dokploy` imported this
   * var. Distinct from `created_at` (unix seconds, every provider) — kept as
   * its own field so a re-import's timestamp doesn't collide with the
   * generic one other providers already rely on.
   */
  imported_at?: string;
  /**
   * Dokploy DISCOVERY import only (CAP-657 follow-up): the git branch the
   * matched Dokploy service builds from (its `branch` field), recorded as
   * information only — it is never read back to decide anything, and it is
   * NOT the Capy branch (the Dokploy ENVIRONMENT name is — see
   * `docs/dokploy-deploy-adapter.md`'s "Discovery" section).
   */
  git_branch?: string;
  /**
   * Dokploy import only (CAP-673): the compose/application's own name in
   * Dokploy — `compose.one`/`application.one`'s `name`, falling back to
   * `appName` when Dokploy only set that. Always available from the same
   * response the import already reads (no extra request); absent only when
   * Dokploy returned neither field.
   */
  service_name?: string;
  /**
   * Dokploy import only (CAP-673): the Dokploy PROJECT name the service
   * lives in. Only set when the import already had `project.all` data in
   * hand to resolve it from — a `--discover` import always does (its own
   * plan reads `project.all` up front); a plain `--application`/`--compose`
   * import never fetches `project.all` (every "only ever GETs
   * application.one/compose.one" test pins that path at exactly one
   * request), so its entries carry `service_name` only.
   */
  dokploy_project?: string;
  /**
   * Dokploy import only (CAP-673): the Dokploy ENVIRONMENT name the service
   * runs in — distinct from `git_branch` above, which is the git branch the
   * service BUILDS from, not the Dokploy environment it runs as. Same
   * availability rule as `dokploy_project`.
   */
  environment?: string;
}

/**
 * One `capy deploy` target's own record of delivering this variable (CAP-679).
 * Facts, not intent — the intent (which vars a target ships, its branch, its
 * adapter options) lives in `.capy/deploy.json`; this is what actually landed.
 *
 * `deployed_value_hash !== value_hash` on the entry it sits on means STALE:
 * the value changed since this target last received it.
 *
 * At most one element per (provider, target) on a given entry — a new deploy
 * to the same target REPLACES its element, never appends a duplicate.
 */
export interface TargetDelivery {
  /** Adapter id — e.g. 'dokploy'. Same vocabulary as `TargetConfig.kind`. */
  provider: string;
  /** `.capy/deploy.json` target name — same vocabulary as `TargetConfig.name`. */
  target: string;
  /** Adapter-specific handle for what was written, e.g. `{ composeId }` or `{ applicationId }`. */
  ref?: Record<string, string>;
  /** sha256(value).slice(0,16) — same algorithm as `value_hash`, computed at delivery time. */
  deployed_value_hash: string;
  /** ISO8601 UTC — when this was delivered to the target's configuration (not "running"). */
  deployed_at: string;
  /** Token deploys only (Dokploy): the deploy id `capy deploy revoke` takes. */
  deploy_id?: string;
  /**
   * `false` when this element was written by `capy deploy --no-deploy` — the
   * config landed, but the platform deploy itself never ran, so nothing is
   * actually serving this value yet. Absent (the default for every element
   * written before this field existed, and for every REAL successful deploy)
   * means "deployed" — this is deliberately additive-only: a real deploy
   * OMITS the field rather than writing `true`, so an old keep.lock with no
   * `deployed` field at all keeps meaning exactly what it always meant. The
   * next successful real deploy to the same (provider, target) clears this
   * by omitting the field on the fresh element `upsertTargetElement` writes.
   */
  deployed?: boolean;
  /**
   * Deploy ids this element's CURRENT `deploy_id` superseded, that a prior
   * write (a pending `--no-deploy`, or a config that was written but never
   * confirmed as running) may still depend on — see `targetsGate.ts`'s
   * "no untracked tokens" note. Revoked only once the REPLACEMENT has been
   * successfully delivered AND deployed (a real deploy, polled to done), at
   * which point they are dropped from this list. Never revoked for a pending
   * write or a failed deploy — those may still need the old token.
   */
  superseded_deploy_ids?: readonly string[];
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
  /**
   * Every `capy deploy` target this variable has been delivered to (CAP-679).
   * Optional and additive — absent on every entry written before this field
   * existed. See `TargetDelivery`'s own doc for the one-per-(provider,target)
   * rule and what "stale" means.
   */
  targets?: ReadonlyArray<TargetDelivery>;
}

export interface KeepFile {
  version: string;
  /**
   * Count of forced redeploys. Absent until `capy deploy --force` sets it.
   *
   * Exists so a forced redeploy can produce a real keep.lock diff — and so it
   * stops doing that by bumping `changed_at`, which meant "this value last
   * changed at T" about values that had not changed. Excluded from
   * `computeKeepHash` like every other file-level field, so it cannot perturb
   * client/server hash agreement.
   */
  deploy_revision?: number;
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
  // --- Org system store (CAP-664) ---
  /** Caller's live org role is not owner/admin. Mirrors the server's 403 `code`. */
  SYSTEM_STORE_ADMIN_ONLY: 'SYSTEM_STORE_ADMIN_ONLY',
  /** Entry name doesn't match `^_CONNECTOR_[A-Z0-9]+_[A-Z0-9_]+$`. */
  SYSTEM_STORE_BAD_NAME: 'SYSTEM_STORE_BAD_NAME',
  /** `capy system set/rm` needs a human (hidden prompt / confirmation) and there is no TTY. */
  SYSTEM_STORE_NEEDS_TTY: 'SYSTEM_STORE_NEEDS_TTY',
  /** `_system` is reserved for the org's system store and can't be used as a project name. */
  PROJECT_NAME_RESERVED: 'PROJECT_NAME_RESERVED',
  /** The human declined a confirmation prompt (e.g. `capy system rm`'s default-no). Not an error — a choice. */
  CANCELLED: 'CANCELLED',
  /**
   * `capy rotate` refused on a var whose connector is import-only (e.g.
   * `dokploy`) — there is nothing to rotate through a one-time import.
   */
  ROTATE_NOT_SUPPORTED_IMPORTED: 'ROTATE_NOT_SUPPORTED_IMPORTED',
  // --- Deploy targets (CAP-679) ---
  /**
   * A Dokploy Compose service has `createEnvFile: false` — writing Capy's
   * block into `env` would never reach a container reading `env_file: .env`.
   */
  DOKPLOY_ENV_FILE_DISABLED: 'DOKPLOY_ENV_FILE_DISABLED',
  /**
   * `capy deploy <target>` refused: the active `.env` branch (what deploy is
   * about to read) differs from the saved target's own branch (what the
   * result would be filed under). Also the code any keep.lock-writing
   * follow-up (`recordDeployTargets`, `deploy targets-remove`) refuses on —
   * see `DEPLOY_BRANCH_UNKNOWN` for its sibling: this code always means the
   * active branch IS known, just wrong.
   */
  DEPLOY_BRANCH_MISMATCH: 'DEPLOY_BRANCH_MISMATCH',
  /**
   * Same refusal family as `DEPLOY_BRANCH_MISMATCH`, for when the active
   * branch cannot be determined at all (no `.env` header, no `.capy/branch`,
   * no unambiguous fallback) — never guessed, never silently skipped when a
   * write is about to key off it.
   */
  DEPLOY_BRANCH_UNKNOWN: 'DEPLOY_BRANCH_UNKNOWN',
  // --- Agent onboarding (CAP-681) ---
  /** `capy agents` needs a terminal to confirm a write, and neither --print nor --remove was passed. */
  AGENTS_SETUP_NEEDS_TTY: 'AGENTS_SETUP_NEEDS_TTY',
  /**
   * AGENTS.md or CLAUDE.md has exactly one of the `capy:agents:begin`/`end`
   * markers, or more than one of either — the file was hand-edited into a
   * state the idempotent replace can't safely resolve. Refused rather than
   * guessed at, so no byte outside the markers is ever put at risk.
   */
  AGENTS_BLOCK_MALFORMED: 'AGENTS_BLOCK_MALFORMED',
  /**
   * AGENTS.md or CLAUDE.md resolves (via a symlink) to a path outside the
   * repo root — refused before any read or write through it, so `capy
   * agents` can never be tricked into touching a file elsewhere on disk.
   */
  AGENTS_FILE_OUTSIDE_REPO: 'AGENTS_FILE_OUTSIDE_REPO',
  // --- Deploy follow-ups (CAP-679 continued) ---
  /**
   * Deploy needs the Dokploy API key: `_TARGET_DOKPLOY_API_KEY` is absent,
   * `_CONNECTOR_DOKPLOY_API_KEY` already holds one, and there is no TTY to
   * ask whether to reuse it or set a dedicated one.
   */
  DOKPLOY_TARGET_KEY_MISSING: 'DOKPLOY_TARGET_KEY_MISSING',
  /**
   * `capy connect dokploy` needs the Dokploy API key: `_CONNECTOR_DOKPLOY_API_KEY`
   * is absent, `_TARGET_DOKPLOY_API_KEY` already holds one, and there is no
   * TTY to ask whether to reuse it or set a dedicated one.
   */
  DOKPLOY_CONNECTOR_KEY_MISSING: 'DOKPLOY_CONNECTOR_KEY_MISSING',
  /** A system-store reference (`capy-ref:1:<name>`) points at a name with no entry. */
  SYSTEM_STORE_REFERENCE_MISSING: 'SYSTEM_STORE_REFERENCE_MISSING',
  /** A system-store reference points at another reference — chains are refused, never followed. */
  SYSTEM_STORE_REFERENCE_CHAIN: 'SYSTEM_STORE_REFERENCE_CHAIN',
  /**
   * A `composeType: 'stack'` target is below the Dokploy version that fixed
   * `env_file` quoting (see `dokploy.ts#STACK_ENV_FILE_FIX_VERSION`) — WARN,
   * never refuse.
   */
  DOKPLOY_STACK_QUOTES: 'DOKPLOY_STACK_QUOTES',
  /** Couldn't read the Dokploy instance's version to check for the stack quoting issue above — warn rather than guess either way. */
  DOKPLOY_VERSION_UNKNOWN: 'DOKPLOY_VERSION_UNKNOWN',
  /** `_SECRETS_BLOB` (the new runtime pair) is not valid base64 after stripping one layer of surrounding quotes. */
  RUN_SECRETS_BLOB_INVALID: 'RUN_SECRETS_BLOB_INVALID',
  /** `_PROJECT_KEY` (the new runtime pair) is not 64 hex characters after stripping one layer of surrounding quotes. */
  RUN_PROJECT_KEY_INVALID: 'RUN_PROJECT_KEY_INVALID',
  // --- Dokploy plaintext delivery (CAP-682) ---
  /**
   * A value Capy needs to deliver plaintext to Dokploy cannot be rendered as
   * a dotenv value that reads back byte-exact (e.g. it contains every quote
   * character dotenv understands, or a quoting ambiguity none of them can
   * resolve). Refused before any write — naming the VARIABLE only, never
   * the value.
   */
  DOKPLOY_VALUE_UNREPRESENTABLE: 'DOKPLOY_VALUE_UNREPRESENTABLE',
  /**
   * A value Capy needs to deliver plaintext to Dokploy contains a literal
   * `${{` — Dokploy resolves `${{project.X}}`/`${{environment.X}}`
   * template references inside `env` at deploy time itself (or refuses the
   * deploy if one doesn't resolve), so the container would never receive
   * this value byte-for-byte. Refused before any write, naming the
   * VARIABLE only, never the value.
   */
  DOKPLOY_VALUE_HAS_REFERENCE: 'DOKPLOY_VALUE_HAS_REFERENCE',
  /**
   * A single delivery refused MORE THAN ONE distinct reason across its
   * variables — some values `DOKPLOY_VALUE_UNREPRESENTABLE`, others
   * `DOKPLOY_VALUE_HAS_REFERENCE`. Neither specific code alone would
   * correctly describe every variable in the refusal, so this umbrella
   * code covers the mixed case; a refusal where every variable shares ONE
   * specific reason still carries that specific code instead (see
   * `describeDokployPlainMergeProblem`).
   */
  DOKPLOY_VALUE_INVALID: 'DOKPLOY_VALUE_INVALID',
  /** CI-mode preflight: the Dokploy Application/Compose service has auto-deploy turned off, so merging the keep.lock PR would never trigger a deploy. */
  DOKPLOY_AUTODEPLOY_OFF: 'DOKPLOY_AUTODEPLOY_OFF',
  /** CI-mode preflight: the git branch Dokploy is tracking doesn't match the deploy PR's base branch — merging it would never reach Dokploy's auto-deploy. */
  DOKPLOY_BRANCH_MISMATCH: 'DOKPLOY_BRANCH_MISMATCH',
  /** CI-mode preflight: Dokploy's configured watch paths for this service don't cover keep.lock, so merging the PR would never trigger a deploy. */
  DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP: 'DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
