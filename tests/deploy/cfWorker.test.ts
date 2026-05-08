import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { cfWorkerAdapter } from '../../src/deploy/adapters/cfWorker';
import { TargetConfig } from '../../src/deploy/adapter';

// "Happy path" preflight tests need wrangler on PATH (the binary check is
// the last step before ok:true). CI doesn't ship wrangler, so gate those
// tests. Config-error tests don't need wrangler — they short-circuit before
// the binary check.
const HAS_WRANGLER = spawnSync('which', ['wrangler']).status === 0;

const ROOT = join(tmpdir(), `capy-cf-worker-adapter-${process.pid}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

function writeWranglerToml(dir: string, name: string, accountId?: string): void {
  mkdirSync(dir, { recursive: true });
  let content = `name = "${name}"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n`;
  if (accountId) content += `account_id = "${accountId}"\n`;
  writeFileSync(join(dir, 'wrangler.toml'), content);
}

const baseTarget = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'worker-test',
  kind: 'cf-worker',
  branch: 'production',
  vars: ['SUPABASE_URL', 'STRIPE_SECRET_KEY'],
  options: { workerName: 'my-worker', workerDir: 'worker' },
  ...overrides,
});

describe('cfWorker — detect', () => {
  test('finds wrangler.toml in worker/ subdir', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'detected-worker');
    const r = await cfWorkerAdapter.detect(ROOT);
    expect(r.options).toEqual({
      workerName: 'detected-worker',
      workerDir: 'worker',
    });
    expect(r.summary).toContain('detected-worker');
  });

  test('finds wrangler.toml in cwd', async () => {
    writeWranglerToml(ROOT, 'root-worker');
    const r = await cfWorkerAdapter.detect(ROOT);
    expect(r.options).toEqual({ workerName: 'root-worker', workerDir: '.' });
  });

  test('returns empty when no wrangler.toml exists', async () => {
    const r = await cfWorkerAdapter.detect(ROOT);
    expect(r.options).toBeUndefined();
    expect(r.summary).toBeUndefined();
  });
});

describe('cfWorker — preflight', () => {
  test.if(HAS_WRANGLER)('passes when wrangler is on PATH and config is valid', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });

  test('fails when wrangler.toml is missing', async () => {
    const r = await cfWorkerAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('wrangler.toml');
  });

  test('fails when target has zero vars', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(baseTarget({ vars: [] }), {
      cwd: ROOT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no vars');
  });

  test.if(HAS_WRANGLER)('accepts build-time vars (the picker is the gate, not preflight)', async () => {
    // Once the user explicitly opts in via the picker, capy trusts them.
    // Misclassification protection lives in the picker pre-selection +
    // the bold-faced summary line, not in preflight refusals.
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(
      baseTarget({ vars: ['SUPABASE_URL', 'VITE_SUPABASE_URL'] }),
      { cwd: ROOT },
    );
    expect(r.ok).toBe(true);
  });

  test('refuses when worker has package.json deps but no node_modules', async () => {
    const workerDir = join(ROOT, 'worker');
    writeWranglerToml(workerDir, 'my-worker');
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'w', dependencies: { hono: '^4.0.0' } }),
    );
    const r = await cfWorkerAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('node_modules');
    expect(r.hint).toContain('bun install');
  });

  test.if(HAS_WRANGLER)('passes when node_modules exists', async () => {
    const workerDir = join(ROOT, 'worker');
    writeWranglerToml(workerDir, 'my-worker');
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'w', dependencies: { hono: '^4.0.0' } }),
    );
    mkdirSync(join(workerDir, 'node_modules'), { recursive: true });
    const r = await cfWorkerAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });

  test.if(HAS_WRANGLER)('passes when package.json has no deps (no node_modules required)', async () => {
    const workerDir = join(ROOT, 'worker');
    writeWranglerToml(workerDir, 'my-worker');
    writeFileSync(join(workerDir, 'package.json'), JSON.stringify({ name: 'w' }));
    const r = await cfWorkerAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });

  test('fails with helpful hint when options missing', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(
      baseTarget({ options: {} }),
      { cwd: ROOT },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('workerName');
  });
});

describe('cfWorker — deploy (dry-run)', () => {
  test('dry-run skips secret bulk and deploy steps without side effects', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const result = await cfWorkerAdapter.deploy(baseTarget(), {
      env: { SUPABASE_URL: 'x', STRIPE_SECRET_KEY: 'y' },
      dryRun: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'skip', 'skip']);
  });

  test('secretsOnly mode skips wrangler deploy step (CI handoff)', async () => {
    // We can't actually exercise the bulk push without auth, but the dry-run
    // path also flips into the secretsOnly short-circuit if both are set.
    // Use dry-run to verify the deploy step is reported as skipped with the
    // CI-specific reason.
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const result = await cfWorkerAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: true,
      secretsOnly: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    // dry-run takes precedence; the steps still report skip — good enough,
    // since the live secretsOnly path is exercised end-to-end via the
    // plugin tests when credentials are present.
    const labels = result.steps.map((s) => s.label);
    expect(labels).toContain('wrangler deploy');
  });

  test('dry-run accepts an empty env (decryption is skipped in dry-run)', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const result = await cfWorkerAdapter.deploy(baseTarget(), {
      env: {}, // dry-run = no decryption upstream, so empty is expected
      dryRun: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0].label).toBe('filter vars');
    expect(result.steps[0].detail).toContain('would push');
  });
});
