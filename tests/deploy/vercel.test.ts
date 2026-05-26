import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vercelAdapter } from '../../src/deploy/adapters/vercel';
import { TargetConfig } from '../../src/deploy/adapter';

// Vercel is CI-only: capy never runs the vercel CLI. There are no vendor-side
// checks (binary, linkage, auth), so these tests need nothing on PATH.

const ROOT = join(tmpdir(), `capy-vercel-adapter-${process.pid}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

function writePkg(dir: string, deps: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'app',
      scripts: { build: 'next build' },
      dependencies: { ...deps },
    }),
  );
}

const baseTarget = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'vercel-test',
  kind: 'vercel',
  branch: 'production',
  vars: ['NEXT_PUBLIC_X', 'DATABASE_URL'],
  options: { projectDir: 'web' },
  mode: 'ci',
  ...overrides,
});

describe('vercel — adapter shape', () => {
  test('is CI-only and needs no local vendor toolchain', () => {
    expect(vercelAdapter.ciOnly).toBe(true);
    expect(vercelAdapter.defaultMode).toBe('ci');
    expect(vercelAdapter.requires.binaries).toEqual([]);
  });
});

describe('vercel — detect', () => {
  test('finds project in web/', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    const r = await vercelAdapter.detect(ROOT);
    expect((r.options as any).projectDir).toBe('web');
    expect(r.summary).toContain('Next.js');
    // CI-only: linkage is irrelevant, so it's not mentioned.
    expect(r.summary).not.toMatch(/linked/i);
  });

  test('finds project from package.json build script', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { vite: '^5.0.0' });
    const r = await vercelAdapter.detect(ROOT);
    expect((r.options as any).projectDir).toBe('web');
    expect(r.summary).toContain('Vite');
  });

  test('returns empty when nothing detected', async () => {
    const r = await vercelAdapter.detect(ROOT);
    expect(r.options).toBeUndefined();
  });
});

describe('vercel — preflight', () => {
  test('refuses when projectDir missing on disk', async () => {
    const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/project directory|not found/i);
  });

  test('refuses when zero vars', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    const r = await vercelAdapter.preflight(baseTarget({ vars: [] }), {
      cwd: ROOT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no vars');
  });

  test('passes with no vendor setup — no binary, linkage, or node_modules', async () => {
    // The whole point of CI-only: an unlinked project with no node_modules and
    // no vercel CLI on PATH must still preflight clean. The build runs in the
    // user's CI on merge.
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });
});

describe('vercel — deploy', () => {
  test('dry-run reports the PR it would open, no side effects', async () => {
    const result = await vercelAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].status).toBe('skip');
    expect(result.steps[0].detail).toMatch(/keep\.lock/);
  });

  test('CI deploy is a single skipped vendor step (PR is the deploy)', async () => {
    const result = await vercelAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: false,
      secretsOnly: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].status).toBe('skip');
    expect(result.steps[0].detail).toContain('CI mode');
  });
});
