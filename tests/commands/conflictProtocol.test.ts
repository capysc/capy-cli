/**
 * The non-TTY conflict protocol (CAP-717, docs/conflict-resolution.md), driven through the BUILT cli (`dist/index.js`):
 * the real argument parser, the real stdin, an isolated HOME and a mock service that remembers every push
 * (tests/helpers/pipedHarness.ts). Needs `bun run build` first.
 *
 * The world is the Oct 2 incident in miniature. The folder is pinned to an old snapshot of the branch and holds
 * ITS OWN edit of X (a teammate's newer X is already on the server). Every command that writes must:
 *   - stop at the conflict: exit 3, `{ ok:false, code:'SECRETS_CONFLICT', conflict_id, conflicts }` on stdout and
 *     nothing else there, the explanation on stderr, no value anywhere, NOTHING uploaded and the folder untouched;
 *   - on a rerun with `--resolve X=mine|theirs --conflict <id>`: write what was chosen and nothing else;
 *   - refuse a rerun whose state moved (`SECRETS_CONFLICT_STALE`, a new id, nothing written), answer a partial
 *     set of decisions with the names still open, and refuse `--resolve` without `--conflict`.
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
const ALL_SENTINELS = [OLD.X, OLD.Y, MINE, THEIRS, THEIRS_AGAIN];

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
  h.setBranchData(PROJECT_ID, BRANCH, { env_file: lines.join('\n'), permissions: [], keep_file: JSON.stringify(keepOf(values)) });
}

/** What the last accepted push left on the server for `name`, decrypted. */
function pushedValue(h: Harness, name: string): string | undefined {
  const file = join(h.root, 'store.json');
  if (!existsSync(file)) return undefined;
  const store = JSON.parse(readFileSync(file, 'utf8')) as { keep?: KeepFile; blobs: Record<string, string> };
  if (store.keep === undefined) return undefined;
  const blob = store.blobs[SyncEngine.computeKeepHash(store.keep, BRANCH)] ?? '';
  const line = blob.split('\n').find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : new FileManager(h.project).decryptValue(line.slice(name.length + 1), h.projectKey);
}

const json = (r: CliResult): Record<string, any> => JSON.parse(r.stdout) as Record<string, any>;
const noValuesIn = (r: CliResult): void => ALL_SENTINELS.forEach((s) => expect(`${r.stdout}\n${r.stderr}`).not.toContain(s));

describe('the non-TTY conflict protocol (built cli)', () => {
  const state = { h: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.h) throw new Error('harness not ready');
    return state.h;
  };
  beforeEach(async () => {
    Object.assign(state, { h: await createHarness() });
    // Folder: pinned to the old snapshot, with its own edit of X. Server: a teammate already saved a newer X.
    seedFolder(h(), OLD, { X: MINE, Y: OLD.Y });
    seedServer(h(), { X: THEIRS, Y: OLD.Y });
  });
  afterEach(async () => {
    await state.h?.dispose();
  });

  /** The conflict a first run reports, and the folder/server facts every refusal must leave untouched. */
  async function firstRefusal(args: readonly string[], stdin?: string): Promise<{ readonly result: CliResult; readonly id: string }> {
    const result = await h().run(args, stdin);
    expect(result.code).toBe(3);
    const out = json(result);
    expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(Object.keys(out).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
    expect(out.conflict_id).toMatch(/^c_[0-9a-f]{12}$/);
    noValuesIn(result);
    // Nothing uploaded; the folder is as it was.
    expect(h().pushCount()).toBe(0);
    expect(h().envValue('X')).toBe(MINE);
    return { result, id: out.conflict_id as string };
  }

  describe('capy edit NAME < value (piped)', () => {
    test('stops at the conflict: exit 3, the payload on stdout, fingerprints only, prose on stderr, nothing uploaded', async () => {
      const { result } = await firstRefusal(['edit', 'X', '--json'], `${MINE}\n`);
      expect(json(result).conflicts).toEqual([
        {
          kind: 'source',
          name: 'X',
          project: 'piped-test',
          branch: BRANCH,
          pinned: hash16(OLD.X),
          yours: hash16(MINE),
          theirs: hash16(THEIRS),
          theirs_changed_at: '2026-10-01T21:44:18.000Z',
        },
      ]);
      expect(result.stderr).toContain('X');
      expect(result.stderr).toContain('Nothing was written');
    });

    test('without --json it is the same protocol: still JSON on stdout, exit 3', async () => {
      const result = await h().run(['edit', 'X'], `${MINE}\n`);
      expect(result.code).toBe(3);
      expect(json(result)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
      expect(h().pushCount()).toBe(0);
    });

    test('rerun with mine: MY value is what the server decrypts to', async () => {
      const { id } = await firstRefusal(['edit', 'X', '--json'], `${MINE}\n`);
      const rerun = await h().run(['edit', 'X', '--json', '--resolve', 'X=mine', '--conflict', id], `${MINE}\n`);
      expect(rerun.code).toBe(0);
      expect(json(rerun)).toMatchObject({ ok: true, name: 'X', pushed: true });
      expect(h().pushCount()).toBe(1);
      expect(pushedValue(h(), 'X')).toBe(MINE);
      expect(pushedValue(h(), 'Y')).toBe(OLD.Y);
    });

    test('rerun with theirs: nothing is uploaded and the folder takes THEIR value', async () => {
      const { id } = await firstRefusal(['edit', 'X', '--json'], `${MINE}\n`);
      const rerun = await h().run(['edit', 'X', '--json', '--resolve', 'X=theirs', '--conflict', id], `${MINE}\n`);
      expect(rerun.code).toBe(0);
      expect(h().pushCount()).toBe(0);
      expect(h().envValue('X')).toBe(THEIRS);
    });

    test('a rerun whose state moved is SECRETS_CONFLICT_STALE: a new id, the fresh conflict, nothing written', async () => {
      const { id } = await firstRefusal(['edit', 'X', '--json'], `${MINE}\n`);
      seedServer(h(), { X: THEIRS_AGAIN, Y: OLD.Y }); // another writer moved X again
      const rerun = await h().run(['edit', 'X', '--json', '--resolve', 'X=mine', '--conflict', id], `${MINE}\n`);
      expect(rerun.code).toBe(3);
      const out = json(rerun);
      expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE' });
      expect(out.conflict_id).not.toBe(id);
      expect(out.conflicts[0]).toMatchObject({ name: 'X', theirs: hash16(THEIRS_AGAIN) });
      noValuesIn(rerun);
      expect(h().pushCount()).toBe(0);
      expect(h().envValue('X')).toBe(MINE);
      // ... and the NEW id works.
      const again = await h().run(['edit', 'X', '--json', '--resolve', 'X=mine', '--conflict', out.conflict_id], `${MINE}\n`);
      expect(again.code).toBe(0);
      expect(pushedValue(h(), 'X')).toBe(MINE);
    });

    test('--resolve without --conflict is refused with a code, and nothing is read or written', async () => {
      const result = await h().run(['edit', 'X', '--json', '--resolve', 'X=mine'], `${MINE}\n`);
      expect(result.code).toBe(1);
      expect(json(result)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_NEEDS_CONFLICT' });
      expect(h().pushCount()).toBe(0);
    });

    test('a malformed --resolve is SECRETS_RESOLVE_INVALID', async () => {
      const result = await h().run(['edit', 'X', '--json', '--resolve', 'X:mine', '--conflict', 'c_9f2e41a07b3d'], `${MINE}\n`);
      expect(result.code).toBe(1);
      expect(json(result)).toMatchObject({ ok: false, code: 'SECRETS_RESOLVE_INVALID' });
    });

    test('--dry-run previews the same conflict_id and writes nothing', async () => {
      const real = await firstRefusal(['edit', 'X', '--json'], `${MINE}\n`);
      const preview = await h().run(['edit', 'X', '--json', '--dry-run'], `${MINE}\n`);
      expect(preview.code).toBe(3);
      expect(json(preview)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: real.id });
      noValuesIn(preview);
      expect(h().pushCount()).toBe(0);
    });
  });

  describe('capy add NAME --force < value (piped)', () => {
    test('stops at the conflict, and a rerun with mine writes my value', async () => {
      const { id } = await firstRefusal(['add', 'X', '--force', '--json'], `${MINE}\n`);
      const rerun = await h().run(['add', 'X', '--force', '--json', '--resolve', 'X=mine', '--conflict', id], `${MINE}\n`);
      expect(rerun.code).toBe(0);
      expect(pushedValue(h(), 'X')).toBe(MINE);
    });
  });

  describe('capy remove', () => {
    test('stops at the conflict, with --dry-run previewing the same id; a rerun with mine removes only what was named', async () => {
      const args = ['remove', 'X', '--yes', '--json'];
      const { id } = await firstRefusal(args);
      const preview = await h().run([...args, '--dry-run']);
      expect(preview.code).toBe(3);
      expect(json(preview)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: id });
      expect(json(preview).conflicts[0]).toMatchObject({ name: 'X', yours: null, theirs: hash16(THEIRS) });
      expect(h().pushCount()).toBe(0);

      const rerun = await h().run([...args, '--resolve', 'X=mine', '--conflict', id]);
      expect(rerun.code).toBe(0);
      expect(h().pushCount()).toBe(1);
      expect(pushedValue(h(), 'X')).toBeUndefined();
      expect(pushedValue(h(), 'Y')).toBe(OLD.Y);
    });

    test('a name nobody else touched is removed without a question', async () => {
      const result = await h().run(['remove', 'Y', '--yes', '--json']);
      expect(result.code).toBe(0);
      expect(pushedValue(h(), 'Y')).toBeUndefined();
      expect(pushedValue(h(), 'X')).toBe(THEIRS); // the teammate's X survives
    });
  });

  describe('capy push', () => {
    test('stops at the conflict (stdin is not a terminal), and a rerun with mine pushes my edit', async () => {
      const { id } = await firstRefusal(['push']);
      const rerun = await h().run(['push', '--resolve', 'X=mine', '--conflict', id]);
      expect(rerun.code).toBe(0);
      expect(pushedValue(h(), 'X')).toBe(MINE);
      expect(pushedValue(h(), 'Y')).toBe(OLD.Y);
    });

    test('partial decisions get the names still open, under the id of the whole set', async () => {
      seedFolder(h(), OLD, { X: MINE, Y: 'SENTINEL-y-mine-77aa' });
      seedServer(h(), { X: THEIRS, Y: 'SENTINEL-y-theirs-91bc' });
      const first = await h().run(['push']);
      expect(first.code).toBe(3);
      const out = json(first);
      expect(out.conflicts.map((c: { name: string }) => c.name)).toEqual(['X', 'Y']);
      const partial = await h().run(['push', '--resolve', 'X=mine', '--conflict', out.conflict_id]);
      expect(partial.code).toBe(3);
      expect(json(partial)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: out.conflict_id });
      expect(json(partial).conflicts.map((c: { name: string }) => c.name)).toEqual(['Y']);
      expect(h().pushCount()).toBe(0);
      const full = await h().run(['push', '--resolve', 'X=mine', '--resolve', 'Y=theirs', '--conflict', out.conflict_id]);
      expect(full.code).toBe(0);
      expect(pushedValue(h(), 'X')).toBe(MINE);
      expect(pushedValue(h(), 'Y')).toBe('SENTINEL-y-theirs-91bc');
    });

    test('a variable deleted from .env is pushed as a removal and is not resurrected (CAP-712 follow-up)', async () => {
      // Nobody else touched anything: the folder is current and only deleted Y.
      seedFolder(h(), OLD, { X: OLD.X });
      seedServer(h(), OLD);
      const result = await h().run(['push']);
      expect(result.code).toBe(0);
      expect(pushedValue(h(), 'Y')).toBeUndefined();
      expect(pushedValue(h(), 'X')).toBe(OLD.X);
      expect(h().envValue('Y')).toBeUndefined();
    });

    test('a deletion is conflict-checked like an edit: Y changed on the server since this folder pinned it', async () => {
      seedFolder(h(), OLD, { X: OLD.X }); // Y deleted locally
      seedServer(h(), { X: OLD.X, Y: 'SENTINEL-y-theirs-91bc' });
      const result = await h().run(['push']);
      expect(result.code).toBe(3);
      expect(json(result).conflicts[0]).toMatchObject({ name: 'Y', yours: null, theirs: hash16('SENTINEL-y-theirs-91bc') });
      expect(h().pushCount()).toBe(0);
    });
  });
});

describe('capy secrets set NAME (built cli)', () => {
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

  test('--dry-run with the value reports the conflict and the plan_id; the real run is stopped the same way before anything is pushed', async () => {
    const preview = await h().run([...SET, '--dry-run'], `${MINE}\n`);
    expect(preview.code).toBe(3);
    const out = json(preview);
    expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true });
    expect(out.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(out.conflicts[0]).toMatchObject({ kind: 'source', name: 'X', pinned: hash16(OLD.X), yours: hash16(MINE), theirs: hash16(THEIRS) });
    noValuesIn(preview);

    const real = await h().run([...SET, '--confirm', out.plan_id], `${MINE}\n`);
    expect(real.code).toBe(3);
    expect(json(real)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: out.conflict_id });
    noValuesIn(real);
    expect(h().pushCount()).toBe(0);
  });

  test('rerun with mine pushes MY value; with theirs it pushes nothing and leaves their value', async () => {
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    const base = [...SET, '--confirm', preview.plan_id as string, '--conflict', preview.conflict_id as string];

    const theirs = await h().run([...base, '--resolve', 'X=theirs'], `${MINE}\n`);
    expect(theirs.code).toBe(0);
    expect(h().pushCount()).toBe(0);

    const mine = await h().run([...base, '--resolve', 'X=mine'], `${MINE}\n`);
    expect(mine.code).toBe(0);
    expect(h().pushCount()).toBe(1);
    expect(pushedValue(h(), 'X')).toBe(MINE);
  });

  test('a rerun whose location moved again is stale: a new id, nothing pushed', async () => {
    const preview = json(await h().run([...SET, '--dry-run'], `${MINE}\n`));
    seedServer(h(), { X: THEIRS_AGAIN });
    const stale = await h().run([...SET, '--confirm', preview.plan_id as string, '--conflict', preview.conflict_id as string, '--resolve', 'X=mine'], `${MINE}\n`);
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
    expect(pushedValue(h(), 'X')).toBe(MINE);
  });
});

describe('bare capy off a terminal (built cli)', () => {
  const state = { h: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.h) throw new Error('harness not ready');
    return state.h;
  };
  beforeEach(async () => {
    Object.assign(state, { h: await createHarness() });
    seedFolder(h(), OLD, { X: MINE, Y: OLD.Y });
    seedServer(h(), { X: THEIRS, Y: OLD.Y });
  });
  afterEach(async () => {
    await state.h?.dispose();
  });

  test('both sides changed X: exit 3 with the payload alone on stdout (no banner), prose on stderr, nothing uploaded', async () => {
    const result = await h().run([], '');
    expect(result.code).toBe(3);
    const out = json(result); // stdout is JSON and nothing else
    expect(Object.keys(out).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
    expect(out).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ kind: 'source', name: 'X', pinned: hash16(OLD.X), yours: hash16(MINE), theirs: hash16(THEIRS) });
    noValuesIn(result);
    expect(h().pushCount()).toBe(0);
    expect(h().envValue('X')).toBe(MINE);
  });

  test('rerun with mine commits MY change on top of the server\'s latest, and pulls what others changed', async () => {
    seedFolder(h(), OLD, { X: MINE, Y: OLD.Y });
    seedServer(h(), { X: THEIRS, Y: 'SENTINEL-y-theirs-91bc' }); // a teammate also moved Y, which this folder did not touch
    const first = await h().run([], '');
    const id = json(first).conflict_id as string;
    const rerun = await h().run(['--resolve', 'X=mine', '--conflict', id], '');
    expect(rerun.code).toBe(0);
    expect(h().pushCount()).toBe(1);
    expect(pushedValue(h(), 'X')).toBe(MINE);
    expect(pushedValue(h(), 'Y')).toBe('SENTINEL-y-theirs-91bc'); // untouched by this folder
    expect(h().envValue('Y')).toBe('SENTINEL-y-theirs-91bc');
  });

  test('rerun with theirs uploads nothing and the folder takes their value', async () => {
    const id = json(await h().run([], '')).conflict_id as string;
    const rerun = await h().run(['--resolve', 'X=theirs', '--conflict', id], '');
    expect(rerun.code).toBe(0);
    expect(h().pushCount()).toBe(0);
    expect(h().envValue('X')).toBe(THEIRS);
  });

  test('a stale id gets a fresh conflict and a new id; --resolve without --conflict is refused with a code', async () => {
    const id = json(await h().run([], '')).conflict_id as string;
    seedServer(h(), { X: THEIRS_AGAIN, Y: OLD.Y });
    const stale = await h().run(['--resolve', 'X=mine', '--conflict', id], '');
    expect(stale.code).toBe(3);
    expect(json(stale)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE' });
    expect(json(stale).conflict_id).not.toBe(id);
    expect(h().pushCount()).toBe(0);

    const bare = await h().run(['--resolve', 'X=mine'], '');
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('--conflict');
    expect(h().pushCount()).toBe(0);
  });
});
