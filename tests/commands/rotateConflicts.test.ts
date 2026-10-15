/**
 * `capy rotate` and conflicts (CAP-717). A rotation replaces a value with a key the provider issues ONCE, so a
 * conflict on the variable has to be settled BEFORE the new key is issued: after it, a refused write would lose
 * the only copy. `settleConflicts` is that step (the first thing `rotateMany` does once it has a deciding context).
 *
 * The properties: with the protocol on and the server's value moved since the folder's pin, nothing is rotated and the
 * payload comes back (exit 3); `theirs` drops the variable from the run (nothing is issued for a value that would not
 * be written); `mine` keeps it and hands the answer to the write; a variable nobody changed passes untouched.
 * At a terminal (no deciding context) the same step ASKS (mine / theirs per variable) before anything is issued;
 * cancelling the question ends it with nothing rotated or written.
 */
import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';

// The terminal's question. `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
const ask = mock(async (_conflicts: readonly unknown[]) => ({}) as Record<string, 'mine' | 'theirs'>);
mock.module('../../src/commands/conflictPrompt', () => ({ askConflicts: ask }));

import { RotateCommand } from '../../src/commands/rotateCommand';
import { parseConflictFlags, protocolDecider } from '../../src/sync/conflicts';
import { hashValue } from '../../src/sync/compareSecrets';
import { Encryptor } from '../../src/crypto/encryptor';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';
import { fakeCapyServer, seedServer } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const BRANCH = 'development';
const OLD = { STRIPE: 'sk_old', OTHER: 'o_old' } as const;
const THEIRS = 'sk_rotated_by_a_teammate';

const OLD_SEED = seedServer({ projectKey: KEY, values: { [BRANCH]: OLD } });
const NEW_SEED = seedServer({ projectKey: KEY, values: { [BRANCH]: { STRIPE: THEIRS, OTHER: OLD.OTHER } } });

const made = mock((_: Folder) => undefined);
afterEach(() => {
  made.mock.calls.forEach(([folder]) => removeFolder(folder));
  ask.mockReset();
  ask.mockImplementation(async () => ({}));
});

const connector = (): ConnectorMetadata => ({ provider: 'stripe', source: 'cli', created_at: 1, fingerprint: 'fp' }) as unknown as ConnectorMetadata;
const targets = (...names: string[]) => names.map((varName) => ({ varName, connector: connector() }));

type Settled = { rotate: Array<{ varName: string }>; resolutions: Record<string, string> };

function world(flags: Parameters<typeof parseConflictFlags>[0] | undefined) {
  const server = fakeCapyServer({ initial: NEW_SEED });
  const folder = makeFolder({ projectKey: KEY, branch: BRANCH, keep: OLD_SEED.keep as KeepFile, env: OLD, client: server.client });
  made(folder);
  const ctx = { ...folder.ctx, ...(flags === undefined ? {} : { decide: protocolDecider(parseConflictFlags(flags)) }) };
  const settle = (list: ReturnType<typeof targets>, opts: { noPush?: boolean } = {}): Promise<Settled> =>
    (new RotateCommand() as unknown as { settleConflicts: (c: unknown, t: unknown, o: unknown) => Promise<Settled> }).settleConflicts(ctx, list, opts);
  return { server, settle };
}

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

/** Runs `fn` with `process.exit` and the console captured: what it printed, and the code it exited with (if it did). */
async function captured<T>(fn: () => Promise<T>) {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const outcome = await fn().then(
    (value) => ({ value, thrown: undefined as unknown }),
    (thrown: unknown) => ({ value: undefined, thrown }),
  );
  const stdout = logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (outcome.thrown !== undefined && !(outcome.thrown instanceof ExitSignal)) throw outcome.thrown;
  return { value: outcome.value, exitCode: outcome.thrown instanceof ExitSignal ? outcome.thrown.code : undefined, stdout };
}

describe('capy rotate: conflicts are settled before the new key is issued', () => {
  test('a variable the server changed since this folder\'s pin: nothing is rotated, exit 3 with the payload', async () => {
    const { server, settle } = world({});
    const out = await captured(() => settle(targets('STRIPE')));
    expect(out.exitCode).toBe(3);
    const payload = JSON.parse(out.stdout) as { code: string; conflicts: unknown[] };
    expect(payload.code).toBe('SECRETS_CONFLICT');
    expect(payload.conflicts).toEqual([
      expect.objectContaining({ kind: 'source', name: 'STRIPE', pinned: hashValue(OLD.STRIPE), yours: null, theirs: hashValue(THEIRS) }),
    ]);
    expect(out.stdout).not.toContain(THEIRS);
    expect(server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('theirs drops the variable from the run; mine keeps it and carries the answer to the write', async () => {
    const conflict = (JSON.parse((await captured(() => world({}).settle(targets('STRIPE')))).stdout) as { conflict_id: string }).conflict_id;

    const theirs = await captured(() => world({ resolve: ['STRIPE=theirs'], conflict }).settle(targets('STRIPE', 'OTHER')));
    expect(theirs.value?.rotate.map((t) => t.varName)).toEqual(['OTHER']);

    const mine = await captured(() => world({ resolve: ['STRIPE=mine'], conflict }).settle(targets('STRIPE', 'OTHER')));
    expect(mine.value?.rotate.map((t) => t.varName)).toEqual(['STRIPE', 'OTHER']);
    expect(mine.value?.resolutions).toEqual({ STRIPE: 'mine' });
  });

  test('a variable nobody else changed passes untouched', async () => {
    const done = await captured(() => world({}).settle(targets('OTHER')));
    expect(done.exitCode).toBeUndefined();
    expect(done.value?.rotate.map((t) => t.varName)).toEqual(['OTHER']);
    expect(done.value?.resolutions).toEqual({});
  });

  test('with --no-push the step does nothing', async () => {
    expect((await captured(() => world({}).settle(targets('STRIPE'), { noPush: true }))).value?.rotate).toHaveLength(1);
    expect((await captured(() => world(undefined).settle(targets('STRIPE'), { noPush: true }))).value?.rotate).toHaveLength(1);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('capy rotate at a terminal: the conflict is asked BEFORE the new key is issued', () => {
  test('a variable the server changed: the question comes first (names and fingerprints only), and nothing is written before the answer', async () => {
    const { server, settle } = world(undefined);
    ask.mockImplementationOnce(async () => ({ STRIPE: 'mine' }));
    const done = await captured(() => settle(targets('STRIPE')));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual([expect.objectContaining({ kind: 'source', name: 'STRIPE', pinned: hashValue(OLD.STRIPE), theirs: hashValue(THEIRS) })]);
    expect(done.exitCode).toBeUndefined();
    expect(server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('theirs drops the variable from the run (no key is issued for it); mine keeps it and carries the answer to the write', async () => {
    ask.mockImplementationOnce(async () => ({ STRIPE: 'theirs' }));
    const theirs = await captured(() => world(undefined).settle(targets('STRIPE', 'OTHER')));
    expect(theirs.value?.rotate.map((t) => t.varName)).toEqual(['OTHER']);

    ask.mockImplementationOnce(async () => ({ STRIPE: 'mine' }));
    const mine = await captured(() => world(undefined).settle(targets('STRIPE', 'OTHER')));
    expect(mine.value?.rotate.map((t) => t.varName)).toEqual(['STRIPE', 'OTHER']);
    expect(mine.value?.resolutions).toEqual({ STRIPE: 'mine' });
  });

  test('cancelling the question ends the step with the prompt\'s own error: nothing is rotated and nothing is written', async () => {
    const { server, settle } = world(undefined);
    ask.mockImplementationOnce(async () => {
      throw new Error('prompt cancelled');
    });
    await expect(settle(targets('STRIPE'))).rejects.toThrow('prompt cancelled');
    expect(server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a variable nobody else changed is not asked about', async () => {
    const done = await captured(() => world(undefined).settle(targets('OTHER')));
    expect(ask).not.toHaveBeenCalled();
    expect(done.value?.rotate.map((t) => t.varName)).toEqual(['OTHER']);
  });
});
