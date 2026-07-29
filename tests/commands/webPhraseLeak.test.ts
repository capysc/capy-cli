/**
 * The invariant the browser onboarding path exists to hold: the 24-word
 * recovery phrase is generated in this process, rendered into the loopback
 * page for a human to write down, and NEVER printed to stdout or stderr.
 *
 * That is the whole reason `capy byoc --web` exists. When an agent shells this
 * command through the MCP, the model sees the child's output and nothing else
 * — so a phrase that reaches stdout is a phrase the model has, and a phrase
 * the model has is a compromised master key.
 *
 * This was already verified by scripts/demo/verify-web-onboarding.mjs, which
 * nothing ran: no reference in run-tests.sh, so it only executed when someone
 * remembered to type it. The check needs no browser — the phrase is read out
 * of the served HTML with fetch — so there is no reason it cannot run on every
 * commit, which is what this file does.
 *
 * NEVER remove `CAPY_WEB_NO_OPEN`. Without it the command opens the
 * developer's real browser.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const ENTRY = join(CLI_ROOT, 'src/index.ts');
const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?n=([a-f0-9]+)/;
const headers = { 'content-type': 'application/json' };

/** The 24 words as the page renders them — one mono span each. */
function extractPhrase(html: string): string[] {
  return [...html.matchAll(/font-family:ui-monospace[^>]*>([a-z]+)</g)].map((m) => m[1]);
}

describe('capy byoc --web keeps the recovery phrase off the wire', () => {
  let home = '';
  let child: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    child?.kill('SIGKILL');
    child = null;
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  test('the phrase is on the page and in neither stdout nor stderr', async () => {
    home = mkdtempSync(join(tmpdir(), 'capy-phrase-'));

    let out = '';
    let err = '';
    child = spawn('bun', [ENTRY, 'byoc', '--web'], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        // Headless: drive the loopback ourselves. Without this the command
        // opens the developer's real browser, which is never acceptable.
        CAPY_WEB_NO_OPEN: '1',
        CAPY_NO_AUTOCOMMIT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));

    // Wait for the loopback URL to be announced.
    let match: RegExpMatchArray | null = null;
    for (let i = 0; i < 300 && !match; i++) {
      match = (out + err).match(URL_RE);
      if (!match) await new Promise((r) => setTimeout(r, 50));
    }
    expect(match, `no loopback URL announced.\nstdout:\n${out}\nstderr:\n${err}`).not.toBeNull();

    const base = `http://127.0.0.1:${match![1]}`;
    const nonce = match![2];

    // Ask for a freshly generated phrase, and read it off the page the way the
    // person writing it down would.
    const generated = (await (
      await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { ...headers, origin: base },
        body: JSON.stringify({ nonce, payload: { mode: 'generate' } }),
      })
    ).json()) as { screen?: string };

    const words = extractPhrase(generated.screen ?? '');
    expect(words).toHaveLength(24);

    // THE ASSERTION: no run of the phrase reaches either stream.
    const terminal = out + err;
    expect(terminal).not.toContain(words.join(' '));

    /*
     * Partial leaks too — but by SEQUENCE, not by word.
     *
     * Checking each word on its own does not work, and the first version of
     * this test failed proving it: BIP39 words are ordinary English, and
     * "never" is both a valid phrase word and part of the CLI's own line
     * "values never touch this terminal or the AI". Flagging that is a false
     * positive, and a check that cries wolf gets deleted.
     *
     * What is unambiguous is ORDER. Four consecutive words of the phrase, in
     * the order the page rendered them, do not occur by chance in prose — so
     * any such run is the phrase itself, whole or truncated, however it was
     * formatted on the way out.
     */
    const RUN = 4;
    for (let i = 0; i + RUN <= words.length; i++) {
      const run = words.slice(i, i + RUN);
      // Whitespace-insensitive: a phrase printed one word per line, or in a
      // padded grid, is still a leaked phrase.
      const pattern = new RegExp(run.join('\\s+'), 'i');
      expect(
        pattern.test(terminal),
        `words ${i + 1}–${i + RUN} of the phrase ("${run.join(' ')}") appeared in the CLI's output`,
      ).toBe(false);
    }

    // And the page really did carry it — otherwise this test would pass just
    // as well against a screen that renders nothing at all.
    expect(generated.screen).toContain(words[0]);
  }, 60_000);
});
