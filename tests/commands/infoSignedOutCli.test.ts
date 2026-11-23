/**
 * `capy info --json` on a machine that is not signed in answers in JSON with a `code`, so an agent can branch on it.
 * Runs the BUILT dev entry point (needs `bun run build` first) against an empty home and an unreachable API.
 */
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

test('signed out: capy info --json prints {ok:false, code:AUTH_FAILED} on stdout and exits 1', () => {
  const home = mkdtempSync(join(tmpdir(), 'capy-info-signed-out-'));
  const cwd = mkdtempSync(join(tmpdir(), 'capy-info-cwd-'));
  try {
    const r = spawnSync('node', [DEV_CLI, 'info', '--json'], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, CAPY_GLOBAL_DIR_NAME: '.capy-test', CAPY_API_URL: 'http://127.0.0.1:9' },
    });
    expect(r.status).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body).toEqual({ ok: false, code: 'AUTH_FAILED', error: 'Not signed in.' });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
