/**
 * An in-memory Capy secrets server for the commit-path tests (CAP-712): one project, any
 * number of branches, the project-wide latest keep, env blobs stored by keep hash, and the
 * stale-base check (`base_keep_hash` that is no longer the latest -> 409 `SECRETS_STALE_BASE`).
 *
 * No mutation, house style: the server's state is a pure fold over a tape of every push
 * attempt. `tape` is a `mock`, so what each writer sent is also readable from its calls.
 * A push the server refuses is on the tape too, and the fold skips it the same way the
 * server did, so the state at any point is a function of the tape alone.
 */
import { mock } from 'bun:test';
import { Encryptor } from '../../src/crypto/encryptor';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { FileManager } from '../../src/files/fileManager';
import { hashValue } from '../../src/sync/compareSecrets';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { CommitClient } from '../../src/sync/commit';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';

export interface PushCall {
  readonly projectId: string;
  readonly keepFile: string;
  readonly envBlob: string;
  readonly branch: string;
  readonly baseKeepHash: string | undefined;
}

export interface ServerState {
  readonly keep: KeepFile | undefined;
  /** env blobs by keep hash */
  readonly blobs: Readonly<Record<string, string>>;
}

export const EMPTY_SERVER: ServerState = { keep: undefined, blobs: {} };

const staleAgainst = (state: ServerState, call: PushCall): boolean =>
  call.baseKeepHash !== undefined && state.keep !== undefined && SyncEngine.computeKeepHash(state.keep, call.branch) !== call.baseKeepHash;

/** The state after one accepted push: the pushed branch's entries spliced into the stored keep, `changed_at` stamped. */
function applyPush(state: ServerState, call: PushCall, index: number): ServerState {
  const incoming = JSON.parse(call.keepFile) as KeepFile;
  const spliced = SyncEngine.spliceKeepBranch(state.keep ?? null, incoming, call.branch);
  const before = state.keep?.variables ?? {};
  const stampedAt = new Date(Date.UTC(2026, 9, 3, 0, 0, index)).toISOString();
  const stamped: KeepFile = {
    ...spliced,
    variables: Object.fromEntries(
      Object.entries(spliced.variables).map(([name, entries]) => [
        name,
        entries.map((e) => {
          if (e.branch !== call.branch) return e;
          const was = before[name]?.find((b) => b.branch === call.branch);
          return was?.value_hash === e.value_hash && was.changed_at !== undefined ? { ...e, changed_at: was.changed_at } : { ...e, changed_at: stampedAt };
        }),
      ]),
    ),
  };
  return { keep: stamped, blobs: { ...state.blobs, [SyncEngine.computeKeepHash(stamped, call.branch)]: call.envBlob } };
}

const foldTape = (initial: ServerState, calls: readonly (readonly [PushCall])[]): ServerState =>
  calls.reduce((state, [call], index) => (staleAgainst(state, call) ? state : applyPush(state, call, index)), initial);

/** The server state with `values` (by branch) already saved, as one writer would have saved them. */
export function seedServer(opts: {
  readonly projectId?: string;
  readonly projectKey: string;
  readonly values: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): ServerState {
  const projectId = opts.projectId ?? 'proj';
  const branches = Object.keys(opts.values);
  const keep: KeepFile = {
    version: '3.0',
    org_id: 'org',
    project_id: projectId,
    project_name: 'demo',
    variables: Object.fromEntries(
      [...new Set(branches.flatMap((b) => Object.keys(opts.values[b])))].map((name) => [
        name,
        branches.filter((b) => name in opts.values[b]).map((b) => ({ resource_id: deriveResourceId(b, name), branch: b, value_hash: hashValue(opts.values[b][name]) })),
      ]),
    ),
  };
  const blobFor = (b: string): string =>
    Object.entries(opts.values[b])
      .map(([name, value]) => `${name}=capy:${deriveResourceId(b, name)}:${Encryptor.encrypt(value, opts.projectKey)}`)
      .join('\n');
  return { keep, blobs: Object.fromEntries(branches.map((b) => [SyncEngine.computeKeepHash(keep, b), blobFor(b)])) };
}

export interface FakeServerOpts {
  readonly initial?: ServerState;
  /**
   * Pushes that land from someone else right after the CLI's Nth read (N counts from 1): the
   * CLI's next push is built from a keep that is no longer the latest, and the server refuses
   * it with 409.
   */
  readonly racing?: (readNumber: number) => readonly PushCall[];
}

/** A push as another writer would send it: `branch` holding exactly `values` (no `base_keep_hash`, so always accepted). */
export function pushOf(opts: {
  readonly projectKey: string;
  readonly branch: string;
  readonly values: Readonly<Record<string, string>>;
  readonly projectId?: string;
}): PushCall {
  const keep: KeepFile = {
    version: '3.0',
    org_id: 'org',
    project_id: opts.projectId ?? 'proj',
    project_name: 'demo',
    variables: Object.fromEntries(
      Object.entries(opts.values).map(([name, value]) => [
        name,
        [{ resource_id: deriveResourceId(opts.branch, name), branch: opts.branch, value_hash: hashValue(value) }],
      ]),
    ),
  };
  return {
    projectId: opts.projectId ?? 'proj',
    keepFile: JSON.stringify(keep),
    envBlob: Object.entries(opts.values)
      .map(([name, value]) => `${name}=capy:${deriveResourceId(opts.branch, name)}:${Encryptor.encrypt(value, opts.projectKey)}`)
      .join('\n'),
    branch: opts.branch,
    baseKeepHash: undefined,
  };
}

export function fakeCapyServer(opts: FakeServerOpts = {}) {
  const initial = opts.initial ?? EMPTY_SERVER;
  const tape = mock((_call: PushCall) => undefined);
  const stateNow = (): ServerState => foldTape(initial, tape.mock.calls as unknown as readonly (readonly [PushCall])[]);

  const getDecryptData = mock(async (_projectId: string, branch?: string) => {
    const state = stateNow();
    const hash = state.keep === undefined ? undefined : SyncEngine.computeKeepHash(state.keep, branch);
    const response = {
      env_content: hash === undefined ? '' : (state.blobs[hash] ?? ''),
      decrypt_key: '',
      expires_at: '',
      ...(state.keep === undefined ? {} : { keep_hash: hash, keep_file: JSON.stringify(state.keep) }),
    };
    // Someone else saves right after this (first) read.
    (opts.racing?.(getDecryptData.mock.calls.length) ?? []).forEach((call) => tape(call));
    return response;
  });

  const pushSecrets = mock(async (projectId: string, keepFile: string, envBlob: string, branch: string, _onRate?: unknown, baseKeepHash?: string) => {
    const call: PushCall = { projectId, keepFile, envBlob, branch, baseKeepHash };
    const before = stateNow();
    tape(call);
    if (staleAgainst(before, call)) {
      throw new CapyError('The keep this push was built from is no longer the latest.', ERROR_CODES.SECRETS_STALE_BASE, { status: 409 });
    }
    const after = stateNow();
    return { keep_hash: SyncEngine.computeKeepHash(after.keep as KeepFile, branch), keep_file: JSON.stringify(after.keep) };
  });

  return {
    client: { getDecryptData, pushSecrets } as unknown as CommitClient,
    getDecryptData,
    pushSecrets,
    tape,
    state: stateNow,
    /** Pushes the server accepted, in order. */
    accepted: (): readonly PushCall[] => {
      const calls = tape.mock.calls.map(([c]) => c as PushCall);
      return calls.filter((c, i) => !staleAgainst(foldTape(initial, calls.slice(0, i).map((x) => [x] as const)), c));
    },
  };
}

/** What a branch holds on the server right now, decrypted (lines this key cannot decrypt are left out). */
export function serverValues(server: ServerState, branch: string, projectKey: string): Record<string, string> {
  if (server.keep === undefined) return {};
  const blob = server.blobs[SyncEngine.computeKeepHash(server.keep, branch)] ?? '';
  const fm = new FileManager();
  return Object.fromEntries(
    blob
      .split('\n')
      .filter((l) => l.length > 0)
      .flatMap((line) => {
        const eq = line.indexOf('=');
        // A line this key cannot decrypt (someone else's) is not a value here.
        return tryDecrypt(fm, line.slice(eq + 1), projectKey).map((value) => [line.slice(0, eq), value] as const);
      }),
  );
}

const tryDecrypt = (fm: FileManager, line: string, key: string): readonly string[] => {
  try {
    return [fm.decryptValue(line, key)];
  } catch {
    return [];
  }
};

/** The server's ciphertext line for `name` on `branch`, exactly as stored. */
export function serverLine(server: ServerState, branch: string, name: string): string | undefined {
  if (server.keep === undefined) return undefined;
  const blob = server.blobs[SyncEngine.computeKeepHash(server.keep, branch)] ?? '';
  return blob.split('\n').find((l) => l.startsWith(`${name}=`));
}

/** The server's pinned hash for `name` on `branch`. */
export function serverHash(server: ServerState, branch: string, name: string): string | undefined {
  return server.keep?.variables[name]?.find((e) => e.branch === branch)?.value_hash;
}
