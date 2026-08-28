/**
 * Runs real commands under `--web` and looks at what actually reached the
 * caller. Nothing else in this repo does that except `webPhraseLeak.test.ts`,
 * and that covers one command's happy path.
 *
 * WHY A BEHAVIOURAL TEST, AND WHY SOURCE-LEVEL ONES WERE NOT ENOUGH
 * ---------------------------------------------------------------------------
 * `webFlagWiring.test.ts` asserts, by reading source, that each command threads
 * the flag. It passed for the entire life of `capy deploy --web`, which has
 * never worked: the block it scanned contained two routes to the
 * implementation and only one of them was wired, so a sibling of the broken
 * code satisfied the scan. A test that reads source can only ever check the
 * shape someone wrote; this one checks what the program does.
 *
 * THE RULE UNDER TEST
 * ---------------------------------------------------------------------------
 * `--web` exists because the caller has no terminal — an agent, or a person on
 * another device. So a refusal that goes only to stderr is a refusal nobody
 * receives. Under `--web` every ending owes the caller a URL: the
 * `command-error` page `displayErrorAndExit` already serves. The bug class is
 * `console.error(...); process.exit(1)` in a guard clause, which never throws,
 * so the surrounding catch never runs and the page is never served. The fix
 * pattern is documented in `rotateCommand.ts` and was applied there and in
 * `connectCommand`; these paths never got it.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * "No URL in the output" is trivially true of a command that never ran, or
 * that died on a missing binary, or that is still starting up. So each case
 * first proves the command REACHED ITS GUARD by observing the refusal it
 * emits, and only then asserts on the URL. Without that, this file would pass
 * vacuously the day someone renames the entrypoint.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const ENTRY = join(CLI_ROOT, 'src/index.ts');
/** Any URL the caller could act on — the loopback page, or a Keep page. */
const ANY_URL = /https?:\/\/[^\s"'`]+/;

interface Run {
  readonly out: string;
  readonly err: string;
  readonly combined: string;
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** Spawn a real command in a clean HOME and collect everything it emitted. */
async function runWeb(args: readonly string[], settleMs = 20_000): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'capy-weburl-'));
  homes.push(home);
  const acc = { out: '', err: '' };
  const child: ChildProcess = spawn('bun', [ENTRY, ...args, '--web'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      // NEVER remove: without it the command opens the developer's real browser.
      CAPY_WEB_NO_OPEN: '1',
      CAPY_NO_AUTOCOMMIT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (acc.out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (acc.err += d.toString()));

  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, settleMs);
    child.on('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
  return { out: acc.out, err: acc.err, combined: acc.out + acc.err };
}

describe('under --web, a refusal still reaches the caller', () => {
  test('deploy: the uninitialised-project guard serves a URL, not just stderr', async () => {
    const r = await runWeb(['deploy']);

    // CONTROL: the command ran and reached its guard. Asserted on the refusal
    // it emits, so "no URL" can never be satisfied by a command that never got
    // this far.
    expect(
      r.combined.length,
      `the command produced NO output at all, so it cannot be shown to have reached ` +
        `its guard — this is an inconclusive run, not a passing one.`,
    ).toBeGreaterThan(0);
    expect(
      r.combined,
      `expected the uninitialised-project refusal, which is the control proving ` +
        `the command reached the guard under test.\nstdout:\n${r.out}\nstderr:\n${r.err}`,
    ).toContain('keep.lock');

    // THE ASSERTION: --web owes the caller something they can open.
    expect(
      ANY_URL.test(r.combined),
      `\`capy deploy --web\` refused with no URL anywhere in its output. Under ` +
        `--web the caller has no terminal, so a refusal written to stderr is a ` +
        `refusal nobody receives. The guard exits via console.error + ` +
        `process.exit(1), which never throws, so displayErrorAndExit never runs ` +
        `and the command-error page is never served.\n` +
        `stdout:\n${r.out}\nstderr:\n${r.err}`,
    ).toBe(true);
  }, 40_000);

  /**
   * THE INSTRUMENT'S OWN CONTROL.
   *
   * The test above asserts an ABSENCE — no URL in the output. An absence is
   * satisfied by any harness that cannot see a URL in the first place: a wrong
   * regex, output collected off the wrong stream, a spawn that dies early.
   *
   * So this runs a command whose `--web` path is known to work and requires the
   * SAME harness, the SAME streams and the SAME pattern to find its URL. If
   * this fails, the failure above proves nothing about deploy and everything
   * about this file.
   *
   * `byoc --web` is the one command with existing behavioural coverage
   * (`webPhraseLeak.test.ts`), which is precisely why it makes a trustworthy
   * control: its browser path is independently known to serve a page.
   */
  test('CONTROL: a working --web path IS seen by this harness', async () => {
    const r = await runWeb(['byoc']);

    expect(
      r.combined.length,
      'the control command produced no output at all — the harness itself is broken.',
    ).toBeGreaterThan(0);
    expect(
      ANY_URL.test(r.combined),
      `the harness could not find a URL even from a command whose --web path is ` +
        `known to serve one. Every absence this file reports is therefore ` +
        `meaningless until this passes.\nstdout:\n${r.out}\nstderr:\n${r.err}`,
    ).toBe(true);
  }, 40_000);
});
