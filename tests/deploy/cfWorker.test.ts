import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cfWorkerAdapter } from '../../src/deploy/adapters/cfWorker';
import { TargetConfig } from '../../src/deploy/adapter';

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
  test('passes when wrangler is on PATH and config is valid', async () => {
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

  test('REFUSES build-time vars (defense-in-depth against bundle leaks)', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(
      baseTarget({ vars: ['SUPABASE_URL', 'VITE_SUPABASE_URL'] }),
      { cwd: ROOT },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('build-time vars');
    expect(r.reason).toContain('VITE_SUPABASE_URL');
  });

  test('refuses NEXT_PUBLIC_* and PUBLIC_* too', async () => {
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    const r = await cfWorkerAdapter.preflight(
      baseTarget({ vars: ['NEXT_PUBLIC_KEY', 'PUBLIC_FOO', 'X'] }),
      { cwd: ROOT },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('NEXT_PUBLIC_KEY');
    expect(r.reason).toContain('PUBLIC_FOO');
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
