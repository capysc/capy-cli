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
import { withHarness, ORG_ID, PROJECT_ID, type Harness } from '../helpers/pipedHarness';
import { hashValue } from '../../src/sync/compareSecrets';

// Tests that run a full deploy through preflight need wrangler on PATH —
// adapter preflight terminates with "wrangler not found" otherwise. Gate
// those specific tests; the config/help/list tests don't depend on it.
const HAS_WRANGLER = spawnSync('which', ['wrangler']).status === 0;

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

/**
 * A project in `h` that bare `capy` (the first step of every `capy deploy`) finds in sync: `keep.lock` pins the hash of
 * every value in `values` for `branch`, and `.env` holds them. What `deploy` does with it is what these tests are about.
 */
function syncedProject(h: Harness, values: Record<string, string> = {}, branch: string = 'production'): void {
  const variables = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, [{ resource_id: `rid-${name}`, branch, value_hash: hashValue(value) }]]),
  );
  writeFileSync(join(h.project, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'test', variables }, null, 2));
  writeFileSync(join(h.project, '.env'), Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
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

  test('unknown adapter id → lists known ones', async () => {
    await withHarness(async (h) => {
      syncedProject(h);
      const r = await h.run(['deploy', '--target=does-not-exist', '--yes']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Unknown adapter');
      expect(r.stderr).toContain('cf-worker');
    });
  });

  test('named target that does not exist → exit 1', async () => {
    await withHarness(async (h) => {
      syncedProject(h);
      const r = await h.run(['deploy', 'missing-target', '--yes']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('No target named');
    });
  });
});

// ── list / remove ───────────────────────────────────────────────────────────

describe('capy deploy list / remove', () => {
  test('list when no targets configured', () => {
    const r = capy(['deploy', 'targets']);
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
    const r = capy(['deploy', 'targets']);
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
    const r = capy(['deploy', 'targets-remove', 'worker-prod']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Removed');
    const r2 = capy(['deploy', 'targets']);
    expect(r2.stdout).toContain('No targets configured');
  });

  test('remove unknown target exits non-zero', () => {
    const r = capy(['deploy', 'targets-remove', 'nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No target');
  });
});

// ── --dry-run, plaintext .env (no decrypt path) ────────────────────────────

describe('capy deploy --dry-run', () => {
  test.if(HAS_WRANGLER)('plaintext .env + dry-run: preflight + plan, no side effects', async () => {
    await withHarness(async (h) => {
      syncedProject(h, { SUPABASE_URL: 'https://x.supabase.co', STRIPE_SECRET_KEY: 'sk_test' });
      writeWranglerToml(join(h.project, 'worker'), 'my-worker');
      writeDeployConfig(h.project, [
        {
          name: 'worker-prod',
          kind: 'cf-worker',
          branch: 'production',
          vars: ['SUPABASE_URL', 'STRIPE_SECRET_KEY'],
          options: { workerName: 'my-worker', workerDir: 'worker' },
        },
      ]);

      const r = await h.run(['deploy', 'worker-prod', '--dry-run', '--yes']);
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
  });

  test.if(HAS_WRANGLER)('dry-run accepts mixed vars (the picker is the gate, not preflight)', async () => {
    // Once a target is saved, capy trusts the user's earlier picker choice.
    // No silent var filtering, no preflight refusal — the picker pre-selects
    // what's likely relevant and surfaces what's not, but lets the user
    // toggle anything in or out.
    await withHarness(async (h) => {
      syncedProject(h, { SUPABASE_URL: 'x', VITE_API_URL: 'y' });
      writeWranglerToml(join(h.project, 'worker'), 'my-worker');
      writeDeployConfig(h.project, [
        {
          name: 'mixed',
          kind: 'cf-worker',
          branch: 'production',
          vars: ['SUPABASE_URL', 'VITE_API_URL'],
          options: { workerName: 'my-worker', workerDir: 'worker' },
        },
      ]);
      const r = await h.run(['deploy', 'mixed', '--dry-run', '--yes']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('VITE_API_URL');
    });
  });
});

// ── Rename: `capy deploy token …` is the legacy token flow ──────────────────

describe('capy deploy — coexistence: token+docs flow + connector flow', () => {
  test('`capy deploy --help` advertises both modes', () => {
    const r = capy(['deploy', '--help']);
    const out = r.stdout + r.stderr;
    expect(out).toContain('--target');
    expect(out).toContain('--connect');
    expect(out).toContain('--dry-run');
    expect(out).toContain('--yes');
  });

  test('legacy `capy deploy revoke` and `list` (deploy tokens) still wired', () => {
    const r1 = capy(['deploy', 'revoke', '--help']);
    expect((r1.stdout + r1.stderr)).toContain('Revoke a deploy token');

    const r2 = capy(['deploy', 'list', '--help']);
    expect((r2.stdout + r2.stderr)).toContain('List deploy tokens');
  });

  test('target subcommands are addressable as `targets` / `targets-remove`', () => {
    // CAP-679 follow-up: this help text says "target" now, not "connector"
    // — that word moved to being the INBOUND half of "integrations" only.
    const r1 = capy(['deploy', 'targets', '--help']);
    expect((r1.stdout + r1.stderr)).toContain('target');

    const r2 = capy(['deploy', 'targets-remove', '--help']);
    expect((r2.stdout + r2.stderr)).toContain('Remove');
  });
});
