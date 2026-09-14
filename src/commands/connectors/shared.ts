import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { AuthService } from '../../auth/authService';
import { ServiceClient } from '../../service/serviceClient';
import { SyncEngine } from '../../sync/syncEngine';
import { Encryptor } from '../../crypto/encryptor';
import { hasOrgKey } from '../../crypto/keyResolver';
import { deriveResourceId } from '../../crypto/resourceId';
import { writeKeepCache } from '../../config/globalConfig';
import { formatRelativeTime } from '../../ui/relativeTime';
import { createGrantResolutionOps } from '../../auth/deviceKey/grantResolver';
import {
  setSyncKeepHash,
  getSyncKeepHash,
  KeepFile,
  ConnectorMetadata,
  CapyError,
  ERROR_CODES,
} from '../../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * sha256('') — the well-known CAS base hash for a branch nothing has ever
 * been pushed to (SyncEngine.computeKeepHash of an empty KeepFile hashes the
 * empty string the same way). Lock-less contexts bootstrapping against a
 * project with no secrets yet resolve to this rather than `undefined`, so
 * the first push still carries a real precondition instead of silently
 * skipping the CAS check.
 */
const EMPTY_KEEP_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface ResolvedContext {
  pm: ProjectManager;
  fileManager: FileManager;
  authService: AuthService;
  serviceClient: ServiceClient;
  orgId: string;
  projectId: string;
  branch: string;
  userId: string;
  projectKey: string;
  keep: KeepFile;
  localPlaintext: Record<string, string>;
  /**
   * True when this directory has no keep.lock — single-user "lock-less"
   * mode. The server's latest/keep.json for org/project/branch is the only
   * source of truth; `writeAndSync` never writes keep.lock or auto-commits
   * it in this mode.
   */
  lockless: boolean;
  /**
   * The branch's keep_hash this context was resolved from — the CAS
   * precondition for the next push (`ServiceClient.pushSecrets`'s
   * `base_keep_hash`). Always set in lock-less mode (server hash, or the
   * well-known empty-state hash when nothing has been pushed yet). In
   * lock-full mode this is sync-state's recorded hash for the branch when
   * one is known, and `undefined` otherwise — callers must omit
   * `base_keep_hash` entirely rather than guess when this is `undefined`.
   */
  base_keep_hash?: string;
  /**
   * How lock-less identity was resolved — `'header'` when the `.env` capy
   * header already named org/project (a previous lock-less write in this
   * directory, or a git-synced teammate's `.env`), `'server'` when nothing
   * local named it and this call fell back to auth + `listProjects`'s
   * "default" project. `undefined` in lock-full mode (irrelevant — keep.lock
   * is the identity source there).
   *
   * Drives `maybeWarnPersonalEnv`'s "first lock-less write in this
   * directory" condition below: it only fires on `'server'`, since `'header'`
   * means an earlier write already left the header behind.
   */
  identitySource?: 'header' | 'server';
  /** Whether the authoritative remote keep marker existed when this context was resolved. */
  remoteKeepExists: boolean;
}

type ContextAuthResult = Awaited<ReturnType<AuthService['authenticateSilent']>>;

async function authenticateContext(authService: AuthService, orgId?: string): Promise<ContextAuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success) return scopedSilent;
  const unscopedSilent = await authService.authenticateSilent();
  if (unscopedSilent.success) return unscopedSilent;
  return authService.authenticate(orgId);
}

/**
 * An authenticated account can already own a PRF-protected local root while
 * this machine has none. Before a key-dependent command reports that the
 * organization is unavailable, let the CLI ask Keep for the credential PRF
 * result and restore the root locally. Keep only returns the sealed PRF
 * result; this process fetches, unwraps, and persists its own wrapper.
 */
async function restoreAuthenticatedLocalCustody(input: Readonly<{
  readonly authService: AuthService;
  readonly authResult: ContextAuthResult;
  readonly devMode: boolean;
  readonly organizationId: string;
  readonly serviceClient: ServiceClient;
}>): Promise<void> {
  const userId = input.authResult.user_id;
  if (!userId || hasOrgKey(input.organizationId, userId)) return;
  const { restoreLocalCustodyWithDeviceKey } = await import('../../auth/deviceKey/wiring');
  await restoreLocalCustodyWithDeviceKey({
    authService: input.authService,
    serviceClient: input.serviceClient,
    devMode: input.devMode,
    userId,
    userEmail: input.authResult.user_email,
    organizations: input.authResult.organizations ?? [],
    activeOrgId: input.organizationId,
  });
}

function decryptReadableValues(
  raw: Readonly<Record<string, string>>,
  projectKey: string,
  fileManager: FileManager,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, value]) => {
      if (!value.startsWith('capy:')) return [[name, value] as const];
      try {
        return [[name, fileManager.decryptValue(value, projectKey)] as const];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * Run the standard "I'm an interactive command that needs to encrypt + push"
 * setup. Mirrors the front half of editCommand.ts. Exits the process on
 * unrecoverable errors (no keep.lock, auth fail, key resolution fail).
 */
export interface ResolveContextOptions {
  readonly apiUrl?: string;
  readonly devMode?: boolean;
  /** Billing-authoritative free mode ignores any stale/local keep.lock identity. */
  readonly forceLockless?: boolean;
  readonly authService?: AuthService;
  readonly serviceClient?: ServiceClient;
  readonly authResult?: ContextAuthResult;
  /** Fail directly instead of displaying a browser error surface. */
  readonly nonInteractive?: boolean;
  /** Planning/agent push may restore existing custody, never mint replacement keys. */
  readonly existingKeyOnly?: boolean;
}

export async function resolveContext(opts: ResolveContextOptions = {}): Promise<ResolvedContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  // No keep.lock: single-user lock-less mode against the user's personal
  // ("default") project, rather than the old hard exit. A dir WITH
  // keep.lock keeps every line below byte-for-byte unchanged.
  if (opts.forceLockless || !projectState.initialized || !projectState.organizationId || !projectState.projectId) {
    return resolveLocklessContext(pm, opts);
  }
  const orgId = projectState.organizationId;
  const projectId = projectState.projectId;
  const branch = projectState.activeBranch;
  if (!branch) {
    console.error(`No active branch. Run ${B('capy')} to select a branch.`);
    process.exit(1);
  }

  const keep = pm.readKeepFile();
  if (!keep) {
    console.error('Could not read keep.lock');
    process.exit(1);
  }

  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;
  const authService = new AuthService(opts.apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(opts.apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const authResult = await authenticateContext(authService, orgId);
  if (!authResult.success || !authResult.user_id) {
    console.error('Authentication failed');
    process.exit(1);
  }

  await restoreAuthenticatedLocalCustody({
    authService,
    authResult,
    devMode,
    organizationId: orgId,
    serviceClient,
  });

  const { resolveProjectKeyWithMintFallback } = await import('../../auth/masterKeyMint');
  const projectKey = await (async (): Promise<string> => {
    try {
      return await resolveProjectKeyWithMintFallback({
        orgId,
        projectId,
        userId: authResult.user_id!,
        serviceClient,
        keyServiceOps: {
          coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
          wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
        },
        // The key_state for THIS org from the auth-response org list, when
        // known — absent (undefined) makes the mint chokepoint use the
        // claim's own 409 as its probe instead. See resolveProjectKeyWithMintFallback.
        orgKeyState: authResult.organizations?.find((o) => o.id === orgId)?.key_state,
      });
    } catch (err: unknown) {
      const { displayErrorAndExit } = await import('../../ui/errorScreen');
      await displayErrorAndExit(err, {
        projectName: keep.project_name,
        projectId: keep.project_id,
        branch,
      });
      throw err;
    }
  })();

  const localPlaintext = decryptReadableValues(fileManager.readEnvFile(), projectKey, fileManager);

  return {
    pm,
    fileManager,
    authService,
    serviceClient,
    orgId,
    projectId,
    branch,
    userId: authResult.user_id,
    projectKey,
    keep,
    localPlaintext,
    lockless: false,
    remoteKeepExists: true,
    // sync-state's per-branch keep_hash when this machine has one recorded
    // (it does after any prior push or pull on this branch); `undefined` on
    // a keep.lock that was hand-created or predates keep_hash tracking —
    // pushSecrets omits base_keep_hash entirely rather than guess.
    base_keep_hash: getSyncKeepHash(pm.readSyncState(), branch),
  };
}

/**
 * Identity + secrets resolution for a directory with no keep.lock —
 * single-user "lock-less" mode. The server's latest/keep.json for the
 * org/project/branch is the only source of truth; nothing here writes
 * keep.lock (see `writeAndSync`'s lock-less branch, which skips it too).
 *
 * Identity resolution order:
 *   1. The `.env` header a previous lock-less `writeAndSync` wrote
 *      (`# capy:org_id=…` / `# capy:project_id=…`, parsed by
 *      `FileManager.readEnvMeta`).
 *   2. Otherwise: authenticate, then find the caller's org's project named
 *      "default" via `ServiceClient.listProjects()`. A missing "default"
 *      project fails with a coded PROJECT_NOT_FOUND — server-side
 *      auto-provisioning of that project is a separate workstream; this
 *      function never creates one.
 *
 * Branch: billing-forced lock-less resolution always uses `'development'`,
 * because free mode has one authoritative remote branch and stale local
 * branch hints must not redirect it. Legacy lock-less resolution continues to
 * use `ProjectManager.deriveActiveBranch()` (which itself already checks the
 * `.env` header, `.capy/branch`, and single-branch fallbacks), defaulting to
 * `'development'` only when none yield anything. The lock-full path above is
 * untouched.
 */
async function resolveLocklessContext(
  pm: ProjectManager,
  opts: ResolveContextOptions,
): Promise<ResolvedContext> {
  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;

  const envMeta = fileManager.readEnvMeta();
  const identityMeta = opts.forceLockless ? {} : envMeta;
  // Captured before the auth+listProjects fallback below can fill orgId in —
  // this is the only point that knows whether identity came from the header
  // or had to be looked up. See `identitySource` on `ResolvedContext`.
  const identitySource: 'header' | 'server' = identityMeta.org_id && identityMeta.project_id ? 'header' : 'server';
  // Used only to synthesize an empty KeepFile's project_name below, when
  // nothing has ever been pushed to this branch — a KeepFile fetched from the
  // server always carries the project's real name instead. Lock-less mode
  // always targets the org's project literally named "default" (the
  // identity-resolution contract above), so that's the safe assumption here
  // even when identity came from the `.env` header rather than listProjects.
  const authService = opts.authService ?? new AuthService(opts.apiUrl, devMode, pm.readSyncState()?.user_id);
  const serviceClient = opts.serviceClient ?? new ServiceClient(opts.apiUrl, devMode);
  if (!opts.serviceClient) serviceClient.setTokenProvider(() => authService.getValidToken());

  const authResult = opts.authResult ?? await authenticateContext(authService, identityMeta.org_id);
  if (!authResult.success || !authResult.user_id) {
    throw new CapyError(authResult.error ?? 'Authentication failed', ERROR_CODES.AUTH_FAILED);
  }
  const userId = authResult.user_id;

  const identity = await (async (): Promise<{
    readonly orgId: string;
    readonly projectId: string;
    readonly projectName: string;
  }> => {
    if (identityMeta.org_id && identityMeta.project_id) {
      return { orgId: identityMeta.org_id, projectId: identityMeta.project_id, projectName: 'default' };
    }
    const orgId = authResult.organization_id;
    if (!orgId) {
      throw new CapyError(
        'Could not determine an organization for this account.',
        ERROR_CODES.ORG_NOT_FOUND,
      );
    }
    const projects = await serviceClient.listProjects();
    const defaultProject = projects.find((p) => p.name === 'default' && p.organization_id === orgId);
    if (!defaultProject) {
      throw new CapyError(
        `No "default" project found for this organization. Run ${B('capy')} in a new directory to create one.`,
        ERROR_CODES.PROJECT_NOT_FOUND,
        { orgId },
      );
    }
    return { orgId, projectId: defaultProject.id, projectName: defaultProject.name };
  })();
  const { orgId, projectId, projectName } = identity;

  await restoreAuthenticatedLocalCustody({
    authService,
    authResult,
    devMode,
    organizationId: orgId,
    serviceClient,
  });

  const branch = opts.forceLockless
    ? SyncEngine.DEFAULT_BRANCH
    : pm.deriveActiveBranch() || SyncEngine.DEFAULT_BRANCH;

  const { resolveProjectKeyWithMintFallback } = await import('../../auth/masterKeyMint');
  const projectKey = await (async (): Promise<string> => {
    try {
      if (opts.existingKeyOnly) {
        const { resolveFreeSyncProjectKey } = await import('../../sync/freeSyncKeyResolver');
        return resolveFreeSyncProjectKey(orgId, projectId, userId, {
          coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then(result => result.plaintext),
          wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then(result => result.ciphertext),
        }, createGrantResolutionOps(serviceClient, authService));
      }
      return await resolveProjectKeyWithMintFallback({
        orgId,
        projectId,
        userId,
        serviceClient,
        keyServiceOps: {
          coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
          wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
        },
        grantResolutionOps: createGrantResolutionOps(serviceClient, authService),
        orgKeyState: authResult.organizations?.find((o) => o.id === orgId)?.key_state,
      });
    } catch (err: unknown) {
      if (opts.nonInteractive) throw err;
      const { displayErrorAndExit } = await import('../../ui/errorScreen');
      await displayErrorAndExit(err, { projectName, projectId, branch });
      throw err;
    }
  })();

  // Latest state from the server for this branch — the lock-less source of
  // truth. `keepHash` omitted is the CLI's existing "give me latest"
  // contract (GET /secrets/:id?branch=… with no keep_hash), which already
  // returns `keep_hash` + `keep_file` and already swallows a "nothing pushed
  // yet" 404 (NO_SECRETS) into an empty result — see getDecryptData's own
  // doc comment for the PROJECT_NOT_FOUND/BRANCH_NOT_FOUND propagation rule.
  const decryptResult = await serviceClient.getDecryptData(projectId, branch);
  const keep: KeepFile = decryptResult.keep_file
    ? JSON.parse(decryptResult.keep_file)
    : { version: '3.0', org_id: orgId, project_id: projectId, project_name: projectName, variables: {} };
  const baseKeepHash = decryptResult.keep_file
    ? decryptResult.keep_hash ?? SyncEngine.computeKeepHash(keep, branch)
    : EMPTY_KEEP_HASH;

  // Seed from the server's blob FIRST. A fresh directory with no local `.env`
  // is the NORMAL case in single-user mode — the personal env follows the
  // user across repos rather than living in any one checkout — so starting
  // `localPlaintext` from local `.env` alone would make it empty here even
  // though the branch already has vars on the server. `writeAndSync`'s prune
  // step treats anything in `keep` (the server's keep, in lock-less mode)
  // but missing from `finalEnv` as an explicit local delete; an empty
  // `localPlaintext` would make the very first write in a new directory
  // silently wipe every existing variable on the branch. Local `.env`
  // entries are layered on top afterward so uncommitted local edits win.
  const remotePlaintext = decryptReadableValues(
    decryptResult.env_content ? fileManager.parseEnvContent(decryptResult.env_content) : {},
    projectKey,
    fileManager,
  );
  const localPlaintext = {
    ...remotePlaintext,
    ...decryptReadableValues(fileManager.readEnvFile(), projectKey, fileManager),
  };

  return {
    pm,
    fileManager,
    authService,
    serviceClient,
    orgId,
    projectId,
    branch,
    userId,
    projectKey,
    keep,
    localPlaintext,
    lockless: true,
    base_keep_hash: baseKeepHash,
    identitySource,
    remoteKeepExists: Boolean(decryptResult.keep_file),
  };
}

/**
 * Set `varName=value` in `.env`, encrypt + push to Keep, and update
 * keep.lock + sync state. Mirrors the editCommand `saveLocalEdits` flow.
 *
 * If `connector` is provided, the metadata is attached to the keep.lock entry
 * for `varName` on the active branch. Survives future syncs because
 * `mergeWithKeep` preserves extra fields on existing entries.
 *
 * If `push` is false, writes the encrypted snippet locally only — the next
 * `capy push` / `capy` will pick it up. Local-only mode skips the merge so
 * the connector field doesn't get attached until a real push.
 */
/**
 * Write a variable (when there is one to write), attach its connector, sync.
 *
 * `value === undefined` is the METADATA-ONLY mode, and it is what `connect`
 * uses: the env map goes to the service unchanged and only keep.lock's
 * connector entry moves. Everything downstream — the keep merge, the push, the
 * cache, the sync state, the auto-commit — is identical either way, which is
 * why this is one function and not two. `rotate` is the caller that passes a
 * value, because replacing a credential is what rotate is for.
 */
export async function writeAndSync(
  ctx: ResolvedContext,
  varName: string,
  value: string | undefined,
  opts: {
    push: boolean;
    connector?: ConnectorMetadata;
    /**
     * Called when the retry below finds that `varName` itself changed on the
     * server since `ctx` was resolved (not just some other key) — i.e. a
     * genuine edit-time conflict, not an unrelated concurrent push. `true`
     * overwrites the server's value with this write anyway. Omitted (or
     * returning `false`) refuses and throws a coded STALE_KEEP_HASH error —
     * the safe default for a non-interactive caller. See `addCommand.ts`'s
     * `overwriteNotice` for the terminal wording this mirrors.
     *
     * `contextLines` — pre-rendered by `conflictContextLines` from the
     * server's freshest copy of the conflicting entries (connector metadata,
     * last-written time) — is handed to the caller to print above whatever
     * question it asks; never itself part of the question text.
     */
    confirmOverwrite?: (varNames: string[], contextLines: string[]) => Promise<boolean>;
    /** Additional (varName, connector) pairs to mark managed in the same write. */
    alsoConnect?: ReadonlyArray<{ varName: string; entry: ConnectorMetadata }>;
  },
  warningState: PersonalEnvWarningState = initialPersonalEnvWarningState(),
): Promise<PersonalEnvWarningState> {
  const nextWarningState = maybeWarnPersonalEnv(ctx, warningState);
  const finalEnv = value === undefined
    ? { ...ctx.localPlaintext }
    : { ...ctx.localPlaintext, [varName]: value };

  if (!opts.push) {
    // Local-only path. Even though we're not hitting the service, we still
    // need to attach the connector marker to keep.lock so a follow-up `capy
    // push` (which will round-trip through mergeWithKeep) preserves it. In
    // lock-less mode there is no keep.lock to write — the connector-attached
    // keep is still handed to writeEncryptedEnvFile so the `.env` identity
    // header stays correct, but nothing lands on disk as keep.lock.
    if (opts.connector || opts.alsoConnect) {
      const merged = applyConnectors(ctx.keep, ctx.branch, varName, opts.connector, opts.alsoConnect);
      if (!ctx.lockless) ctx.fileManager.writeKeepFile(merged);
      ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, merged, ctx.branch);
    } else {
      ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, ctx.keep, ctx.branch);
    }
    return nextWarningState;
  }

  await syncResolvedSnapshot(ctx, finalEnv, {
    primaryVarNames: [varName],
    connector: opts.connector ? { varName, metadata: opts.connector } : undefined,
    alsoConnect: opts.alsoConnect,
    confirmOverwrite: opts.confirmOverwrite,
  });
  return nextWarningState;
}

export interface SyncResolvedSnapshotOptions {
  readonly primaryVarNames: readonly string[];
  readonly connector?: {
    readonly varName: string;
    readonly metadata: ConnectorMetadata;
  };
  readonly alsoConnect?: ReadonlyArray<{ varName: string; entry: ConnectorMetadata }>;
  readonly confirmOverwrite?: (varNames: string[], contextLines: string[]) => Promise<boolean>;
  readonly cacheRemote?: typeof writeKeepCache;
  /** Revalidate a reviewed target before request and before local persistence. */
  readonly beforePush?: () => Promise<void> | void;
  readonly beforeLocalWrite?: () => void;
  readonly reportStatus?: (message: string, warning: boolean) => void;
  readonly maxRetries?: number;
}

function encryptSnapshot(
  finalEnv: Readonly<Record<string, string>>,
  projectKey: string,
  branch: string,
): {
  readonly envBlob: string;
  readonly pushedVars: Readonly<Record<string, { readonly resource_id: string; readonly value_hash: string }>>;
} {
  const entries = Object.entries(finalEnv).map(([name, value]) => {
    const resourceId = deriveResourceId(branch, name);
    return {
      name,
      encrypted: `capy:${resourceId}:${Encryptor.encrypt(value, projectKey)}`,
      pushed: {
        resource_id: resourceId,
        value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
      },
    };
  });
  return {
    envBlob: entries.map(({ name, encrypted }) => `${name}=${encrypted}`).join('\n'),
    pushedVars: Object.fromEntries(entries.map(({ name, pushed }) => [name, pushed])),
  };
}

function replaceOriginalBranchSnapshot(
  merged: KeepFile,
  original: KeepFile,
  finalVariableNames: ReadonlySet<string>,
  branch: string,
): KeepFile {
  const variables = Object.fromEntries(
    Object.entries(merged.variables).flatMap(([name, entries]) => {
      const existedInOriginal = original.variables[name]?.some((entry) => entry.branch === branch) ?? false;
      const nextEntries = existedInOriginal && !finalVariableNames.has(name)
        ? entries.filter((entry) => entry.branch !== branch)
        : entries;
      return nextEntries.length > 0 ? [[name, nextEntries] as const] : [];
    }),
  );
  return { ...merged, variables };
}

/**
 * The one authoritative encrypted-snapshot write path used by connector
 * writes and manifest-less explicit push: merge/prune, CAS retry, cache,
 * local encrypted state, and sync-state bookkeeping stay in one corpus.
 */
export async function syncResolvedSnapshot(
  ctx: ResolvedContext,
  finalEnv: Readonly<Record<string, string>>,
  opts: SyncResolvedSnapshotOptions,
): Promise<void> {
  const built = encryptSnapshot(finalEnv, ctx.projectKey, ctx.branch);
  const finalVariableNames = new Set(Object.keys(finalEnv));
  const syncEngine = new SyncEngine();
  const buildFinalKeep = (base: KeepFile): KeepFile => {
    const merged = replaceOriginalBranchSnapshot(
      syncEngine.mergeWithKeep(base, built.pushedVars, ctx.branch),
      ctx.keep,
      finalVariableNames,
      ctx.branch,
    );
    return applyConnectors(
      merged,
      ctx.branch,
      opts.connector?.varName ?? '',
      opts.connector?.metadata,
      opts.alsoConnect,
    );
  };

  const pushed = await pushKeepWithRetry({
    serviceClient: ctx.serviceClient,
    projectId: ctx.projectId,
    branch: ctx.branch,
    baseKeep: ctx.keep,
    baseHash: ctx.base_keep_hash,
    buildEnvBlob: (extraLines) => extraLines.length > 0
      ? [built.envBlob, ...extraLines].filter((line) => line.length > 0).join('\n')
      : built.envBlob,
    localVarNames: Object.keys(finalEnv),
    buildFinalKeep,
    primaryVarNames: [...opts.primaryVarNames],
    confirmOverwrite: opts.confirmOverwrite,
    beforePush: opts.beforePush,
    maxRetries: opts.maxRetries,
  });

  await opts.beforePush?.();
  (opts.cacheRemote ?? writeKeepCache)(ctx.orgId, ctx.projectId, pushed.keep_hash, pushed.envBlob);
  const adoptedKeep = SyncEngine.adoptServerKeep(pushed.keep_file, pushed.finalKeep, ctx.branch);
  if (!ctx.lockless) ctx.fileManager.writeKeepFile(adoptedKeep);
  opts.beforeLocalWrite?.();
  ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, adoptedKeep, ctx.branch);

  const existingSyncState = ctx.pm.readSyncState();
  ctx.fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: ctx.userId,
    ...(ctx.lockless ? {
      org_id: ctx.orgId,
      project_id: ctx.projectId,
      project_name: ctx.keep.project_name,
      sync_mode: 'free' as const,
    } : {}),
    keep_hash: setSyncKeepHash(existingSyncState, ctx.branch, pushed.keep_hash),
  });

  if (!ctx.lockless) {
    const { autoCommitKeep } = await import('../../git/autoCommitKeep');
    if (opts.reportStatus) autoCommitKeep(ctx.branch, undefined, opts.reportStatus);
    else autoCommitKeep(ctx.branch);
  }
}

/** The (varName, branch) entry, or undefined when the variable has no entry on this branch. */
export function keepEntryFor(keep: KeepFile, varName: string, branch: string) {
  return keep.variables[varName]?.find((e) => e.branch === branch);
}

/**
 * Human-readable one-liner for a connector-managed key — `"stripe (test)"`,
 * or just `"stripe"` when the connector has no mode. No account_id: that's
 * shown elsewhere already redacted, and a conflict gate only needs "which
 * service is this," not the account.
 */
export function describeConnector(connector: ConnectorMetadata): string {
  return connector.mode ? `${connector.provider} (${connector.mode})` : connector.provider;
}

/**
 * The same-key CAS conflict confirm question — one sentence, asked
 * identically everywhere a caller hits it (`addCommand`, `editCommand`,
 * `pushCommand`), so there is exactly one wording to keep in sync rather than
 * three copies that can drift.
 */
export function conflictOverwriteQuestion(varNames: string[]): string {
  return `${varNames.join(', ')} changed on the server while you were editing. Overwrite?`;
}

/**
 * Context lines for an overwrite/conflict gate — one per `varName` that has
 * something worth saying: connector metadata and/or when it was last written
 * (`changed_at`, server-stamped). Printed ABOVE the existing confirm
 * question, never folded into it — `overwriteNotice()`'s and
 * `conflictOverwriteQuestion()`'s own return values are tested/relied-on
 * verbatim and must stay byte-identical. A key with neither produces no
 * line — an ordinary unmanaged variable someone is about to overwrite says
 * nothing new.
 */
export function conflictContextLines(keep: KeepFile, varNames: string[], branch: string): string[] {
  return varNames.flatMap((varName) => {
    const entry = keepEntryFor(keep, varName, branch);
    if (!entry) return [];
    const parts = [
      ...(entry.connector ? [describeConnector(entry.connector)] : []),
      ...(entry.changed_at ? [`last written ${formatRelativeTime(entry.changed_at)}`] : []),
    ];
    return parts.length > 0 ? [`  ${B(varName)} — ${parts.join(', ')}`] : [];
  });
}

/**
 * Cheap "does this look like a team project" probe for `maybeWarnPersonalEnv`
 * below: inside a git work tree with at least one remote configured. Mirrors
 * `autoCommitKeep`'s own `git rev-parse --is-inside-work-tree` pattern —
 * never throws, folds any git failure (not a repo, git missing) into `false`.
 */
function hasGitRemote(cwd: string): boolean {
  try {
    const inRepo = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim() === 'true';
    if (!inRepo) return false;
    const remotes = execFileSync('git', ['remote'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    return remotes.length > 0;
  } catch {
    return false;
  }
}

/** Immutable caller-owned state for a command/context's personal-env note. */
export interface PersonalEnvWarningState {
  readonly emitted: boolean;
}

export function initialPersonalEnvWarningState(): PersonalEnvWarningState {
  return { emitted: false };
}

/**
 * Soft, non-blocking heads-up — never a prompt, never blocks the write — for
 * the FIRST lock-less write in a directory that git recognizes as a team
 * project (a repo with at least one remote) whose `.env` has no capy
 * identity header yet (`ctx.identitySource === 'server'`: see the field's own
 * doc comment on `ResolvedContext`). Once a write lands, `writeEncryptedEnvFile`
 * puts the header in place, so the very next command's `ctx.identitySource`
 * reads `'header'` and this stays silent from then on. Within a command,
 * callers thread the returned immutable state through repeated writes.
 */
export function maybeWarnPersonalEnv(
  ctx: ResolvedContext,
  state: PersonalEnvWarningState = initialPersonalEnvWarningState(),
  cwd: string = process.cwd(),
): PersonalEnvWarningState {
  if (state.emitted || !ctx.lockless || ctx.identitySource !== 'server') return state;
  const persistedIdentity = ctx.fileManager.readEnvMeta();
  if (persistedIdentity.org_id && persistedIdentity.project_id) return state;
  if (!hasGitRemote(cwd)) return state;
  console.error('Heads up: this saves to your personal env, not a team project.');
  return { emitted: true };
}

/**
 * Did `varName`'s entry on `branch` change between `baseKeep` (what the
 * write was based on) and `serverKeep` (what a 409's response just reported
 * as current)? Appearing, disappearing, or a different resource_id/value_hash
 * all count — anything that means "someone else's write already landed on
 * exactly the key this call is about to write."
 */
function keepEntryChanged(baseKeep: KeepFile, serverKeep: KeepFile, varName: string, branch: string): boolean {
  const before = keepEntryFor(baseKeep, varName, branch);
  const after = keepEntryFor(serverKeep, varName, branch);
  if (!before && !after) return false;
  if (!before || !after) return true;
  return before.resource_id !== after.resource_id || before.value_hash !== after.value_hash;
}

export interface PushKeepWithRetryOpts {
  serviceClient: ServiceClient;
  projectId: string;
  branch: string;
  /** The keep this write started from — the baseline `primaryVarNames` are compared against on a conflict. */
  baseKeep: KeepFile;
  /** CAS precondition for the first attempt. `undefined` omits `base_keep_hash` (legacy/unknown-base push). */
  baseHash: string | undefined;
  /**
   * Build the env blob to push, given extra ciphertext LINES (already
   * `KEY=capy:resourceId:...` formatted) for keys a rebase pulled into the
   * keep that this call never had a value for. Called once up front with an
   * empty array — which MUST return exactly the same content a caller would
   * have sent before this hook existed, so the no-conflict path stays
   * byte-for-byte unchanged — and again after every rebase that introduces a
   * "foreign" key (see `localVarNames`).
   */
  buildEnvBlob: (extraLines: string[]) => string;
  /**
   * Every key `buildEnvBlob`'s own content already covers. A key that ends
   * up in the rebased keep but is NOT in this set is a concurrent write this
   * call knows nothing about — its ciphertext line has to be pulled from the
   * server's blob for the rebased `keep_hash`, or the pushed keep and the
   * pushed blob would disagree about which keys exist on this branch.
   */
  localVarNames: string[];
  /** Rebuild the keep to push (merge + prune + any per-caller extras) from a given base — called once up front and again after every rebase. */
  buildFinalKeep: (base: KeepFile) => KeepFile;
  /** The variable name(s) this write is the author of — same-key conflict detection runs only against these. */
  primaryVarNames: string[];
  /** See `writeAndSync`'s `confirmOverwrite` — same contract, just plural. */
  confirmOverwrite?: (varNames: string[], contextLines: string[]) => Promise<boolean>;
  /**
   * Reviewed callers re-check their local target immediately before each
   * request. This keeps a stale review from being applied after the
   * repository or keep metadata changes while key/network work is pending.
   */
  beforePush?: () => Promise<void> | void;
  maxRetries?: number;
}

/**
 * Push a keep.lock with optimistic-concurrency (CAS) retry.
 *
 * On a 409 STALE_KEEP_HASH, the server's current keep_file is folded in as
 * the new base (`SyncEngine.spliceKeepBranch`, so only THIS branch's entries
 * move — same rule the sync path already uses to avoid one branch's push
 * clobbering another's pins) and the write is rebuilt and retried against the
 * server's `keep_hash`. A concurrent change to a DIFFERENT key is merged in
 * silently — that's the whole point of a CAS retry. A concurrent change to
 * one of `primaryVarNames` — the key(s) THIS call is actually writing — is
 * different: without `confirmOverwrite` (or with one that declines), the
 * write refuses rather than silently clobbering someone else's newer value,
 * and throws a coded STALE_KEEP_HASH so the caller can surface it.
 *
 * A rebase can pull a "foreign" key into the keep this call is about to push
 * — one the caller's own `localVarNames` never covered. Left alone, the push
 * would carry that key's KEEP entry (metadata: resource_id/value_hash) but
 * not its ENV BLOB line (ciphertext) — the two are supposed to describe the
 * same content, and a push that lists a key with no value for it corrupts
 * the branch's stored snapshot for every reader from that point on. Before
 * retrying, this fetches the server's blob at the rebased `keep_hash`
 * (`ServiceClient.getSecrets`) and carries the foreign keys' ciphertext
 * lines forward verbatim — never re-encrypted, since the resource_id and the
 * ciphertext are the server's, not this call's, to mint.
 *
 * Retries are capped (default 3): a server that keeps saying stale no matter
 * how many times this rebases is a loop, not a resolvable conflict.
 */
export async function pushKeepWithRetry(
  opts: PushKeepWithRetryOpts,
): Promise<{ keep_hash: string; keep_file?: string; finalKeep: KeepFile; envBlob: string }> {
  const maxRetries = opts.maxRetries ?? 3;
  const fileManager = new FileManager();
  const knownKeys = new Set(opts.localVarNames);
  const attemptPush = async (state: {
    readonly baseKeep: KeepFile;
    readonly baseHash: string | undefined;
    readonly extraLines: readonly string[];
    readonly attempt: number;
  }): Promise<{ keep_hash: string; keep_file?: string; finalKeep: KeepFile; envBlob: string }> => {
    const finalKeep = opts.buildFinalKeep(state.baseKeep);
    const envBlob = opts.buildEnvBlob([...state.extraLines]);
    try {
      await opts.beforePush?.();
      const result = await opts.serviceClient.pushSecrets(
        opts.projectId,
        JSON.stringify(finalKeep),
        envBlob,
        opts.branch,
        state.baseHash,
      );
      return { ...result, finalKeep, envBlob };
    } catch (err) {
      if (!(err instanceof CapyError) || err.code !== ERROR_CODES.STALE_KEEP_HASH) throw err;
      if (state.attempt >= maxRetries) {
        throw new CapyError(
          'Too many conflicting pushes to Keep — someone else keeps changing this branch faster than this write can land. Re-run to try again.',
          ERROR_CODES.STALE_KEEP_HASH,
          err.details,
        );
      }

      const serverKeepJson = err.details?.keep_file as string | undefined;
      const serverKeepHash = err.details?.keep_hash as string | undefined;
      const serverKeep: KeepFile = serverKeepJson
        ? JSON.parse(serverKeepJson)
        : { ...state.baseKeep, variables: {} };

      const conflicted = opts.primaryVarNames.filter((name) =>
        keepEntryChanged(state.baseKeep, serverKeep, name, opts.branch),
      );
      if (conflicted.length > 0) {
        // The server's own copy — not `baseKeep` — is the freshest source for
        // the confirm's context lines (connector metadata, changed_at): it's
        // exactly the state the conflict was just detected against.
        const contextLines = opts.confirmOverwrite ? conflictContextLines(serverKeep, conflicted, opts.branch) : [];
        const proceed = opts.confirmOverwrite ? await opts.confirmOverwrite(conflicted, contextLines) : false;
        if (!proceed) {
          throw new CapyError(
            `${conflicted.join(', ')} changed on the server while you were editing. Aborted.`,
            ERROR_CODES.STALE_KEEP_HASH,
            err.details,
          );
        }
      }

      const extraLineKeys = new Set(
        state.extraLines.map((line) => line.slice(0, Math.max(0, line.indexOf('=')))),
      );
      const foreignKeys = Object.keys(serverKeep.variables).filter(
        (name) =>
          !knownKeys.has(name) &&
          !extraLineKeys.has(name) &&
          serverKeep.variables[name].some((entry) => entry.branch === opts.branch),
      );
      const newExtraLines = serverKeepHash && foreignKeys.length > 0
        ? await opts.serviceClient.getSecrets(opts.projectId, serverKeepHash).then((serverBlob) => {
            if (!serverBlob?.env_file) return [];
            const parsed = fileManager.parseEnvContent(serverBlob.env_file);
            return foreignKeys.flatMap((key) => key in parsed ? [`${key}=${parsed[key]}`] : []);
          })
        : [];

      return attemptPush({
        baseKeep: SyncEngine.spliceKeepBranch(state.baseKeep, serverKeep, opts.branch),
        baseHash: serverKeepHash,
        extraLines: [...state.extraLines, ...newExtraLines],
        attempt: state.attempt + 1,
      });
    }
  };

  return attemptPush({ baseKeep: opts.baseKeep, baseHash: opts.baseHash, extraLines: [], attempt: 0 });
}

/**
 * Attach the primary connector and any extras in one pass.
 *
 * Returns `keep` unchanged when there is nothing to attach, so the local-only
 * path can skip rewriting keep.lock exactly as it did before.
 */
function applyConnectors(
  keep: KeepFile,
  branch: string,
  varName: string,
  connector: ConnectorMetadata | undefined,
  also: ReadonlyArray<{ varName: string; entry: ConnectorMetadata }> | undefined,
): KeepFile {
  const withPrimary = connector ? attachConnector(keep, varName, branch, connector) : keep;
  return (also ?? []).reduce(
    (acc, extra) => attachConnector(acc, extra.varName, branch, extra.entry),
    withPrimary,
  );
}

/** Return a deep-cloned KeepFile with `connector` set on the (varName, branch) entry. */
export function attachConnector(
  keep: KeepFile,
  varName: string,
  branch: string,
  connector: ConnectorMetadata,
): KeepFile {
  const existing = keep.variables[varName]?.map((entry) => ({ ...entry })) ?? [];
  const hasBranchEntry = existing.some((entry) => entry.branch === branch);
  const entries = hasBranchEntry
    ? existing.map((entry) => entry.branch === branch ? { ...entry, connector } : entry)
    : [...existing, { resource_id: '', branch, value_hash: '', connector }];
  return {
    ...keep,
    variables: { ...keep.variables, [varName]: entries },
  };
}

/**
 * Look up the connector metadata for (varName, branch). Returns undefined if
 * the var isn't tracked or has no connector field on that branch.
 */
export function findManagedConnector(
  keep: KeepFile,
  varName: string,
  branch: string,
): ConnectorMetadata | undefined {
  const entries = keep.variables[varName];
  if (!entries) return undefined;
  return entries.find((e) => e.branch === branch)?.connector;
}

/** All variables on `branch` that have a connector field set. */
export function listManagedKeys(
  keep: KeepFile,
  branch: string,
): Array<{ varName: string; connector: ConnectorMetadata }> {
  return Object.entries(keep.variables).flatMap(([varName, entries]) => {
    const connector = entries.find((entry) => entry.branch === branch)?.connector;
    return connector ? [{ varName, connector }] : [];
  });
}

/** All variables with an entry on `branch`, sorted. Both managed and unmanaged. */
export function listAllVarsOnBranch(keep: KeepFile, branch: string): string[] {
  return Object.entries(keep.variables)
    .filter(([, entries]) => entries.some((entry) => entry.branch === branch))
    .map(([varName]) => varName)
    .reduce<string[]>((ordered, value) => {
      const insertionIndex = ordered.findIndex((candidate) => candidate.localeCompare(value) > 0);
      return insertionIndex < 0
        ? [...ordered, value]
        : [...ordered.slice(0, insertionIndex), value, ...ordered.slice(insertionIndex)];
    }, []);
}

/** `abc…xyz`-style snippet of a credential value; never plaintext. */
export function fingerprint(value: string): string {
  if (value.length <= 7) return value;
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/**
 * `rk_live_` — the first eight characters of a key, for a browser payload, and
 * ONLY when there is more of the value than that.
 *
 * The terminal prints `value.slice(0, 8)` as "Key type" and can go on doing
 * so: it is showing eight characters to the person whose key it is, on a
 * screen they are already looking at. A payload is a different thing. Eight
 * characters of a forty-character key is a redaction; eight characters of an
 * eight-character value is the value, and the difference is a length check
 * nobody performs by eye.
 *
 * The same rule `fingerprint()` above needs and does not have — it returns
 * anything seven characters or shorter VERBATIM — which is why the browser
 * paths wrap it rather than calling it directly. Undefined means "say
 * nothing": every screen renders the absence, and none of them renders a
 * short secret.
 */
export function keyTypePrefix(value: string): string | undefined {
  return value.length > 8 ? value.slice(0, 8) : undefined;
}

export interface ExpiringKey {
  varName: string;
  provider: string;
  expiresIn: number; // days, can be negative if already expired
  connector: ConnectorMetadata;
}

/**
 * Walk keep.lock for managed keys on the active branch whose `expires_at`
 * is within `windowDays`. Silent on any failure (missing/corrupt keep.lock,
 * read errors, etc.) so this never blocks a primary command at its tail.
 */
export function checkExpiringKeys(windowDays: number = 7): ExpiringKey[] {
  try {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    if (!keep) return [];
    const branch = pm.deriveActiveBranch();
    if (!branch) return [];
    const managed = listManagedKeys(keep, branch);
    const now = Date.now() / 1000;
    const windowSec = windowDays * 86400;
    return managed.flatMap(({ varName, connector }) => {
      if (typeof connector.expires_at !== 'number') return [];
      const remainingSec = connector.expires_at - now;
      return remainingSec > windowSec
        ? []
        : [{
            varName,
            provider: connector.provider,
            expiresIn: Math.floor(remainingSec / 86400),
            connector,
          }];
    });
  } catch {
    return [];
  }
}

/** Print expiry warnings to stderr. Safe to call from any command's tail. */
export function printExpiryWarnings(): void {
  const expiring = checkExpiringKeys();
  if (expiring.length === 0) return;
  for (const k of expiring) {
    const when = k.expiresIn < 0
      ? `expired ${-k.expiresIn} day(s) ago`
      : k.expiresIn === 0
        ? 'expires today'
        : `expires in ${k.expiresIn} day(s)`;
    console.error(
      `\x1b[33m⚠\x1b[0m ${B(k.varName)} ${when}. Run ${B(`capy rotate ${k.varName}`)} to refresh.`,
    );
  }
}
