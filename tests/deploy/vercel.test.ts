import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vercelAdapter } from '../../src/deploy/adapters/vercel';
import { TargetConfig } from '../../src/deploy/adapter';

// Vercel: code deploy is the keep.lock PR (CI), but env vars are pushed via the
// `vercel env` CLI. So preflight requires a linked project + an explicit
// vercelEnv, and deploy scopes vars to that environment.

const ROOT = join(tmpdir(), `capy-vercel-adapter-${process.pid}`);

/** Write a .vercel/project.json so the dir looks linked to a Vercel project. */
function link(dir: string): void {
  mkdirSync(join(dir, '.vercel'), { recursive: true });
  writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_x', orgId: 'org_x' }));
}

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
  options: { projectDir: 'web', vercelEnv: 'production' },
  mode: 'ci',
  ...overrides,
});

describe('vercel — adapter shape', () => {
  test('ships code via CI, pushes SECRETS_BLOB+PROJECT_KEY via the vercel CLI', () => {
    expect(vercelAdapter.ciOnly).toBe(true);
    expect(vercelAdapter.defaultMode).toBe('ci');
    expect(vercelAdapter.needsDeployToken).toBe(true);
    expect(vercelAdapter.requires.binaries).toEqual(['vercel']);
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
    link(dir);
    const r = await vercelAdapter.preflight(baseTarget({ vars: [] }), {
      cwd: ROOT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no vars');
  });

  test('refuses when vercelEnv is missing', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    link(dir);
    const r = await vercelAdapter.preflight(
      baseTarget({ options: { projectDir: 'web' } }),
      { cwd: ROOT },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/vercelEnv/);
  });

  test('refuses when the project is not linked to Vercel', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    // no link() — missing .vercel/project.json
    const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not linked/i);
  });

  test('passes when linked, with vercelEnv and vars', async () => {
    const dir = join(ROOT, 'web');
    writePkg(dir, { next: '^16.0.0' });
    link(dir);
    const r = await vercelAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });
});

describe('vercel — deploy', () => {
  test('dry-run reports SECRETS_BLOB + PROJECT_KEY it would set, no side effects', async () => {
    const result = await vercelAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].status).toBe('skip');
    expect(result.steps[0].detail).toMatch(/SECRETS_BLOB \+ PROJECT_KEY on production/);
  });

  test('fails (without touching the CLI) when no deploy token was minted', async () => {
    // No ctx.deployToken — the adapter reports the failure before shelling out
    // to `vercel`, so this is deterministic.
    const result = await vercelAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: false,
      secretsOnly: true,
      cwd: ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe('fail');
    expect(result.steps[0].detail).toMatch(/no deploy token/i);
  });

  test('preview scopes the step detail to the target git branch', async () => {
    const result = await vercelAdapter.deploy(
      baseTarget({ branch: 'development', options: { projectDir: 'web', vercelEnv: 'preview' } }),
      { env: {}, dryRun: true, cwd: ROOT },
    );
    expect(result.steps[0].detail).toMatch(/preview · branch=development/);
  });
});
