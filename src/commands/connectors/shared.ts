import { createHash } from 'crypto';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { AuthService } from '../../auth/authService';
import { ServiceClient } from '../../service/serviceClient';
import { SyncEngine } from '../../sync/syncEngine';
import { Encryptor } from '../../crypto/encryptor';
import { deriveResourceId } from '../../crypto/resourceId';
import { writeKeepCache } from '../../config/globalConfig';
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
   * True when this directory has no keep.lock — CAP-304 single-user
   * "lock-less" mode. The server's latest/keep.json for org/project/branch is
   * the only source of truth; `writeAndSync` never writes keep.lock or
   * auto-commits it in this mode.
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
}

/**
 * Run the standard "I'm an interactive command that needs to encrypt + push"
 * setup. Mirrors the front half of editCommand.ts. Exits the process on
 * unrecoverable errors (no keep.lock, auth fail, key resolution fail).
 */
export async function resolveContext(opts: { apiUrl?: string; devMode?: boolean } = {}): Promise<ResolvedContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  // No keep.lock: CAP-304 lock-less mode against the user's personal
  // ("default") project, rather than the old hard exit. A dir WITH
  // keep.lock keeps every line below byte-for-byte unchanged.
  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
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

  let authResult = await authService.authenticateSilent(orgId);
  if (!authResult.success) authResult = await authService.authenticateSilent();
  if (!authResult.success) authResult = await authService.authenticate(orgId);
  if (!authResult.success || !authResult.user_id) {
    console.error('Authentication failed');
    process.exit(1);
  }

  const { resolveProjectKey } = await import('../../crypto/keyResolver');
  let projectKey: string;
  try {
    projectKey = await resolveProjectKey(orgId, projectId, authResult.user_id, {
      coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    });
  } catch (err: any) {
    const { displayErrorAndExit } = await import('../../ui/errorScreen');
    await displayErrorAndExit(err, {
      projectName: keep.project_name,
      projectId: keep.project_id,
      branch,
    });
    throw err;
  }

  const localPlaintext: Record<string, string> = {};
  const rawLocal = fileManager.readEnvFile();
  for (const [k, v] of Object.entries(rawLocal)) {
    if (v.startsWith('capy:')) {
      try {
        localPlaintext[k] = fileManager.decryptValue(v, projectKey);
      } catch {
        // skip undecryptable
      }
    } else {
      localPlaintext[k] = v;
    }
  }

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
    // sync-state's per-branch keep_hash when this machine has one recorded
    // (it does after any prior push or pull on this branch); `undefined` on
    // a keep.lock that was hand-created or predates keep_hash tracking —
    // pushSecrets omits base_keep_hash entirely rather than guess.
    base_keep_hash: getSyncKeepHash(pm.readSyncState(), branch),
  };
}

/**
 * CAP-304: identity + secrets resolution for a directory with no keep.lock —
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
 * Branch: `ProjectManager.deriveActiveBranch()` (which itself already checks
 * the `.env` header, `.capy/branch`, and single-branch fallbacks) or, when
 * none of those yield anything, `'development'` — lock-less mode is the ONE
 * caller allowed to default a branch rather than fail NO_ACTIVE_BRANCH; the
 * lock-full path above is untouched.
 */
async function resolveLocklessContext(
  pm: ProjectManager,
  opts: { apiUrl?: string; devMode?: boolean },
): Promise<ResolvedContext> {
  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;

  const envMeta = fileManager.readEnvMeta();
  let orgId = envMeta.org_id;
  let projectId = envMeta.project_id;
  // Used only to synthesize an empty KeepFile's project_name below, when
  // nothing has ever been pushed to this branch — a KeepFile fetched from the
  // server always carries the project's real name instead. Lock-less mode
  // always targets the org's project literally named "default" (the
  // identity-resolution contract above), so that's the safe assumption here
  // even when identity came from the `.env` header rather than listProjects.
  let projectName = 'default';

  const authService = new AuthService(opts.apiUrl, devMode, pm.readSyncState()?.user_id);
  const serviceClient = new ServiceClient(opts.apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  let authResult = await authService.authenticateSilent(orgId);
  if (!authResult.success) authResult = await authService.authenticateSilent();
  if (!authResult.success) authResult = await authService.authenticate(orgId);
  if (!authResult.success || !authResult.user_id) {
    console.error('Authentication failed');
    process.exit(1);
  }
  const userId = authResult.user_id;

  if (!orgId || !projectId) {
    orgId = authResult.organization_id;
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
    projectId = defaultProject.id;
    projectName = defaultProject.name;
  }

  const branch = pm.deriveActiveBranch() || SyncEngine.DEFAULT_BRANCH;

  const { resolveProjectKey } = await import('../../crypto/keyResolver');
  let projectKey: string;
  try {
    projectKey = await resolveProjectKey(orgId, projectId, userId, {
      coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    });
  } catch (err: any) {
    const { displayErrorAndExit } = await import('../../ui/errorScreen');
    await displayErrorAndExit(err, { projectName, projectId, branch });
    throw err;
  }

  // Latest state from the server for this branch — the lock-less source of
  // truth. `keepHash` omitted is the CLI's existing "give me latest"
  // contract (GET /secrets/:id?branch=… with no keep_hash), which already
  // returns `keep_hash` + `keep_file` and already swallows a "nothing pushed
  // yet" 404 (NO_SECRETS) into an empty result — see getDecryptData's own
  // doc comment for the PROJECT_NOT_FOUND/BRANCH_NOT_FOUND propagation rule.
  const decryptResult = await serviceClient.getDecryptData(projectId, branch);
  let keep: KeepFile;
  let baseKeepHash: string;
  if (decryptResult.keep_file) {
    keep = JSON.parse(decryptResult.keep_file);
    baseKeepHash = decryptResult.keep_hash ?? SyncEngine.computeKeepHash(keep, branch);
  } else {
    // Nothing pushed to this branch yet — synthesize an in-memory KeepFile so
    // every downstream caller (writeAndSync, add/edit/list) sees the same
    // shape it would after a lock-full `capy` bootstrap.
    keep = { version: '3.0', org_id: orgId, project_id: projectId, project_name: projectName, variables: {} };
    baseKeepHash = EMPTY_KEEP_HASH;
  }

  const localPlaintext: Record<string, string> = {};
  const rawLocal = fileManager.readEnvFile();
  for (const [k, v] of Object.entries(rawLocal)) {
    if (v.startsWith('capy:')) {
      try {
        localPlaintext[k] = fileManager.decryptValue(v, projectKey);
      } catch {
        // skip undecryptable
      }
    } else {
      localPlaintext[k] = v;
    }
  }

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
     * genuine edit-time conflict, not an unrelated concurrent push. Return
     * `true` to overwrite the server's value with this write anyway. Omitted
     * (or returning `false`) refuses and throws a coded STALE_KEEP_HASH
     * error — the safe default for a non-interactive caller. See
     * `addCommand.ts`'s `overwriteNotice` for the terminal wording this
     * mirrors.
     */
    confirmOverwrite?: (varNames: string[]) => Promise<boolean>;
  },
): Promise<void> {
  const { pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey, keep, localPlaintext, lockless } = ctx;

  const finalEnv: Record<string, string> =
    value === undefined ? { ...localPlaintext } : { ...localPlaintext, [varName]: value };

  if (!opts.push) {
    // Local-only path. Even though we're not hitting the service, we still
    // need to attach the connector marker to keep.lock so a follow-up `capy
    // push` (which will round-trip through mergeWithKeep) preserves it. In
    // lock-less mode there is no keep.lock to write — the connector-attached
    // keep is still handed to writeEncryptedEnvFile so the `.env` identity
    // header stays correct, but nothing lands on disk as keep.lock.
    if (opts.connector) {
      const merged = attachConnector(keep, varName, branch, opts.connector);
      if (!lockless) fileManager.writeKeepFile(merged);
      fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    } else {
      fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, keep, branch);
    }
    return;
  }

  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(finalEnv)) {
    const resourceId = deriveResourceId(branch, k);
    encrypted[k] = `capy:${resourceId}:${Encryptor.encrypt(v, projectKey)}`;
  }
  const envBlob = Object.entries(encrypted)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
  for (const [k, v] of Object.entries(finalEnv)) {
    pushedVars[k] = {
      resource_id: deriveResourceId(branch, k),
      value_hash: createHash('sha256').update(v).digest('hex').slice(0, 16),
    };
  }

  const syncEngine = new SyncEngine();
  // The keep this write started from, captured once — NOT `base`, which a CAS
  // retry below replaces with a rebase onto the server's current state. The
  // prune step needs to know what THIS machine's local basis actually was:
  // a var missing from `finalEnv` that this basis never had either is
  // someone else's concurrent addition (visible only because a retry rebased
  // onto it), not something the local user deleted, and must survive.
  // Conflating the two would make a same-branch CAS retry a data-loss bug —
  // exactly the "silently re-merge, don't clobber" contract this function
  // exists to uphold.
  const originalKeep = keep;
  const buildFinalKeep = (base: KeepFile): KeepFile => {
    let fk = syncEngine.mergeWithKeep(base, pushedVars, branch);
    for (const name of Object.keys(fk.variables)) {
      if (name in finalEnv) continue;
      const wasInLocalBasis = originalKeep.variables[name]?.some((e) => e.branch === branch);
      if (!wasInLocalBasis) continue;
      const entries = fk.variables[name].filter((e) => e.branch !== branch);
      if (entries.length > 0) fk.variables[name] = entries;
      else delete fk.variables[name];
    }
    if (opts.connector) {
      fk = attachConnector(fk, varName, branch, opts.connector);
    }
    return fk;
  };

  const { keep_hash, keep_file, finalKeep } = await pushKeepWithRetry({
    serviceClient,
    projectId,
    branch,
    baseKeep: keep,
    baseHash: ctx.base_keep_hash,
    envBlob,
    buildFinalKeep,
    primaryVarNames: [varName],
    confirmOverwrite: opts.confirmOverwrite,
  });

  writeKeepCache(orgId, projectId, keep_hash, envBlob);
  // Prefer the server's copy — it carries server-assigned changed_at. Never
  // written in lock-less mode: there is no keep.lock file for this directory.
  if (!lockless) {
    fileManager.writeKeepFile(SyncEngine.adoptServerKeep(keep_file, finalKeep, branch));
  }
  fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

  const existingSyncState = pm.readSyncState();
  fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: userId,
    keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
  });

  // The new pin reaches teammates only through git — and in lock-less mode
  // there is no keep.lock to commit; the server IS the pin.
  if (!lockless) {
    const { autoCommitKeep } = await import('../../git/autoCommitKeep');
    autoCommitKeep(branch);
  }
}

/** The (varName, branch) entry, or undefined when the variable has no entry on this branch. */
function keepEntryFor(keep: KeepFile, varName: string, branch: string) {
  return keep.variables[varName]?.find((e) => e.branch === branch);
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
  /** Pre-encrypted env blob to push — independent of which keep base is currently in play, so it's built once. */
  envBlob: string;
  /** Rebuild the keep to push (merge + prune + any per-caller extras) from a given base — called once up front and again after every rebase. */
  buildFinalKeep: (base: KeepFile) => KeepFile;
  /** The variable name(s) this write is the author of — same-key conflict detection runs only against these. */
  primaryVarNames: string[];
  /** See `writeAndSync`'s `confirmOverwrite` — same contract, just plural. */
  confirmOverwrite?: (varNames: string[]) => Promise<boolean>;
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
 * Retries are capped (default 3): a server that keeps saying stale no matter
 * how many times this rebases is a loop, not a resolvable conflict.
 */
export async function pushKeepWithRetry(
  opts: PushKeepWithRetryOpts,
): Promise<{ keep_hash: string; keep_file?: string; finalKeep: KeepFile }> {
  const maxRetries = opts.maxRetries ?? 3;
  let baseKeep = opts.baseKeep;
  let baseHash = opts.baseHash;
  let finalKeep = opts.buildFinalKeep(baseKeep);
  let attempt = 0;

  for (;;) {
    try {
      const result = await opts.serviceClient.pushSecrets(
        opts.projectId,
        JSON.stringify(finalKeep),
        opts.envBlob,
        opts.branch,
        baseHash,
      );
      return { ...result, finalKeep };
    } catch (err) {
      if (!(err instanceof CapyError) || err.code !== ERROR_CODES.STALE_KEEP_HASH) throw err;

      attempt++;
      if (attempt > maxRetries) {
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
        : { ...baseKeep, variables: {} };

      const conflicted = opts.primaryVarNames.filter((name) =>
        keepEntryChanged(baseKeep, serverKeep, name, opts.branch),
      );
      if (conflicted.length > 0) {
        const proceed = opts.confirmOverwrite ? await opts.confirmOverwrite(conflicted) : false;
        if (!proceed) {
          throw new CapyError(
            `${conflicted.join(', ')} changed on the server while you were editing. Aborted.`,
            ERROR_CODES.STALE_KEEP_HASH,
            err.details,
          );
        }
      }

      baseKeep = SyncEngine.spliceKeepBranch(baseKeep, serverKeep, opts.branch);
      baseHash = serverKeepHash;
      finalKeep = opts.buildFinalKeep(baseKeep);
    }
  }
}

/** Return a deep-cloned KeepFile with `connector` set on the (varName, branch) entry. */
export function attachConnector(
  keep: KeepFile,
  varName: string,
  branch: string,
  connector: ConnectorMetadata,
): KeepFile {
  const next: KeepFile = { ...keep, variables: { ...keep.variables } };
  const existing = next.variables[varName] ? next.variables[varName].map((e) => ({ ...e })) : [];
  const idx = existing.findIndex((e) => e.branch === branch);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], connector };
  } else {
    // No entry on this branch yet (writeAndSync hasn't pushed). Defer to the
    // next merge — but seed an entry so subsequent reads see the connector.
    existing.push({ resource_id: '', branch, value_hash: '', connector });
  }
  next.variables[varName] = existing;
  return next;
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
  const out: Array<{ varName: string; connector: ConnectorMetadata }> = [];
  for (const [varName, entries] of Object.entries(keep.variables)) {
    const entry = entries.find((e) => e.branch === branch);
    if (entry?.connector) out.push({ varName, connector: entry.connector });
  }
  return out;
}

/** All variables with an entry on `branch`, sorted. Both managed and unmanaged. */
export function listAllVarsOnBranch(keep: KeepFile, branch: string): string[] {
  const out: string[] = [];
  for (const [varName, entries] of Object.entries(keep.variables)) {
    if (entries.some((e) => e.branch === branch)) out.push(varName);
  }
  return out.sort();
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
    const expiring: ExpiringKey[] = [];
    for (const { varName, connector } of managed) {
      if (typeof connector.expires_at !== 'number') continue;
      const remainingSec = connector.expires_at - now;
      if (remainingSec > windowSec) continue;
      expiring.push({
        varName,
        provider: connector.provider,
        expiresIn: Math.floor(remainingSec / 86400),
        connector,
      });
    }
    return expiring;
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
