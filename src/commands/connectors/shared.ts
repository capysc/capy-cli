import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { AuthService, silentAuthFailureMessage } from '../../auth/authService';
import { ServiceClient } from '../../service/serviceClient';
import { commitFolder, readLocalPlaintext } from '../../sync/commit';
import { KeepFile, ConnectorMetadata, CapyError, ERROR_CODES, AuthResult } from '../../types/index';
import type { ImportOutcome } from './registry';
import { reportRepoLinkForCommand, type RepoLinkWarning } from '../../core/repoLinkReporter';

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
  /** CAP-697: warnings from reporting this project's repo link (empty unless the keep.lock looks copied). */
  repoLinkWarnings?: readonly RepoLinkWarning[];
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
    /** The caller emits JSON and carries `ctx.repoLinkWarnings` in it: nothing is printed for them here. */
    json?: boolean;
    /** The caller is a dry run: the repo link is not reported. */
    dryRun?: boolean;
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

  // CAP-697: tell Capy which repo/folder holds this keep.lock. Never blocks past
  // its budget, never fails or prints on error; a copied keep.lock gets one warning.
  const repoLink = await reportRepoLinkForCommand(
    { cwd: process.cwd(), orgId, projectId, projectName: keep.project_name, client: serviceClient, dryRun: opts.dryRun },
    { json: opts.json },
  );

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
    localPlaintext: readLocalPlaintext(fileManager, projectKey),
    repoLinkWarnings: repoLink.warnings,
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
 * Write a variable (when there is one to write), attach its connector, sync.
 *
 * `value === undefined` is the METADATA-ONLY mode, and it is what `connect`
 * uses: no value changes and only keep.lock's connector entry moves. `rotate`
 * is the caller that passes a value, because replacing a credential is what
 * rotate is for.
 *
 * The save is `commitFolder` (sync/commit.ts): it changes ONLY `varName` (plus the
 * connector entries) on top of the server's latest, so nothing else in this folder's
 * `.env` or keep.lock can revert anyone else's value. If the server changed `varName`
 * since this folder's pin, it throws `SECRETS_CONFLICT` and uploads nothing.
 *
 * If `connector` is provided, the metadata is attached to the keep.lock entry for
 * `varName` on the active branch.
 *
 * If `push` is false, writes the encrypted snippet locally only — the next
 * `capy push` / `capy` will pick it up. Local-only mode skips the merge so
 * the connector field doesn't get attached until a real push.
 */
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
  const attach = (k: KeepFile): KeepFile => applyConnectors(k, branch, varName, opts.connector, opts.alsoConnect);

  if (!opts.push) {
    // Local-only path. Even though we're not hitting the service, we still
    // need to attach the connector marker to keep.lock so a follow-up `capy
    // push` (which will round-trip through mergeWithKeep) preserves it.
    const finalEnv = value === undefined ? { ...localPlaintext } : { ...localPlaintext, [varName]: value };
    const merged = attach(keep);
    if (merged !== keep) fileManager.writeKeepFile(merged);
    fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    return;
  }

  await commitFolder(ctx, { set: value === undefined ? {} : { [varName]: value }, remove: [] }, { transformKeep: attach });
}

/**
 * `capy remove NAME...` — drop `names` from the active branch. Only those names
 * move: everything else on the server, and every local edit in `.env`, is left
 * alone. A name the server changed since this folder's pin is a `SECRETS_CONFLICT`.
 */
export async function removeAndSync(ctx: ResolvedContext, names: readonly string[]): Promise<void> {
  await commitFolder(ctx, { set: {}, remove: names });
}

/**
 * Write SEVERAL NEW variables at once — a `capy connect <import-connector>`
 * import — and sync, in one push/commit rather than one per variable.
 *
 * `writeAndSync`'s `(varName, value)` pair is for ONE variable's value; an import adds
 * N key/value pairs simultaneously, in one commit. Every entry becomes a managed
 * connector on its own (varName, branch) entry, same as `writeAndSync`'s `alsoConnect`.
 */
export async function writeImportedAndSync(
  ctx: ResolvedContext,
  entries: ReadonlyArray<{ varName: string; value: string; entry: ConnectorMetadata }>,
  opts: {
    push: boolean;
    /**
     * `--overwrite` clear-only writes: proceed even when `entries` is empty.
     * Clearing removes names (`opts.clear`) rather than adding an entry, so a
     * clear-only run has nothing in `entries` at all; without this flag that
     * would hit the early return below and write nothing. Default false
     * preserves every other caller's "nothing to do" no-op.
     */
    forceWrite?: boolean;
    /** `--overwrite`: names to drop from the branch in the same write. */
    clear?: readonly string[];
  },
): Promise<void> {
  if (entries.length === 0 && !opts.forceWrite) return;
  const { fileManager, branch, projectKey, keep, localPlaintext } = ctx;
  const clear = opts.clear ?? [];
  const also = entries.map((e) => ({ varName: e.varName, entry: e.entry }));
  // `entries[0]?.varName ?? ''`: the positional `varName` argument below is
  // only ever READ by `applyConnectors` when its own `connector` argument
  // (always `undefined` here) is set — so on a clear-only call (`entries`
  // empty, `forceWrite: true`) this placeholder is never actually consulted,
  // but `entries[0].varName` would still throw evaluating it eagerly.
  const attachAll = (k: KeepFile): KeepFile => applyConnectors(k, branch, entries[0]?.varName ?? '', undefined, also);
  const set = Object.fromEntries(entries.map((e) => [e.varName, e.value]));

  if (!opts.push) {
    const finalEnv = { ...Object.fromEntries(Object.entries(localPlaintext).filter(([k]) => !clear.includes(k))), ...set };
    const merged = attachAll(keep);
    if (merged !== keep) fileManager.writeKeepFile(merged);
    fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    return;
  }

  await commitFolder(ctx, { set, remove: clear }, { transformKeep: attachAll });
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
 * an empty `entries` array, so the cleared names are passed as `clear` and
 * `forceWrite` is set so `writeImportedAndSync` does not take its normal
 * "nothing to do" early return.
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

  await writeImportedAndSync(ctx, [...outcome.imported, ...unchangedEntries], {
    push: opts.push,
    forceWrite: cleared.length > 0 || unchangedEntries.length > 0,
    clear: cleared,
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
