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

/**
 * WHAT THIS FILE ASSERTS, AND WHY IT IS NOT "prints a 127.0.0.1 URL".
 *
 * The invariant is that a URL REACHES THE CALLER. Loopback is merely today's
 * answer to it, and a poor one: `--web` exists because the caller has no
 * terminal — an agent, or a person on another device — and `127.0.0.1` is
 * precisely the address such a caller cannot open. A page served on the
 * machine that failed is not a page the person who needs it can see.
 *
 * So the assertions below are written against the invariant, and this helper
 * classifies the answer separately. When the renderer moves to Keep, the
 * invariant assertions keep passing unchanged and this classification is where
 * the tightening happens — one line, not a rewrite. A test pinned to loopback
 * would have to be rewritten by the same change that fixes the problem, which
 * is how suites end up being edited to match whatever the code now does.
 */
function isRemotelyReachable(url: string): boolean {
  return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);
}

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

  /**
   * Not an assertion — a RECORD, deliberately.
   *
   * Today every `--web` ending is a loopback page, so asserting remote
   * reachability here would paint the whole suite red for a decision that has
   * been made but not yet built. What this does instead is print what the
   * caller actually got, so the day the rail moves to Keep the change shows up
   * in the log rather than having to be remembered.
   */
  test('RECORD: what kind of URL does a --web refusal hand back today?', async () => {
    const r = await runWeb(['deploy']);
    const url = r.combined.match(ANY_URL)?.[0] ?? null;

    expect(url, `no URL at all — see the assertions above; this record is meaningless without one.`).not.toBeNull();
    console.log(
      `[record] deploy --web refusal URL is ${isRemotelyReachable(url!) ? 'REMOTELY REACHABLE' : 'LOOPBACK-ONLY'}: ${url}`,
    );
    // The invariant, restated: something was handed back. Reachability is
    // recorded above rather than asserted, until Keep is the renderer.
    expect(ANY_URL.test(r.combined)).toBe(true);
  }, 40_000);
});

/**
 * THE SYSTEMIC CLASS, one case per command.
 *
 * `console.error(...); process.exit(1)` in a guard clause never throws, so the
 * surrounding catch never runs, so `displayErrorAndExit` never serves its page.
 * `rotateCommand.ts` documents this exact class and its own fix; the fix was
 * never applied anywhere else.
 *
 * Every command below was RUN under `--web` in a clean HOME before this test
 * was written, and each was observed emitting its refusal with no URL at all.
 * The set is what running them found, not what a grep predicted: `branch` is
 * here because a run surfaced it, and `transport`/`edit`/`org` are absent
 * because their runs got past the guard into the auth path and did hand back a
 * URL — a source sweep would have listed all of them.
 *
 * Framed against the invariant (a URL reaches the caller), never against
 * loopback, so the move to Keep as the sole renderer does not rewrite them.
 */
const REFUSAL_CASES: ReadonlyArray<{ readonly argv: readonly string[]; readonly control: string }> = [
  // control = a fragment of the refusal itself, proving the command reached
  // its guard. Without it, "no URL" is satisfied by a command that never ran.
  //
  // ARGUMENTS MATTER HERE. `checkout --web` with no branch name never reaches
  // its guard at all: Commander rejects it first with `missing required
  // argument 'branch'`. The first draft of this file ran exactly that, saw
  // output with no URL, and would have reported a violation that does not
  // exist — the control is what caught it, failing on "did it reach its
  // refusal" rather than on "was there a URL".
  { argv: ['checkout', 'somebranch'], control: 'keep.lock' },
  { argv: ['decrypt'], control: 'keep.lock' },
  { argv: ['branch'], control: 'keep.lock' },
];

// DELIBERATELY ABSENT, and worth recording so nobody re-adds them:
//
//   kick      `kick --web` with no argument never reaches a guard at all —
//             Commander rejects it first with `missing required argument
//             'email'`. It was in the first draft of this list and the CONTROL
//             caught it: the case failed on "did it reach its refusal", not on
//             "was there a URL". Listing it as a URL violation would have been
//             a fabricated finding. Reaching kick's real guard needs a session
//             and a member lookup, which is a different test.
//
//   transport, edit, org
//             their runs get PAST the guard into the auth path and do hand
//             back a URL. A source sweep lists them; running them clears them.


describe('the systemic class: every --web refusal hands back a URL', () => {
  test.each(REFUSAL_CASES.map((c) => [c.argv.join(' '), c.argv, c.control] as const))(
    '%s --web refuses with a URL, not just a dead stream',
    async (cmd, argv, control) => {
      const r = await runWeb(argv);

      expect(
        r.combined.length,
        `\`${cmd} --web\` produced NO output at all, so it cannot be shown to have ` +
          `reached its guard. Inconclusive, not passing.`,
      ).toBeGreaterThan(0);
      expect(
        r.combined,
        `expected \`${cmd} --web\` to reach its refusal (the control for this case).\n` +
          `stdout:\n${r.out}\nstderr:\n${r.err}`,
      ).toContain(control);

      expect(
        ANY_URL.test(r.combined),
        `\`${cmd} --web\` refused with no URL anywhere. Under --web the caller has no ` +
          `terminal, so this refusal reached nobody. The guard exits via console.error ` +
          `+ process.exit(1), which never throws, so the catch never runs and ` +
          `displayErrorAndExit never serves its page.\nstdout:\n${r.out}\nstderr:\n${r.err}`,
      ).toBe(true);
    },
    45_000,
  );
});
