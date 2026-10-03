/**
 * `capy add NAME` with a piped value: the same reader and write path as
 * `capy edit NAME`, with `add`'s own meaning (a name that already exists needs
 * `--force`). Driven through the real argument parser of the BUILT cli against
 * an isolated HOME and a local mock service. Needs `bun run build` first.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, BRANCH, type Harness } from '../helpers/pipedHarness';

const PEM = readFileSync(join(__dirname, '../fixtures/rsa_test_key.pem'), 'utf8').trimEnd();

// Neither --pr nor --no-pr and no terminal: the PR step does not run and says which flags would answer it.
const UNANSWERED = [
  { id: 'create_pr', flag: '--pr' },
  { id: 'pr_base', flag: '--pr-base' },
];

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('capy add NAME < value (piped)', () => {
  const state = { harness: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.harness) throw new Error('harness not ready');
    return state.harness;
  };
  beforeAll(async () => {
    Object.assign(state, { harness: await createHarness() });
  });
  afterAll(async () => {
    await state.harness?.dispose();
  });

  test('creates a new variable: created, pure JSON, pushed', async () => {
    const r = await h().run(['add', 'ADD_NEW', '--json'], 'v\n');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(parseJson(r.stdout)).toEqual({ ok: true, name: 'ADD_NEW', branch: BRANCH, action: 'created', pushed: true, keep_lock: { changed: true, committed: false }, unanswered: UNANSWERED });
    expect(h().envValue('ADD_NEW')).toBe('v');
    expect(h().pushCount()).toBe(1);
  });

  test('an existing variable without --force is refused with ADD_VAR_EXISTS (exit 3) and left untouched', async () => {
    await h().run(['add', 'ADD_EXISTS', '--json'], 'first\n');
    const pushes = h().pushCount();
    const r = await h().run(['add', 'ADD_EXISTS', '--json'], 'second\n');
    expect(r.code).toBe(3);
    const out = parseJson(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('ADD_VAR_EXISTS');
    expect(String(out.error)).toContain('--force');
    expect(String(out.error)).toContain('capy edit ADD_EXISTS');
    expect(h().envValue('ADD_EXISTS')).toBe('first');
    expect(h().pushCount()).toBe(pushes);
  });

  test('the same refusal in human mode goes to stderr only', async () => {
    const r = await h().run(['add', 'ADD_EXISTS'], 'second\n');
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('ADD_EXISTS already exists');
  });

  test('--force overwrites: updated', async () => {
    const r = await h().run(['add', 'ADD_EXISTS', '--force', '--json'], 'second\n');
    expect(r.code).toBe(0);
    expect(parseJson(r.stdout)).toEqual({ ok: true, name: 'ADD_EXISTS', branch: BRANCH, action: 'updated', pushed: true, keep_lock: { changed: true, committed: false }, unanswered: UNANSWERED });
    expect(h().envValue('ADD_EXISTS')).toBe('second');
  });

  test('more than one name is refused with ADD_STDIN_ONE_NAME (exit 3); nothing is written', async () => {
    const pushes = h().pushCount();
    const r = await h().run(['add', 'ADD_ONE', 'ADD_TWO', '--json'], 'v\n');
    expect(r.code).toBe(3);
    expect(parseJson(r.stdout).code).toBe('ADD_STDIN_ONE_NAME');
    expect(h().envValue('ADD_ONE')).toBeUndefined();
    expect(h().envValue('ADD_TWO')).toBeUndefined();
    expect(h().pushCount()).toBe(pushes);
  });

  test('empty after stripping one line ending: STDIN_EMPTY, nothing written', async () => {
    const pushes = h().pushCount();
    const r = await h().run(['add', 'ADD_EMPTY', '--json'], '\n');
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout).code).toBe('STDIN_EMPTY');
    expect(h().envValue('ADD_EMPTY')).toBeUndefined();
    expect(h().pushCount()).toBe(pushes);
    const none = await h().run(['add', 'ADD_EMPTY', '--json']);
    expect(parseJson(none.stdout).code).toBe('STDIN_EMPTY');
  });

  test('over 1 MiB: STDIN_TOO_LARGE; exactly 1 MiB is accepted', async () => {
    const over = await h().run(['add', 'ADD_BIG', '--json'], 'a'.repeat(1024 * 1024 + 1));
    expect(over.code).toBe(1);
    expect(parseJson(over.stdout).code).toBe('STDIN_TOO_LARGE');
    expect(h().envValue('ADD_BIG')).toBeUndefined();

    const at = await h().run(['add', 'ADD_AT_CAP', '--json', '--no-push'], 'a'.repeat(1024 * 1024));
    expect(at.code).toBe(0);
  });

  test('a PEM key with inner newlines round-trips byte for byte; one trailing newline is stripped, nothing else', async () => {
    await h().run(['add', 'ADD_PEM', '--json'], `${PEM}\n`);
    expect(h().envValue('ADD_PEM')).toBe(PEM);
    await h().run(['add', 'ADD_SPACES', '--json'], '  a  \n\n');
    expect(h().envValue('ADD_SPACES')).toBe('  a  \n');
  });

  test('NUL and invalid UTF-8 are INVALID_FORMAT', async () => {
    const nul = await h().run(['add', 'ADD_NUL', '--json'], Buffer.from([0x61, 0x00]));
    expect(parseJson(nul.stdout).code).toBe('INVALID_FORMAT');
    const bad = await h().run(['add', 'ADD_BAD', '--json'], Buffer.from([0xc3, 0x28]));
    expect(parseJson(bad.stdout).code).toBe('INVALID_FORMAT');
  });

  test('--no-push writes .env only: no push call, result says so', async () => {
    const pushes = h().pushCount();
    const r = await h().run(['add', 'ADD_LOCAL', '--no-push', '--json'], 'local\n');
    expect(parseJson(r.stdout)).toEqual({ ok: true, name: 'ADD_LOCAL', branch: BRANCH, action: 'created', pushed: false, keep_lock: { changed: false } });
    expect(h().envValue('ADD_LOCAL')).toBe('local');
    expect(h().pushCount()).toBe(pushes);
  });

  test('a bad name is INVALID_FORMAT and the argument is not echoed', async () => {
    const r = await h().run(['add', 'BAD-NAME=hunter2', '--json'], 'x\n');
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout).code).toBe('INVALID_FORMAT');
    expect(r.stdout + r.stderr).not.toContain('hunter2');
  });

  test('--non-tty with a closed pipe reads as an empty value (the old refusal still applies when stdin is a terminal)', async () => {
    const r = await h().run(['add', 'ADD_NT', '--json', '--non-tty']);
    expect(parseJson(r.stdout).code).toBe('STDIN_EMPTY');
  });

  test('a failed push is a coded refusal and writes nothing confirmed', async () => {
    const failing = await createHarness();
    try {
      failing.failPushes();
      const r = await failing.run(['add', 'ADD_PUSH_FAIL', '--json'], 'v\n');
      expect(r.code).toBe(1);
      expect(parseJson(r.stdout).ok).toBe(false);
    } finally {
      await failing.dispose();
    }
  });

  test('--pr with --no-pr is refused before anything is written', async () => {
    const pushes = h().pushCount();
    const r = await h().run(['add', 'ADD_PR_CONFLICT', '--pr', '--no-pr', '--json'], 'v\n');
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
    expect(h().pushCount()).toBe(pushes);
    expect(h().envValue('ADD_PR_CONFLICT')).toBeUndefined();
  });

  test('--no-pr: keep_lock is changed-not-committed and nothing is left unanswered', async () => {
    const r = await h().run(['add', 'ADD_PR_NO', '--no-pr', '--json'], 'v\n');
    expect(r.code).toBe(0);
    expect(parseJson(r.stdout)).toMatchObject({ ok: true, keep_lock: { changed: true, committed: false } });
    expect(parseJson(r.stdout).unanswered).toBeUndefined();
  });

  test('--pr outside a repository checkout: the add still succeeds (exit 0) and keep_lock.error is coded', async () => {
    const r = await h().run(['add', 'ADD_PR_NOT_GIT', '--pr', '--json'], 'v\n');
    expect(r.code).toBe(0);
    expect(h().envValue('ADD_PR_NOT_GIT')).toBe('v');
    expect(parseJson(r.stdout).keep_lock).toMatchObject({ changed: true, committed: false, error: { code: 'KEEP_PR_NOT_GIT_REPO' } });
  });
});
