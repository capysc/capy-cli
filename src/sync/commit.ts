/**
 * The one way anything uploads secrets to Keep (CAP-712).
 *
 * WHAT IT IS NOT. It decides nothing about who is right. Bare `capy` is the conflict path
 * (docs/conflict-resolution.md): every command that writes from a folder runs it first, so by the
 * time something here is called the folder and Capy agree, and a command that writes without a folder
 * has had its own answers (sync/noFolder.ts). This module only uploads.
 *
 * WHAT IT DOES.
 *   1. Reads the server's latest for (project, branch).
 *   2. Applies the caller's change (`set` / `remove`) onto that latest. A name the caller is not
 *      changing keeps the server's ciphertext line byte for byte.
 *   3. Builds the keep to upload from the SERVER's keep (only this branch's entries for the changed
 *      names move) and pushes it with `base_keep_hash`: the keep it started from.
 *   4. If the server refuses the upload as stale (`SECRETS_STALE_BASE`, someone saved in between), the
 *      caller runs its `between` step (a folder command runs bare `capy` again) and tries once more.
 *   5. Folder side only: caches the blob, adopts this branch's slice of the server's keep into keep.lock
 *      (CAP-303), and writes `.env` and the sync state.
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
import { SyncEngine } from './syncEngine';
import type { RateInfo } from '../utils/pool';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** What the caller wants different. Names not mentioned are never touched. */
export interface Changes {
  readonly set: Readonly<Record<string, string>>;
  readonly remove: readonly string[];
}

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

/** value_hash by name for `branch`: what a keep.lock pins. */
export function pinnedHashes(keep: KeepFile | null | undefined, branch: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(keep?.variables ?? {}).flatMap(([name, entries]) => {
      const entry = entries.find((e) => e.branch === branch);
      return entry ? ([[name, entry.value_hash]] as const) : [];
    }),
  );
}

const has = (record: object, name: string): boolean => Object.hasOwn(record, name);

/** The keep hash for `branch` of a snapshot: the `base_keep_hash` of an upload built from it. `undefined` when the server holds no keep. */
export const baseHashOf = (snapshot: Snapshot, branch: string): string | undefined =>
  snapshot.keep === undefined ? undefined : SyncEngine.computeKeepHash(snapshot.keep, branch);

// ── Applying a change (pure) ────────────────────────────────────────────────

export interface Applied {
  /** The whole blob after the change, in order: name → line. */
  readonly lines: Readonly<Record<string, string>>;
  /** Plaintext of every decryptable variable after the change. */
  readonly env: Readonly<Record<string, string>>;
  /** The names whose value is actually (re-)encrypted: name → plaintext. */
  readonly written: Readonly<Record<string, string>>;
  /** The names actually dropped. */
  readonly removed: readonly string[];
}

/**
 * `changes` applied to `latest`. A name already holding the intended value keeps the server's line; a name
 * the caller does not mention is never touched.
 */
export function applyChanges(input: {
  readonly latest: Readonly<Record<string, LatestEntry>>;
  readonly changes: Changes;
  /** Encrypts one value into its blob line. */
  readonly encryptLine: (name: string, value: string) => string;
}): Applied {
  const { latest, changes, encryptLine } = input;
  const toWrite = Object.entries(changes.set).filter(([name, value]) => latest[name]?.plaintext !== value);
  const toRemove = changes.remove.filter((name) => !has(changes.set, name) && has(latest, name));

  const written = Object.fromEntries(toWrite);
  const encrypted = Object.fromEntries(toWrite.map(([name, value]) => [name, encryptLine(name, value)]));
  const gone = new Set(toRemove);
  const kept = Object.entries(latest).filter(([name]) => !gone.has(name));

  return {
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

/**
 * The change that makes Capy's branch hold exactly `env`: every value that differs, and every variable Capy
 * has (that this profile can read) that `env` does not. Used when the folder's values ARE the answer
 * ("Commit and push all local values", or the answers of the non-TTY protocol).
 */
export function changesToMatch(latest: Readonly<Record<string, LatestEntry>>, env: Readonly<Record<string, string>>): Changes {
  return {
    set: Object.fromEntries(Object.entries(env).filter(([name, value]) => latest[name]?.plaintext !== value)),
    remove: Object.entries(latest)
      .filter(([name, entry]) => entry.plaintext !== undefined && !has(env, name))
      .map(([name]) => name),
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

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
      Object.entries(data.env_content ? fm.parseEnvContent(data.env_content) : {}).map(([name, line]) => {
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

/** `keep` with this branch's slice rebuilt from `env`: every name set, every other pinned name dropped. */
export function keepForEnv(keep: KeepFile, branch: string, env: Readonly<Record<string, string>>): KeepFile {
  const stale = Object.keys(pinnedHashes(keep, branch)).filter((name) => !has(env, name));
  return keepWithChanges(keep, branch, env, stale, (name) => deriveResourceId(branch, name));
}

// ── Uploading ───────────────────────────────────────────────────────────────

/** The answer of a push. */
export interface PushResult {
  readonly keep_hash: string;
  readonly keep_file?: string;
}

/**
 * How an upload talks to the server, for a caller that needs more than the client's plain calls (the bulk
 * `capy secrets` writes read the rate-limit headers and wait out a 429). Both calls reject with the error as it is.
 */
export interface UploadIo {
  readonly read: () => Promise<{ readonly snapshot: Snapshot; readonly rate?: RateInfo }>;
  readonly push: (keepFile: string, envBlob: string, baseKeepHash: string | undefined) => Promise<{ readonly result: PushResult; readonly rate?: RateInfo }>;
}

export interface UploadInput {
  readonly client: CommitClient;
  readonly projectId: string;
  readonly branch: string;
  readonly projectKey: string;
  /** Talk to the server this way instead of through `client` directly. */
  readonly io?: UploadIo;
  /** The keep the caller started from; only used when the server holds none yet. */
  readonly startKeep: KeepFile;
  readonly changes: Changes;
  /** Runs on the keep to upload (e.g. attach connector metadata). Return its input to change nothing. */
  readonly transformKeep?: (keep: KeepFile) => KeepFile;
  /** A read the caller already made (bare `capy`'s): used for this attempt instead of reading again. */
  readonly seen?: Snapshot;
}

export interface Uploaded {
  /** The server state this upload was planned against. */
  readonly snapshot: Snapshot;
  /** The server's keep after the upload. */
  readonly keep: KeepFile;
  readonly lines: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly written: readonly string[];
  readonly removed: readonly string[];
  /** The push response; `undefined` when nothing needed uploading. */
  readonly result: PushResult | undefined;
  /** The rate-limit readings of the read and of the push, when the `io` reports them. */
  readonly rates: { readonly read?: RateInfo; readonly push?: RateInfo };
}

/** The plain client, as an `UploadIo`. */
function clientIo(input: Pick<UploadInput, 'client' | 'projectId' | 'branch' | 'projectKey'>): UploadIo {
  const { client, projectId, branch, projectKey } = input;
  return {
    read: async () => ({ snapshot: await readSnapshot(client, projectId, branch, projectKey) }),
    push: async (keepFile, envBlob, baseKeepHash) => ({ result: await client.pushSecrets(projectId, keepFile, envBlob, branch, undefined, baseKeepHash) }),
  };
}

/**
 * THE shared upload: `input.changes` applied to the server's latest and uploaded with `base_keep_hash`.
 * One attempt. Throws `SECRETS_STALE_BASE` when the server's latest moved since the read (nothing was written);
 * `retryOnceOnStale` is how a caller goes again. Does not touch the local disk.
 */
export async function uploadChanges(input: UploadInput): Promise<Uploaded> {
  const { branch, projectKey, startKeep, changes, transformKeep } = input;
  const io = input.io ?? clientIo(input);
  const read = input.seen === undefined ? await io.read() : { snapshot: input.seen };
  const snapshot = read.snapshot;
  const latestKeep: KeepFile = snapshot.keep ?? { ...startKeep, variables: {} };
  const resourceIdOf = (name: string): string =>
    latestKeep.variables[name]?.find((e) => e.branch === branch)?.resource_id || deriveResourceId(branch, name);

  const applied = applyChanges({
    latest: snapshot.entries,
    changes,
    encryptLine: (name, value) => `capy:${resourceIdOf(name)}:${Encryptor.encrypt(value, projectKey)}`,
  });
  const changed = keepWithChanges(latestKeep, branch, applied.written, applied.removed, resourceIdOf);
  const keep = transformKeep ? transformKeep(changed) : changed;
  const base = { snapshot, keep, lines: applied.lines, env: applied.env, written: Object.keys(applied.written), removed: applied.removed };
  const readRate = 'rate' in read && read.rate !== undefined ? { read: read.rate } : {};
  if (keep === latestKeep) return { ...base, result: undefined, rates: readRate };

  const pushed = await io.push(JSON.stringify(keep), envBlobOf(applied.lines), baseHashOf(snapshot, branch));
  return { ...base, result: pushed.result, rates: { ...readRate, ...(pushed.rate === undefined ? {} : { push: pushed.rate }) } };
}

/**
 * `uploadChanges`, and once more from a fresh read if the server refuses it as stale (`SECRETS_STALE_BASE`): for a
 * writer with no folder and no bare `capy` to run (the org system store). A second stale refusal is thrown.
 */
export async function uploadChangesRereading(input: UploadInput): Promise<Uploaded> {
  try {
    return await uploadChanges(input);
  } catch (err) {
    if (!isStaleBase(err)) throw err;
    return uploadChanges({ ...input, seen: undefined });
  }
}

/**
 * `attempt()`, and once more if the server refused it as stale (`SECRETS_STALE_BASE`). `between` runs first and
 * says whether to go on (a folder command runs bare `capy` again; a record writer just reads again). `undefined`
 * when `between` said to stop. A second stale refusal is thrown as it is.
 */
export async function retryOnceOnStale<T>(attempt: () => Promise<T>, between: () => Promise<boolean>): Promise<T | undefined> {
  try {
    return await attempt();
  } catch (err) {
    if (!isStaleBase(err)) throw err;
    return (await between()) ? attempt() : undefined;
  }
}

/**
 * The keep.lock a folder holding `local` should have after `uploaded`: `local` with this
 * branch's slice replaced by the server's (CAP-303: keep.lock is git-owned, so no other
 * branch's pins move).
 */
export function adoptedKeepFor(local: KeepFile, uploaded: Uploaded, branch: string): KeepFile {
  // The server holds no keep yet and nothing was uploaded: there is nothing to adopt.
  if (uploaded.result === undefined && uploaded.snapshot.keep === undefined) return local;
  const serverKeep = SyncEngine.adoptServerKeep(uploaded.result?.keep_file, uploaded.keep, branch);
  return SyncEngine.spliceKeepBranch(local, serverKeep, branch);
}

// ── A keep-only change ──────────────────────────────────────────────────────

/** What a keep-only upload needs from the service client (the read that returns the blob as stored). */
export interface KeepOnlyClient {
  getLatestSecrets(projectId: string, branch: string): Promise<{ env_file: string; keep_hash: string; keep_file?: string } | null>;
  pushSecrets(
    projectId: string,
    keepFile: string,
    envBlob: string,
    branch: string,
    onRateLimit?: undefined,
    /** The branch hash of the keep this push was built from. */
    baseKeepHash?: string,
  ): Promise<unknown>;
}

export type KeepOnlyResult =
  | {
      readonly ok: true;
      readonly pushed: boolean;
      /** The keep as the server held it, and the one now there. */
      readonly previous: KeepFile;
      readonly keep: KeepFile;
      /** The push response's keep (with server-assigned `changed_at`), when the server sent one. */
      readonly serverKeepFile?: string;
    }
  | { readonly ok: false; readonly code: string };

const codeOf = (err: unknown): string => (err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR);

async function keepOnlyOnce(client: KeepOnlyClient, projectId: string, branch: string, transform: (keep: KeepFile) => KeepFile): Promise<KeepOnlyResult> {
  const read = await client.getLatestSecrets(projectId, branch).then(
    (latest) => ({ ok: true as const, latest }),
    (err: unknown) => ({ ok: false as const, code: codeOf(err) }),
  );
  if (!read.ok) return read;
  const { latest } = read;
  const keep = latest === null ? undefined : parseKeep(latest.keep_file);
  if (latest === null || keep === undefined) return { ok: false, code: ERROR_CODES.NO_KEEP_FILE };
  const next = transform(keep);
  if (next === keep) return { ok: true, pushed: false, previous: keep, keep };
  // The blob goes back exactly as the server holds it: a keep-only change moves no value.
  const response = await client.pushSecrets(projectId, JSON.stringify(next), latest.env_file, branch, undefined, SyncEngine.computeKeepHash(keep, branch));
  const serverKeepFile = (response as { keep_file?: unknown } | null | undefined)?.keep_file;
  return { ok: true, pushed: true, previous: keep, keep: next, ...(typeof serverKeepFile === 'string' ? { serverKeepFile } : {}) };
}

/**
 * A change to Capy's keep that moves no value (a deploy target's record, a connector's metadata, a revoked
 * token): reads the server's latest, applies `transform` to THAT keep and uploads it with the blob exactly as
 * stored and `base_keep_hash`. If the server says it is stale it reads again and rebuilds once. Never throws; a
 * failure is a code.
 */
export async function uploadKeepOnly(
  client: KeepOnlyClient,
  projectId: string,
  branch: string,
  transform: (keep: KeepFile) => KeepFile,
): Promise<KeepOnlyResult> {
  try {
    const done = await retryOnceOnStale(() => keepOnlyOnce(client, projectId, branch, transform), async () => true);
    return done ?? { ok: false, code: ERROR_CODES.SECRETS_STALE_BASE };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
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
}

export interface FolderCommitOptions {
  readonly transformKeep?: (keep: KeepFile) => KeepFile;
  readonly seen?: Snapshot;
}

export interface FolderCommit {
  /** Whether anything was uploaded. */
  readonly uploaded: boolean;
  readonly written: readonly string[];
  readonly removed: readonly string[];
  /** The keep.lock now on disk. */
  readonly keep: KeepFile;
  /** The plaintext env now in `.env`. */
  readonly env: Readonly<Record<string, string>>;
}

/** `changes` applied to a plain env. */
function applyToEnv(env: Readonly<Record<string, string>>, changes: Changes): Record<string, string> {
  const gone = new Set(changes.remove);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !gone.has(name))),
    ...changes.set,
  };
}

/** The local-only "server": the working copy is the truth, there is no one to disagree with. */
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
    adopted: keep,
    cacheHash: SyncEngine.computeKeepHash(keep, ctx.branch),
    uploaded: false,
    written: Object.keys(changes.set),
    removed: changes.remove,
  };
}

async function uploadForFolder(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions) {
  const uploaded = await uploadChanges({
    client: ctx.serviceClient!,
    projectId: ctx.projectId,
    branch: ctx.branch,
    projectKey: ctx.projectKey,
    startKeep: ctx.keep,
    changes,
    transformKeep: opts.transformKeep,
    seen: opts.seen,
  });
  return {
    env: uploaded.env,
    lines: uploaded.lines,
    adopted: adoptedKeepFor(ctx.keep, uploaded, ctx.branch),
    cacheHash: uploaded.result?.keep_hash ?? SyncEngine.computeKeepHash(uploaded.keep, ctx.branch),
    uploaded: uploaded.result !== undefined,
    written: uploaded.written,
    removed: uploaded.removed,
  };
}

/**
 * Commits `changes` for a folder: to the server (or, in local-only mode, to the working copy), then caches
 * the blob and writes keep.lock, `.env` and the sync state. The folder and Capy agreed before this ran (bare
 * `capy` ran first), so `.env` afterwards is the server's latest plus `changes`. Throws `SECRETS_STALE_BASE`
 * (nothing written) when someone saved since the read.
 */
export async function commitFolder(ctx: FolderContext, changes: Changes, opts: FolderCommitOptions = {}): Promise<FolderCommit> {
  const done = ctx.serviceClient === undefined ? commitLocalCopy(ctx, changes, opts.transformKeep) : await uploadForFolder(ctx, changes, opts);

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

  return { uploaded: done.uploaded, written: done.written, removed: done.removed, keep: done.adopted, env: done.env };
}
