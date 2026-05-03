import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { vercelAdapter } from '../../src/deploy/adapters/vercel';
import { TargetConfig } from '../../src/deploy/adapter';

// Tests that exercise vendor-side checks (linkage, auth) need the vercel
// CLI on PATH — preflight terminates earlier with "vercel not found"
// otherwise. CI doesn't have it, so gate. Config/filesystem-only tests
// short-circuit before the binary check and don't need it.
const HAS_VERCEL = spawnSync('which', ['vercel']).status === 0;

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

function writeLink(dir: string, projectId: string, orgId: string): void {
  mkdirSync(join(dir, '.vercel'), { recursive: true });
  writeFileSync(
    join(dir, '.vercel/project.json'),
    JSON.stringify({ projectId, orgId, projectName: 'app' }),
  );
}

const baseTarget = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'vercel-test',
  kind: 'vercel',
  branch: 'production',
  vars: ['NEXT_PUBLIC_X', 'DATABASE_URL'],
  options: { projectDir: 'web', vercelEnv: 'preview' },
  ...overrides,
});

describe('vercel — detect', () => {
  test('finds linked project in web/', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    writeLink(dir, 'prj_abc123def456', 'team_xyz');
    const r = await vercelAdapter.detect(ROOT);
    expect((r.options as any).projectDir).toBe('web');
    expect(r.summary).toContain('Next.js');
    expect(r.summary).toContain('linked');
  });

  test('finds unlinked project (package.json only)', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { vite: '^5.0.0' });
    const r = await vercelAdapter.detect(ROOT);
    expect((r.options as any).projectDir).toBe('web');
    expect(r.summary).toContain('NOT linked');
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

  test('refuses when node_modules missing and deps declared', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    writeLink(dir, 'prj_x', 'team_y');
    const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('node_modules');
    expect(r.hint).toContain('bun install');
  });

  test.if(HAS_VERCEL)('refuses when project not linked and no env IDs', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const prevProj = process.env.VERCEL_PROJECT_ID;
    const prevOrg = process.env.VERCEL_ORG_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_ORG_ID;
    try {
      const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not linked');
      expect(r.hint).toContain('vercel link');
    } finally {
      if (prevProj) process.env.VERCEL_PROJECT_ID = prevProj;
      if (prevOrg) process.env.VERCEL_ORG_ID = prevOrg;
    }
  });

  test('refuses when zero vars', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    writeLink(dir, 'prj_x', 'team_y');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const prevTok = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = 'test-token-shortcircuits-whoami-check';
    try {
      const r = await vercelAdapter.preflight(baseTarget({ vars: [] }), {
        cwd: ROOT,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('no vars');
    } finally {
      if (prevTok) process.env.VERCEL_TOKEN = prevTok;
      else delete process.env.VERCEL_TOKEN;
    }
  });
});

describe('vercel — deploy (dry-run)', () => {
  test('dry-run skips build + deploy steps without side effects', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    writeLink(dir, 'prj_x', 'team_y');
    const result = await vercelAdapter.deploy(baseTarget(), {
      env: { NEXT_PUBLIC_X: 'a', DATABASE_URL: 'b' },
      dryRun: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.label)).toEqual([
      'inject build env',
      'vercel build',
      'vercel deploy',
    ]);
    expect(result.steps[1].status).toBe('skip');
    expect(result.steps[2].status).toBe('skip');
  });

  test('dry-run preview vs production tags the deploy step', async () => {
    const r1 = await vercelAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: true,
      cwd: ROOT,
    });
    expect(r1.steps[2].detail).toContain('preview');

    const r2 = await vercelAdapter.deploy(
      baseTarget({ options: { projectDir: 'web', vercelEnv: 'production' } }),
      { env: {}, dryRun: true, cwd: ROOT },
    );
    expect(r2.steps[2].detail).toContain('--prod');
  });

  test('dry-run preview with gitBranch surfaces --git-branch in plan', async () => {
    const r = await vercelAdapter.deploy(
      baseTarget({
        options: {
          projectDir: 'web',
          vercelEnv: 'preview',
          gitBranch: 'staging',
        },
      }),
      { env: {}, dryRun: true, cwd: ROOT },
    );
    expect(r.steps[2].detail).toContain('--git-branch=staging');
  });

  test('secretsOnly (CI mode) collapses to a single skipped step', async () => {
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
