/**
 * CAP-679: `capy deploy` refuses when the active `.env` branch disagrees
 * with the saved target's own branch — deploy reads `.env` but files the
 * result under `target.branch`. Also covers the `--no-deploy` flag's
 * presence on both `deploy` and `deploy targets-remove` help text.
 *
 * Uses the same spawned-CLI style as `deployCommand.test.ts`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-deploy-branch-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

function capy(args: string[], cwd: string = ROOT): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(dir: string, branches: string[] = ['development', 'production']): void {
  const variables: Record<string, any[]> = {};
  for (const v of ['DATABASE_URL']) {
    variables[v] = branches.map((b) => ({ resource_id: 'rid' + b[0], branch: b, value_hash: 'hhh' }));
  }
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables }, null, 2),
  );
}

function writeDeployConfig(cwd: string, targets: any[]): void {
  mkdirSync(join(cwd, '.capy'), { recursive: true });
  const obj: any = { version: '1', targets: {} };
  for (const t of targets) obj.targets[t.name] = t;
  writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify(obj, null, 2));
}

const dokployTarget = (branch: string) => ({
  name: 'dokploy-target',
  kind: 'dokploy',
  branch,
  vars: ['DATABASE_URL'],
  options: { baseUrl: 'https://dokploy.example.com', applicationId: 'app_1', tokenEnv: 'DOKPLOY_API_KEY' },
});

describe('capy deploy — branch check (CAP-679)', () => {
  test('active branch (.env header) differs from target.branch → refused with the coded reason', () => {
    writeKeep(ROOT);
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(join(ROOT, '.env'), '# capy:branch=development\nDATABASE_URL=x\n');

    const r = capy(['deploy', 'dokploy-target', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DEPLOY_BRANCH_MISMATCH');
    expect(r.stderr).toContain('development');
    expect(r.stderr).toContain('production');
  });

  test('active branch matches target.branch → passes the check (fails later, at Dokploy auth)', () => {
    writeKeep(ROOT);
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(join(ROOT, '.env'), '# capy:branch=production\nDATABASE_URL=x\n');

    const r = capy(['deploy', 'dokploy-target', '--yes']);
    expect(r.stderr).not.toContain('DEPLOY_BRANCH_MISMATCH');
    // Reaches preflight instead — no Dokploy token configured in this env.
    expect(r.stderr).toContain('preflight');
  });

  test('no active-branch signal (plaintext .env, several keep.lock branches) never refuses on this check', () => {
    writeKeep(ROOT); // two branches — deriveActiveBranch cannot pick one
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(ROOT + '/.env', 'DATABASE_URL=x\n'); // no header, no .capy/branch

    const r = capy(['deploy', 'dokploy-target', '--yes']);
    expect(r.stderr).not.toContain('DEPLOY_BRANCH_MISMATCH');
    expect(r.stderr).toContain('preflight');
  });
});

describe('capy deploy — --no-deploy flag (CAP-679)', () => {
  test('is advertised on `capy deploy --help`', () => {
    const r = capy(['deploy', '--help']);
    expect((r.stdout + r.stderr)).toContain('--no-deploy');
  });

  test('is advertised on `capy deploy targets-remove --help`', () => {
    const r = capy(['deploy', 'targets-remove', '--help']);
    expect((r.stdout + r.stderr)).toContain('--no-deploy');
  });
});
