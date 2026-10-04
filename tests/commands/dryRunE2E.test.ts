/**
 * `--dry-run` for `capy edit`, `capy add` and `capy remove` (agent paths), through
 * the BUILT cli (`dist/index.js`) against an isolated HOME, a mock service and a
 * fake `gh` (tests/helpers). Needs `bun run build` first.
 *
 * The property: a dry run previews and changes NOTHING. No push, no keep cache, no
 * `.env` / keep.lock / sync-state write, no repo-link PUT, no GitHub write: shown
 * by comparing every byte of the project folder and the home keep cache before and
 * after, and by the mock service's and the fake gh's request logs.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, BRANCH, type CliResult, type Harness } from '../helpers/pipedHarness';
import { MAX_PIPED_BYTES } from '../../src/commands/pipedValue';
import { gitInit, ghCalls, ghWrites, installFakeGh } from '../helpers/ghWorld';

const NAME = 'DRY_TEST_TOKEN';
const SENTINEL = 'SENTINEL_7b8e1f0a2c4d6e8091a3b5c7d9e1f203_DRY';
const UNANSWERED = [
  { id: 'create_pr', flag: '--pr' },
  { id: 'pr_base', flag: '--pr-base' },
];

const json = (r: CliResult): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

/** Every file under `dir` as [relative path, bytes]. */
function snapshot(dir: string): ReadonlyArray<readonly [string, string]> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .toSorted()
    .flatMap((entry): ReadonlyArray<readonly [string, string]> => {
      const full = join(dir, entry);
      return statSync(full).isDirectory()
        ? snapshot(full).map(([p, c]) => [`${entry}/${p}`, c] as const)
        : [[entry, readFileSync(full).toString('base64')] as const];
    });
}

/** What a dry run must not touch: the project folder (keep.lock, .env, .capy/sync-state) and the home keep cache. */
const state = (h: Harness) => ({ project: snapshot(h.project), keepCache: snapshot(join(h.home, '.capy', 'keep')) });

async function withWorld<T>(fn: (h: Harness, env: Record<string, string>) => Promise<T>): Promise<T> {
  const h = await createHarness();
  try {
    // Reporting ON (the suite switches it off), in a git checkout with an origin: a REAL run would PUT a repo link.
    gitInit(h.project, 'git@github.com:Acme/solo.git');
    return await fn(h, { ...installFakeGh(h), CAPY_NO_REPO_LINK: '' });
  } finally {
    await h.dispose();
  }
}

/** Creates NAME for real (reporting off, so the run is quiet), and returns the harness state afterwards. */
async function seedReal(h: Harness, env: Record<string, string>, value = 'first-value'): Promise<void> {
  const out = await h.run(['edit', NAME, '--json', '--no-pr'], `${value}\n`, undefined, { ...env, CAPY_NO_REPO_LINK: '1' });
  expect(out.code).toBe(0);
}

/** The service and GitHub saw no writes since `before`. */
function expectNothingWritten(h: Harness, before: ReturnType<typeof state>, pushesBefore: number): void {
  expect(state(h)).toEqual(before);
  expect(h.pushCount()).toBe(pushesBefore);
  expect(h.repoPuts()).toHaveLength(0);
  expect(ghWrites(h)).toHaveLength(0);
}

describe('capy edit NAME --dry-run (piped)', () => {
  test('created: the envelope plus dry_run, action created, pushed false, keep_lock preview; unanswered as in a real run', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const out = await h.run(['edit', NAME, '--dry-run', '--json'], 'v\n', undefined, env);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      expect(json(out)).toEqual({
        ok: true,
        name: NAME,
        branch: BRANCH,
        action: 'created',
        pushed: false,
        dry_run: true,
        keep_lock: { changed: true, committed: false, would_pr: null },
        unanswered: UNANSWERED,
      });
      expect(Object.keys(json(out))).toEqual(['ok', 'name', 'branch', 'action', 'pushed', 'dry_run', 'keep_lock', 'unanswered']);
      expectNothingWritten(h, before, 0);
    });
  });

  test('updated, then unchanged: the action is what WOULD happen', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env, 'first-value');
      const before = state(h);
      const pushes = h.pushCount();
      const updated = await h.run(['edit', NAME, '--dry-run', '--json'], 'second-value\n', undefined, env);
      expect(json(updated)).toMatchObject({ action: 'updated', pushed: false, dry_run: true, keep_lock: { changed: true, committed: false, would_pr: null } });
      const same = await h.run(['edit', NAME, '--dry-run', '--json'], 'first-value\n', undefined, env);
      expect(json(same)).toEqual({
        ok: true,
        name: NAME,
        branch: BRANCH,
        action: 'unchanged',
        pushed: false,
        dry_run: true,
        keep_lock: { changed: false, committed: false, would_pr: null },
      });
      expectNothingWritten(h, before, pushes);
    });
  });

  test('--no-push: keep.lock would not change', async () => {
    await withWorld(async (h, env) => {
      const out = await h.run(['edit', NAME, '--dry-run', '--json', '--no-push'], 'v\n', undefined, env);
      expect(json(out)).toMatchObject({ action: 'created', pushed: false, keep_lock: { changed: false, would_pr: null } });
      expect(json(out).unanswered).toBeUndefined();
    });
  });

  test('--no-pr: no unanswered; --pr: would_pr names the default branch read from GitHub; --pr-base wins', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const noPr = json(await h.run(['edit', NAME, '--dry-run', '--json', '--no-pr'], 'v\n', undefined, env));
      expect(noPr.keep_lock).toEqual({ changed: true, committed: false, would_pr: null });
      expect(noPr.unanswered).toBeUndefined();

      const pr = json(await h.run(['edit', NAME, '--dry-run', '--json', '--pr'], 'v\n', undefined, env));
      expect(pr.keep_lock).toEqual({ changed: true, committed: false, would_pr: { base: 'main' } });
      expect(pr.unanswered).toBeUndefined();

      const base = json(await h.run(['edit', NAME, '--dry-run', '--json', '--pr', '--pr-base', 'release/1'], 'v\n', undefined, env));
      expect(base.keep_lock).toEqual({ changed: true, committed: false, would_pr: { base: 'release/1' } });

      expect(ghCalls(h).some((c) => c.args.at(-1) === 'repos/Acme/solo')).toBe(true); // it READ the default branch
      expectNothingWritten(h, before, 0);
    });
  });

  test('--pr outside a repository: would_pr carries a code, not a crash; the dry run still succeeds', async () => {
    const h = await createHarness();
    try {
      const out = await h.run(['edit', NAME, '--dry-run', '--json', '--pr'], 'v\n', undefined, installFakeGh(h));
      expect(out.code).toBe(0);
      expect(json(out).keep_lock).toEqual({ changed: true, committed: false, would_pr: { base: null, error: { code: 'KEEP_PR_NOT_GIT_REPO' } } });
    } finally {
      await h.dispose();
    }
  });

  test('human mode: one stderr line, nothing on stdout', async () => {
    await withWorld(async (h, env) => {
      const created = await h.run(['edit', NAME, '--dry-run'], 'v\n', undefined, env);
      expect(created.stdout).toBe('');
      expect(created.stderr).toBe(`Dry run: would create ${NAME} on ${BRANCH}. Nothing was changed.\n`);
      await seedReal(h, env, 'first-value');
      const updated = await h.run(['edit', NAME, '--dry-run'], 'other\n', undefined, env);
      expect(updated.stderr).toBe(`Dry run: would update ${NAME} on ${BRANCH}. Nothing was changed.\n`);
      const same = await h.run(['edit', NAME, '--dry-run'], 'first-value\n', undefined, env);
      expect(same.stderr).toBe(`Dry run: ${NAME} on ${BRANCH} already has this value. Nothing would change.\n`);
    });
  });

  test('the flag works in every position: before the command, after it, and as -d', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const outs = [
        await h.run(['--dry-run', 'edit', NAME, '--json'], 'v\n', undefined, env),
        await h.run(['edit', NAME, '--json', '--dry-run'], 'v\n', undefined, env),
        await h.run(['edit', NAME, '--json', '-d'], 'v\n', undefined, env),
      ];
      outs.forEach((o) => expect(json(o)).toMatchObject({ ok: true, dry_run: true, pushed: false }));
      expectNothingWritten(h, before, 0);
    });
  });

  test('every stdin refusal still fires under --dry-run, and nothing is written', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const cases: ReadonlyArray<readonly [string, Buffer | string | undefined, string, number]> = [
        ['empty', '', 'STDIN_EMPTY', 1],
        ['only a newline', '\n', 'STDIN_EMPTY', 1],
        ['over 1 MiB', 'x'.repeat(MAX_PIPED_BYTES + 1), 'STDIN_TOO_LARGE', 1],
        ['a NUL byte', 'ab\u0000cd', 'INVALID_FORMAT', 1],
        ['not UTF-8', Buffer.from([0xff, 0xfe, 0xfd]), 'INVALID_FORMAT', 1],
      ];
      for (const [label, stdin, code, exit] of cases) {
        const out = await h.run(['edit', NAME, '--dry-run', '--json'], stdin, undefined, env);
        expect({ label, code: json(out).code, exit: out.code, ok: json(out).ok }).toEqual({ label, code, exit, ok: false });
      }
      const badName = await h.run(['edit', 'not a name', '--dry-run', '--json'], 'v\n', undefined, env);
      expect(json(badName).code).toBe('INVALID_FORMAT');
      expectNothingWritten(h, before, 0);
    });
  });

  test('no terminal and no value is still EDIT_NEEDS_TTY (exit 3), not a dry run', async () => {
    await withWorld(async (h, env) => {
      const out = await h.run(['edit', '--dry-run', '--json'], undefined, undefined, env);
      expect(out.code).toBe(3);
      expect(json(out).code).toBe('EDIT_NEEDS_TTY');
    });
  });
});

describe('capy add NAME --dry-run (piped)', () => {
  test('created: the envelope with dry_run; --force for an existing name gives updated', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const created = await h.run(['add', NAME, '--dry-run', '--json'], 'v\n', undefined, env);
      expect(json(created)).toEqual({
        ok: true,
        name: NAME,
        branch: BRANCH,
        action: 'created',
        pushed: false,
        dry_run: true,
        keep_lock: { changed: true, committed: false, would_pr: null },
        unanswered: UNANSWERED,
      });
      expectNothingWritten(h, before, 0);

      await seedReal(h, env);
      const afterSeed = state(h);
      const pushes = h.pushCount();
      const forced = await h.run(['add', NAME, '--dry-run', '--json', '--force'], 'new-value\n', undefined, env);
      expect(json(forced)).toMatchObject({ action: 'updated', pushed: false, dry_run: true, keep_lock: { changed: true } });
      const same = await h.run(['--dry-run', 'add', NAME, '--json', '-f'], 'first-value\n', undefined, env);
      expect(json(same)).toMatchObject({ action: 'unchanged', keep_lock: { changed: false, committed: false, would_pr: null } });
      expectNothingWritten(h, afterSeed, pushes);
    });
  });

  test('an existing name without --force is still ADD_VAR_EXISTS (exit 3) under --dry-run', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      const before = state(h);
      const pushes = h.pushCount();
      const out = await h.run(['add', NAME, '--dry-run', '--json'], 'x\n', undefined, env);
      expect(out.code).toBe(3);
      expect(json(out).code).toBe('ADD_VAR_EXISTS');
      expectNothingWritten(h, before, pushes);
    });
  });

  test('--pr names the base; the other piped refusals still fire; human mode is one stderr line', async () => {
    await withWorld(async (h, env) => {
      const pr = json(await h.run(['add', NAME, '--dry-run', '--json', '--pr'], 'v\n', undefined, env));
      expect(pr.keep_lock).toEqual({ changed: true, committed: false, would_pr: { base: 'main' } });
      expect(json(await h.run(['add', NAME, '--dry-run', '--json'], '', undefined, env)).code).toBe('STDIN_EMPTY');
      expect(json(await h.run(['add', 'A', 'B', '--dry-run', '--json'], 'v\n', undefined, env)).code).toBe('ADD_STDIN_ONE_NAME');
      expect(json(await h.run(['add', NAME, '--dry-run', '--json'], 'x'.repeat(MAX_PIPED_BYTES + 1), undefined, env)).code).toBe('STDIN_TOO_LARGE');
      const human = await h.run(['add', NAME, '--dry-run'], 'v\n', undefined, env);
      expect(human.stdout).toBe('');
      expect(human.stderr).toBe(`Dry run: would create ${NAME} on ${BRANCH}. Nothing was changed.\n`);
    });
  });
});

describe('capy remove NAME --dry-run', () => {
  test('--yes --json: which variable WOULD be removed on which branch; nothing is', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      const before = state(h);
      const pushes = h.pushCount();
      const out = await h.run(['remove', NAME, '--yes', '--json', '--dry-run'], undefined, undefined, env);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      expect(json(out)).toEqual({
        removed: [NAME],
        branch: BRANCH,
        dry_run: true,
        keep_lock: { changed: true, committed: false, would_pr: null },
        unanswered: UNANSWERED,
      });
      expectNothingWritten(h, before, pushes);
    });
  });

  test('it never needs --yes (it only says what would happen); --pr / --no-pr / --pr-base behave as for edit', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      const before = state(h);
      const pushes = h.pushCount();
      const noYes = await h.run(['--dry-run', 'remove', NAME, '--json'], undefined, undefined, env);
      expect(json(noYes)).toMatchObject({ removed: [NAME], dry_run: true });
      const pr = json(await h.run(['remove', NAME, '--json', '-d', '--pr', '--pr-base', 'dev'], undefined, undefined, env));
      expect(pr.keep_lock).toEqual({ changed: true, committed: false, would_pr: { base: 'dev' } });
      const noPr = json(await h.run(['remove', NAME, '--json', '-d', '--no-pr'], undefined, undefined, env));
      expect(noPr.keep_lock).toEqual({ changed: true, committed: false, would_pr: null });
      expect(noPr.unanswered).toBeUndefined();
      expectNothingWritten(h, before, pushes);
    });
  });

  test('the refusals that are not about prompting still fire: unknown name, no names', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      const unknown = await h.run(['remove', 'NOT_THERE', '--yes', '--json', '--dry-run'], undefined, undefined, env);
      expect(unknown.code).toBe(1);
      expect(json(unknown)).toMatchObject({ ok: false, code: 'VAR_NOT_FOUND' });
    });
  });

  test('human mode: one stderr line, nothing on stdout', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      const out = await h.run(['remove', NAME, '--yes', '--dry-run'], undefined, undefined, env);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('');
      expect(out.stderr).toBe(`Dry run: would remove ${NAME} from ${BRANCH}. Nothing was changed.\n`);
    });
  });

  test('a local drift on OTHER variables still refuses, as in a real run', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env);
      // A second variable that exists only locally (unpushed): removing NAME would carry it along.
      await h.run(['edit', 'DRY_OTHER', '--json', '--no-push'], 'x\n', undefined, { ...env, CAPY_NO_REPO_LINK: '1' });
      const out = await h.run(['remove', NAME, '--yes', '--json', '--dry-run'], undefined, undefined, env);
      expect(json(out)).toMatchObject({ ok: false, code: 'REMOVE_LOCAL_DRIFT' });
    });
  });
});

describe('the control: the same commands without --dry-run DO write (so the tests above can fail)', () => {
  test('a real edit pushes, writes the project files and reports the repo link', async () => {
    await withWorld(async (h, env) => {
      const before = state(h);
      const out = await h.run(['edit', NAME, '--json', '--no-pr'], 'v\n', undefined, env);
      expect(out.code).toBe(0);
      expect(h.pushCount()).toBe(1);
      expect(state(h)).not.toEqual(before);
      expect(h.repoPuts()).toHaveLength(1);
    });
  });
});

describe('the value never appears in a dry run', () => {
  test('stdout, stderr, requests, gh calls and files: edit, add and remove; JSON and human; every refusal', async () => {
    await withWorld(async (h, env) => {
      await seedReal(h, env, 'first-value');
      const forms = [SENTINEL, Buffer.from(SENTINEL).toString('base64').replace(/=+$/, ''), Buffer.from(SENTINEL).toString('hex'), encodeURIComponent(SENTINEL)];
      const has = (hay: string | Buffer) => forms.filter((f) => Buffer.from(hay).includes(f));
      const runs: readonly CliResult[] = [
        await h.run(['edit', NAME, '--dry-run', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['edit', NAME, '--dry-run', '--verbose', '--pr'], `${SENTINEL}\n`, undefined, env),
        await h.run(['edit', 'NEW_ONE', '--dry-run', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['edit', NAME, '--dry-run', '--json', '--verbose'], `${SENTINEL}\u0000\n`, undefined, env),
        await h.run(['add', NAME, '--dry-run', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env), // ADD_VAR_EXISTS
        await h.run(['add', NAME, '--dry-run', '--json', '--verbose', '--force'], `${SENTINEL}\n`, undefined, env),
        await h.run(['add', NAME, '--dry-run', '--verbose', '--force'], `${SENTINEL}\n`, undefined, env),
        await h.run(['add', 'A', 'B', '--dry-run', '--json'], `${SENTINEL}\n`, undefined, env),
        await h.run(['remove', NAME, '--yes', '--dry-run', '--json', '--verbose'], `${SENTINEL}\n`, undefined, env),
        await h.run(['remove', NAME, '--yes', '--dry-run', '--verbose'], `${SENTINEL}\n`, undefined, env),
      ];
      runs.forEach((r, i) => expect({ i, stdout: has(r.stdout), stderr: has(r.stderr) }).toEqual({ i, stdout: [], stderr: [] }));
      expect(h.requests().filter((r) => has(r.body).length > 0 || has(r.path).length > 0)).toEqual([]);
      expect(ghCalls(h).filter((c) => has(JSON.stringify(c)).length > 0)).toEqual([]);
      expect(h.allFiles().filter(([, bytes]) => has(bytes).length > 0).map(([p]) => p)).toEqual([]);
    });
  }, 120000);
});
