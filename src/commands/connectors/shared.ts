import { commandExit, currentInteraction, InteractionCommandError } from '../../ui/interaction';
import { humanError } from '../../ui/webMode';
import { createHash } from 'crypto';
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
import { assertSupportedKeepMode } from '../../sync/legacyKeepMode';
import {
  setSyncKeepHash,
  getSyncKeepHash,
  KeepFile,
  ConnectorMetadata,
  CapyError,
  ERROR_CODES,
} from '../../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

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
  /** Compatibility field while command callers converge; initialized Keep is always lock-full. */
  readonly lockless: false;
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
  /** Whether the authoritative remote keep marker existed when this context was resolved. */
  remoteKeepExists: boolean;
}

type ContextAuthResult = Awaited<ReturnType<AuthService['authenticateSilent']>>;

async function authenticateContext(authService: AuthService, orgId?: string): Promise<ContextAuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success) return scopedSilent;
  const unscopedSilent = await authService.authenticateSilent();
  if (unscopedSilent.success) return unscopedSilent;
  if (currentInteraction()) throw new InteractionCommandError('ROTATE_CAPY_AUTH_REQUIRED', 'Capy authentication is required. Restore this device pairing, then retry.');
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
  readonly authService?: AuthService;
  readonly serviceClient?: ServiceClient;
  readonly authResult?: ContextAuthResult;
  /** Fail directly instead of displaying a browser error surface. */
  readonly nonInteractive?: boolean;
}

export async function resolveContext(opts: ResolveContextOptions = {}): Promise<ResolvedContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
    assertSupportedKeepMode(pm.readSyncState());
    throw new CapyError('No keep.lock found in this directory.', ERROR_CODES.NO_KEEP_FILE);
  }
  const orgId = projectState.organizationId;
  const projectId = projectState.projectId;
  const branch = projectState.activeBranch;
  if (!branch) {
    humanError(`No active branch. Run ${B('capy')} to select a branch.`);
    commandExit(1);
  }

  const keep = pm.readKeepFile();
  if (!keep) {
    humanError('Could not read keep.lock');
    commandExit(1);
  }

  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;
  const authService = new AuthService(opts.apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(opts.apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const authResult = await authenticateContext(authService, orgId);
  if (!authResult.success || !authResult.user_id) {
    humanError('Authentication failed');
    commandExit(1);
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
): Promise<void> {
  const finalEnv = value === undefined
    ? { ...ctx.localPlaintext }
    : { ...ctx.localPlaintext, [varName]: value };

  if (!opts.push) {
    if (opts.connector || opts.alsoConnect) {
      const merged = applyConnectors(ctx.keep, ctx.branch, varName, opts.connector, opts.alsoConnect);
      ctx.fileManager.writeKeepFile(merged);
      ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, merged, ctx.branch);
    } else {
      ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, ctx.keep, ctx.branch);
    }
    return;
  }

  await syncResolvedSnapshot(ctx, finalEnv, {
    primaryVarNames: [varName],
    connector: opts.connector ? { varName, metadata: opts.connector } : undefined,
    alsoConnect: opts.alsoConnect,
    confirmOverwrite: opts.confirmOverwrite,
  });
  return;
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
  ctx.fileManager.writeKeepFile(adoptedKeep);
  opts.beforeLocalWrite?.();
  ctx.fileManager.writeEncryptedEnvFile(finalEnv, ctx.projectKey, undefined, adoptedKeep, ctx.branch);

  const existingSyncState = ctx.pm.readSyncState();
  ctx.fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: ctx.userId,
    keep_hash: setSyncKeepHash(existingSyncState, ctx.branch, pushed.keep_hash),
  });

  const { autoCommitKeep } = await import('../../git/autoCommitKeep');
  if (opts.reportStatus) autoCommitKeep(ctx.branch, undefined, opts.reportStatus);
  else autoCommitKeep(ctx.branch);
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
    humanError(
      `\x1b[33m⚠\x1b[0m ${B(k.varName)} ${when}. Run ${B(`capy rotate ${k.varName}`)} to refresh.`,
    );
  }
}
