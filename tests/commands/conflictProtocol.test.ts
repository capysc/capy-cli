/**
 * Bare `capy` runs first, and off a terminal it answers by protocol (CAP-717; docs/conflict-resolution.md). Driven
 * through the BUILT cli (`dist/index.js`): the real argument parser, the real stdin, an isolated HOME and a mock
 * service that remembers every push (tests/helpers/pipedHarness.ts). Needs `bun run build` first.
 *
 * Two worlds. In both, the folder is pinned to an old snapshot of the branch and a teammate has saved a newer X since
 * (the Oct 2 incident):
 *   - STALE: the folder's `.env` still holds the old values (nothing changed here);
 *   - EDITED: the folder's `.env` also holds ITS OWN edit of X.
 *
 * Every command that writes from a folder must:
 *   - stop at the difference before doing anything of its own: exit 3, `{ ok:false, code:'SECRETS_CONFLICT',
 *     conflict_id, conflicts }` on stdout and nothing else there (rows are bare `capy`'s `compareSecrets` rows:
 *     `name, project, branch, type, pinned, local, remote`), the explanation on stderr, no value anywhere, NOTHING
 *     uploaded and the folder untouched;
 *   - on a rerun with `--resolve X=pinned|local|remote|delete --conflict <id>`: apply the answer as bare `capy`'s
 *     individual resolution, commit it so the folder and Capy agree, THEN write only its own change on top;
 *   - refuse a rerun whose state moved (`SECRETS_CONFLICT_STALE`, a new id, nothing written), answer a partial set
 *     of answers with the rows still open, and refuse `--resolve` without `--conflict`.
 * The property asserted is always the server's: what its latest DECRYPTS to.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Encryptor } from '../../src/crypto/encryptor';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { FileManager } from '../../src/files/fileManager';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { KeepFile } from '../../src/types/index';
import { createHarness, BRANCH, ORG_ID, PROJECT_ID, type CliResult, type Harness } from '../helpers/pipedHarness';

const hash16 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);

// Values no output may ever carry.
const OLD = { X: 'SENTINEL-x-old-7a1c', Y: 'SENTINEL-y-old-3b9d' } as const;
const MINE = 'SENTINEL-x-mine-51e2';
const THEIRS = 'SENTINEL-x-theirs-c04f';
const THEIRS_AGAIN = 'SENTINEL-x-theirs-AGAIN-88d1';
const NEW_Z = 'SENTINEL-z-new-d2e8';
const ALL_SENTINELS = [OLD.X, OLD.Y, MINE, THEIRS, THEIRS_AGAIN, NEW_Z];

const keepOf = (values: Readonly<Record<string, string>>): KeepFile => ({
  version: '3.0',
  org_id: ORG_ID,
  project_id: PROJECT_ID,
  project_name: 'piped-test',
  variables: Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      [{ resource_id: deriveResourceId(BRANCH, name), branch: BRANCH, value_hash: hash16(value), changed_at: '2026-10-01T21:44:18.000Z' }],
    ]),
  ),
});

/** The folder: pinned to `pinned`, its `.env` holding `local`. */
function seedFolder(h: Harness, pinned: Readonly<Record<string, string>>, local: Readonly<Record<string, string>>): void {
  const files = new FileManager(h.project);
  const keep = keepOf(pinned);
  files.writeKeepFile(keep);
  files.writeEncryptedEnvFile({ ...local }, h.projectKey, undefined, keep, BRANCH);
}

/** What the server holds for the branch right now (replaces the last fixture). */
function seedServer(h: Harness, values: Readonly<Record<string, string>>): void {
  const lines = Object.entries(values).map(([name, value]) => `${name}=capy:${deriveResourceId(BRANCH, name)}:${Encryptor.encrypt(value, h.projectKey)}`);
  h.setBranchData(PROJECT_ID, BRANCH, { env_file: lines.join('\n'), permissions: [], keep_hash: SyncEngine.computeKeepHash(keepOf(values), BRANCH), keep_file: JSON.stringify(keepOf(values)) });
}

/** What the server's latest decrypts to for `name`: the last accepted push, else the fixture. */
function serverValue(h: Harness, name: string): string | undefined {
  const file = join(h.root, 'store.json');
  const fixture = join(h.root, `branch-${PROJECT_ID}-${BRANCH}.json`);
  const fm = new FileManager(h.project);
  const envFile = existsSync(file)
    ? (() => {
        const store = JSON.parse(readFileSync(file, 'utf8')) as { keep?: KeepFile; blobs: Record<string, string> };
        return store.keep === undefined ? '' : (store.blobs[SyncEngine.computeKeepHash(store.keep, BRANCH)] ?? '');
      })()
    : existsSync(fixture)
      ? (JSON.parse(readFileSync(fixture, 'utf8')) as { env_file: string }).env_file
      : '';
  const line = envFile.split('\n').find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : fm.decryptValue(line.slice(name.length + 1), h.projectKey);
}

const json = (r: CliResult): Record<string, any> => JSON.parse(r.stdout) as Record<string, any>;
const noValuesIn = (r: CliResult): void => ALL_SENTINELS.forEach((s) => expect(`${r.stdout}\n${r.stderr}`).not.toContain(s));

const rowX = (pinned: string, local: string, remote: string) => ({
  name: 'X',
  project: 'piped-test',
  branch: BRANCH,
  type: 'changed',
  pinned: hash16(pinned),
  local: hash16(local),
  remote: hash16(remote),
});

describe('bare capy first, off a terminal (built cli)', () => {
  const state = { h: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.h) throw new Error('harness not ready');
    return state.h;
  };
  beforeEach(async () => {
    Object.assign(state, { h: await createHarness() });
    // Folder: pinned to the old snapshot, nothing edited. Server: a teammate already saved a newer X.
    seedFolder(h(), OLD, OLD);
    seedServer(h(), { X: THEIRS, Y: OLD.Y });
  });
  afterEach(async () => {
    await state.h?.dispose();
  });

  /** What a first run reports, and the facts every refusal must leave untouched. */
  async function firstRefusal(args: readonly string[], stdin?: string): Promise<{ readonly result: CliResult; readonly id: string }> {
    const result = await h().run(args, stdin);
    expect(result.code).toBe(3);
    const out = json(result);
    expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(Object.keys(out).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
    expect(out.conflict_id).toMatch(/^c_[0-9a-f]{12}$/);
    expect(out.conflicts).toEqual([rowX(OLD.X, OLD.X, THEIRS)]);
    noValuesIn(result);
    // Nothing uploaded; the folder is as it was.
    expect(h().pushCount()).toBe(0);
    expect(h().envValue('X')).toBe(OLD.X);
    return { result, id: out.conflict_id as string };
  }

  describe('Oct 2: a stale folder, every writer', () => {
    test('capy edit Z (piped): stops with the row, no value, nothing uploaded; remote takes their X, then Z lands on top', async () => {
      const { result, id } = await firstRefusal(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      expect(result.stderr).toContain('X');
      const rerun = await h().run(['edit', 'Z', '--json', '--resolve', 'X=remote', '--conflict', id], `${NEW_Z}\n`);
      expect(rerun.code).toBe(0);
      expect(json(rerun)).toMatchObject({ ok: true, name: 'Z', pushed: true });
      // The property: what a teammate saved is still what Capy holds, and Z is there too.
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(serverValue(h(), 'Y')).toBe(OLD.Y);
      expect(serverValue(h(), 'Z')).toBe(NEW_Z);
      // The folder took Capy's X.
      expect(h().envValue('X')).toBe(THEIRS);
      expect(h().envValue('Z')).toBe(NEW_Z);
    });

    test('capy add Z (piped): the same', async () => {
      const { id } = await firstRefusal(['add', 'Z', '--json'], `${NEW_Z}\n`);
      const rerun = await h().run(['add', 'Z', '--json', '--resolve', 'X=remote', '--conflict', id], `${NEW_Z}\n`);
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(serverValue(h(), 'Z')).toBe(NEW_Z);
      expect(h().envValue('X')).toBe(THEIRS);
    });

    test('capy remove Y --yes: the same, and only Y goes', async () => {
      const args = ['remove', 'Y', '--yes', '--json'];
      const { id } = await firstRefusal(args);
      const rerun = await h().run([...args, '--resolve', 'X=remote', '--conflict', id]);
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'Y')).toBeUndefined();
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(h().envValue('X')).toBe(THEIRS);
    });

    test('capy push: bare capy IS the push; remote leaves Capy as it is and the folder takes it', async () => {
      const { id } = await firstRefusal(['push']);
      const rerun = await h().run(['push', '--resolve', 'X=remote', '--conflict', id]);
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(h().envValue('X')).toBe(THEIRS);
    });

    test('bare capy: stdout is the payload alone (no banner), prose on stderr', async () => {
      const result = await h().run([], '');
      expect(result.code).toBe(3);
      expect(Object.keys(json(result)).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
      noValuesIn(result);
      expect(h().pushCount()).toBe(0);
    });

    test('after the answer, the folder and Capy agree: bare capy has nothing to say', async () => {
      const { id } = await firstRefusal(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      await h().run(['edit', 'Z', '--json', '--resolve', 'X=remote', '--conflict', id], `${NEW_Z}\n`);
      const again = await h().run([], '');
      expect(again.code).toBe(0);
      expect(again.stdout).toBe('');
    });

    test('a folder that agrees with Capy is not asked anything: the command goes straight through', async () => {
      seedServer(h(), OLD); // nobody saved since
      const result = await h().run(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      expect(result.code).toBe(0);
      expect(json(result)).toMatchObject({ ok: true, name: 'Z' });
      expect(result.stderr).toBe('');
      expect(serverValue(h(), 'Z')).toBe(NEW_Z);
    });
  });

  describe('the four choices', () => {
    beforeEach(() => {
      // EDITED: the folder also holds its own X.
      seedFolder(h(), OLD, { X: MINE, Y: OLD.Y });
    });

    const rerunWith = async (choice: string) => {
      const first = await h().run(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      expect(first.code).toBe(3);
      expect(json(first).conflicts).toEqual([rowX(OLD.X, MINE, THEIRS)]);
      return h().run(['edit', 'Z', '--json', '--resolve', `X=${choice}`, '--conflict', json(first).conflict_id as string], `${NEW_Z}\n`);
    };

    test('local: MY value is committed to Capy (what its latest decrypts to), then Z', async () => {
      const rerun = await rerunWith('local');
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(MINE);
      expect(serverValue(h(), 'Z')).toBe(NEW_Z);
      expect(serverValue(h(), 'Y')).toBe(OLD.Y);
      expect(h().envValue('X')).toBe(MINE);
    });

    test('remote: THEIR value stays in Capy and the folder takes it', async () => {
      const rerun = await rerunWith('remote');
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(h().envValue('X')).toBe(THEIRS);
    });

    test('pinned, when the pinned value cannot be read here: refused with a code, not guessed (it would delete X); nothing is written', async () => {
      const rerun = await rerunWith('pinned');
      expect(rerun.code).toBe(1);
      expect(json(rerun)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_INVALID' });
      noValuesIn(rerun);
      expect(h().pushCount()).toBe(0);
      expect(h().envValue('X')).toBe(MINE);
    });

    test('delete: X goes from Capy and from the folder', async () => {
      const rerun = await rerunWith('delete');
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBeUndefined();
      expect(h().envValue('X')).toBeUndefined();
      expect(serverValue(h(), 'Z')).toBe(NEW_Z);
    });
  });

  describe('pinned', () => {
    test('the value this folder last agreed on (still in .env here) is committed back, over their newer one', async () => {
      const first = await h().run(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      const rerun = await h().run(['edit', 'Z', '--json', '--resolve', 'X=pinned', '--conflict', json(first).conflict_id as string], `${NEW_Z}\n`);
      expect(rerun.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(OLD.X);
      expect(h().envValue('X')).toBe(OLD.X);
    });
  });

  describe('the id binds the answers to what was seen', () => {
    test('a rerun whose state moved is SECRETS_CONFLICT_STALE: the fresh row, a new id, nothing written; the new id works', async () => {
      const { id } = await firstRefusal(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      seedServer(h(), { X: THEIRS_AGAIN, Y: OLD.Y }); // another writer moved X again
      const rerun = await h().run(['edit', 'Z', '--json', '--resolve', 'X=remote', '--conflict', id], `${NEW_Z}\n`);
      expect(rerun.code).toBe(3);
      const out = json(rerun);
      expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE' });
      expect(out.conflict_id).not.toBe(id);
      expect(out.conflicts).toEqual([rowX(OLD.X, OLD.X, THEIRS_AGAIN)]);
      noValuesIn(rerun);
      expect(h().pushCount()).toBe(0);
      expect(h().envValue('X')).toBe(OLD.X);
      const again = await h().run(['edit', 'Z', '--json', '--resolve', 'X=remote', '--conflict', out.conflict_id], `${NEW_Z}\n`);
      expect(again.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(THEIRS_AGAIN);
    });

    test('every row needs an answer: a partial set gets the rows still open, under the id of the whole set', async () => {
      seedFolder(h(), OLD, OLD);
      seedServer(h(), { X: THEIRS, Y: 'SENTINEL-y-theirs-91bc' });
      const first = await h().run(['push']);
      expect(first.code).toBe(3);
      const out = json(first);
      expect(out.conflicts.map((c: { name: string }) => c.name)).toEqual(['X', 'Y']);
      const partial = await h().run(['push', '--resolve', 'X=remote', '--conflict', out.conflict_id]);
      expect(partial.code).toBe(3);
      expect(json(partial)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: out.conflict_id });
      expect(json(partial).conflicts.map((c: { name: string }) => c.name)).toEqual(['Y']);
      expect(h().pushCount()).toBe(0);
      const full = await h().run(['push', '--resolve', 'X=remote', '--resolve', 'Y=pinned', '--conflict', out.conflict_id]);
      expect(full.code).toBe(0);
      expect(serverValue(h(), 'X')).toBe(THEIRS);
      expect(serverValue(h(), 'Y')).toBe(OLD.Y);
    });

    test('--resolve without --conflict is refused with a code, and nothing is read or written', async () => {
      const result = await h().run(['edit', 'Z', '--json', '--resolve', 'X=remote'], `${NEW_Z}\n`);
      expect(result.code).toBe(1);
      expect(json(result)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_NEEDS_CONFLICT' });
      expect(h().pushCount()).toBe(0);
    });

    test('a malformed --resolve is SECRETS_RESOLVE_INVALID; so is mine/theirs, which are not answers any more', async () => {
      const bad = await h().run(['edit', 'Z', '--json', '--resolve', 'X:remote', '--conflict', 'c_9f2e41a07b3d'], `${NEW_Z}\n`);
      expect(bad.code).toBe(1);
      expect(json(bad)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_INVALID' });
      const old = await h().run(['edit', 'Z', '--json', '--resolve', 'X=mine', '--conflict', 'c_9f2e41a07b3d'], `${NEW_Z}\n`);
      expect(old.code).toBe(1);
      expect(json(old)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_INVALID' });
    });

    test('--dry-run reports the same conflict_id with dry_run, and writes nothing', async () => {
      const real = await firstRefusal(['edit', 'Z', '--json'], `${NEW_Z}\n`);
      const preview = await h().run(['edit', 'Z', '--json', '--dry-run'], `${NEW_Z}\n`);
      expect(preview.code).toBe(3);
      expect(json(preview)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: real.id });
      noValuesIn(preview);
      expect(h().pushCount()).toBe(0);
      expect(h().envValue('X')).toBe(OLD.X);
    });
  });
});

describe('capy secrets set NAME with no folder (built cli)', () => {
  const state = { h: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.h) throw new Error('harness not ready');
    return state.h;
  };
  beforeEach(async () => {
    Object.assign(state, { h: await createHarness() });
    // The row `capy secrets` listed holds the OLD X; since then a teammate saved a newer X at the one location.
    h().setSecretsIndex({
      org_id: ORG_ID,
      skipped: [],
      rows: [
        {
          name: 'X',
          value_hash: hash16(OLD.X),
          locations: [{ project_id: PROJECT_ID, project_name: 'piped-test', branch: BRANCH, protected: false, service: null }],
          users: [],
        },
      ],
    });
    seedServer(h(), { X: THEIRS });
  });
  afterEach(async () => {
    await state.h?.dispose();
  });

  const SET = ['secrets', 'set', 'X', '--all-rows', '--no-pr', '--json'];
  const row = { name: 'X', project: 'piped-test', branch: BRANCH, type: 'changed', pinned: hash16(OLD.X), local: hash16(MINE), remote: hash16(THEIRS) };

  test('--dry-run with the value reports the row and the plan_id; the real run is stopped the same way before anything is pushed', async () => {
    const preview = await h().run([...SET, '--dry-run'], `${MINE}\n`);
    expect(preview.code).toBe(3);
    const out = json(preview);
    expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true });
    expect(out.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(out.conflicts).toEqual([row]);
    noValuesIn(preview);

    const real = await h().run([...SET, '--confirm', out.plan_id], `${MINE}\n`);
    expect(real.code).toBe(3);
    expect(json(real)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: out.conflict_id });
    noValuesIn(real);
    expect(h().pushCount()).toBe(0);
  });

  test('rerun with local writes MY value (and names the keep it started from); with remote it pushes nothing and leaves their value', async () => {
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    const base = [...SET, '--confirm', preview.plan_id as string, '--conflict', preview.conflict_id as string];

    const remote = await h().run([...base, '--resolve', 'X=remote'], `${MINE}\n`);
    expect(remote.code).toBe(0);
    expect(h().pushCount()).toBe(0);
    expect(serverValue(h(), 'X')).toBe(THEIRS);

    const local = await h().run([...base, '--resolve', 'X=local'], `${MINE}\n`);
    expect(local.code).toBe(0);
    expect(h().pushCount()).toBe(1);
    expect(serverValue(h(), 'X')).toBe(MINE);
    const push = h().requests().find((r) => r.method === 'POST' && r.path.startsWith('/secrets/'));
    expect(JSON.parse(push?.body ?? '{}').base_keep_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('pinned and delete are not answers to setting a value: refused with a code, nothing pushed', async () => {
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    const base = [...SET, '--confirm', preview.plan_id as string, '--conflict', preview.conflict_id as string];
    const pinned = await h().run([...base, '--resolve', 'X=pinned'], `${MINE}\n`);
    expect(pinned.code).toBe(1);
    expect(json(pinned)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_INVALID' });
    expect(h().pushCount()).toBe(0);
  });

  test('a rerun whose location moved again is stale: a new id, nothing pushed', async () => {
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    seedServer(h(), { X: THEIRS_AGAIN });
    const stale = await h().run([...SET, '--confirm', preview.plan_id as string, '--conflict', preview.conflict_id as string, '--resolve', 'X=local'], `${MINE}\n`);
    expect(stale.code).toBe(3);
    expect(json(stale)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE' });
    expect(json(stale).conflict_id).not.toBe(preview.conflict_id);
    expect(h().pushCount()).toBe(0);
  });

  test('a location nobody changed since its row was listed is set without a question', async () => {
    seedServer(h(), { X: OLD.X });
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    expect(preview.ok).toBe(true);
    const real = await h().run([...SET, '--confirm', preview.plan_id as string], `${MINE}\n`);
    expect(real.code).toBe(0);
    expect(serverValue(h(), 'X')).toBe(MINE);
  });
});
