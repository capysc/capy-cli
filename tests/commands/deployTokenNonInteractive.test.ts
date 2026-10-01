/**
 * CAP-659 Phase 2 / CAP-520 — `capy deploy` (no target/--connect/positional:
 * the token+docs picker, `DeployCommand` in `deployTokenCommand.ts`).
 *
 * Driven through the real argument parser against the built CLI, same
 * hermetic style as `dryRunGuard.e2e.test.ts` (whose harness this copies):
 * a throwaway HOME with an unreachable service URL, so any call that
 * somehow reached auth/network is refused locally in milliseconds rather
 * than touching api.capy.sc. Every test below exits before any of that is
 * attempted — the platform/mode gate refuses (or `--mode` is rejected)
 * before `ensureUserId()` is ever called — so the unreachable port is
 * belt-and-suspenders here, not load-bearing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-deploy-token-noninteractive-${process.pid}-${Date.now()}`);
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:9'; // discard port — refused at once

function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'capy-deploy-token-noninteractive-home-'));
  mkdirSync(join(home, '.capy', 'auth'), { recursive: true });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: UNREACHABLE_SERVICE_URL } } }),
  );
  return home;
}

const FAKE_HOME = makeFakeHome();
const CLI_ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CAPY_WEB_NO_OPEN: '1',
  CAPY_NO_AUTOCOMMIT: '1',
};

function capy(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], { cwd: ROOT, env: CLI_ENV, encoding: 'utf-8', timeout: 30_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(): void {
  writeFileSync(
    join(ROOT, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables: {} }),
  );
  writeFileSync(join(ROOT, '.env'), '# capy:branch=development\n');
}

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeKeep();
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

describe('capy deploy (token picker) — platform/mode gate, no TTY (CAP-659/CAP-520)', () => {
  test('no --platform, no TTY: refuses with DEPLOY_PICKER_NEEDS_TTY, exit 3 — never reaches auth', () => {
    const r = capy(['deploy']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('DEPLOY_PICKER_NEEDS_TTY');
    expect(r.stderr).not.toContain('Authentication failed');
  });

  test('--platform heroku (no connector, no mode question): does NOT refuse on the picker gate', () => {
    const r = capy(['deploy', '--platform', 'heroku']);
    expect(r.stderr).not.toContain('DEPLOY_PICKER_NEEDS_TTY');
    // Heroku has no connector adapter — the only remaining real-run step is
    // minting, which needs auth; refused by the (separate, out-of-scope-
    // here) auth chain against the unreachable service instead.
  });

  test('--platform vercel (has a connector), no --mode, no TTY: refuses with DEPLOY_PICKER_NEEDS_TTY', () => {
    const r = capy(['deploy', '--platform', 'vercel']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('DEPLOY_PICKER_NEEDS_TTY');
  });

  test('--platform vercel --mode target: does NOT refuse on the picker gate (reaches deployCommand(), a separate already-safe path)', () => {
    const r = capy(['deploy', '--platform', 'vercel', '--mode', 'target', '--yes']);
    expect(r.stderr).not.toContain('DEPLOY_PICKER_NEEDS_TTY');
  });

  test('an unknown --mode is rejected with a code, never silently falls through to the token flow', () => {
    const r = capy(['deploy', '--platform', 'heroku', '--mode', 'banana']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DEPLOY_MODE_INVALID');
    expect(r.stderr).not.toContain('Authentication failed');
  });

  test('an unknown --mode under --json is a coded JSON refusal, not prose', () => {
    const r = capy(['deploy', '--platform', 'heroku', '--mode', 'banana', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: false,
      code: 'DEPLOY_MODE_INVALID',
      error: '--mode must be "target" or "token" (got "banana").',
    });
  });

  test('no keep.lock at all, --json: a coded JSON refusal, not prose', () => {
    rmSync(join(ROOT, 'keep.lock'));
    const r = capy(['deploy', '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NO_KEEP_FILE');
  });
});
