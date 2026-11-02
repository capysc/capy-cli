/**
 * `capy secrets set NAME` through the BUILT cli (`dist/index.js`): the real
 * argument parser (repeatable options, `--json` after the subcommand, the
 * negatable-looking `--no-pr-for`), the real engine, an isolated HOME, a mock
 * service and a fake `gh` (tests/helpers). Needs `bun run build` first.
 *
 * Also the leak test for this command: the sentinel value is run through
 * --dry-run, a real run and refusals with `--verbose`, and must appear in no
 * output, no request the mock service saw, no call the fake gh saw, and no file.
 */
import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Encryptor } from '../../src/crypto/encryptor';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { FileManager, serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';
import { createHarness, BRANCH, ORG_ID, PROJECT_ID, type CliResult, type Harness } from '../helpers/pipedHarness';

const NAME = 'E2E_API_KEY';
const OLD = 'e2e-old-value';
const SENTINEL = 'SENTINEL_2c26b46b68ffc68ff99b453c1d304134_E2E';
const FAKE_GH = join(__dirname, '../helpers/fake-gh.cjs');
const hash16 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);

const keepWith = (value: string): KeepFile => ({
  version: '3.0',
  org_id: ORG_ID,
  project_id: PROJECT_ID,
  project_name: 'piped-test',
  variables: {
    [NAME]: [{ resource_id: deriveResourceId(BRANCH, NAME), branch: BRANCH, value_hash: hash16(value), changed_at: '2026-01-01T00:00:00.000Z' }],
  },
});

/** The world: one project, one location holding NAME, one linked GitHub repo, a fake gh. Returns the env the cli needs. */
function seed(h: Harness): Record<string, string> {
  const keep = keepWith(OLD);
  h.setSecretsIndex({
    org_id: ORG_ID,
    skipped: [],
    rows: [
      {
        name: NAME,
        value_hash: hash16(OLD),
        locations: [{ project_id: PROJECT_ID, project_name: 'piped-test', branch: BRANCH, protected: false, service: null }],
        users: [],
      },
    ],
  });
  h.setOrgRepos({
    org_id: ORG_ID,
    repos: [{ project_id: PROJECT_ID, project_name: 'piped-test', host: 'github.com', owner: 'Acme', name: 'solo', path: '.', github_repo_id: 5, last_seen_at: '' }],
  });
  const line = `${NAME}=capy:${deriveResourceId(BRANCH, NAME)}:${Encryptor.encrypt(OLD, h.projectKey)}`;
  h.setBranchData(PROJECT_ID, BRANCH, { env_file: line, permissions: [], keep_file: JSON.stringify(keep) });

  const bin = join(h.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE_GH)});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(
    join(h.root, 'gh-config.json'),
    JSON.stringify({ repos: { 'acme/solo': { id: 5, default_branch: 'trunk', files: { 'keep.lock': serializeKeep(keep) } } } }),
  );
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: h.root };
}

const ghLog = (h: Harness): Array<{ args: string[]; stdin: string }> =>
  readFileSync(join(h.root, 'gh-log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string });

const json = (r: CliResult): Record<string, any> => JSON.parse(r.stdout) as Record<string, any>;

describe('capy secrets set (built cli)', () => {
  test('dry run (no stdin), then the confirmed run: option parsing, plan_id, push, PR, exit codes', async () => {
    const h = await createHarness();
    try {
      const env = seed(h);
      // `--json` after the subcommand, and the program-level --dry-run in any position.
      const dry = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--all-rows'], undefined, undefined, env);
      expect(dry.code).toBe(0);
      expect(dry.stderr).toBe('');
      const plan = json(dry);
      expect(plan).toMatchObject({ ok: true, dry_run: true, name: NAME, not_linked: [] });
      expect(plan.locations).toEqual([{ project: 'piped-test', branch: BRANCH, protected: false, action: 'update' }]);
      expect(plan.prs).toEqual([{ repo: 'Acme/solo', base: 'trunk', keep_lock_paths: ['keep.lock'], keep_lock_diverged: false }]);
      expect(h.pushCount()).toBe(0);
      // The dry run wrote nothing to GitHub (the one POST is the batched GraphQL READ of the default branches).
      expect(ghLog(h).filter((c) => c.args.includes('POST') && c.args[c.args.length - 1] !== 'graphql')).toEqual([]);
      expect(ghLog(h).filter((c) => c.args[c.args.length - 1] === 'graphql')).toHaveLength(1);
      expect(ghLog(h).filter((c) => c.args[c.args.length - 1] === 'repos/Acme/solo')).toHaveLength(0);

      // No --confirm: refused with the plan, exit 3, nothing written.
      const unconfirmed = await h.run(['secrets', 'set', NAME, '--json'], `${SENTINEL}\n`, undefined, env);
      expect(unconfirmed.code).toBe(3);
      expect(json(unconfirmed)).toMatchObject({ ok: false, code: 'PLAN_CONFIRM_REQUIRED', plan_id: plan.plan_id });
      expect(h.pushCount()).toBe(0);

      // A stale id: PLAN_CHANGED, exit 1.
      const stale = await h.run(['secrets', 'set', NAME, '--confirm', 'deadbeefdeadbeef', '--json'], `${SENTINEL}\n`, undefined, env);
      expect(stale.code).toBe(1);
      expect(json(stale).code).toBe('PLAN_CHANGED');
      expect(h.pushCount()).toBe(0);

      // The real run.
      const real = await h.run(['secrets', 'set', NAME, '--confirm', plan.plan_id, '--json', '--verbose'], `${SENTINEL}\n`, undefined, env);
      expect(real.code).toBe(0);
      const result = json(real);
      expect(result).toMatchObject({ ok: true, name: NAME, plan_id: plan.plan_id, unchanged: [], failed: [] });
      expect(result.updated).toEqual([{ project: 'piped-test', branch: BRANCH, protected: false }]);
      expect(result.prs).toEqual([
        {
          repo: 'Acme/solo',
          url: 'https://github.com/Acme/solo/pull/7',
          base: 'trunk',
          keep_lock_paths: ['keep.lock'],
          keep_lock_diverged: false,
          locations: [{ project: 'piped-test', branch: BRANCH, protected: false }],
        },
      ]);
      expect(h.pushCount()).toBe(1);

      // The pushed blob decrypts to the new value (property, not shape), and the service never saw plaintext.
      const push = h.requests().find((r) => r.method === 'POST' && r.path.startsWith('/secrets/')) as { body: string };
      const blob = (JSON.parse(push.body) as { env_blob: string }).env_blob;
      const stored = blob.split('\n').find((l) => l.startsWith(`${NAME}=`)) as string;
      expect(new FileManager().decryptValue(stored.slice(NAME.length + 1), h.projectKey)).toBe(SENTINEL);

      // The PR targets the repo's default branch and carries only the pointer.
      const pull = ghLog(h).find((c) => c.args.includes('POST') && c.args.at(-1)?.endsWith('/pulls')) as { stdin: string };
      expect(JSON.parse(pull.stdin)).toMatchObject({ base: 'trunk', title: 'chore(capy): update keep.lock' });
    } finally {
      await h.dispose();
    }
  }, 60000);

  test('repeatable options and --no-pr-for / --no-pr reach the command; a typo is refused', async () => {
    const h = await createHarness();
    try {
      const env = seed(h);
      const noPrFor = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--no-pr-for', 'acme/SOLO', '--no-pr-for', 'x/y'], undefined, undefined, env);
      expect(json(noPrFor).code).toBe('INVALID_FORMAT'); // x/y names no repo of this plan
      const onlyOne = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--no-pr-for', 'acme/SOLO'], undefined, undefined, env);
      expect(json(onlyOne).prs).toEqual([]);
      const noPr = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--no-pr'], undefined, undefined, env);
      expect(json(noPr).prs).toEqual([]);
      const excluded = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--exclude', `piped-test:${BRANCH}`], undefined, undefined, env);
      expect(json(excluded).code).toBe('SECRETS_NOTHING_SELECTED');
      const row = await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--row', 'nope', '--row', 'nada'], undefined, undefined, env);
      expect(json(row).code).toBe('SECRET_NOT_FOUND');
    } finally {
      await h.dispose();
    }
  }, 60000);

  test('`capy secrets --name` filters, and every JSON row has an opaque row_id', async () => {
    const h = await createHarness();
    try {
      seed(h);
      const rows = await h.run(['secrets', '--name', NAME, '--json']);
      const body = json(rows);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].row_id).toMatch(/^[0-9a-f]{12}$/);
      expect(hash16(OLD).startsWith(body.rows[0].row_id)).toBe(false);
      expect(JSON.stringify(body.rows[0])).not.toContain(OLD);
      const none = await h.run(['secrets', '--name', 'OTHER', '--json']);
      expect(json(none).rows).toEqual([]);
    } finally {
      await h.dispose();
    }
  }, 30000);

  test('the global --dry-run is accepted on `capy secrets` in either position, and the non-TTY listing is unchanged', async () => {
    const h = await createHarness();
    try {
      seed(h);
      const before = await h.run(['secrets', '--json']);
      const front = await h.run(['--dry-run', 'secrets', '--json']);
      const back = await h.run(['secrets', '--dry-run', '--json']);
      expect([front.code, back.code]).toEqual([0, 0]);
      expect(json(front)).toEqual(json(before));
      expect(json(back)).toEqual(json(before));
      expect(h.pushCount()).toBe(0);
    } finally {
      await h.dispose();
    }
  }, 30000);

  test('the value never appears in output, requests, gh calls or files (dry run, success, refusals, --verbose)', async () => {
    const h = await createHarness();
    try {
      const env = seed(h);
      const forms = [SENTINEL, Buffer.from(SENTINEL).toString('base64').replace(/=+$/, ''), Buffer.from(SENTINEL).toString('hex'), encodeURIComponent(SENTINEL)];
      const has = (hay: string | Buffer) => forms.filter((f) => Buffer.from(hay).includes(f));
      const plan = json(await h.run(['secrets', 'set', NAME, '--dry-run', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env));
      const results = [
        await h.run(['secrets', 'set', NAME, '--dry-run', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['secrets', 'set', NAME, '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['secrets', 'set', NAME, '--confirm', 'stale', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['secrets', 'set', NAME, '--confirm', plan.plan_id, '--json', '--verbose'], `${SENTINEL}\u0000\n`, undefined, env),
        await h.run(['secrets', 'set', NAME, '--confirm', plan.plan_id, '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['secrets', 'set', NAME, '--confirm', plan.plan_id, '--verbose'], `${SENTINEL}\n`, undefined, env),
      ];
      results.forEach((r, i) => {
        expect({ i, stdout: has(r.stdout), stderr: has(r.stderr) }).toEqual({ i, stdout: [], stderr: [] });
      });
      expect(h.requests().filter((r) => has(r.body).length > 0 || has(r.path).length > 0)).toEqual([]);
      expect(ghLog(h).filter((c) => has(JSON.stringify(c)).length > 0)).toEqual([]);
      expect(h.allFiles().filter(([, bytes]) => has(bytes).length > 0).map(([p]) => p)).toEqual([]);
    } finally {
      await h.dispose();
    }
  }, 90000);
});
