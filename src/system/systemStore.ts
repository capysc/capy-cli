/**
 * The org system store (CAP-664).
 *
 * One store per org, holding connector credentials (`_CONNECTOR_<PROVIDER>_
 * <NAME>`) — never repo secrets. See docs/org-system-store.md for the full
 * contract this module implements ("CLI" section) and the security model
 * ("Security model" section).
 *
 * WHAT THIS IS NOT: `ProjectManager` / `FileManager` / `resolveContext`
 * (commands/connectors/shared.ts). Those are all cwd-based and assume a repo
 * keep.lock. This module never reads or writes anything in the current
 * working directory, never calls git, and is never read by `capy run`. Its
 * local state lives entirely under `~/.capy/orgs/<orgId>/system/` (see
 * `src/config/globalConfig.ts`'s "Org system store" section).
 *
 * WHAT THIS REUSES, NOT COPIES: `Encryptor`, `deriveResourceId`, `SyncEngine`
 * (mergeWithKeep / computeKeepHash / adoptServerKeep), `resolveProjectKey`,
 * and the existing `ServiceClient` secrets routes (`pushSecrets`,
 * `getDecryptData`) plus `writeKeepCache`. The only new service call is
 * `getOrCreateSystemStore` — the create-or-get endpoint. Everything else goes
 * through the SAME client methods every other project's secrets do; the
 * admin-only restriction is enforced by the server on those same routes, not
 * by anything special about how this module calls them.
 */
import { createHash } from 'crypto';
import inquirer from 'inquirer';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { resolveOrgContext } from '../core/orgContext';
import { resolveProjectKey } from '../crypto/keyResolver';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { SyncEngine } from '../sync/syncEngine';
import {
  writeKeepCache,
  readSystemKeepFile,
  saveSystemKeepFile,
  readSystemSyncState,
  saveSystemSyncState,
} from '../config/globalConfig';
import {
  CapyError,
  ERROR_CODES,
  KeepFile,
  KeepVariableEntry,
  SyncState,
  setSyncKeepHash,
} from '../types/index';
import { SYSTEM_PROJECT_NAME } from './reservedProjectName';

export { SYSTEM_PROJECT_NAME } from './reservedProjectName';

/** Every entry on the system store lives on this fixed branch. */
export const SYSTEM_STORE_BRANCH = 'system';

/** `_CONNECTOR_<PROVIDER>_<NAME>` — see docs/org-system-store.md "Naming". */
const CONNECTOR_NAME_RE = /^_CONNECTOR_[A-Z0-9]+_[A-Z0-9_]+$/;

/** COPY-FLAG: minimal neutral wording. */
const BAD_NAME_MESSAGE = (name: string) =>
  `"${name}" is not a valid connector secret name. Names must match _CONNECTOR_<PROVIDER>_<NAME>.`;

/** COPY-FLAG: minimal neutral wording. */
const ADMIN_ONLY_MESSAGE = 'This org\'s system store is only available to owners and admins.';

/**
 * Throws `SYSTEM_STORE_BAD_NAME` when `name` doesn't match
 * `^_CONNECTOR_[A-Z0-9]+_[A-Z0-9_]+$`. Callers must call this BEFORE any
 * network call — see docs/org-system-store.md Proof 3.
 */
export function assertValidConnectorName(name: string): void {
  if (!CONNECTOR_NAME_RE.test(name)) {
    throw new CapyError(BAD_NAME_MESSAGE(name), ERROR_CODES.SYSTEM_STORE_BAD_NAME, { name });
  }
}

export interface OpenSystemStoreOptions {
  /** Explicit org id (e.g. `--org`). Falls back to the cwd's keep.lock org, then an interactive/resolved pick. */
  orgId?: string;
  apiUrl?: string;
  devMode?: boolean;
}

export interface SystemStoreEntry {
  name: string;
  /** ISO8601 UTC, server-assigned. Absent when this entry has never round-tripped through a push response. */
  changed_at?: string;
}

export interface SystemStoreHandle {
  readonly orgId: string;
  readonly userId: string;
  /** Names + `changed_at` only — values are never listed. */
  listNames(): SystemStoreEntry[];
  /** Decrypts in memory. `null` when `name` has no entry. */
  get(name: string): string | null;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Immutable snapshot resolved once at open time; every operation below is a pure function of one of these. */
interface SystemStoreContext {
  orgId: string;
  userId: string;
  projectId: string;
  branch: string;
  projectKey: string;
  serviceClient: ServiceClient;
  keep: KeepFile;
  plaintextEnv: Readonly<Record<string, string>>;
}

/** A 403 whose body carries `SYSTEM_STORE_ADMIN_ONLY` becomes a typed error with that same top-level code. */
function isSystemStoreAdminOnly(err: unknown): boolean {
  return (
    err instanceof CapyError &&
    err.code === ERROR_CODES.PERMISSION_DENIED &&
    err.details?.code === 'SYSTEM_STORE_ADMIN_ONLY'
  );
}

async function withAdminOnlyTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isSystemStoreAdminOnly(err)) {
      throw new CapyError(ADMIN_ONLY_MESSAGE, ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY, (err as CapyError).details);
    }
    throw err;
  }
}

/** Blank keep.lock for a system store that has never been pushed to. */
function blankSystemKeep(orgId: string, projectId: string): KeepFile {
  return {
    version: '3.0',
    org_id: orgId,
    project_id: projectId,
    project_name: SYSTEM_PROJECT_NAME,
    variables: {},
  };
}

/** `KEY=capy:{resourceId}:{cipher}` lines, one per var — the exact shape this module writes and reads back. */
function parseEnvBlob(blob: string): Record<string, string> {
  const entries = blob
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const eq = line.indexOf('=');
      return eq === -1 ? null : ([line.slice(0, eq), line.slice(eq + 1)] as const);
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);
  return Object.fromEntries(entries);
}

/** Decrypts a `capy:{resourceId}:{cipher}` value written by this module (never snippet-wrapped — see module header). */
function decryptStoredValue(raw: string, projectKey: string): string | null {
  if (raw === 'capy:deleted') return null;
  if (!raw.startsWith('capy:')) return null;
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const cipher = parts.slice(2).join(':');
  return Encryptor.decrypt(cipher, projectKey);
}

/** Encrypts `env` into the `KEY=capy:{resourceId}:{cipher}` blob this module writes. */
function buildEnvBlob(env: Readonly<Record<string, string>>, branch: string, projectKey: string): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=capy:${deriveResourceId(branch, k)}:${Encryptor.encrypt(v, projectKey)}`)
    .join('\n');
}

/**
 * Drops any keep.lock entry (on `branch`) for a name no longer in `keptNames`
 * — the immutable equivalent of the delete-stale-entries loop in
 * `connectors/shared.ts`'s `writeAndSync`. Names in `keptNames` are left
 * exactly as `mergeWithKeep` produced them.
 */
function pruneRemovedVariables(keep: KeepFile, branch: string, keptNames: ReadonlySet<string>): KeepFile {
  const variables = Object.fromEntries(
    Object.entries(keep.variables)
      .map(([name, entries]): [string, KeepVariableEntry[]] => [
        name,
        keptNames.has(name) ? entries : entries.filter((e) => e.branch !== branch),
      ])
      .filter(([, entries]) => entries.length > 0),
  );
  return { ...keep, variables };
}

/** Push `newEnv` as the system store's complete env for `ctx.branch`, and self-heal the local cache. */
async function pushSystemEnv(ctx: SystemStoreContext, newEnv: Readonly<Record<string, string>>): Promise<void> {
  const envBlob = buildEnvBlob(newEnv, ctx.branch, ctx.projectKey);

  const pushedVars = Object.fromEntries(
    Object.entries(newEnv).map(([k, v]) => [
      k,
      { resource_id: deriveResourceId(ctx.branch, k), value_hash: createHash('sha256').update(v).digest('hex').slice(0, 16) },
    ]),
  );

  const syncEngine = new SyncEngine();
  const merged = syncEngine.mergeWithKeep(ctx.keep, pushedVars, ctx.branch);
  const pruned = pruneRemovedVariables(merged, ctx.branch, new Set(Object.keys(newEnv)));

  const result = await withAdminOnlyTranslation(() =>
    ctx.serviceClient.pushSecrets(ctx.projectId, JSON.stringify(pruned), envBlob, ctx.branch),
  );

  writeKeepCache(ctx.orgId, ctx.projectId, result.keep_hash, envBlob);
  const adopted = SyncEngine.adoptServerKeep(result.keep_file, pruned, ctx.branch);
  saveSystemKeepFile(ctx.orgId, adopted);

  const existingSyncState = readSystemSyncState(ctx.orgId);
  const nextSyncState: SyncState = {
    ...(existingSyncState ?? { last_sync: '', synced_variables: [] }),
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(newEnv),
    user_id: ctx.userId,
    keep_hash: setSyncKeepHash(existingSyncState, ctx.branch, SyncEngine.computeKeepHash(pruned, ctx.branch)),
  };
  saveSystemSyncState(ctx.orgId, nextSyncState);
}

/** Silent-then-interactive auth, pinned to `orgId`. Throws `AUTH_FAILED` rather than exiting — this is a library, not a command. */
async function authenticateOrThrow(authService: AuthService, orgId: string): Promise<string> {
  const silent = await authService.authenticateSilent(orgId);
  const result = silent.success ? silent : await authService.authenticate(orgId);
  if (!result.success || !result.user_id) {
    throw new CapyError('Authentication failed.', ERROR_CODES.AUTH_FAILED, { orgId });
  }
  return result.user_id;
}

/** `opts.orgId`, else the cwd's keep.lock org (read-only — never falls through to writing anything there), else `null`. */
async function resolveHintedOrgId(explicitOrgId: string | undefined): Promise<{ orgId: string | null; userIdHint?: string }> {
  if (explicitOrgId) return { orgId: explicitOrgId };
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();
  return { orgId: projectState.organizationId ?? null, userIdHint: projectState.userId };
}

/**
 * Resolves org + auth + the system project + the project key, and pulls the
 * latest ciphertext for `SYSTEM_STORE_BRANCH` — everything every operation
 * below needs, gathered exactly once. A 403 anywhere in here (create-or-get,
 * or the secrets read) means the caller isn't an org owner/admin, and comes
 * back as a typed `SYSTEM_STORE_ADMIN_ONLY` error.
 */
async function openSystemStoreContext(opts: OpenSystemStoreOptions): Promise<SystemStoreContext> {
  const devMode = opts.devMode ?? false;
  const { orgId: hinted, userIdHint } = await resolveHintedOrgId(opts.orgId);

  const { orgId, userId, serviceClient } = hinted
    ? await (async () => {
        const authService = new AuthService(opts.apiUrl, devMode, userIdHint);
        const serviceClient = new ServiceClient(opts.apiUrl, devMode);
        serviceClient.setTokenProvider(() => authService.getValidToken());
        const userId = await authenticateOrThrow(authService, hinted);
        return { orgId: hinted, userId, serviceClient };
      })()
    : await (async () => {
        const ctx = await resolveOrgContext(opts.apiUrl, devMode);
        return { orgId: ctx.orgId, userId: ctx.userId, serviceClient: ctx.serviceClient };
      })();

  const keyServiceOps = {
    coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
    wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
  };

  const { project_id: projectId, branch } = await withAdminOnlyTranslation(() =>
    serviceClient.getOrCreateSystemStore(orgId),
  );

  const projectKey = await resolveProjectKey(orgId, projectId, userId, keyServiceOps);

  const decryptData = await withAdminOnlyTranslation(() =>
    serviceClient.getDecryptData(projectId, branch || SYSTEM_STORE_BRANCH, undefined, true),
  );

  const localKeep = readSystemKeepFile(orgId);
  const keep = SyncEngine.adoptServerKeep(
    decryptData.keep_file,
    localKeep ?? blankSystemKeep(orgId, projectId),
    branch || SYSTEM_STORE_BRANCH,
  );
  // Self-heal the local cache on every open, same as a normal checkout/sync.
  saveSystemKeepFile(orgId, keep);

  const rawEntries = Object.entries(parseEnvBlob(decryptData.env_content || ''));
  const decryptedEntries = rawEntries
    .map(([k, v]): [string, string | null] => [k, decryptStoredValue(v, projectKey)])
    .filter((pair): pair is [string, string] => pair[1] !== null);
  const plaintextEnv = Object.fromEntries(decryptedEntries);

  return {
    orgId,
    userId,
    projectId,
    branch: branch || SYSTEM_STORE_BRANCH,
    projectKey,
    serviceClient,
    keep,
    plaintextEnv,
  };
}

function listNamesFrom(ctx: SystemStoreContext): SystemStoreEntry[] {
  const unsorted = Object.entries(ctx.keep.variables)
    .map(([name, entries]) => ({ name, entry: entries.find((e) => e.branch === ctx.branch) }))
    .filter((x): x is { name: string; entry: KeepVariableEntry } => x.entry !== undefined)
    .map(({ name, entry }) => ({ name, changed_at: entry.changed_at }));
  // `.toSorted()` needs ES2023, which this package's tsconfig `lib` doesn't
  // include — sort a fresh copy instead of mutating `unsorted` in place.
  return Array.from(unsorted).sort((a, b) => a.name.localeCompare(b.name));
}

function getFrom(ctx: SystemStoreContext, name: string): string | null {
  assertValidConnectorName(name);
  return Object.prototype.hasOwnProperty.call(ctx.plaintextEnv, name) ? ctx.plaintextEnv[name] : null;
}

/** Resolves org + auth, opens/creates the org's system store, and pulls its current entries. */
export async function openSystemStore(opts: OpenSystemStoreOptions = {}): Promise<SystemStoreHandle> {
  const ctx = await openSystemStoreContext(opts);
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    listNames: () => listNamesFrom(ctx),
    get: (name: string) => getFrom(ctx, name),
    set: async (name: string, value: string) => {
      assertValidConnectorName(name);
      await pushSystemEnv(ctx, { ...ctx.plaintextEnv, [name]: value });
    },
    remove: async (name: string) => {
      assertValidConnectorName(name);
      const { [name]: _removed, ...rest } = ctx.plaintextEnv;
      await pushSystemEnv(ctx, rest);
    },
  };
}

export interface GetConnectorSecretOptions {
  orgId?: string;
  apiUrl?: string;
  devMode?: boolean;
  /** No terminal → never prompts; a missing entry resolves to `null`. */
  interactive: boolean;
}

/**
 * Returns a connector's secret, prompting to collect and save it when it's
 * missing and the caller can ask a human.
 *
 * Opening the store already requires org owner/admin (the server enforces
 * this on every call inside `openSystemStoreContext`), so reaching the
 * "missing" check below means the caller already has that access — there is
 * no separate admin check to make here.
 */
export async function getConnectorSecret(name: string, opts: GetConnectorSecretOptions): Promise<string | null> {
  assertValidConnectorName(name);
  const ctx = await openSystemStoreContext(opts);

  const existing = getFrom(ctx, name);
  if (existing !== null) return existing;
  if (!opts.interactive) return null;

  const { value } = await inquirer.prompt([
    {
      type: 'password',
      name: 'value',
      message: `Enter a value for ${name}:`, // COPY-FLAG
      mask: '*',
    },
  ]);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  await pushSystemEnv(ctx, { ...ctx.plaintextEnv, [name]: trimmed });
  return trimmed;
}
