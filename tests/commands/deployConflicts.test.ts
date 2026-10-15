/**
 * `capy deploy` and conflicts (CAP-717): before a delivery writes anything, the values it is about to deliver are
 * compared with Capy's latest for the branch (SOURCE, the folder against the server) and, on Dokploy, with the
 * service's live env (TARGET). This drives `reconcileDeployConflicts`, the step `deployCommand` takes before the CI
 * gate, a mint or a write, against the in-memory Capy server of tests/helpers/fakeCapyServer.ts and a real folder.
 *
 * The properties: a variable the folder did not change is never delivered stale (Capy's latest is pulled in); a
 * variable both sides changed is a conflict that stops the deploy off a terminal (exit-3 payload, nothing uploaded,
 * the folder untouched) and, once answered, is either committed first and delivered (mine) or taken from Capy
 * (theirs); a folder edit nobody else touched is delivered as always and NOT committed; source and target
 * conflicts are answered in one step under one conflict_id.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';
import type { DeployAdapter } from '../../src/deploy/adapter';
import { FIXED_PROJECT_KEY, fixedKeyResolver } from '../helpers/deployServer';
import { fakeCapyServer, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = FIXED_PROJECT_KEY;
const currentServer = mock((): ReturnType<typeof fakeCapyServer> => {
  throw new Error('no server for this test');
});

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return { success: true, user_id: 'user-b' };
    }
    async getValidToken() {
      return 'fake-session-token';
    }
  },
  silentAuthFailureMessage: () => 'auth failed',
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    getDecryptData(...args: unknown[]) {
      return (currentServer().getDecryptData as (...a: unknown[]) => unknown)(...args);
    }
    pushSecrets(...args: unknown[]) {
      return (currentServer().pushSecrets as (...a: unknown[]) => unknown)(...args);
    }
  },
}));
mock.module('../../src/crypto/keyResolver', () => fixedKeyResolver());
const ask = mock(async (_conflicts: readonly unknown[]) => ({}) as Record<string, 'mine' | 'theirs'>);
mock.module('../../src/commands/conflictPrompt', () => ({ askConflicts: ask }));

import { reconcileDeployConflicts, type ReconcileInput } from '../../src/commands/deployConflicts';
import { ConflictRefusal, parseConflictFlags, type Conflict } from '../../src/sync/conflicts';
import { hashValue } from '../../src/sync/compareSecrets';
import type { KeepFile } from '../../src/types/index';

const BRANCH = 'production';
const OLD = { X: 'x-old', Y: 'y-old' } as const;
const THEIRS = 'x-theirs-from-A';
const MINE = 'x-mine-from-B';

const OLD_SEED = seedServer({ projectKey: KEY, values: { [BRANCH]: OLD } });
const NEW_SEED = seedServer({ projectKey: KEY, values: { [BRANCH]: { X: THEIRS, Y: OLD.Y } } });

const made = mock((_: Folder) => undefined);
afterEach(() => {
  made.mock.calls.forEach(([folder]) => removeFolder(folder));
  made.mockClear();
  ask.mockClear();
});

/** A folder pinned to the old snapshot holding `env`, and a server holding `server` (default: a teammate's newer X). */
function world(env: Record<string, string>, server: typeof NEW_SEED = NEW_SEED) {
  const fake = fakeCapyServer({ initial: server });
  currentServer.mockImplementation(() => fake);
  const folder = makeFolder({ projectKey: KEY, branch: BRANCH, keep: OLD_SEED.keep as KeepFile, env, client: fake.client });
  made(folder);
  return { fake, folder };
}

/** An adapter that delivers plain values and, optionally, reports live-value conflicts the way Dokploy does. */
function adapterWith(live: readonly Conflict[] = []): DeployAdapter & { readonly deploy: ReturnType<typeof mock> } {
  const deploy = mock(async (_target: unknown, ctx: { dryRun: boolean; targetCheck?: { resolutions: Record<string, string> } }) => ({
    ok: true,
    steps: [],
    conflicts: ctx.dryRun ? live : undefined,
  }));
  return { id: 'dokploy', label: 'x', description: '', varKind: 'runtime', defaultMode: 'ci', readsLiveValues: live.length > 0, requires: { binaries: [] }, detect: async () => ({}), preflight: async () => ({ ok: true }), deploy } as unknown as DeployAdapter & {
    readonly deploy: ReturnType<typeof mock>;
  };
}

const target = (vars: readonly string[] = ['X', 'Y']) => ({ name: 'dokploy-production', kind: 'dokploy', branch: BRANCH, vars: [...vars], options: {}, mode: 'ci' as const });

const input = (folder: Folder, adapter: DeployAdapter, over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  cwd: folder.dir,
  target: target(),
  adapter,
  dryRun: false,
  interactive: false,
  flags: { resolutions: {}, conflictId: undefined },
  adapterCtx: {},
  showFailure: () => undefined,
  ...over,
});

/** The refusal a non-interactive reconcile throws. */
async function refusal(run: () => Promise<unknown>): Promise<ConflictRefusal> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictRefusal);
  return err as ConflictRefusal;
}

describe('capy deploy: source conflicts', () => {
  test('the folder changed X, a teammate changed X: off a terminal the deploy stops with the payload — nothing uploaded, the folder untouched, no value in it', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const stopped = await refusal(() => reconcileDeployConflicts(input(folder, adapterWith())));
    expect(stopped.payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(stopped.payload.conflicts).toEqual([
      expect.objectContaining({ kind: 'source', name: 'X', pinned: hashValue(OLD.X), yours: hashValue(MINE), theirs: hashValue(THEIRS) }),
    ]);
    expect(JSON.stringify(stopped.payload)).not.toContain(MINE);
    expect(JSON.stringify(stopped.payload)).not.toContain(THEIRS);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
    expect(folder.env()).toEqual({ X: MINE, Y: OLD.Y });
  });

  test('mine: the folder\'s value is committed through the commit path FIRST (the server now holds it), and that is what gets delivered', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const id = (await refusal(() => reconcileDeployConflicts(input(folder, adapterWith())))).payload.conflict_id;
    const flags = parseConflictFlags({ resolve: ['X=mine'], conflict: id });
    const done = await reconcileDeployConflicts(input(folder, adapterWith(), { flags }));
    expect(done.ok).toBe(true);
    expect(fake.pushSecrets.mock.calls).toHaveLength(1);
    expect(serverValues(fake.state(), BRANCH, KEY)).toEqual({ X: MINE, Y: OLD.Y });
    expect(folder.env().X).toBe(MINE);
  });

  test('theirs: nothing is uploaded and the folder takes Capy\'s latest (so Capy\'s latest is what gets delivered)', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const id = (await refusal(() => reconcileDeployConflicts(input(folder, adapterWith())))).payload.conflict_id;
    const done = await reconcileDeployConflicts(input(folder, adapterWith(), { flags: parseConflictFlags({ resolve: ['X=theirs'], conflict: id }) }));
    expect(done.ok).toBe(true);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
    expect(folder.env().X).toBe(THEIRS);
  });

  test('a variable the folder did NOT change, that Capy moved, is not a conflict: Capy\'s latest is pulled in, never the stale value', async () => {
    const { fake, folder } = world({ X: OLD.X, Y: OLD.Y }); // the folder is simply behind
    const done = await reconcileDeployConflicts(input(folder, adapterWith()));
    expect(done.ok).toBe(true);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
    expect(folder.env().X).toBe(THEIRS);
    expect(folder.pin('X')).toBe(hashValue(THEIRS));
  });

  test('a folder edit nobody else touched is delivered as it always was and is NOT committed by the deploy', async () => {
    const { fake, folder } = world({ X: OLD.X, Y: 'y-edited' }, OLD_SEED);
    const done = await reconcileDeployConflicts(input(folder, adapterWith()));
    expect(done.ok).toBe(true);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
    expect(folder.env().Y).toBe('y-edited'); // still the folder's edit
  });

  test('a folder that agrees with Capy is left alone: no write of any kind', async () => {
    const { fake, folder } = world({ X: OLD.X, Y: OLD.Y }, OLD_SEED);
    const before = JSON.stringify(folder.keep());
    await reconcileDeployConflicts(input(folder, adapterWith()));
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
    expect(JSON.stringify(folder.keep())).toBe(before);
  });

  test('--dry-run reports the conflict (dry_run: true, the same id) and writes nothing', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const real = await refusal(() => reconcileDeployConflicts(input(folder, adapterWith())));
    const preview = await refusal(() => reconcileDeployConflicts(input(folder, adapterWith(), { dryRun: true })));
    expect(preview.payload).toMatchObject({ dry_run: true, conflict_id: real.payload.conflict_id });
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('in a terminal every conflict is a question (mine / theirs), and the answer is applied', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    ask.mockImplementationOnce(async () => ({ X: 'mine' }));
    const done = await reconcileDeployConflicts(input(folder, adapterWith(), { interactive: true }));
    expect(done.ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(serverValues(fake.state(), BRANCH, KEY).X).toBe(MINE);
  });
});

describe('capy deploy: source and target conflicts in one step', () => {
  const live: Conflict = { kind: 'target', name: 'Y', target: 'dokploy-production', pinned: null, yours: hashValue(OLD.Y), theirs: 'deadbeefdeadbeef' };

  test('one payload carries both kinds under one conflict_id; the answers split between the folder and the adapter', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const adapter = adapterWith([live]);
    const first = await refusal(() => reconcileDeployConflicts(input(folder, adapter)));
    expect(first.payload.conflicts.map((c) => `${c.kind}:${c.name}`)).toEqual(['source:X', 'target:Y']);
    // Nothing is written before every conflict is answered: the adapter was only asked to LOOK.
    expect(adapter.deploy.mock.calls.every(([, ctx]) => (ctx as { dryRun: boolean }).dryRun)).toBe(true);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);

    const flags = parseConflictFlags({ resolve: ['X=mine', 'Y@dokploy-production=theirs'], conflict: first.payload.conflict_id });
    const done = await reconcileDeployConflicts(input(folder, adapter, { flags }));
    expect(done).toMatchObject({ ok: true, skipped: ['Y'] });
    expect(done.ok && done.targetCheck?.resolutions).toEqual({ Y: 'theirs' });
    expect(serverValues(fake.state(), BRANCH, KEY).X).toBe(MINE);
  });

  test('answering only the source conflict leaves the target one open: the remaining names come back and nothing is written', async () => {
    const { fake, folder } = world({ X: MINE, Y: OLD.Y });
    const adapter = adapterWith([live]);
    const first = await refusal(() => reconcileDeployConflicts(input(folder, adapter)));
    const partial = await refusal(() =>
      reconcileDeployConflicts(input(folder, adapter, { flags: parseConflictFlags({ resolve: ['X=mine'], conflict: first.payload.conflict_id }) })),
    );
    expect(partial.payload.code).toBe('SECRETS_CONFLICT');
    expect(partial.payload.conflict_id).toBe(first.payload.conflict_id);
    expect(partial.payload.conflicts.map((c) => `${c.kind}:${c.name}`)).toEqual(['target:Y']);
    expect(fake.pushSecrets.mock.calls).toHaveLength(0);
  });
});
