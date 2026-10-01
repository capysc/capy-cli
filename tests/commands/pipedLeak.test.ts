/**
 * THE LEAK TEST (spec test 9). The hard rule: a piped value never leaves the
 * process except encrypted.
 *
 * Every path of `capy edit NAME` and `capy add NAME` with a piped value, success
 * and every refusal, is run through the BUILT cli with `--verbose` and a sentinel
 * as the value. Afterwards the sentinel must appear in none of:
 *   - stdout, stderr (success, errors, debug logs, stack traces)
 *   - any request body the mock service received (it only ever sees ciphertext)
 *   - any file under the throwaway HOME or project (.env, keep.lock, caches, ...)
 * in plaintext, JSON-escaped, or base64.
 *
 * Includes a forced push failure. Needs `bun run build` first.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, type CliResult, type Harness } from '../helpers/pipedHarness';

const SENTINEL = 'SENTINEL_5d41402abc4b2a76b9719d911017c592_ZZ';
const SENTINEL_FORMS: readonly (string | Buffer)[] = [
  SENTINEL,
  JSON.stringify(SENTINEL).slice(1, -1),
  Buffer.from(SENTINEL).toString('base64').replace(/=+$/, ''),
  Buffer.from(SENTINEL).toString('hex'),
  encodeURIComponent(SENTINEL),
];

function leaks(haystack: string | Buffer): readonly string[] {
  const buffer = typeof haystack === 'string' ? Buffer.from(haystack) : haystack;
  return SENTINEL_FORMS.filter((form) => buffer.includes(form)).map((form) => String(form).slice(0, 12));
}

/** Fails (naming WHERE, never the value) if the sentinel is anywhere it must not be. */
function expectNoLeak(label: string, result: CliResult, harness: Harness): void {
  expect({ label, where: 'stdout', found: leaks(result.stdout) }).toEqual({ label, where: 'stdout', found: [] });
  expect({ label, where: 'stderr', found: leaks(result.stderr) }).toEqual({ label, where: 'stderr', found: [] });
  const requestLeaks = harness.requests().filter((r) => leaks(r.body).length > 0 || leaks(r.path).length > 0);
  expect({ label, where: 'service request bodies', found: requestLeaks.length }).toEqual({
    label,
    where: 'service request bodies',
    found: 0,
  });
  const fileLeaks = harness.allFiles().filter(([, bytes]) => leaks(bytes).length > 0).map(([path]) => path);
  expect({ label, where: 'files on disk', found: fileLeaks }).toEqual({ label, where: 'files on disk', found: [] });
}

const VERBOSE = '--verbose';

describe('leak test: the value never appears in output, errors, requests or files', () => {
  test('the sentinel check itself can fail (the test is not vacuous)', () => {
    expect(leaks(`prefix ${SENTINEL} suffix`)).not.toEqual([]);
    expect(leaks(Buffer.from(JSON.stringify({ v: SENTINEL })))).not.toEqual([]);
    expect(leaks(Buffer.from(SENTINEL).toString('base64'))).not.toEqual([]);
    expect(leaks('nothing to see')).toEqual([]);
  });

  test('every channel is really watched: a planted sentinel in stdout, stderr, a request or a file is caught', async () => {
    const harness = await createHarness();
    try {
      const clean: CliResult = { stdout: '', stderr: '', code: 0, elapsedMs: 0 };
      expectNoLeak('clean', clean, harness); // control: nothing planted, nothing found
      expect(() => expectNoLeak('stdout', { ...clean, stdout: `x ${SENTINEL}` }, harness)).toThrow();
      expect(() => expectNoLeak('stderr', { ...clean, stderr: `x ${SENTINEL}` }, harness)).toThrow();
      writeFileSync(join(harness.home, 'planted.txt'), `x ${SENTINEL}`);
      expect(() => expectNoLeak('file', clean, harness)).toThrow();
    } finally {
      await harness.dispose();
    }
  });

  describe('capy edit NAME', () => {
    test('success paths: created, updated, unchanged, --no-push, in --json and human mode', async () => {
      const harness = await createHarness();
      try {
        const runs: readonly (readonly [string, readonly string[], string])[] = [
          ['create --json', ['edit', 'LEAK_A', '--json', VERBOSE], `${SENTINEL}\n`],
          ['unchanged --json', ['edit', 'LEAK_A', '--json', VERBOSE], `${SENTINEL}\n`],
          ['update --json', ['edit', 'LEAK_A', '--json', VERBOSE], `${SENTINEL}-two\n`],
          ['create human', ['edit', 'LEAK_B', VERBOSE], `${SENTINEL}\n`],
          ['update human', ['edit', 'LEAK_B', VERBOSE], `${SENTINEL}-two\n`],
          ['no-push --json', ['edit', 'LEAK_C', '--json', '--no-push', VERBOSE], `${SENTINEL}\n`],
          ['no-push human', ['edit', 'LEAK_D', '--no-push', VERBOSE], `${SENTINEL}\n`],
        ];
        // Sequential on purpose: each run builds on the state the one before left.
        await runs.reduce(async (previous, [label, args, stdin]) => {
          await previous;
          const result = await harness.run(args, stdin);
          expect({ label, code: result.code }).toEqual({ label, code: 0 });
          expectNoLeak(label, result, harness);
        }, Promise.resolve());
      } finally {
        await harness.dispose();
      }
    }, 60000);

    test('every refusal: bad name carrying the value, NUL, invalid UTF-8, too large, empty, no keep.lock', async () => {
      const harness = await createHarness();
      try {
        const nul = Buffer.from(`${SENTINEL}\u0000tail`);
        const badUtf8 = Buffer.concat([Buffer.from(SENTINEL), Buffer.from([0xff, 0xfe])]);
        const tooLarge = Buffer.concat([Buffer.from(SENTINEL), Buffer.alloc(1024 * 1024, 0x61)]);
        const runs: readonly (readonly [string, readonly string[], Buffer | string, number])[] = [
          // the value typed as `NAME=value` by mistake: refused WITHOUT echoing the argument
          ['bad name = value', ['edit', `API_KEY=${SENTINEL}`, '--json', VERBOSE], `${SENTINEL}\n`, 1],
          ['bad name human', ['edit', `API-${SENTINEL}`, VERBOSE], `${SENTINEL}\n`, 1],
          ['NUL', ['edit', 'LEAK_NUL', '--json', VERBOSE], nul, 1],
          ['NUL human', ['edit', 'LEAK_NUL', VERBOSE], nul, 1],
          ['invalid UTF-8', ['edit', 'LEAK_UTF8', '--json', VERBOSE], badUtf8, 1],
          ['too large', ['edit', 'LEAK_BIG', '--json', VERBOSE], tooLarge, 1],
          ['too large human', ['edit', 'LEAK_BIG', VERBOSE], tooLarge, 1],
          ['empty', ['edit', 'LEAK_EMPTY', '--json', VERBOSE], '', 1],
          ['no terminal, no name', ['edit', '--json', VERBOSE], '', 3],
        ];
        await runs.reduce(async (previous, [label, args, stdin, code]) => {
          await previous;
          const result = await harness.run(args, stdin);
          expect({ label, code: result.code }).toEqual({ label, code });
          expectNoLeak(label, result, harness);
        }, Promise.resolve());

        // keep.lock gone: the value was read, then the run is refused before any write
        rmSync(join(harness.project, 'keep.lock'));
        const noKeep = await harness.run(['edit', 'LEAK_NOKEEP', '--json', VERBOSE], `${SENTINEL}\n`);
        expect(noKeep.code).toBe(1);
        expectNoLeak('no keep.lock', noKeep, harness);
      } finally {
        await harness.dispose();
      }
    }, 90000);

    test('forced push failure: coded refusal, value in neither stream, request, nor file', async () => {
      const harness = await createHarness();
      try {
        harness.failPushes();
        const asJson = await harness.run(['edit', 'LEAK_PUSH', '--json', VERBOSE], `${SENTINEL}\n`);
        expect(asJson.code).toBe(1);
        expect(JSON.parse(asJson.stdout).ok).toBe(false);
        expectNoLeak('push failure --json', asJson, harness);

        const human = await harness.run(['edit', 'LEAK_PUSH', VERBOSE], `${SENTINEL}\n`);
        expect(human.code).toBe(1);
        expectNoLeak('push failure human', human, harness);
      } finally {
        await harness.dispose();
      }
    }, 60000);

    test('auth refused (no session) and key unavailable: coded, no value anywhere', async () => {
      const noSession = await createHarness();
      try {
        rmSync(join(noSession.home, '.capy', 'auth'), { recursive: true, force: true });
        const result = await noSession.run(['edit', 'LEAK_AUTH', '--json', VERBOSE], `${SENTINEL}\n`);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout).code).toBe('AUTH_FAILED');
        expectNoLeak('auth refused', result, noSession);
      } finally {
        await noSession.dispose();
      }

      const noKey = await createHarness();
      try {
        rmSync(join(noKey.home, '.capy', 'orgs'), { recursive: true, force: true });
        const result = await noKey.run(['edit', 'LEAK_KEY', '--json', VERBOSE], `${SENTINEL}\n`);
        expect(result.code).toBe(1);
        expectNoLeak('key unavailable', result, noKey);
      } finally {
        await noKey.dispose();
      }
    }, 60000);
  });

  describe('capy add NAME', () => {
    test('success, exists-without-force, --force, multiple names, --no-push', async () => {
      const harness = await createHarness();
      try {
        const runs: readonly (readonly [string, readonly string[], string, number])[] = [
          ['add create --json', ['add', 'LEAK_ADD', '--json', VERBOSE], `${SENTINEL}\n`, 0],
          ['add exists no force --json', ['add', 'LEAK_ADD', '--json', VERBOSE], `${SENTINEL}-2\n`, 3],
          ['add exists no force human', ['add', 'LEAK_ADD', VERBOSE], `${SENTINEL}-2\n`, 3],
          ['add --force --json', ['add', 'LEAK_ADD', '--force', '--json', VERBOSE], `${SENTINEL}-2\n`, 0],
          ['add multiple names', ['add', 'LEAK_X', 'LEAK_Y', '--json', VERBOSE], `${SENTINEL}\n`, 3],
          ['add multiple names human', ['add', 'LEAK_X', 'LEAK_Y', VERBOSE], `${SENTINEL}\n`, 3],
          ['add no-push', ['add', 'LEAK_LOCAL', '--no-push', '--json', VERBOSE], `${SENTINEL}\n`, 0],
          ['add human', ['add', 'LEAK_HUMAN', VERBOSE], `${SENTINEL}\n`, 0],
        ];
        await runs.reduce(async (previous, [label, args, stdin, code]) => {
          await previous;
          const result = await harness.run(args, stdin);
          expect({ label, code: result.code }).toEqual({ label, code });
          expectNoLeak(label, result, harness);
        }, Promise.resolve());
      } finally {
        await harness.dispose();
      }
    }, 90000);

    test('every refusal: bad name carrying the value, NUL, invalid UTF-8, too large, empty', async () => {
      const harness = await createHarness();
      try {
        const nul = Buffer.from(`${SENTINEL}\u0000tail`);
        const badUtf8 = Buffer.concat([Buffer.from(SENTINEL), Buffer.from([0xff])]);
        const tooLarge = Buffer.concat([Buffer.from(SENTINEL), Buffer.alloc(1024 * 1024, 0x61)]);
        const runs: readonly (readonly [string, readonly string[], Buffer | string])[] = [
          ['add bad name = value', ['add', `API_KEY=${SENTINEL}`, '--json', VERBOSE], `${SENTINEL}\n`],
          ['add NUL', ['add', 'LEAK_NUL', '--json', VERBOSE], nul],
          ['add invalid UTF-8', ['add', 'LEAK_UTF8', '--json', VERBOSE], badUtf8],
          ['add too large', ['add', 'LEAK_BIG', '--json', VERBOSE], tooLarge],
          ['add too large human', ['add', 'LEAK_BIG', VERBOSE], tooLarge],
          ['add empty', ['add', 'LEAK_EMPTY', '--json', VERBOSE], ''],
        ];
        await runs.reduce(async (previous, [label, args, stdin]) => {
          await previous;
          const result = await harness.run(args, stdin);
          expect({ label, refused: result.code !== 0 }).toEqual({ label, refused: true });
          expectNoLeak(label, result, harness);
        }, Promise.resolve());
      } finally {
        await harness.dispose();
      }
    }, 90000);

    test('forced push failure', async () => {
      const harness = await createHarness();
      try {
        harness.failPushes();
        const result = await harness.run(['add', 'LEAK_PUSH', '--json', VERBOSE], `${SENTINEL}\n`);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout).ok).toBe(false);
        expectNoLeak('add push failure', result, harness);
      } finally {
        await harness.dispose();
      }
    }, 30000);
  });

  test('the piped-value modules never touch process.env or temp files', () => {
    // Code only: the doc comments say "not placed in process.env" on purpose.
    const sources = ['pipedValue.ts', 'pipedWrite.ts', 'editPiped.ts'].map((file) =>
      readFileSync(join(__dirname, '../../src/commands', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    );
    sources.forEach((source) => {
      expect(source).not.toContain('process.env');
      expect(source).not.toMatch(/tmpdir|mkdtemp|writeFile|appendFile/);
    });
  });
});
