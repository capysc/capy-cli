import { createHash } from 'crypto';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { AuthService, silentAuthFailureMessage } from '../../auth/authService';
import { ServiceClient } from '../../service/serviceClient';
import { SyncEngine } from '../../sync/syncEngine';
import { Encryptor } from '../../crypto/encryptor';
import { deriveResourceId } from '../../crypto/resourceId';
import { writeKeepCache } from '../../config/globalConfig';
import { setSyncKeepHash, KeepFile, ConnectorMetadata, CapyError, ERROR_CODES, AuthResult } from '../../types/index';
import type { ImportOutcome } from './registry';

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
}

/**
 * How a failed setup step is reported. By default (every existing caller) it is
 * the sentence on stderr and `process.exit(1)`. A caller that owes its reader a
 * coded, machine-readable refusal (`capy edit NAME --json`) passes its own.
 */
export type ContextRefusal = (code: string, message: string) => never;

const exitWithMessage: ContextRefusal = (_code, message) => {
  console.error(message);
  process.exit(1);
};

/**
 * Silent auth for the org, then for any org, then (only when `interactive`) the
 * interactive sign-in: the first that succeeds. `interactive: false` is for a
 * caller that must never open a browser (`capy edit NAME < value`).
 */
async function authenticateForOrg(authService: AuthService, orgId: string, interactive: boolean): Promise<AuthResult> {
  const forOrg = await authService.authenticateSilent(orgId);
  if (forOrg.success) return forOrg;
  const anyOrg = await authService.authenticateSilent();
  if (anyOrg.success || !interactive) return anyOrg;
  return authService.authenticate(orgId);
}

/** Decrypts `.env` (values the profile holds the key for; the rest are skipped). */
function decryptLocalEnv(fileManager: FileManager, projectKey: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fileManager.readEnvFile()).flatMap(([k, v]) => {
      if (!v.startsWith('capy:')) return [[k, v] as const];
      try {
        return [[k, fileManager.decryptValue(v, projectKey)] as const];
      } catch {
        return []; // skip undecryptable
      }
    }),
  );
}

/**
 * Run the standard "I'm an interactive command that needs to encrypt + push"
 * setup. Mirrors the front half of editCommand.ts. Exits the process on
 * unrecoverable errors (no keep.lock, auth fail, key resolution fail), or
 * hands them to `opts.refuse` when the caller wants them coded.
 */
export async function resolveContext(
  opts: {
    apiUrl?: string;
    devMode?: boolean;
    refuse?: ContextRefusal;
    /** false: silent auth only, never the browser sign-in (default true). */
    interactive?: boolean;
  } = {},
): Promise<ResolvedContext> {
  const refuse = opts.refuse ?? exitWithMessage;
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
    return refuse(ERROR_CODES.NO_KEEP_FILE, `No keep.lock found. Run ${B('capy')} to initialize.`);
  }
  const orgId = projectState.organizationId;
  const projectId = projectState.projectId;
  const branch = projectState.activeBranch;
  if (!branch) {
    return refuse(ERROR_CODES.NO_ACTIVE_BRANCH, `No active branch. Run ${B('capy')} to select a branch.`);
  }

  const keep = pm.readKeepFile();
  if (!keep) {
    return refuse(ERROR_CODES.NO_KEEP_FILE, 'Could not read keep.lock');
  }

  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;
  const authService = new AuthService(opts.apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(opts.apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const authResult = await authenticateForOrg(authService, orgId, opts.interactive !== false);
  if (!authResult.success || !authResult.user_id) {
    // A silent-only caller gets the reason and the remedy (chosen from the
    // failure's code inside `silentAuthFailureMessage`); everyone else keeps the
    // sentence they have always had.
    return refuse(
      ERROR_CODES.AUTH_FAILED,
      opts.interactive === false ? silentAuthFailureMessage(authResult) : 'Authentication failed',
    );
  }
  const userId = authResult.user_id;

  const projectKey = await resolveProjectKeyOrRefuse({
    orgId,
    projectId,
    userId,
    serviceClient,
    keep,
    branch,
    refuse: opts.refuse,
  });

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
    localPlaintext: decryptLocalEnv(fileManager, projectKey),
  };
}

/**
 * Resolves the project key. On failure: the error screen + exit (default), or a
 * coded refusal when the caller supplied one. A thrown error keeps its `code`;
 * the message of anything that is not a CapyError is NOT forwarded.
 */
async function resolveProjectKeyOrRefuse(args: {
  orgId: string;
  projectId: string;
  userId: string;
  serviceClient: ServiceClient;
  keep: KeepFile;
  branch: string;
  refuse?: ContextRefusal;
}): Promise<string> {
  const { orgId, projectId, userId, serviceClient, keep, branch, refuse } = args;
  const { resolveProjectKey } = await import('../../crypto/keyResolver');
  try {
    return await resolveProjectKey(orgId, projectId, userId, {
      coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    });
  } catch (err: any) {
    if (refuse) {
      return err instanceof CapyError
        ? refuse(err.code, err.message)
        : refuse(ERROR_CODES.SERVICE_ERROR, 'Could not resolve the project key.');
    }
    const { displayErrorAndExit } = await import('../../ui/errorScreen');
    await displayErrorAndExit(err, {
      projectName: keep.project_name,
      projectId: keep.project_id,
      branch,
    });
    throw err;
  }
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
 * connector entry moves. Everything downstream — the keep merge, the push,
 * the cache, the sync state — is identical either way, which is why this is
 * one function and not two. `rotate` is the caller that passes a value,
 * because replacing a credential is what rotate is for.
 */
/**
 * Shared tail of `writeAndSync`/`removeAndSync`: encrypt the full desired
 * `finalEnv`, merge it into keep.lock for `branch` (dropping any entry for a
 * name no longer in `finalEnv`), push, cache the pushed blob, adopt the
 * server's copy, and write `.env` + sync state. Writes only the untracked
 * working copy (`writeKeepFile`); it never auto-commits the tracked
 * keep.lock onto whatever branch the caller happens to be on.
 *
 * `keepMutator` runs on the post-merge, post-drop `KeepFile` right before the
 * push — `writeAndSync` uses it to attach connector metadata; a plain remove
 * passes the identity function through.
 */
async function commitFinalEnv(
  ctx: ResolvedContext,
  finalEnv: Record<string, string>,
  keepMutator: (merged: KeepFile) => KeepFile,
): Promise<void> {
  const { pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey, keep } = ctx;

  const encrypted = Object.fromEntries(
    Object.entries(finalEnv).map(([k, v]) => [
      k,
      `capy:${deriveResourceId(branch, k)}:${Encryptor.encrypt(v, projectKey)}`,
    ]),
  );
  const envBlob = Object.entries(encrypted)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const pushedVars = Object.fromEntries(
    Object.entries(finalEnv).map(([k, v]) => [
      k,
      {
        resource_id: deriveResourceId(branch, k),
        value_hash: createHash('sha256').update(v).digest('hex').slice(0, 16),
      },
    ]),
  );

  const syncEngine = new SyncEngine();
  const merged = syncEngine.mergeWithKeep(keep, pushedVars, branch);
  // Drop entries for names no longer in `finalEnv` — a plain filter/flatMap
  // over the merged map rather than a mutate-in-place loop, so `merged`
  // itself is never touched after `mergeWithKeep` hands it back.
  const dropped: KeepFile = {
    ...merged,
    variables: Object.fromEntries(
      Object.entries(merged.variables).flatMap(([name, entries]) => {
        if (name in finalEnv) return [[name, entries]] as const;
        const kept = entries.filter((e) => e.branch !== branch);
        return kept.length > 0 ? ([[name, kept]] as const) : [];
      }),
    ),
  };
  const finalKeep = keepMutator(dropped);

  const result = await serviceClient.pushSecrets(projectId, JSON.stringify(finalKeep), envBlob, branch);

  writeKeepCache(orgId, projectId, result.keep_hash, envBlob);
  // Prefer the server's copy — it carries server-assigned changed_at
  fileManager.writeKeepFile(SyncEngine.adoptServerKeep(result.keep_file, finalKeep, branch));
  fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

  const existingSyncState = pm.readSyncState();
  fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: userId,
    keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
  });
}

export async function writeAndSync(
  ctx: ResolvedContext,
  varName: string,
  value: string | undefined,
  opts: {
    push: boolean;
    connector?: ConnectorMetadata;
    /** Additional (varName, connector) pairs to mark managed in the same write. */
    alsoConnect?: ReadonlyArray<{ varName: string; entry: ConnectorMetadata }>;
  },
): Promise<void> {
  const { fileManager, branch, projectKey, keep, localPlaintext } = ctx;

  const finalEnv: Record<string, string> =
    value === undefined ? { ...localPlaintext } : { ...localPlaintext, [varName]: value };

  if (!opts.push) {
    // Local-only path. Even though we're not hitting the service, we still
    // need to attach the connector marker to keep.lock so a follow-up `capy
    // push` (which will round-trip through mergeWithKeep) preserves it.
    const merged = applyConnectors(keep, branch, varName, opts.connector, opts.alsoConnect);
    if (merged !== keep) fileManager.writeKeepFile(merged);
    fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    return;
  }

  await commitFinalEnv(ctx, finalEnv, (merged) => applyConnectors(merged, branch, varName, opts.connector, opts.alsoConnect));
}

/**
 * `capy remove NAME...` — drop `names` from the active branch and push the
 * remaining set through the exact same mechanics `writeAndSync` uses (encrypt
 * full set, `mergeWithKeep`, drop entries for names no longer present, push,
 * cache, adopt, write `.env` + sync state).
 *
 * Callers are expected to have already confirmed `names` are all present and
 * that nothing ELSE in `ctx.localPlaintext` has drifted from the pinned
 * baseline — this function does no such checking itself, it only performs
 * the write.
 */
export async function removeAndSync(ctx: ResolvedContext, names: readonly string[]): Promise<void> {
  const removed = new Set(names);
  const finalEnv = Object.fromEntries(Object.entries(ctx.localPlaintext).filter(([k]) => !removed.has(k)));
  await commitFinalEnv(ctx, finalEnv, (merged) => merged);
}

/**
 * Write SEVERAL NEW variables at once — a `capy connect <import-connector>`
 * import — and sync, in one push/commit rather than one per variable.
 *
 * Mirrors `writeAndSync`, but that function's `(varName, value)` pair is for
 * ONE variable's value; an import adds N brand-new key/value pairs
 * simultaneously. Chaining `writeAndSync` calls per variable would each read
 * `ctx.localPlaintext`/`ctx.keep` as they stood BEFORE the run started, so a
 * second call would push a snapshot missing the first call's write — this
 * function builds the one final `env`/`keep.lock` state and writes it once.
 *
 * Every entry becomes a managed connector on its own (varName, branch) entry,
 * same as `writeAndSync`'s `alsoConnect`.
 */
export async function writeImportedAndSync(
  ctx: ResolvedContext,
  entries: ReadonlyArray<{ varName: string; value: string; entry: ConnectorMetadata }>,
  opts: {
    push: boolean;
    /**
     * `--overwrite` clear-only writes: proceed even when `entries` is empty.
     * Clearing removes names from `ctx.localPlaintext` (the caller passes a
     * PRUNED context — see `writeImportOutcome`) rather than adding an
     * entry, so a clear-only run has nothing in `entries` at all; without
     * this flag that would hit the early return below and write nothing.
     * Default false preserves every other caller's "nothing to do" no-op.
     */
    forceWrite?: boolean;
  },
): Promise<void> {
  if (entries.length === 0 && !opts.forceWrite) return;
  const { pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey, keep, localPlaintext } = ctx;

  const finalEnv: Record<string, string> = {
    ...localPlaintext,
    ...Object.fromEntries(entries.map((e) => [e.varName, e.value])),
  };
  const also = entries.map((e) => ({ varName: e.varName, entry: e.entry }));
  // `entries[0]?.varName ?? ''`: the positional `varName` argument below is
  // only ever READ by `applyConnectors` when its own `connector` argument
  // (always `undefined` here) is set — so on a clear-only call (`entries`
  // empty, `forceWrite: true`) this placeholder is never actually consulted,
  // but `entries[0].varName` would still throw evaluating it eagerly.
  const attachAll = (k: KeepFile): KeepFile => applyConnectors(k, branch, entries[0]?.varName ?? '', undefined, also);

  if (!opts.push) {
    const merged = attachAll(keep);
    if (merged !== keep) fileManager.writeKeepFile(merged);
    fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    return;
  }

  const encrypted: Record<string, string> = Object.fromEntries(
    Object.entries(finalEnv).map(([k, v]) => [
      k,
      `capy:${deriveResourceId(branch, k)}:${Encryptor.encrypt(v, projectKey)}`,
    ]),
  );
  const envBlob = Object.entries(encrypted)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const pushedVars: Record<string, { resource_id: string; value_hash: string }> = Object.fromEntries(
    Object.entries(finalEnv).map(([k, v]) => [
      k,
      { resource_id: deriveResourceId(branch, k), value_hash: createHash('sha256').update(v).digest('hex').slice(0, 16) },
    ]),
  );

  const syncEngine = new SyncEngine();
  const merged = syncEngine.mergeWithKeep(keep, pushedVars, branch);
  const pruned: KeepFile = {
    ...merged,
    variables: Object.fromEntries(
      Object.entries(merged.variables).flatMap(([name, varEntries]) => {
        if (name in finalEnv) return [[name, varEntries]] as const;
        const filtered = varEntries.filter((e) => e.branch !== branch);
        return filtered.length > 0 ? ([[name, filtered]] as const) : [];
      }),
    ),
  };
  const finalKeep = attachAll(pruned);

  const result = await serviceClient.pushSecrets(projectId, JSON.stringify(finalKeep), envBlob, branch);

  writeKeepCache(orgId, projectId, result.keep_hash, envBlob);
  fileManager.writeKeepFile(SyncEngine.adoptServerKeep(result.keep_file, finalKeep, branch));
  fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

  const existingSyncState = pm.readSyncState();
  fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: userId,
    keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
  });
}

/**
 * Given a successful `ImportOutcome` (dokploy import, plain or
 * `--overwrite`), performs the write `executeImport` used to do inline —
 * factored out so discovery's own per-environment import step (which never
 * goes through `ConnectCommand.executeImport`, see `dokploy.ts`) writes
 * through the exact same path rather than a second copy of this logic.
 *
 * Vince's rule: a dry run changes nothing — `opts.dryRun` short-circuits
 * before anything is read even from `outcome`. Otherwise writes when there
 * is either something to import OR (an `--overwrite` run) something to
 * clear; a clear-only overwrite (nothing new or changed, only removals) has
 * an empty `entries` array, so `ctx.localPlaintext` is pruned of the
 * cleared names and `forceWrite` is set so `writeImportedAndSync` does not
 * take its normal "nothing to do" early return.
 */
export async function writeImportOutcome(
  ctx: ResolvedContext,
  outcome: Extract<ImportOutcome, { ok: true }>,
  opts: { push: boolean; dryRun: boolean },
): Promise<{ wrote: boolean }> {
  if (opts.dryRun) return { wrote: false };
  const cleared = outcome.cleared ?? [];
  // CAP-673: a dokploy import's same-value names still carry a FRESH
  // connector entry (see `ImportOutcome.unchangedEntries`'s doc) — merged
  // into the very same write as `imported` so keep.lock's connector
  // metadata (service_name/dokploy_project/environment) gets backfilled
  // even on a run that changes no value at all. Absent for every other
  // caller (link-kind connectors don't set it; hand-built outcomes in
  // existing tests don't either), so this is a strict no-op there.
  const unchangedEntries = outcome.unchangedEntries ?? [];
  const hasWrite = outcome.imported.length > 0 || cleared.length > 0 || unchangedEntries.length > 0;
  if (!hasWrite) return { wrote: false };

  const prunedCtx: ResolvedContext =
    cleared.length > 0
      ? { ...ctx, localPlaintext: Object.fromEntries(Object.entries(ctx.localPlaintext).filter(([k]) => !cleared.includes(k))) }
      : ctx;

  await writeImportedAndSync(prunedCtx, [...outcome.imported, ...unchangedEntries], {
    push: opts.push,
    forceWrite: cleared.length > 0 || unchangedEntries.length > 0,
  });
  return { wrote: true };
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
  const existing = (keep.variables[varName] ?? []).map((e) => ({ ...e }));
  const idx = existing.findIndex((e) => e.branch === branch);
  // No entry on this branch yet (writeAndSync hasn't pushed): defer to the
  // next merge — but seed an entry so subsequent reads see the connector.
  const updated =
    idx >= 0
      ? existing.map((e, i) => (i === idx ? { ...e, connector } : e))
      : [...existing, { resource_id: '', branch, value_hash: '', connector }];
  return { ...keep, variables: { ...keep.variables, [varName]: updated } };
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
    const connector = entries.find((e) => e.branch === branch)?.connector;
    return connector ? [{ varName, connector }] : [];
  });
}

/** All variables with an entry on `branch`, sorted. Both managed and unmanaged. */
export function listAllVarsOnBranch(keep: KeepFile, branch: string): string[] {
  // The filter result is a fresh array, so sorting it is construction (no `toSorted` below ES2023).
  return Object.entries(keep.variables)
    .filter(([, entries]) => entries.some((e) => e.branch === branch))
    .map(([varName]) => varName)
    .sort();
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
    return managed.flatMap(({ varName, connector }): ExpiringKey[] => {
      if (typeof connector.expires_at !== 'number') return [];
      const remainingSec = connector.expires_at - now;
      if (remainingSec > windowSec) return [];
      return [
        {
          varName,
          provider: connector.provider,
          expiresIn: Math.floor(remainingSec / 86400),
          connector,
        },
      ];
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
