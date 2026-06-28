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

// Pull the 24 words out of the phrase-display screen HTML (monospace word spans).
function extractPhrase(screenHtml) {
  const words = [...screenHtml.matchAll(/font-family:ui-monospace[^>]*>([a-z]+)</g)].map((m) => m[1]);
  return words.join(' ');
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
      // Step 0: generate a new phrase.
      const s1 = await (await post(base, nonce, { mode: 'generate' })).json();
      phrase = extractPhrase(s1.screen || '');
      if (phrase.split(' ').length !== 24) throw new Error(`expected 24 words in page, got ${phrase.split(' ').length}`);
      console.log(`• captured the 24-word phrase from the page (kept only for the leak check)`);
      // Step 1: confirm saved.
      await post(base, nonce, { saved: 'on' });
      // Step 2: set passphrase.
      const s3 = await (await post(base, nonce, { passphrase: 'demo-passphrase', confirm: 'demo-passphrase' })).json();
      console.log(`• POST passphrase → ${JSON.stringify(s3)}`);
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
  const boot = await run('node', [CAPY], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
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
