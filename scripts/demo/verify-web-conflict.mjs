/**
 * Full end-to-end verification of the `capy --web` sync conflict resolver,
 * driven headlessly: it seeds the offline fixture, launches the REAL `capy --web`
 * binary, plays the role of the browser (POSTs the user's per-variable choices to
 * the loopback), then re-runs bare `capy` to prove the conflict committed.
 *
 *   node scripts/demo/verify-web-conflict.mjs
 *
 * Exit 0 = the browser resolution round-tripped through the real CLI and the
 * conflict is gone. Exit 1 = something broke.
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const REPO = new URL('../..', import.meta.url).pathname;
const HOME = '/tmp/capy-demo-home';
const CAPY = join(REPO, 'bin', 'capy');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { ...opts, env: { ...process.env, HOME, ...(opts.env || {}) } });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => {
      out += d.toString();
      opts.onStdout?.(d.toString(), () => cp);
    });
    cp.stderr.on('data', (d) => (err += d.toString()));
    cp.on('close', (code) => resolve({ code, out, err }));
  });
}

const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?n=([a-f0-9]+)/;

async function main() {
  // 1. Seed the offline fixture (clean every run).
  const seed = await run('bun', ['scripts/demo/seed.ts'], { cwd: REPO });
  if (seed.code !== 0) throw new Error(`seed failed:\n${seed.err}`);
  const projectDir = seed.out.trim().split('\n').pop();
  console.log(`• seeded fixture: ${projectDir}`);

  // 2. Launch `capy --web`; play the browser when it prints the loopback URL.
  let posted = false;
  const web = await run('node', [CAPY, '--web'], {
    cwd: projectDir,
    env: { CAPY_WEB_NO_OPEN: '1' }, // headless: drive the loopback, don't open a browser
    onStdout: async (chunk, getCp) => {
      const m = chunk.match(URL_RE);
      if (!m || posted) return;
      posted = true;
      const base = `http://127.0.0.1:${m[1]}`;
      const nonce = m[2];
      console.log(`• capy --web opened loopback on ${base} — playing the browser`);
      // Keep PINNED baseline for API_KEY, keep LOCAL edit for DATABASE_URL.
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          nonce,
          payload: { __action: 'apply', API_KEY: 'pinned', DATABASE_URL: 'local' },
        }),
      });
      const body = await res.json();
      console.log(`• POST /submit → ${res.status} ${JSON.stringify(body)}`);
    },
  });
  if (web.code !== 0) throw new Error(`capy --web exited ${web.code}:\n${web.err}\n${web.out}`);
  if (!posted) throw new Error(`capy --web never printed a loopback URL:\n${web.out}`);

  // 3. Re-run bare `capy`: the conflict must be gone now.
  const after = await run('node', [CAPY], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const clean = /Everything is up to date/.test(after.out);
  console.log(`• re-run bare capy → ${clean ? 'CLEAN (no conflict)' : 'STILL DIRTY'}`);
  if (!clean) throw new Error(`expected a clean sync after web-resolve, got:\n${after.out}`);

  // 4. Value-level check: "up to date" alone can't tell a correct resolution from
  //    a silent deletion (keep.lock + .env stay consistent either way). Assert the
  //    committed hashes match the CHOICES: API_KEY=pinned baseline, DATABASE_URL=local edit.
  const keep = JSON.parse(readFileSync(join(projectDir, 'keep.lock'), 'utf8'));
  const hashOf = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16);
  const committed = (name) => keep.variables[name]?.find((e) => e.branch === 'development')?.value_hash;
  const checks = [
    ['API_KEY', hashOf('sk_baseline_0001'), 'pinned baseline restored'],
    ['DATABASE_URL', hashOf('postgres://localhost:5432/app_staging'), 'local edit kept'],
    ['STRIPE_KEY', hashOf('pk_test_unchanged'), 'unchanged carried over'],
  ];
  for (const [name, want, label] of checks) {
    const got = committed(name);
    if (got !== want) throw new Error(`${name}: expected ${label} (${want}), got ${got}`);
    console.log(`• ${name}: ${label} ✓`);
  }
  console.log('\n✓ E2E PASS — browser resolution committed the CORRECT values through the real CLI.');
}

main().catch((e) => {
  console.error('\n✗ E2E FAIL:', e.message);
  process.exit(1);
});
