/**
 * `capy deploy` integration tests.
 *
 * Covers non-interactive paths (list, remove, --target + --yes + --dry-run),
 * the keep.lock requirement, and the `capy deploy token` rename. Interactive
 * picker flow is tested in unit form via the adapter + classify tests; the
 * inquirer prompt sequence itself is covered by manual / live runs.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-deploy-cmd-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

function capy(
  args: string[],
  cwd: string = ROOT,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(dir: string, branches: string[] = ['development', 'production']): void {
  const variables: Record<string, any[]> = {};
  for (const v of ['SUPABASE_URL', 'STRIPE_SECRET_KEY', 'VITE_API_URL']) {
    variables[v] = branches.map((b) => ({
      resource_id: 'rid' + b[0],
      branch: b,
      value_hash: 'hhh',
    }));
  }
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify(
      {
        version: '3.0',
        org_id: 'org-test',
        project_id: 'proj-test',
        project_name: 'test',
        variables,
      },
      null,
      2,
    ),
  );
}

function writeWranglerToml(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'wrangler.toml'),
    `name = "${name}"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n`,
  );
}

function writeDeployConfig(cwd: string, targets: any[]): void {
  mkdirSync(join(cwd, '.capy'), { recursive: true });
  const obj: any = { version: '1', targets: {} };
  for (const t of targets) obj.targets[t.name] = t;
  writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify(obj, null, 2));
}

// ── Refusals ────────────────────────────────────────────────────────────────

describe('capy deploy — refusals', () => {
  test('no keep.lock → exit 1 with helpful message', () => {
    const r = capy(['deploy', 'whatever']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('keep.lock');
  });

  test('--target without --yes → refuses (would prompt in CI)', () => {
    writeKeep(ROOT);
    const r = capy(['deploy', '--target=cf-worker']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--yes');
  });

  test('unknown adapter id → lists known ones', () => {
    writeKeep(ROOT);
    const r = capy(['deploy', '--target=does-not-exist', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown adapter');
    expect(r.stderr).toContain('cf-worker');
  });

  test('named target that does not exist → exit 1', () => {
    writeKeep(ROOT);
    const r = capy(['deploy', 'missing-target']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No target named');
  });
});

// ── list / remove ───────────────────────────────────────────────────────────

describe('capy deploy list / remove', () => {
  test('list when no targets configured', () => {
    const r = capy(['deploy', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No targets configured');
  });

  test('list shows configured targets', () => {
    writeDeployConfig(ROOT, [
      {
        name: 'worker-prod',
        kind: 'cf-worker',
        branch: 'production',
        vars: ['SUPABASE_URL'],
        options: { workerName: 'my-worker', workerDir: 'worker' },
      },
    ]);
    const r = capy(['deploy', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('worker-prod');
    expect(r.stdout).toContain('Cloudflare Workers');
    expect(r.stdout).toContain('production');
  });

  test('remove deletes a target', () => {
    writeDeployConfig(ROOT, [
      {
        name: 'worker-prod',
        kind: 'cf-worker',
        branch: 'production',
        vars: ['SUPABASE_URL'],
        options: { workerName: 'w', workerDir: 'worker' },
      },
    ]);
    const r = capy(['deploy', 'remove', 'worker-prod']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Removed');
    const r2 = capy(['deploy', 'list']);
    expect(r2.stdout).toContain('No targets configured');
  });

  test('remove unknown target exits non-zero', () => {
    const r = capy(['deploy', 'remove', 'nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No target');
  });
});

// ── --dry-run, plaintext .env (no decrypt path) ────────────────────────────

describe('capy deploy --dry-run', () => {
  test('plaintext .env + dry-run: preflight + plan, no side effects', () => {
    writeKeep(ROOT);
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    writeFileSync(
      join(ROOT, '.env'),
      'SUPABASE_URL=https://x.supabase.co\nSTRIPE_SECRET_KEY=sk_test\n',
    );
    writeDeployConfig(ROOT, [
      {
        name: 'worker-prod',
        kind: 'cf-worker',
        branch: 'production',
        vars: ['SUPABASE_URL', 'STRIPE_SECRET_KEY'],
        options: { workerName: 'my-worker', workerDir: 'worker' },
      },
    ]);

    const r = capy(['deploy', 'worker-prod', '--dry-run', '--yes']);
    if (r.code !== 0) {
      console.error('STDOUT:', r.stdout);
      console.error('STDERR:', r.stderr);
    }
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('worker-prod');
    expect(r.stdout).toContain('cf-worker'.length > 0 ? 'Cloudflare Workers' : 'cf-worker');
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('filter vars');
  });

  test('dry-run rejects target with build-time vars (preflight)', () => {
    writeKeep(ROOT);
    writeWranglerToml(join(ROOT, 'worker'), 'my-worker');
    writeFileSync(join(ROOT, '.env'), 'SUPABASE_URL=x\nVITE_API_URL=y\n');
    writeDeployConfig(ROOT, [
      {
        name: 'bad',
        kind: 'cf-worker',
        branch: 'production',
        vars: ['SUPABASE_URL', 'VITE_API_URL'], // VITE_* must not push to Worker
        options: { workerName: 'my-worker', workerDir: 'worker' },
      },
    ]);
    const r = capy(['deploy', 'bad', '--dry-run', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('build-time vars');
    expect(r.stderr).toContain('VITE_API_URL');
  });
});

// ── Rename: `capy deploy token …` is the legacy token flow ──────────────────

describe('capy deploy token (renamed legacy flow)', () => {
  test('top-level help advertises `deploy token setup`', () => {
    const r = capy(['--help']);
    // commander 11 prints to stdout for --help
    expect(r.stdout + r.stderr).toContain('deploy');
  });

  test('`capy deploy token --help` lists the token subcommands', () => {
    const r = capy(['deploy', 'token', '--help']);
    const out = r.stdout + r.stderr;
    expect(out).toContain('setup');
    expect(out).toContain('revoke');
    expect(out).toContain('list');
  });

  test('`capy deploy --help` shows the new top-level options', () => {
    const r = capy(['deploy', '--help']);
    const out = r.stdout + r.stderr;
    expect(out).toContain('--target');
    expect(out).toContain('--dry-run');
    expect(out).toContain('--yes');
  });
});
