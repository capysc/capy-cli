/**
 * End-to-end verification of `capy byoc --web` (local-only onboarding in the
 * browser), driven headlessly. It plays the browser through the trainstops
 * (generate phrase → confirm → set passphrase), then asserts:
 *
 *   1. setup completed offline (local profile + wrapped key written),
 *   2. a fresh project bootstraps afterward (keep.lock written),
 *   3. SECURITY: the 24-word recovery phrase — captured from the loopback page —
 *      NEVER appears in the CLI's stdout/stderr. This is the invariant that keeps
 *      the phrase out of an MCP/model's view when an agent shells this command.
 *
 *   node scripts/demo/verify-web-onboarding.mjs
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs';

const REPO = new URL('../..', import.meta.url).pathname;
const HOME = '/tmp/capy-onboard-home';
const CAPY = join(REPO, 'bin', 'capy');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { ...opts, env: { ...process.env, HOME, ...(opts.env || {}) } });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => {
      out += d.toString();
      opts.onStdout?.(d.toString());
    });
    cp.stderr.on('data', (d) => (err += d.toString()));
    cp.on('close', (code) => resolve({ code, out, err }));
  });
}

const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?n=([a-f0-9]+)/;
const headers = { 'content-type': 'application/json' };
const post = (base, nonce, payload) =>
  fetch(`${base}/submit`, { method: 'POST', headers: { ...headers, origin: base }, body: JSON.stringify({ nonce, payload }) });

// Every step of this flow is a compiled screen, which is a whole document: the
// answer comes back as `{ next: true }` and the browser RELOADS to receive the
// next step. So the page is fetched rather than read out of the submit's reply.
const page = (base, nonce) => fetch(`${base}/?n=${nonce}`).then((r) => r.text());

/**
 * Pull the 24 words out of the phrase step's payload.
 *
 * The screen renders from `window.__CAPY_DATA__`, inlined into the document at
 * serve time, so `phraseWords` is exactly what the person in front of the page
 * is being shown — and reading it here is the only way this script can hold the
 * leak check, which compares those words against the CLI's own output.
 */
function extractPhrase(html) {
  const m = html.match(/"phraseWords":\s*(\[[^\]]*\])/);
  if (!m) return '';
  return JSON.parse(m[1]).join(' ');
}

async function main() {
  // Fresh, empty fixture home (no profile yet).
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });

  let phrase = '';
  const byoc = await run('node', [CAPY, 'byoc', '--web'], {
    env: { CAPY_WEB_NO_OPEN: '1' },
    onStdout: async (chunk) => {
      const m = chunk.match(URL_RE);
      if (!m || phrase) return;
      const base = `http://127.0.0.1:${m[1]}`;
      const nonce = m[2];
      console.log(`• byoc --web loopback on ${base} — playing the browser`);
      // Step 0: where the phrase comes from. Two rows, one of them this.
      const s1 = await (await post(base, nonce, { source: 'generate' })).json();
      if (s1.error) throw new Error(`phrase-source step refused: ${s1.error}`);
      if (!s1.next) throw new Error(`expected the phrase step to be next, got ${JSON.stringify(s1)}`);
      phrase = extractPhrase(await page(base, nonce));
      if (phrase.split(' ').length !== 24) throw new Error(`expected 24 words in page, got ${phrase.split(' ').length}`);
      console.log(`• captured the 24-word phrase from the page (kept only for the leak check)`);
      // Step 1: consent, and consent only. The words travel one way, so this
      // step answers with a boolean — a payload carrying them is refused.
      const guard = await (await post(base, nonce, { confirmed: true, phrase })).json();
      if (!guard.error) throw new Error('the phrase step accepted the words back — it must not');
      console.log(`• the page refused to send the phrase back ✓ (${guard.error})`);
      const s2 = await (await post(base, nonce, { confirmed: true })).json();
      if (!s2.next) throw new Error(`expected the passphrase step to be next, got ${JSON.stringify(s2)}`);
      // Step 2: set passphrase.
      const s3 = await (await post(base, nonce, { passphrase: 'demo-passphrase', confirm: 'demo-passphrase' })).json();
      console.log(`• POST passphrase → ${JSON.stringify(s3)}`);
      if (!s3.done) throw new Error(`setup did not finish: ${JSON.stringify(s3)}`);
    },
  });
  if (byoc.code !== 0) throw new Error(`byoc --web exited ${byoc.code}:\n${byoc.err}\n${byoc.out}`);

  // 1. Setup completed: local profile + wrapped key on disk.
  const cfg = JSON.parse(readFileSync(join(HOME, '.capy', 'config.json'), 'utf8'));
  if (cfg.profiles?.local?.localOnly !== true) throw new Error('local profile not active/localOnly');
  if (!existsSync(join(HOME, '.capy', 'local', 'key.local'))) throw new Error('wrapped local key not written');
  console.log('• local profile active + wrapped key written ✓');

  // 2. SECURITY: the phrase must NOT be anywhere in the CLI's terminal output.
  const terminal = byoc.out + byoc.err;
  if (!phrase || phrase.split(' ').length !== 24) throw new Error('failed to capture phrase for the leak check');
  if (terminal.includes(phrase)) throw new Error('LEAK: recovery phrase appeared in CLI stdout/stderr');
  // Also defend against partial leaks: no 4-consecutive-word window should appear.
  const words = phrase.split(' ');
  for (let i = 0; i + 4 <= words.length; i++) {
    const window = words.slice(i, i + 4).join(' ');
    if (terminal.includes(window)) throw new Error(`LEAK: phrase fragment "${window}" in CLI output`);
  }
  console.log('• recovery phrase never appeared in the terminal ✓ (stays in the browser only)');

  // 3. A fresh project bootstraps afterward (session is unlocked → no re-prompt).
  const projectDir = join(HOME, 'fresh-project');
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  // CAPY_WEB_NO_OPEN on this one too: a demo script must never be able to take
  // over the browser of whoever is running it.
  const boot = await run('node', [CAPY], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { CAPY_WEB_NO_OPEN: '1' },
  });
  if (!existsSync(join(projectDir, 'keep.lock'))) {
    throw new Error(`fresh project did not bootstrap a keep.lock:\n${boot.out}\n${boot.err}`);
  }
  console.log('• fresh project bootstrapped a keep.lock after onboarding ✓');

  console.log('\n✓ E2E PASS — browser onboarding set up local mode offline, leaked nothing, and a project is ready.');
}

main().catch((e) => {
  console.error('\n✗ E2E FAIL:', e.message);
  process.exit(1);
});
