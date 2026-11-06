/**
 * `capy connect vercel`: a value Vercel will not give back becomes a PLACEHOLDER on the Capy branch it maps to,
 * in every environment (production, preview, development, custom).
 *
 * "Will not give back" is `sensitive_unreadable`, `legacy_secret_unreadable`, or a value route that answers
 * with the structured field `decrypted: false` (`value_not_decrypted`). A value that really is an empty string
 * (`decrypted: true`, value '') stays an `empty_value` skip, and a git-branch-scoped record stays a skip.
 *
 * A placeholder is a flag on the variable's keep.lock entry (core/placeholder.ts), never a value; the run, list and
 * status surfaces are checked here too. Every value in here is a fake sentinel; nothing reaches the network.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { ListCommand } from '../../src/commands/listCommand';
import { FileManager } from '../../src/files/fileManager';
import { placeholderEnvNote, placeholderOf } from '../../src/core/placeholder';
import type { ConnectOpts, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { KeepFile } from '../../src/types/index';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, withExitCodeRestored, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const ALL = ['production', 'preview', 'development'];
const SENTINEL = {
  plain: 'plain-SENT-1a2b',
  sensitive: 'sensitive-SENT-must-never-be-read',
  legacy: 'legacy-SENT-3c4d',
  hidden: 'hidden-SENT-5e6f',
  custom: 'custom-SENT-7a8b',
} as const;

const env = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

const ENVS: ReadonlyArray<RawEnv> = [
  env({ id: 'e_plain', key: 'PLAIN', type: 'plain', target: ALL, listValue: SENTINEL.plain }),
  env({ id: 'e_sens', key: 'SENS', type: 'sensitive', target: ALL }),
  env({ id: 'e_old', key: 'OLD', type: 'secret', target: ['preview'] }),
  env({ id: 'e_hidden', key: 'HIDDEN', type: 'encrypted', target: ['development'], listValue: 'opaque' }),
  env({ id: 'e_empty', key: 'GENUINELY_EMPTY', type: 'encrypted', target: ['production'], listValue: 'opaque' }),
  env({ id: 'e_scoped', key: 'SCOPED', type: 'sensitive', target: ['preview'], gitBranch: 'feature/x' }),
  env({ id: 'e_custom', key: 'CUSTOM_SENS', type: 'sensitive', target: [], customEnvironmentIds: ['c1'] }),
];

const DATA: FakeVercelData = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: ENVS },
  custom: { prj_web: [{ id: 'c1', slug: 'staging' }] },
  // e_hidden: Vercel answers `decrypted: false`; e_empty: it decrypted a value that really is ''.
  values: { e_hidden: SENTINEL.hidden, e_empty: '', e_sens: SENTINEL.sensitive },
  undecrypted: ['e_hidden'],
};

const BASE_OPTS: ConnectOpts = { nonTty: true, project: 'web', tokenEnv: 'T' };

function connector(data: FakeVercelData = DATA) {
  return createVercelConnector({ fetch: fakeVercelFetch(data) as unknown as VercelFetchLike, env: { T: 'tok_fake_value' }, sleep: async () => {} });
}

const ctxWith = (branch: string, localPlaintext: Record<string, string> = {}): ResolvedContext =>
  ({
    keep: { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} },
    branch,
    orgId: 'org_1',
    localPlaintext,
  }) as unknown as ResolvedContext;

const okOutcome = (o: ImportOutcome): Extract<ImportOutcome, { ok: true }> => {
  if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`);
  return o;
};

const codes = (xs: ReadonlyArray<{ name: string; code: string }> | undefined): Record<string, string> =>
  Object.fromEntries((xs ?? []).map((x) => [x.name, x.code]));

describe('import: what becomes a placeholder, in every environment', () => {
  test('production: the sensitive value is a placeholder; a genuine empty string is an empty_value skip', async () => {
    const out = okOutcome(await connector().import!(ctxWith('production'), BASE_OPTS));
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable' });
    expect(codes(out.skipped)).toEqual({ GENUINELY_EMPTY: 'empty_value' });
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
  });

  test('preview: sensitive and legacy secret are placeholders; the git-branch-scoped one stays a skip', async () => {
    const out = okOutcome(await connector().import!(ctxWith('preview'), BASE_OPTS));
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable', OLD: 'legacy_secret_unreadable' });
    expect(out.skipped).toEqual([{ name: 'SCOPED', code: 'git_branch_scoped', gitBranch: 'feature/x' }]);
  });

  test('development: a value Vercel answers with decrypted:false is a placeholder, whatever the answer carries', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development'), BASE_OPTS));
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable', HIDDEN: 'value_not_decrypted' });
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
  });

  test('a custom environment: its sensitive value is a placeholder on the branch named by its slug', async () => {
    const out = okOutcome(await connector().import!(ctxWith('staging'), BASE_OPTS));
    expect(codes(out.placeholders)).toEqual({ CUSTOM_SENS: 'sensitive_unreadable' });
  });

  test('a name that already has a value here keeps it: it is reported as kept, not skipped, and not a placeholder', async () => {
    const out = okOutcome(await connector().import!(ctxWith('production', { SENS: 'mine-already' }), BASE_OPTS));
    expect(out.placeholders).toEqual([]);
    expect(out.kept).toEqual([{ name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }]);
    expect(codes(out.skipped)).toEqual({ GENUINELY_EMPTY: 'empty_value' });
    // the value is untouched: nothing is imported, cleared or replaced for it
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
    expect(out.cleared).toBeUndefined();
    expect(out.unchangedEntries ?? []).toEqual([]);
  });

  test('a value_not_decrypted name with a local value is kept too, with its own reason', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development', { HIDDEN: 'mine-already', SENS: 'also-mine' }), BASE_OPTS));
    expect(out.placeholders).toEqual([]);
    expect(out.kept).toEqual([
      { name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' },
      { name: 'HIDDEN', code: 'CAPY_VALUE_KEPT', reason: 'value_not_decrypted' },
    ]);
    expect(out.skipped).toEqual([]);
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
  });

  test('a legacy secret with a local value is kept', async () => {
    const out = okOutcome(await connector().import!(ctxWith('preview', { OLD: 'mine-already' }), BASE_OPTS));
    expect(out.kept).toEqual([{ name: 'OLD', code: 'CAPY_VALUE_KEPT', reason: 'legacy_secret_unreadable' }]);
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable' });
  });

  test('--var keeps only the in-scope names', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development', { HIDDEN: 'h', SENS: 's' }), { ...BASE_OPTS, var: 'HIDDEN' }));
    expect(out.kept?.map((k) => k.name)).toEqual(['HIDDEN']);
  });

  test('no kept list entries when nothing has a local value', async () => {
    const out = okOutcome(await connector().import!(ctxWith('production'), BASE_OPTS));
    expect(out.kept).toEqual([]);
  });

  test('--var restricts the placeholders to the named variables', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development'), { ...BASE_OPTS, var: 'HIDDEN' }));
    expect(codes(out.placeholders)).toEqual({ HIDDEN: 'value_not_decrypted' });
  });

  test('--overwrite --yes: a placeholder is reported, and a name with a local value is never cleared or turned into one', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development', { SENS: 'mine-already' }), { ...BASE_OPTS, overwrite: true, yes: true }));
    expect(codes(out.placeholders)).toEqual({ HIDDEN: 'value_not_decrypted' });
    expect(out.cleared).toEqual([]);
    expect(out.kept).toEqual([{ name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }]);
    expect(out.skipped).toEqual([]);
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
  });

  test('--overwrite --yes: a value_not_decrypted name with a local value is kept, never cleared, not skipped', async () => {
    const out = okOutcome(await connector().import!(ctxWith('development', { HIDDEN: 'mine-already', STALE: 'gone-from-vercel' }), { ...BASE_OPTS, overwrite: true, yes: true }));
    expect(out.kept).toEqual([{ name: 'HIDDEN', code: 'CAPY_VALUE_KEPT', reason: 'value_not_decrypted' }]);
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable' });
    expect(out.cleared).toEqual(['STALE']);
    expect(out.skipped).toEqual([]);
  });

  test('no value is read for a sensitive record, and none is in the outcome', async () => {
    const out = okOutcome(await connector().import!(ctxWith('production'), BASE_OPTS));
    expect(JSON.stringify(out.placeholders)).not.toContain(SENTINEL.sensitive);
    expect(JSON.stringify(out)).not.toContain(SENTINEL.sensitive);
  });
});

// ── end to end: a real folder, the real report, keep.lock, .env, list, run ────

const PROJECT_KEY = 'placeholder-e2e-project-key-0123456789';

const realCtx = (dir: string, branch: string, keep?: KeepFile, localPlaintext: Record<string, string> = {}): ResolvedContext =>
  ({
    pm: { readSyncState: () => null },
    fileManager: new FileManager(dir),
    serviceClient: {
      pushSecrets: () => {
        throw new Error('must not push — these runs pass noPush');
      },
    },
    orgId: 'org_1',
    projectId: 'p',
    branch,
    userId: 'u',
    projectKey: PROJECT_KEY,
    keep: keep ?? { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} },
    localPlaintext,
  }) as unknown as ResolvedContext;

const importInto = (dir: string, branch: string, opts: ConnectOpts, keep?: KeepFile, local?: Record<string, string>) =>
  captureConsole(() => new ConnectCommand(false)['executeImport'](connector(), 'vercel', realCtx(dir, branch, keep, local), { ...BASE_OPTS, noPush: true, ...opts }));

const readKeep = (dir: string): KeepFile => JSON.parse(readFileSync(join(dir, '.capy', 'keep.lock'), 'utf-8')) as KeepFile;
const SENS_NOTE = placeholderEnvNote('SENS', { provider: 'vercel', reason: 'sensitive_unreadable' });

describe('import end to end (real FileManager, real report)', () => {
  test('--json: the placeholders are their own list, names and codes only; no value anywhere', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-ph-json', async (dir) => {
          const { stdout, stderr } = await importInto(dir, 'production', { json: true });
          expect(stdout).toHaveLength(1);
          const parsed = JSON.parse(stdout[0]);
          expect(parsed.placeholders).toEqual([{ name: 'SENS', code: 'sensitive_unreadable' }]);
          expect(parsed.skipped).toEqual([{ name: 'GENUINELY_EMPTY', code: 'empty_value' }]);
          const everything = [...stdout, ...stderr, readFileSync(join(dir, '.env'), 'utf-8'), readFileSync(join(dir, '.capy', 'keep.lock'), 'utf-8')].join('\n');
          Object.values(SENTINEL).forEach((s) => expect(everything).not.toContain(s));
        }),
      ),
    );
  });

  test('human output names the placeholders and how to set one, without a value', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-ph-human', async (dir) => {
        const { stdout } = await importInto(dir, 'production', {});
        const text = stdout.join('\n');
        expect(text).toContain('SENS (sensitive_unreadable)');
        expect(text).toContain('capy edit');
        expect(text).not.toContain('Skipped: SENS');
      }),
    );
  });

  test('keep.lock: a typed flag with an empty hash and no connector; the .env has no variable for it, only a comment', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-ph-keep', async (dir) => {
        await importInto(dir, 'production', { json: true });
        const entry = readKeep(dir).variables.SENS?.find((e) => e.branch === 'production');
        expect(entry).toMatchObject({ branch: 'production', value_hash: '', placeholder: { provider: 'vercel', reason: 'sensitive_unreadable' } });
        expect(entry).not.toHaveProperty('connector');
        expect(placeholderOf(readKeep(dir), 'SENS', 'production')).toEqual({ provider: 'vercel', reason: 'sensitive_unreadable' });

        const dotenv = readFileSync(join(dir, '.env'), 'utf-8');
        expect(dotenv.split('\n').filter((l) => l === SENS_NOTE)).toHaveLength(1);
        expect(dotenv).not.toMatch(/^SENS=/m);
        expect(new FileManager(dir).readEnvFile()).not.toHaveProperty('SENS');
        expect(new FileManager(dir).readEncryptedEnvFile(PROJECT_KEY)).toEqual({ PLAIN: SENTINEL.plain });
      }),
    );
  });

  test('importing again writes the comment once and leaves the person\'s own lines where they were', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-ph-again', async (dir) => {
        await importInto(dir, 'production', { json: true });
        writeFileSync(join(dir, '.env'), `# mine\n${readFileSync(join(dir, '.env'), 'utf-8')}`);
        const keep = readKeep(dir);
        await importInto(dir, 'production', { json: true }, keep, new FileManager(dir).readEncryptedEnvFile(PROJECT_KEY));
        const dotenv = readFileSync(join(dir, '.env'), 'utf-8');
        expect(dotenv.startsWith('# mine\n')).toBe(true);
        expect(dotenv.split('\n').filter((l) => l === SENS_NOTE)).toHaveLength(1);
        expect(placeholderOf(readKeep(dir), 'SENS', 'production')).toBeDefined();
      }),
    );
  });

  test('--dry-run lists the placeholders and writes nothing', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-ph-dry', async (dir) => {
          const { stdout } = await importInto(dir, 'production', { json: true, dryRun: true });
          expect(JSON.parse(stdout[0])).toMatchObject({ dryRun: true, placeholders: [{ name: 'SENS', code: 'sensitive_unreadable' }] });
          expect(existsSync(join(dir, '.env'))).toBe(false);
          expect(existsSync(join(dir, '.capy', 'keep.lock'))).toBe(false);
        }),
      ),
    );
  });

  test('--json: a name with a local value is under kept (code and reason), not skipped or a placeholder, and its value is untouched', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-kept-json', async (dir) => {
          const { stdout } = await importInto(dir, 'production', { json: true }, undefined, { SENS: 'mine-already' });
          expect(stdout).toHaveLength(1);
          const parsed = JSON.parse(stdout[0]);
          expect(parsed.kept).toEqual([{ name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }]);
          expect(parsed.placeholders).toEqual([]);
          expect(parsed.skipped).toEqual([{ name: 'GENUINELY_EMPTY', code: 'empty_value' }]);
          expect(parsed.imported).toEqual(['PLAIN']);
          // SENS is not a placeholder (no flag, no comment) and its Capy value is still the one it had
          expect(placeholderOf(readKeep(dir), 'SENS', 'production')).toBeUndefined();
          expect(readFileSync(join(dir, '.env'), 'utf-8')).not.toContain(SENS_NOTE);
          expect(new FileManager(dir).readEncryptedEnvFile(PROJECT_KEY)).toEqual({ SENS: 'mine-already', PLAIN: SENTINEL.plain });
          const everything = [...stdout, readFileSync(join(dir, '.capy', 'keep.lock'), 'utf-8')].join('\n');
          Object.values(SENTINEL).forEach((s) => expect(everything).not.toContain(s));
        }),
      ),
    );
  });

  test('human output: one neutral line for the kept names, and they are not listed as skipped', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-kept-human', async (dir) => {
        const { stdout } = await importInto(dir, 'development', {}, undefined, { SENS: 'mine', HIDDEN: 'mine-too' });
        const text = stdout.join('\n');
        expect(text).toContain('Kept the Capy value for 2 name(s) Vercel will not return: SENS (sensitive_unreadable), HIDDEN (value_not_decrypted)');
        expect(text).not.toContain('Skipped: SENS');
        expect(text).not.toContain('Skipped: HIDDEN');
        expect(text).not.toContain('with no value yet');
      }),
    );
  });

  test('--overwrite --json: the kept list is there, and the kept name is neither cleared nor skipped', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-kept-overwrite', async (dir) => {
          const { stdout } = await importInto(dir, 'production', { json: true, overwrite: true, yes: true }, undefined, { SENS: 'mine-already' });
          const parsed = JSON.parse(stdout[0]);
          expect(parsed.kept).toEqual([{ name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }]);
          expect(parsed.cleared ?? []).not.toContain('SENS');
          expect(parsed.skipped.map((s: { name: string }) => s.name)).not.toContain('SENS');
          expect(parsed.placeholders).toEqual([]);
        }),
      ),
    );
  });

  test('--dry-run shows kept (JSON and human) and writes nothing', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-kept-dry', async (dir) => {
          const json = await importInto(dir, 'production', { json: true, dryRun: true }, undefined, { SENS: 'mine-already' });
          expect(JSON.parse(json.stdout[0])).toMatchObject({ dryRun: true, kept: [{ name: 'SENS', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }], placeholders: [] });
          expect(JSON.parse(json.stdout[0]).skipped.map((s: { name: string }) => s.name)).not.toContain('SENS');
          const human = await importInto(dir, 'production', { dryRun: true }, undefined, { SENS: 'mine-already' });
          expect(human.stdout.join('\n')).toContain('Kept the Capy value for 1 name(s) Vercel will not return: SENS (sensitive_unreadable)');
          expect(existsSync(join(dir, '.env'))).toBe(false);
          expect(existsSync(join(dir, '.capy', 'keep.lock'))).toBe(false);
        }),
      ),
    );
  });

  test('another branch gets its own placeholders (preview has two, production one)', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-ph-branches', async (dir) => {
        await importInto(dir, 'production', { json: true });
        await importInto(dir, 'preview', { json: true }, readKeep(dir));
        const keep = readKeep(dir);
        expect(placeholderOf(keep, 'OLD', 'preview')?.reason).toBe('legacy_secret_unreadable');
        expect(placeholderOf(keep, 'OLD', 'production')).toBeUndefined();
        expect(placeholderOf(keep, 'SENS', 'preview')).toBeDefined();
        expect(placeholderOf(keep, 'SENS', 'production')).toBeDefined();
      }),
    );
  });
});

describe('surfaces', () => {
  const withImportedFolder = async (fn: (dir: string) => Promise<void>): Promise<void> =>
    withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-ph-surface', async (dir) => {
        await importInto(dir, 'production', { json: true });
        await fn(dir);
      }),
    );

  /** `fn` with the process working directory in `dir`, put back afterwards. */
  const inDir = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const original = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(original);
    }
  };

  test('capy list --json: the placeholder, its reason and how to set it', async () => {
    await withImportedFolder(async (dir) => {
      const { stdout } = await inDir(dir, () => captureConsole(() => new ListCommand().execute({ json: true })));
      const listed = JSON.parse(stdout.join('\n'));
      const sens = listed.variables.find((v: { name: string }) => v.name === 'SENS');
      expect(sens.placeholder).toEqual({ provider: 'vercel', reason: 'sensitive_unreadable', setWith: 'capy edit SENS' });
      expect(listed.variables.find((v: { name: string }) => v.name === 'PLAIN').placeholder).toBeNull();
    });
  });

  test('capy list: "no value yet (sensitive in Vercel)" and the command', async () => {
    await withImportedFolder(async (dir) => {
      const { stdout } = await inDir(dir, () => captureConsole(() => new ListCommand().execute({})));
      const line = stdout.find((l) => l.includes('SENS')) ?? '';
      expect(line).toContain('no value yet (sensitive in Vercel)');
      expect(line).toContain('capy edit SENS');
      expect(stdout.find((l) => l.includes('PLAIN')) ?? '').not.toContain('no value yet');
    });
  });

  test('capy run: the variable is not set (the comment is not a variable)', async () => {
    await withImportedFolder(async (dir) => {
      const dotenv = readFileSync(join(dir, '.env'), 'utf-8');
      // `capy run` needs no key when no value in the file is encrypted: keep the placeholder's file and one plain variable.
      writeFileSync(join(dir, '.env'), `${dotenv.split('\n').filter((l) => !l.startsWith('PLAIN=')).join('\n')}\nOTHER=here\n`);
      const home = mkdtempSync(join(tmpdir(), 'capy-ph-run-home-'));
      mkdirSync(join(home, '.capy'), { recursive: true });
      const { SENS: _inherited, ...cleanEnv } = process.env;
      const cli = join(__dirname, '../../dist/index.js');
      const printed = execFileSync('node', [cli, 'run', '--', 'node', '-e', 'console.log(JSON.stringify({ has: "SENS" in process.env, other: process.env.OTHER }))'], {
        cwd: dir,
        env: { ...cleanEnv, HOME: home, USERPROFILE: home },
        encoding: 'utf-8',
      });
      rmSync(home, { recursive: true, force: true });
      expect(JSON.parse(printed.trim())).toEqual({ has: false, other: 'here' });
    });
  });
});

// ── one variable's value route answers 404: that name is a placeholder, the rest still import ──

const GONE_ENV = env({ id: 'e_gone', key: 'GONE', type: 'encrypted', target: ['production'], listValue: 'opaque' });
const GONE_DATA = (status: number): FakeVercelData => ({
  ...DATA,
  envs: { prj_web: [...ENVS, GONE_ENV] },
  valueStatus: { e_gone: status },
});

describe('import: a 404 on one variable\'s value route', () => {
  test('production: the 404 name is a placeholder with reason value_not_found; the other names import', async () => {
    const out = okOutcome(await connector(GONE_DATA(404)).import!(ctxWith('production'), BASE_OPTS));
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable', GONE: 'value_not_found' });
    expect(out.imported.map((i) => i.varName)).toEqual(['PLAIN']);
    expect(codes(out.skipped)).toEqual({ GENUINELY_EMPTY: 'empty_value' });
  });

  test('--overwrite --yes: the 404 name is a placeholder and is never cleared when it has a local value', async () => {
    const out = okOutcome(await connector(GONE_DATA(404)).import!(ctxWith('production'), { ...BASE_OPTS, overwrite: true, yes: true }));
    expect(codes(out.placeholders)).toEqual({ SENS: 'sensitive_unreadable', GONE: 'value_not_found' });
    const kept = okOutcome(await connector(GONE_DATA(404)).import!(ctxWith('production', { GONE: 'mine-already' }), { ...BASE_OPTS, overwrite: true, yes: true }));
    expect(kept.kept).toEqual([{ name: 'GONE', code: 'CAPY_VALUE_KEPT', reason: 'value_not_found' }]);
    expect(kept.cleared).toEqual([]);
  });

  test('--json: the 404 name is in placeholders with its reason; keep.lock holds a flag, no value', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-ph-404', async (dir) => {
          const { stdout } = await captureConsole(() =>
            new ConnectCommand(false)['executeImport'](connector(GONE_DATA(404)), 'vercel', realCtx(dir, 'production'), { ...BASE_OPTS, noPush: true, json: true }),
          );
          const parsed = JSON.parse(stdout[0]);
          expect(parsed.placeholders).toEqual([
            { name: 'SENS', code: 'sensitive_unreadable' },
            { name: 'GONE', code: 'value_not_found' },
          ]);
          expect(parsed.imported).toEqual(['PLAIN']);
          expect(placeholderOf(readKeep(dir), 'GONE', 'production')).toEqual({ provider: 'vercel', reason: 'value_not_found' });
        }),
      ),
    );
  });

  test('a 500 on the same route still fails the run, with the Vercel error code', async () => {
    const out = await connector(GONE_DATA(500)).import!(ctxWith('production'), BASE_OPTS);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe('VERCEL_API_ERROR');
  });
});
