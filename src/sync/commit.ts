/**
 * The one way a folder (or the system store) saves secrets to Keep (CAP-712).
 *
 * WHAT IT REPLACES. Every save used to upload the folder's WHOLE local env,
 * merged into the folder's OWN keep.lock, and let the server take it. A folder
 * pinned to an old snapshot therefore silently reverted every value someone
 * else had saved since, deleted server-only variables, and (the server's keep
 * being project-wide) rolled other branches back with it.
 *
 * WHAT IT DOES INSTEAD.
 *   1. Reads the server's latest for (project, branch).
 *   2. `planCommit` (pure): the caller's intended changes applied to that latest.
 *      A name the caller is not changing is never touched, and keeps the server's
 *      ciphertext line byte for byte. A name the caller IS changing, that someone
 *      else changed on the server since the caller's pin, is a conflict: nothing is
 *      uploaded unless the caller already resolved it.
 *   3. Builds the keep to upload from the SERVER's keep (only this branch's entries
 *      for the changed names move) and pushes it with `base_keep_hash`. If the server
 *      says the base is stale (`SECRETS_STALE_BASE`), it re-reads and re-plans ONCE.
 *   4. Folder side only: caches the blob, adopts this branch's slice of the server's
 *      keep into keep.lock (CAP-303), and writes `.env` and the sync state.
 *
 * Never logs or throws a value: errors carry codes and variable NAMES.
 */
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { FileManager } from '../files/fileManager';
import { writeKeepCache } from '../config/globalConfig';
import type { ProjectManager } from '../core/projectManager';
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES, KeepFile, setSyncKeepHash } from '../types/index';
import { hashValue } from './compareSecrets';
import type { ConflictDecider, ConflictView, Resolution, Resolutions, SourceConflict } from './conflicts';
import { SyncEngine } from './syncEngine';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** What the caller wants different. Names not mentioned are never touched. */
export interface Changes {
  readonly set: Readonly<Record<string, string>>;
  readonly remove: readonly string[];
}

export type { Resolution, Resolutions };

/** One variable as the server holds it for the branch. */
export interface LatestEntry {
  /** `capy:<resource_id>:<ciphertext>`, exactly as stored. */
  readonly line: string;
  /** `undefined` when this profile cannot decrypt the line (it is still kept verbatim). */
  readonly plaintext: string | undefined;
  /** Hash of the plaintext; the keep's `value_hash` when the line cannot be decrypted. */
  readonly hash: string;
}

/** The server's latest for one branch: its (project-wide) keep file and the branch's blob. */
export interface Snapshot {
  /** `undefined` when the server holds no keep for the project yet. */
  readonly keep: KeepFile | undefined;
  /** In blob order. */
  readonly entries: Readonly<Record<string, LatestEntry>>;
}

export type Plan =
  | { readonly kind: 'conflict'; readonly names: readonly string[] }
  | {
      readonly kind: 'ok';
      /** The whole blob after the change, in order: name → line. */
      readonly lines: Readonly<Record<string, string>>;
      /** Plaintext of every decryptable variable after the change. */
      readonly env: Readonly<Record<string, string>>;
      /** The names whose value is actually (re-)encrypted: name → plaintext. */
      readonly written: Readonly<Record<string, string>>;
      /** The names actually dropped. */
      readonly removed: readonly string[];
    };

/** value_hash by name for `branch`: what a keep.lock pins. */
export function pinnedHashes(keep: KeepFile | null | undefined, branch: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(keep?.variables ?? {}).flatMap(([name, entries]) => {
      const entry = entries.find((e) => e.branch === branch);
      return entry ? ([[name, entry.value_hash]] as const) : [];
    }),
  );
}

// ── The planner (pure) ──────────────────────────────────────────────────────

const has = (record: object, name: string): boolean => Object.hasOwn(record, name);

/** A change that meets a value the server moved since the caller's pin. Fingerprints only. */
export interface Contest {
  readonly name: string;
  /** What the caller last agreed with the server (`undefined`: the caller never had it). */
  readonly pinned: string | undefined;
  /** The intended value's fingerprint (`undefined`: a deletion). */
  readonly yours: string | undefined;
  /** The server's fingerprint now (`undefined`: the server no longer has it). */
  readonly theirs: string | undefined;
}

/**
 * Whether writing `yours` (a value, or `undefined` for a deletion) over the server's `latest` meets a value the
 * server moved since `pinned`: the server's value differs from the pin (including added or removed since) AND
 * writing would actually change it (the intended value is not already the server's; a deletion of a value the
 * server still has). The one definition `findConflicts` and a screen's row status share.
 */
export function isContested(
  pinned: string | undefined,
  yours: string | undefined,
  latest: Pick<LatestEntry, 'plaintext' | 'hash'> | undefined,
): boolean {
  const changesIt = yours === undefined ? latest !== undefined : latest?.plaintext !== yours;
  return changesIt && latest?.hash !== pinned;
}

/**
 * Every change in `changes` that meets a value the server moved since `pinned` (different hash,
 * including added or removed on the server since) and that would actually change it: a name in
 * `set` whose intended value is not already the server's, a name in `remove` the server still has.
 * Independent of any resolution, so a decision can be bound to exactly this set. In name order.
 */
export function findConflicts(input: {
  readonly pinned: Readonly<Record<string, string>>;
  readonly latest: Readonly<Record<string, LatestEntry>>;
  readonly changes: Changes;
}): readonly Contest[] {
  const { pinned, latest, changes } = input;
  const writes = Object.entries(changes.set).map(([name, value]) => ({ name, value }));
  const removals = changes.remove.filter((name) => !has(changes.set, name)).map((name) => ({ name, value: undefined as string | undefined }));
  return [...writes, ...removals]
    .filter(({ name, value }) => isContested(pinned[name], value, has(latest, name) ? latest[name] : undefined))
    .map(({ name, value }) => ({
      name,
      pinned: pinned[name],
      yours: value === undefined ? undefined : hashValue(value),
      theirs: latest[name]?.hash,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `changes` applied to `latest`.
 *
 * A name in `set` is a conflict when the server's value moved since `pinned`
 * (different hash, including added or removed on the server since) AND differs from
 * the intended value AND the caller gave no resolution. A name in `remove` is a
 * conflict when the server's value moved since `pinned`; removing what the server no
 * longer has is a no-op. `resolutions`: `theirs` leaves the server's value alone,
 * `mine` overwrites it.
 */
export function planCommit(input: {
  readonly pinned: Readonly<Record<string, string>>;
  readonly latest: Readonly<Record<string, LatestEntry>>;
  readonly changes: Changes;
  readonly resolutions?: Resolutions;
  /** Encrypts one value into its blob line. */
  readonly encryptLine: (name: string, value: string) => string;
}): Plan {
  const { pinned, latest, changes, encryptLine } = input;
  const resolutions = input.resolutions ?? {};

  const open = findConflicts({ pinned, latest, changes }).filter((c) => resolutions[c.name] === undefined);
  if (open.length > 0) return { kind: 'conflict', names: open.map((c) => c.name) };

  const toWrite = Object.entries(changes.set).filter(([name, value]) => resolutions[name] !== 'theirs' && latest[name]?.plaintext !== value);
  const toRemove = changes.remove.filter((name) => !has(changes.set, name) && has(latest, name) && resolutions[name] !== 'theirs');

  const written = Object.fromEntries(toWrite);
  const encrypted = Object.fromEntries(toWrite.map(([name, value]) => [name, encryptLine(name, value)]));
  const gone = new Set(toRemove);
  const kept = Object.entries(latest).filter(([name]) => !gone.has(name));

  return {
    kind: 'ok',
    lines: Object.fromEntries([
      ...kept.map(([name, entry]) => [name, encrypted[name] ?? entry.line] as const),
      ...Object.entries(encrypted).filter(([name]) => !has(latest, name)),
    ]),
    env: {
      ...Object.fromEntries(kept.flatMap(([name, entry]) => (entry.plaintext === undefined ? [] : [[name, entry.plaintext] as const]))),
      ...written,
    },
    written,
    removed: toRemove,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Nothing was uploaded: `names` (never values) changed on the server since this folder last synced. */
export function conflictError(names: readonly string[]): CapyError {
  return new CapyError(
    `${names.join(', ')} changed on the server since this was last synced. Nothing was uploaded.`, // COPY-FLAG
    ERROR_CODES.SECRETS_CONFLICT,
    { names },
  );
}

export function isSecretsConflict(err: unknown): err is CapyError {
  return err instanceof CapyError && err.code === ERROR_CODES.SECRETS_CONFLICT;
}

export const isStaleBase = (err: unknown): boolean => err instanceof CapyError && err.code === ERROR_CODES.SECRETS_STALE_BASE;

// ── Reading the folder ──────────────────────────────────────────────────────

/**
 * The folder's `.env`, decrypted. A `capy:` value this profile holds no key for is skipped
 * (it cannot be edited here and is never uploaded); a plaintext value passes through.
 */
export function readLocalPlaintext(fileManager: Pick<FileManager, 'readEnvFile' | 'decryptValue'>, projectKey: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fileManager.readEnvFile()).flatMap(([name, value]) => {
      if (!value.startsWith('capy:')) return [[name, value] as const];
      try {
        return [[name, fileManager.decryptValue(value, projectKey)] as const];
      } catch {
        return [];
      }
    }),
  );
}

// ── Reading the server ──────────────────────────────────────────────────────

function parseKeep(raw: string | undefined): KeepFile | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const variables = typeof parsed === 'object' && parsed !== null ? (parsed as { variables?: unknown }).variables : undefined;
    return typeof variables === 'object' && variables !== null ? (parsed as KeepFile) : undefined;
  } catch {
    return undefined;
  }
}

function tryDecrypt(fm: Pick<FileManager, 'decryptValue'>, line: string, projectKey: string): string | undefined {
  try {
    return fm.decryptValue(line, projectKey);
  } catch {
    return undefined;
  }
}

/** What a `getDecryptData` answer says the branch holds. Lines this key cannot decrypt are kept, undecrypted. */
export function snapshotFrom(
  data: { readonly env_content?: string | null; readonly keep_file?: string },
  branch: string,
  projectKey: string,
  fm: Pick<FileManager, 'parseEnvContent' | 'decryptValue'> = new FileManager(),
): Snapshot {
  const keep = parseKeep(data.keep_file);
  return {
    keep,
    entries: Object.fromEntries(
      Object.entries(fm.parseEnvContent(data.env_content ?? '')).map(([name, line]) => {
        const plaintext = tryDecrypt(fm, line, projectKey);
        const pinnedHash = keep?.variables[name]?.find((e) => e.branch === branch)?.value_hash ?? '';
        return [name, { line, plaintext, hash: plaintext === undefined ? pinnedHash : hashValue(plaintext) }];
      }),
    ),
  };
}

export type CommitClient = Pick<ServiceClient, 'getDecryptData' | 'pushSecrets'>;

export async function readSnapshot(client: CommitClient, projectId: string, branch: string, projectKey: string): Promise<Snapshot> {
  return snapshotFrom(await client.getDecryptData(projectId, branch, undefined, true), branch, projectKey);
}

// ── Building the keep ───────────────────────────────────────────────────────

/** Drops `names`' entries for `branch`; other branches stay as they are. */
function dropBranchEntries(keep: KeepFile, branch: string, names: readonly string[]): KeepFile {
  const dropped = new Set(names);
  return {
    ...keep,
    variables: Object.fromEntries(
      Object.entries(keep.variables).flatMap(([name, entries]) => {
        if (!dropped.has(name)) return [[name, entries]] as const;
        const kept = entries.filter((e) => e.branch !== branch);
        return kept.length > 0 ? ([[name, kept]] as const) : [];
      }),
    ),
  };
}

/**
 * `base` with this branch's entries for `written` (name → plaintext) set and for `removed`
 * dropped. Every other variable and branch is exactly as in `base`, and extra fields on
 * an entry (a connector, deploy targets) survive.
 */
export function keepWithChanges(
  base: KeepFile,
  branch: string,
  written: Readonly<Record<string, string>>,
  removed: readonly string[],
  resourceIdOf: (name: string) => string,
): KeepFile {
  const entries = Object.fromEntries(
    Object.entries(written).map(([name, value]) => [name, { resource_id: resourceIdOf(name), value_hash: hashValue(value) }]),
  );
  const merged = Object.keys(entries).length === 0 ? base : new SyncEngine().mergeWithKeep(base, entries, branch);
  return removed.length === 0 ? merged : dropBranchEntries(merged, branch, removed);
}

export const envBlobOf = (lines: Readonly<Record<string, string>>): string =>
  Object.entries(lines)
    .map(([name, line]) => `${name}=${line}`)
    .join('\n');

// ── Committing to the server ────────────────────────────────────────────────

export interface ServerCommitInput {
  readonly client: CommitClient;
  readonly projectId: string;
  readonly branch: string;
  readonly projectKey: string;
  /** The keep the caller started from: its branch slice is the pin. */
  readonly startKeep: KeepFile;
  readonly changes: Changes;
  readonly resolutions?: Resolutions;
  /** Runs on the keep to upload (e.g. attach connector metadata). Return its input to change nothing. */
  readonly transformKeep?: (keep: KeepFile) => KeepFile;
  /** A read the caller already made and showed its user: used for the first attempt instead of reading again. */
  readonly seen?: Snapshot;
  /**
   * Asked for the decision on every conflict the changes meet that `resolutions` does not already settle
   * (CAP-717). It returns the decisions or throws (a `ConflictRefusal`: nothing is uploaded). Absent: an
   * unsettled conflict is `SECRETS_CONFLICT`.
   */
  readonly decide?: ConflictDecider;
  /** Read, plan and decide, but upload nothing: for a caller that wants to know whether the write would go through. */
  readonly check?: boolean;
}

export interface ServerCommit {
  /** The server state this commit was planned against (after a stale retry, the re-read). */
  readonly snapshot: Snapshot;
  /** The server's keep after the commit. */
  readonly keep: KeepFile;
  readonly lines: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly written: readonly string[];
  readonly removed: readonly string[];
  /** Every decision this commit was planned with: the caller's, and what `decide` added. */
  readonly resolutions: Resolutions;
  /** The push response; `undefined` when nothing needed uploading. */
  readonly result: { readonly keep_hash: string; readonly keep_file?: string } | undefined;
}

/** A resolution holds only for a name whose server value is the one the caller resolved against. */
function stillValid(resolutions: Resolutions | undefined, before: Snapshot, after: Snapshot): Resolutions {
  return Object.fromEntries(
    Object.entries(resolutions ?? {}).filter(([name]) => before.entries[name]?.hash === after.entries[name]?.hash),
  );
}

/** The conflicts `decide` is asked about, as the protocol reports them (fingerprints only). */
export function sourceConflictsOf(contests: readonly Contest[], snapshot: Snapshot, view: ConflictView): readonly SourceConflict[] {
  return contests.map((c) => {
    const changedAt = snapshot.keep?.variables[c.name]?.find((e) => e.branch === view.branch)?.changed_at;
    return {
      kind: 'source',
      name: c.name,
      project: view.project,
      branch: view.branch,
      pinned: c.pinned ?? null,
      yours: c.yours ?? null,
      theirs: c.theirs ?? null,
      ...(changedAt === undefined ? {} : { theirs_changed_at: changedAt }),
    };
  });
}

/** The resolutions `input.decide` gives for the conflicts that `resolutions` leaves open (none when nothing is open or nobody decides). */
async function decidedFor(input: ServerCommitInput, snapshot: Snapshot, resolutions: Resolutions | undefined, latestKeep: KeepFile): Promise<Resolutions> {
  const { branch, startKeep, changes } = input;
  const open = findConflicts({ pinned: pinnedHashes(startKeep, branch), latest: snapshot.entries, changes }).filter((c) => resolutions?.[c.name] === undefined);
  if (open.length === 0 || input.decide === undefined) return {};
  const view: ConflictView = {
    project: latestKeep.project_name,
    branch,
    serverKeepHash: snapshot.keep === undefined ? '' : SyncEngine.computeKeepHash(snapshot.keep, branch),
  };
  return input.decide(sourceConflictsOf(open, snapshot, view), view);
}

async function attempt(input: ServerCommitInput, snapshot: Snapshot, resolutions: Resolutions | undefined, mayRetry: boolean): Promise<ServerCommit> {
  const { client, projectId, branch, projectKey, startKeep, changes, transformKeep } = input;
  const latestKeep: KeepFile = snapshot.keep ?? { ...startKeep, variables: {} };
  const resourceIdOf = (name: string): string =>
    latestKeep.variables[name]?.find((e) => e.branch === branch)?.resource_id || deriveResourceId(branch, name);

  const decided = await decidedFor(input, snapshot, resolutions, latestKeep);
  const settled: Resolutions = { ...resolutions, ...decided };
  const plan = planCommit({
    pinned: pinnedHashes(startKeep, branch),
    latest: snapshot.entries,
    changes,
    resolutions: settled,
    encryptLine: (name, value) => `capy:${resourceIdOf(name)}:${Encryptor.encrypt(value, projectKey)}`,
  });
  if (plan.kind === 'conflict') throw conflictError(plan.names);

  const changed = keepWithChanges(latestKeep, branch, plan.written, plan.removed, resourceIdOf);
  const keep = transformKeep ? transformKeep(changed) : changed;
  const base = { snapshot, keep, lines: plan.lines, env: plan.env, written: Object.keys(plan.written), removed: plan.removed, resolutions: settled };
  if (keep === latestKeep || input.check === true) return { ...base, result: undefined };

  try {
    const result = await client.pushSecrets(
      projectId,
      JSON.stringify(keep),
      envBlobOf(plan.lines),
      branch,
      undefined,
      snapshot.keep === undefined ? undefined : SyncEngine.computeKeepHash(snapshot.keep, branch),
    );
    return { ...base, result };
  } catch (err) {
    if (!mayRetry || !isStaleBase(err)) throw err;
    const fresh = await readSnapshot(client, projectId, branch, projectKey);
    return attempt(input, fresh, stillValid(resolutions, snapshot, fresh), false);
  }
}

/**
 * Applies `input.changes` to the server's latest and uploads the result. Throws
 * `SECRETS_CONFLICT` (nothing uploaded) when a change would overwrite a value the
 * server changed since the caller's pin, and `SECRETS_STALE_BASE` if the server moved
 * again after the one re-read. Does not touch the local disk.
 */
export async function commitToServer(input: ServerCommitInput): Promise<ServerCommit> {
  const snapshot = input.seen ?? (await readSnapshot(input.client, input.projectId, input.branch, input.projectKey));
  return attempt(input, snapshot, input.resolutions, true);
}

/**
 * The keep.lock a folder holding `local` should have after `committed`: `local` with this
 * branch's slice replaced by the server's (CAP-303: keep.lock is git-owned, so no other
 * branch's pins move).
 */
export function adoptedKeepFor(local: KeepFile, committed: ServerCommit, branch: string): KeepFile {
  // The server holds no keep yet and nothing was uploaded: there is nothing to adopt.
  if (committed.result === undefined && committed.snapshot.keep === undefined) return local;
  const serverKeep = SyncEngine.adoptServerKeep(committed.result?.keep_file, committed.keep, branch);
  return SyncEngine.spliceKeepBranch(local, serverKeep, branch);
}

// ── Committing from a folder ────────────────────────────────────────────────

/** Everything a folder commit needs; `ResolvedContext` has all of it. */
export interface FolderContext {
  readonly pm: Pick<ProjectManager, 'readSyncState' | 'readKeepFile'>;
  readonly fileManager: Pick<FileManager, 'readEnvFile' | 'decryptValue' | 'writeKeepFile' | 'writeEncryptedEnvFile' | 'writeSyncState'>;
  /** Absent in local-only mode: there is no server, the working copy is committed as it stands. */
  readonly serviceClient?: CommitClient;
  readonly orgId: string;
  readonly projectId: string;
  readonly branch: string;
  readonly userId: string;
  readonly projectKey: string;
  /** The folder's keep.lock when the command started. */
  readonly keep: KeepFile;
  /** The folder's decrypted `.env` when the command started. */
  readonly localPlaintext: Readonly<Record<string, string>>;
  /** How the command settles a conflict (the non-TTY protocol sets this); absent: a conflict is `SECRETS_CONFLICT`. */
  readonly decide?: ConflictDecider;
}

export interface FolderCommitOptions {
  readonly resolutions?: Resolutions;
  readonly transformKeep?: (keep: KeepFile) => KeepFile;
  readonly seen?: Snapshot;
  /** Overrides the context's `decide` for this one commit. */
  readonly decide?: ConflictDecider;
}

export interface FolderCommit {
  /** Whether anything was uploaded. */
  readonly uploaded: boolean;
  readonly written: readonly string[];
  readonly removed: readonly string[];
  /** The keep.lock now on disk. */
  readonly keep: KeepFile;
}

/**
 * What a folder changed since its pin: the values that differ from it (an edit, or a new
 * name) and, with `removals`, the pinned names gone from `.env`. Values the folder merely
 * still holds from an older sync are not its changes.
 */
export function localChanges(local: Readonly<Record<string, string>>, pinned: Readonly<Record<string, string>>, opts: { readonly removals: boolean }): Changes {
  return {
    set: Object.fromEntries(Object.entries(local).filter(([name, value]) => hashValue(value) !== pinned[name])),
    remove: opts.removals ? Object.keys(pinned).filter((name) => !has(local, name)) : [],
  };
}

/**
 * Bare `capy`'s "commit local values": the folder's changes, committed with the answer the
 * user gave by choosing it. The table showed every changed name with the server's value next
 * to it, so for each one the server also moved, the answer is `mine`. `seen` is the read the
 * table was drawn from; the commit is planned against it, so a save in between is caught by
 * the server (`SECRETS_STALE_BASE`) rather than overwritten.
 *
 * Off a terminal there is no table to answer for (CAP-717): the caller passes `decide` and the same
 * commit grants nothing up front, so a name the server also changed is a conflict that `decide` settles.
 */
export async function commitLocalValues(
  ctx: FolderContext,
  shown: { readonly pinned: Readonly<Record<string, string>>; readonly remoteHashes: Readonly<Record<string, string>>; readonly seen: Snapshot | undefined },
  decide?: ConflictDecider,
): Promise<{ readonly changed: number }> {
  const changes = localChanges(ctx.localPlaintext, shown.pinned, { removals: true });
  const names = [...Object.keys(changes.set), ...changes.remove];
  // Choosing "commit local" in the menu grants `mine` to removals too, exactly as it does to edits: the table showed both.
  const resolutions =
    decide === undefined
      ? Object.fromEntries(names.filter((name) => shown.remoteHashes[name] !== shown.pinned[name]).map((name) => [name, 'mine' as const]))
      : {};
  await commitFolder(ctx, changes, { resolutions, seen: shown.seen, decide });
  return { changed: names.length };
}

/** `changes` applied to a plain env. */
function applyToEnv(env: Readonly<Record<string, string>>, changes: Changes): Record<string, string> {
  const gone = new Set(changes.remove);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !gone.has(name))),
    ...changes.set,
  };
}

/** `keep` with this branch's slice rebuilt from `env`: every name set, every other pinned name dropped. */
export function keepForEnv(keep: KeepFile, branch: string, env: Readonly<Record<string, string>>): KeepFile {
  const stale = Object.keys(pinnedHashes(keep, branch)).filter((name) => !has(env, name));
  return keepWithChanges(keep, branch, env, stale, (name) => deriveResourceId(branch, name));
}

/** `keep` with `names`' entries for `branch` put back as `original` has them (or dropped when it has none). */
function restorePins(keep: KeepFile, original: KeepFile, branch: string, names: readonly string[]): KeepFile {
  if (names.length === 0) return keep;
  const restored = new Set(names);
  return {
    ...keep,
    variables: Object.fromEntries(
      [...new Set([...Object.keys(keep.variables), ...names])].flatMap((name) => {
        if (!restored.has(name)) return [[name, keep.variables[name]]] as const;
        const others = (keep.variables[name] ?? []).filter((e) => e.branch !== branch);
        const own = (original.variables[name] ?? []).filter((e) => e.branch === branch);
        const entries = [...others, ...own];
        return entries.length > 0 ? ([[name, entries]] as const) : [];
      }),
    ),
  };
}

/** The local-only "server": the working copy is the truth, there is no one to conflict with. */
function commitLocalCopy(ctx: FolderContext, changes: Changes, transformKeep: FolderCommitOptions['transformKeep']) {
  const env = applyToEnv(ctx.localPlaintext, changes);
  const lines = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, `capy:${deriveResourceId(ctx.branch, name)}:${Encryptor.encrypt(value, ctx.projectKey)}`]),
  );
  const rebuilt = keepForEnv(ctx.keep, ctx.branch, env);
  const keep = transformKeep ? transformKeep(rebuilt) : rebuilt;
  return {
    env,
    lines,
    keep,
    adopted: keep,
    cacheHash: SyncEngine.computeKeepHash(keep, ctx.branch),
    uploaded: false,
    written: Object.keys(changes.set),
    removed: changes.remove,
  };
}

/** What a folder commit asks the server commit to do. */
function serverInputFor(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions): ServerCommitInput {
  return {
    client: ctx.serviceClient!,
    projectId: ctx.projectId,
    branch: ctx.branch,
    projectKey: ctx.projectKey,
    startKeep: ctx.keep,
    changes,
    resolutions: opts.resolutions,
    transformKeep: opts.transformKeep,
    seen: opts.seen,
    decide: opts.decide ?? ctx.decide,
  };
}

/** The server commit, and what the folder should adopt from it. */
async function commitToServerFor(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions) {
  const committed = await commitToServer(serverInputFor(ctx, changes, opts));
  const pinned = pinnedHashes(ctx.keep, ctx.branch);
  // A local edit nobody committed stays an edit: its value stays in `.env` and its pin stays
  // where it was, so the next bare `capy` still sees what the server changed under it.
  const preserved = Object.keys(ctx.localPlaintext).filter(
    (name) =>
      !has(changes.set, name) &&
      !changes.remove.includes(name) &&
      hashValue(ctx.localPlaintext[name]) !== pinned[name] &&
      ctx.localPlaintext[name] !== committed.env[name],
  );
  const adopted = restorePins(adoptedKeepFor(ctx.keep, committed, ctx.branch), ctx.keep, ctx.branch, preserved);
  return {
    env: { ...committed.env, ...Object.fromEntries(preserved.map((name) => [name, ctx.localPlaintext[name]])) },
    lines: committed.lines,
    keep: committed.keep,
    adopted,
    cacheHash: committed.result?.keep_hash ?? SyncEngine.computeKeepHash(committed.keep, ctx.branch),
    uploaded: committed.result !== undefined,
    written: committed.written,
    removed: committed.removed,
  };
}

/**
 * Reads, plans and decides exactly as `commitFolder(ctx, changes, opts)` would, and writes nothing, on the
 * server or in the folder: a `--dry-run` that can say "this would conflict", or a command that must settle
 * its conflicts BEFORE it does something it cannot take back (`capy rotate` issues a new key first). Throws what
 * the commit would throw; returns the decisions it was planned with. A folder with no server has nothing to
 * conflict with.
 */
export async function checkFolder(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions = {}): Promise<{ readonly resolutions: Resolutions }> {
  if (ctx.serviceClient === undefined) return { resolutions: opts.resolutions ?? {} };
  const checked = await commitToServer({ ...serverInputFor(ctx, changes, opts), check: true });
  return { resolutions: checked.resolutions };
}

/**
 * Commits `changes` for a folder: to the server (or, in local-only mode, to the working copy),
 * then caches the blob and writes keep.lock, `.env` and the sync state. `.env` afterwards is the
 * server's latest plus `changes`, except that local edits nobody committed are kept as edits.
 */
export async function commitFolder(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions = {}): Promise<FolderCommit> {
  const done = ctx.serviceClient === undefined ? commitLocalCopy(ctx, changes, opts.transformKeep) : await commitToServerFor(ctx, changes, opts);

  writeKeepCache(ctx.orgId, ctx.projectId, done.cacheHash, envBlobOf(done.lines));
  ctx.fileManager.writeKeepFile(done.adopted);
  ctx.fileManager.writeEncryptedEnvFile({ ...done.env }, ctx.projectKey, undefined, done.adopted, ctx.branch);

  const existingSyncState = ctx.pm.readSyncState();
  ctx.fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(done.env),
    user_id: ctx.userId,
    keep_hash: setSyncKeepHash(existingSyncState, ctx.branch, SyncEngine.computeKeepHash(done.adopted, ctx.branch)),
  });

  return { uploaded: done.uploaded, written: done.written, removed: done.removed, keep: done.adopted };
}
