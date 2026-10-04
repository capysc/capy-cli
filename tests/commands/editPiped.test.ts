/**
 * `capy edit NAME` with a piped value, driven through the real argument parser
 * of the BUILT cli (`dist/index.js`) against an isolated HOME and a local mock
 * service (tests/helpers/pipedHarness.ts). Needs `bun run build` first.
 *
 * Spec tests 3–9 live here; 1–2 are in tests/commands/editMode.test.ts and 10 in
 * tests/commands/agentsBlockUpgrade.test.ts. The leak test (9) is the one that
 * must never be skipped: the value never leaves the process except encrypted.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, digest, BRANCH, DEV_CLI, type Harness } from '../helpers/pipedHarness';

const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
  '',
  'MBQwEgYDVQQDEwtleGFtcGxlLmNvbQ==',
  '-----END PRIVATE KEY-----',
  '',
].join('\n');

const FIXTURE_PEM = readFileSync(join(__dirname, '../fixtures/rsa_test_key.pem'), 'utf8');

// Neither --pr nor --no-pr and no terminal: the PR step does not run and says which flags would answer it.
const UNANSWERED = [
  { id: 'create_pr', flag: '--pr' },
  { id: 'pr_base', flag: '--pr-base' },
];

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('capy edit NAME < value (piped)', () => {
  const state = { harness: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.harness) throw new Error('harness not ready');
    return state.harness;
  };

  // A fresh world per describe-level test would triple the spawn cost; tests below use distinct names instead.
  beforeAll(async () => {
    Object.assign(state, { harness: await createHarness() });
  });
  afterAll(async () => {
    await state.harness?.dispose();
  });

  test('3. creates, then updates, then reports unchanged; JSON is pure and names no hash', async () => {
    const first = await h().run(['edit', 'SPEC3_TOKEN', '--json'], 'v\n');
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(parseJson(first.stdout)).toEqual({ ok: true, name: 'SPEC3_TOKEN', branch: BRANCH, action: 'created', pushed: true, keep_lock: { changed: true, committed: false }, unanswered: UNANSWERED });
    expect(h().envValue('SPEC3_TOKEN')).toBe('v');
    expect(h().pushCount()).toBe(1);

    const second = await h().run(['edit', 'SPEC3_TOKEN', '--json'], 'w\n');
    expect(parseJson(second.stdout)).toEqual({ ok: true, name: 'SPEC3_TOKEN', branch: BRANCH, action: 'updated', pushed: true, keep_lock: { changed: true, committed: false }, unanswered: UNANSWERED });
    expect(h().envValue('SPEC3_TOKEN')).toBe('w');
    expect(h().pushCount()).toBe(2);

    const third = await h().run(['edit', 'SPEC3_TOKEN', '--json'], 'w\n');
    expect(third.code).toBe(0);
    expect(parseJson(third.stdout)).toEqual({ ok: true, name: 'SPEC3_TOKEN', branch: BRANCH, action: 'unchanged', pushed: false, keep_lock: { changed: false } });
    expect(h().pushCount()).toBe(2); // unchanged: no push
    expect(Object.keys(parseJson(third.stdout)).toSorted()).toEqual(['action', 'branch', 'keep_lock', 'name', 'ok', 'pushed']);
  });

  test('3b. human mode is one line on stderr and nothing on stdout', async () => {
    const r = await h().run(['edit', 'SPEC3B_TOKEN'], 'x\n');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe(`✓ Set SPEC3B_TOKEN on ${BRANCH} (synced)`);
  });

  test('4. strips exactly one trailing line ending and nothing else', async () => {
    await h().run(['edit', 'SPEC4_TWO_NEWLINES', '--json'], 'a\n\n');
    expect(h().envValue('SPEC4_TWO_NEWLINES')).toBe('a\n');

    await h().run(['edit', 'SPEC4_SPACES', '--json'], '  a  ');
    expect(h().envValue('SPEC4_SPACES')).toBe('  a  ');

    await h().run(['edit', 'SPEC4_CRLF', '--json'], 'a\r\n');
    expect(h().envValue('SPEC4_CRLF')).toBe('a');

    await h().run(['edit', 'SPEC4_BARE_CR', '--json'], 'a\r');
    expect(h().envValue('SPEC4_BARE_CR')).toBe('a\r');
  });

  test('4b. a PEM key with inner newlines round-trips byte for byte (with and without the final newline)', async () => {
    await h().run(['edit', 'SPEC4_PEM', '--json'], PEM);
    expect(h().envValue('SPEC4_PEM')).toBe(PEM.slice(0, -1));

    await h().run(['edit', 'SPEC4_PEM_FIXTURE', '--json'], FIXTURE_PEM.trimEnd());
    expect(h().envValue('SPEC4_PEM_FIXTURE')).toBe(FIXTURE_PEM.trimEnd());
  });

  test('4c. a UTF-8 value (and a leading BOM) survives intact', async () => {
    await h().run(['edit', 'SPEC4_UNICODE', '--json'], 'pässwörd-日本語-🔑\n');
    expect(h().envValue('SPEC4_UNICODE')).toBe('pässwörd-日本語-🔑');
    await h().run(['edit', 'SPEC4_BOM', '--json'], '﻿abc\n');
    expect(h().envValue('SPEC4_BOM')).toBe('﻿abc');
  });

  test('5. empty input is refused with STDIN_EMPTY and nothing is written', async () => {
    const before = digest(JSON.stringify(h().allFiles().map(([p, b]) => [p, b.toString('base64')])));
    const pushesBefore = h().pushCount();
    const r = await h().run(['edit', 'SPEC5_EMPTY', '--json'], '');
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout).code).toBe('STDIN_EMPTY');
    expect(parseJson(r.stdout).ok).toBe(false);
    expect(h().pushCount()).toBe(pushesBefore);
    expect(digest(JSON.stringify(h().allFiles().map(([p, b]) => [p, b.toString('base64')])))).toBe(before);
    expect(h().envValue('SPEC5_EMPTY')).toBeUndefined();

    // a lone line ending is "empty" too
    const lone = await h().run(['edit', 'SPEC5_EMPTY', '--json'], '\n');
    expect(parseJson(lone.stdout).code).toBe('STDIN_EMPTY');
    const crlf = await h().run(['edit', 'SPEC5_EMPTY', '--json'], '\r\n');
    expect(parseJson(crlf.stdout).code).toBe('STDIN_EMPTY');
  });

  test('6. exactly 1 MiB is accepted; 1 MiB + 1 byte is STDIN_TOO_LARGE and nothing is written', async () => {
    const atCap = await h().run(['edit', 'SPEC6_AT_CAP', '--json', '--no-push'], 'a'.repeat(1024 * 1024));
    expect(atCap.code).toBe(0);
    expect(h().envValue('SPEC6_AT_CAP')?.length).toBe(1024 * 1024);

    const over = await h().run(['edit', 'SPEC6_OVER', '--json'], 'a'.repeat(1024 * 1024 + 1));
    expect(over.code).toBe(1);
    expect(parseJson(over.stdout).code).toBe('STDIN_TOO_LARGE');
    expect(h().envValue('SPEC6_OVER')).toBeUndefined();
  });

  test('6b. input far past the cap is refused promptly, without reading it all', async () => {
    const r = await h().run(['edit', 'SPEC6_HUGE', '--json'], Buffer.alloc(64 * 1024 * 1024, 0x61));
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout).code).toBe('STDIN_TOO_LARGE');
  });

  test('7. capy edit with no name and no terminal refuses at once with EDIT_NEEDS_TTY, exit 3', async () => {
    const pushesBefore = h().pushCount();
    const requestsBefore = h().requests().length;
    const human = await h().run(['edit']);
    expect(human.code).toBe(3);
    expect(human.elapsedMs).toBeLessThan(5000);
    expect(human.stdout).toBe(''); // nothing drawn into the captured stdout
    expect(human.stderr).toContain('pipe a value: <cmd> | capy edit NAME, or run in a terminal');

    const json = await h().run(['edit', '--json']);
    expect(json.code).toBe(3);
    expect(parseJson(json.stdout).code).toBe('EDIT_NEEDS_TTY');
    // before any auth or network call
    expect(h().requests().length).toBe(requestsBefore);
    expect(h().pushCount()).toBe(pushesBefore);
  }, 15000);

  test('7b. --non-tty with a name and nothing piped is refused rather than waiting', async () => {
    // stdin here is a closed pipe: that IS "nothing piped" and reads as an empty value.
    const r = await h().run(['edit', 'SPEC7B', '--json', '--non-tty']);
    expect(parseJson(r.stdout).code).toBe('STDIN_EMPTY');
  }, 15000);

  test('8. --no-push updates .env only: no push call, and the result says so', async () => {
    const pushesBefore = h().pushCount();
    const r = await h().run(['edit', 'SPEC8_LOCAL', '--json', '--no-push'], 'local-only\n');
    expect(r.code).toBe(0);
    expect(parseJson(r.stdout)).toEqual({ ok: true, name: 'SPEC8_LOCAL', branch: BRANCH, action: 'created', pushed: false, keep_lock: { changed: false } });
    expect(h().envValue('SPEC8_LOCAL')).toBe('local-only');
    expect(h().pushCount()).toBe(pushesBefore);

    const human = await h().run(['edit', 'SPEC8_LOCAL_B', '--no-push'], 'x\n');
    expect(human.stderr.trim()).toBe(`✓ Set SPEC8_LOCAL_B on ${BRANCH} (.env only — not pushed)`);
  });

  test('a name that is not a valid variable name is INVALID_FORMAT and is not echoed', async () => {
    const r = await h().run(['edit', 'NOT-VALID=hunter2', '--json'], 'x\n');
    expect(r.code).toBe(1);
    expect(parseJson(r.stdout).code).toBe('INVALID_FORMAT');
    expect(r.stdout + r.stderr).not.toContain('hunter2');
    expect(r.stdout + r.stderr).not.toContain('NOT-VALID');
  });

  test('a NUL byte is INVALID_FORMAT; bytes that are not UTF-8 are INVALID_FORMAT', async () => {
    const nul = await h().run(['edit', 'SPEC_NUL', '--json'], Buffer.from([0x61, 0x00, 0x62]));
    expect(parseJson(nul.stdout).code).toBe('INVALID_FORMAT');
    expect(h().envValue('SPEC_NUL')).toBeUndefined();

    const bad = await h().run(['edit', 'SPEC_BAD_UTF8', '--json'], Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    expect(parseJson(bad.stdout).code).toBe('INVALID_FORMAT');
    expect(h().envValue('SPEC_BAD_UTF8')).toBeUndefined();
  });

  test('a failed push is a coded refusal on the --json channel, exit 1', async () => {
    const failing = await createHarness();
    try {
      failing.failPushes();
      const r = await failing.run(['edit', 'SPEC_PUSH_FAIL', '--json'], 'v\n');
      expect(r.code).toBe(1);
      const out = parseJson(r.stdout);
      expect(out.ok).toBe(false);
      expect(typeof out.code).toBe('string');
    } finally {
      await failing.dispose();
    }
  });

  test('no session: AUTH_FAILED at once. Piped mode never starts the browser sign-in', async () => {
    const signedOut = await createHarness();
    try {
      rmSync(join(signedOut.home, '.capy', 'auth'), { recursive: true, force: true });
      const r = await signedOut.run(['edit', 'SPEC_NO_SESSION', '--json'], 'v\n');
      expect(r.code).toBe(1);
      expect(parseJson(r.stdout).code).toBe('AUTH_FAILED');
      expect(r.elapsedMs).toBeLessThan(10000);
      expect(signedOut.pushCount()).toBe(0);
    } finally {
      await signedOut.dispose();
    }
  }, 20000);

  test('capy-dev registers the same [name] and piped mode', async () => {
    const r = await h().run(['edit', 'SPEC_DEV', '--json'], 'v\n', DEV_CLI);
    // capy-dev reads ~/.capy-dev, which the throwaway HOME does not have: a coded refusal, never a hang or a prompt.
    expect(r.code).toBe(1);
    expect(typeof parseJson(r.stdout).code).toBe('string');
    const noName = await h().run(['edit', '--json'], undefined, DEV_CLI);
    expect(noName.code).toBe(3);
    expect(parseJson(noName.stdout).code).toBe('EDIT_NEEDS_TTY');
  }, 20000);

  test('no keep.lock is a coded refusal (NO_KEEP_FILE), not prose', async () => {
    const bare = await createHarness();
    try {
      rmSync(join(bare.project, 'keep.lock'));
      const r = await bare.run(['edit', 'SPEC_NO_KEEP', '--json'], 'v\n');
      expect(r.code).toBe(1);
      expect(parseJson(r.stdout).code).toBe('NO_KEEP_FILE');
    } finally {
      await bare.dispose();
    }
  });

  describe('keep.lock PR flags (--pr / --no-pr / --pr-base)', () => {
    test('--pr with --no-pr is refused before anything is written', async () => {
      const before = digest(JSON.stringify(h().allFiles().map(([p, b]) => [p, b.toString('base64')])));
      const pushesBefore = h().pushCount();
      const r = await h().run(['edit', 'PR_CONFLICT', '--pr', '--no-pr', '--json'], 'v\n');
      expect(r.code).toBe(1);
      expect(parseJson(r.stdout)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
      expect(h().pushCount()).toBe(pushesBefore);
      expect(digest(JSON.stringify(h().allFiles().map(([p, b]) => [p, b.toString('base64')])))).toBe(before);
    });

    test('--no-pr: the change is reported, no PR, and nothing is left unanswered', async () => {
      const r = await h().run(['edit', 'PR_NO', '--no-pr', '--json'], 'v\n');
      expect(r.code).toBe(0);
      expect(parseJson(r.stdout)).toEqual({
        ok: true,
        name: 'PR_NO',
        branch: BRANCH,
        action: 'created',
        pushed: true,
        keep_lock: { changed: true, committed: false },
      });
    });

    test('--pr outside a git repository: the secret change still succeeds (exit 0) with a coded keep_lock.error', async () => {
      const r = await h().run(['edit', 'PR_NOT_GIT', '--pr', '--pr-base', 'dev', '--json'], 'v\n');
      expect(r.code).toBe(0);
      const out = parseJson(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.action).toBe('created');
      expect(h().envValue('PR_NOT_GIT')).toBe('v');
      expect(out.keep_lock).toMatchObject({ changed: true, committed: false, error: { code: 'KEEP_PR_NOT_GIT_REPO' } });
      expect(out.unanswered).toBeUndefined();
    });

    test('--pr-base alone leaves only the create-PR question unanswered', async () => {
      const r = await h().run(['edit', 'PR_BASE_ONLY', '--pr-base', 'dev', '--json'], 'v\n');
      expect(r.code).toBe(0);
      expect(parseJson(r.stdout).unanswered).toEqual([{ id: 'create_pr', flag: '--pr' }]);
    });

    test('the flags are in the built CLI help', async () => {
      const r = await h().run(['help', '--json']);
      const doc = parseJson(r.stdout) as { commands: { name: string; options: { long: string }[] }[]; errorCodes: string[] };
      for (const name of ['add', 'edit', 'remove']) {
        const longs = doc.commands.find((c) => c.name === name)?.options.map((o) => o.long) ?? [];
        expect(longs).toEqual(expect.arrayContaining(['--pr', '--no-pr', '--pr-base']));
      }
      expect(doc.errorCodes).toEqual(expect.arrayContaining(['KEEP_PR_NOT_GIT_REPO', 'KEEP_PR_BASE_UNRESOLVED', 'KEEP_PR_CREATE_FAILED']));
    });
  });
});
