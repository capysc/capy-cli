/**
 * `capy deploy` never takes every variable off a platform because the folder had nothing to read.
 *
 * The fault this guards: the variable list a deploy delivers comes from the folder's `.env`. With no `.env` (a fresh or
 * sparse checkout where nobody ran `capy checkout`), or with a `.env` that holds none of the target's variables,
 * `--yes` used to drop every variable from the target and carry on, while `--dry-run` kept the full list and so showed
 * a different result from the real run.
 *
 * Now: both refuse before anything is asked, saved or delivered, with a code; and a dry run drops the same variables a
 * real run would.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withHarness, ORG_ID, PROJECT_ID, type Harness } from '../helpers/pipedHarness';
import { hashValue } from '../../src/sync/compareSecrets';
import { describeVarSetProblem, varSetProblem } from '../../src/deploy/keepGate';

describe('varSetProblem', () => {
  test('no .env: NO_ENV_FILE, whatever the target selects', () => {
    expect(varSetProblem(false, ['A', 'B'], [])).toEqual({ code: 'NO_ENV_FILE' });
    expect(varSetProblem(false, [], [])).toEqual({ code: 'NO_ENV_FILE' });
    expect(varSetProblem(false, ['A'], ['A'])).toEqual({ code: 'NO_ENV_FILE' });
  });

  test('a .env with none of the selected variables: DEPLOY_REMOVES_ALL_VARS, naming every one', () => {
    expect(varSetProblem(true, ['A', 'B'], ['C'])).toEqual({ code: 'DEPLOY_REMOVES_ALL_VARS', removed: ['A', 'B'] });
    expect(varSetProblem(true, ['A'], [])).toEqual({ code: 'DEPLOY_REMOVES_ALL_VARS', removed: ['A'] });
  });

  test('at least one selected variable is still here: no problem (the drift rules decide the rest)', () => {
    expect(varSetProblem(true, ['A', 'B'], ['A'])).toBeNull();
    expect(varSetProblem(true, ['A'], ['A', 'NEW'])).toBeNull();
  });

  test('a target that selects nothing is not "removing all"', () => {
    expect(varSetProblem(true, [], ['A'])).toBeNull();
  });

  test('the sentence leads with the code and names the way out', () => {
    const missing = describeVarSetProblem({ code: 'NO_ENV_FILE' }, 'prod-target', 'production');
    expect(missing.startsWith('[NO_ENV_FILE]')).toBe(true);
    expect(missing).toContain('capy checkout production');
    const all = describeVarSetProblem({ code: 'DEPLOY_REMOVES_ALL_VARS', removed: ['A', 'B'] }, 'prod-target', 'production');
    expect(all.startsWith('[DEPLOY_REMOVES_ALL_VARS]')).toBe(true);
    expect(all).toContain('capy checkout production');
  });
});

const TARGET = 'dokploy-target';

function writeDeployConfig(cwd: string, vars: readonly string[]): void {
  mkdirSync(join(cwd, '.capy'), { recursive: true });
  const target = {
    name: TARGET,
    kind: 'dokploy',
    branch: 'production',
    vars,
    options: { baseUrl: 'https://dokploy.example.com', applicationId: 'app_1', tokenEnv: 'DOKPLOY_API_KEY' },
  };
  writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify({ version: '1', targets: { [TARGET]: target } }, null, 2));
}

/**
 * A folder that bare `capy` (the first step of every deploy) finds in sync: keep.lock pins DATABASE_URL on
 * `production` and `.env` holds it. The target's own variable list is the test's.
 */
function syncedProject(h: Harness, targetVars: readonly string[]): void {
  const variables = { DATABASE_URL: [{ resource_id: 'ridp', branch: 'production', value_hash: hashValue('x') }] };
  writeFileSync(
    join(h.project, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'test', variables }, null, 2),
  );
  writeDeployConfig(h.project, targetVars);
  writeFileSync(join(h.project, '.env'), '# capy:branch=production\nDATABASE_URL=x\n');
  writeFileSync(join(h.project, '.capy', 'branch'), 'production');
}

const deployJson = (h: Harness): string => readFileSync(join(h.project, '.capy/deploy.json'), 'utf-8');
const NO_KEY = { DOKPLOY_API_KEY: '' };

describe('capy deploy: none of the target\'s variables are in the folder', () => {
  test('--yes refuses with DEPLOY_REMOVES_ALL_VARS, exit 1, before preflight; the saved target is untouched', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['GONE_ONE', 'GONE_TWO']);
      const before = deployJson(h);
      const r = await h.run(['deploy', TARGET, '--yes'], undefined, undefined, NO_KEY);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('[DEPLOY_REMOVES_ALL_VARS]');
      expect(r.stderr).toContain('capy checkout production');
      expect(r.stderr).not.toContain('preflight');
      expect(deployJson(h)).toBe(before);
    });
  });

  test('--dry-run refuses the same way: the preview and the real run agree', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['GONE_ONE', 'GONE_TWO']);
      const before = deployJson(h);
      const r = await h.run(['deploy', TARGET, '--dry-run'], undefined, undefined, NO_KEY);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('[DEPLOY_REMOVES_ALL_VARS]');
      expect(r.stderr).not.toContain('preflight');
      expect(deployJson(h)).toBe(before);
    });
  });

  test('--json reports it as a coded problem with the names', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['GONE_ONE', 'GONE_TWO']);
      const r = await h.run(['deploy', TARGET, '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).problem).toEqual({
        code: 'DEPLOY_REMOVES_ALL_VARS',
        target: TARGET,
        targetBranch: 'production',
        removed: ['GONE_ONE', 'GONE_TWO'],
      });
    });
  });
});

describe('capy deploy: the folder has no .env', () => {
  test('--dry-run refuses with NO_ENV_FILE, exit 1, before preflight; nothing is written', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['DATABASE_URL']);
      rmSync(join(h.project, '.env'));
      const before = deployJson(h);
      const r = await h.run(['deploy', TARGET, '--dry-run'], undefined, undefined, NO_KEY);
      expect(r.code).not.toBe(0);
      expect(r.stderr).not.toContain('preflight');
      expect(r.stderr).not.toContain('no longer in the project');
      expect(deployJson(h)).toBe(before);
      expect(existsSync(join(h.project, '.env'))).toBe(false);
    });
  });

  test('--yes never carries on with an empty variable list: the target keeps its variables', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['DATABASE_URL']);
      rmSync(join(h.project, '.env'));
      const before = deployJson(h);
      const r = await h.run(['deploy', TARGET, '--yes'], undefined, undefined, NO_KEY);
      // Bare capy runs first and may bring `.env` back; either way no run drops the target's variables.
      expect(r.stderr).not.toContain('no longer in the project');
      expect(deployJson(h)).toBe(before);
      if (!existsSync(join(h.project, '.env'))) {
        expect(r.code).not.toBe(0);
        expect(r.stderr).not.toContain('preflight');
      }
    });
  });

  test('--json reports NO_ENV_FILE as a coded problem', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['DATABASE_URL']);
      rmSync(join(h.project, '.env'));
      const r = await h.run(['deploy', TARGET, '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).problem).toEqual({ code: 'NO_ENV_FILE', target: TARGET, targetBranch: 'production', removed: [] });
    });
  });
});

describe('capy deploy: some of the target\'s variables are gone', () => {
  test('--dry-run and --yes both go on (to preflight) and both name the same dropped variable', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['DATABASE_URL', 'GONE_ONE']);
      const dry = await h.run(['deploy', TARGET, '--dry-run'], undefined, undefined, NO_KEY);
      const real = await h.run(['deploy', TARGET, '--yes'], undefined, undefined, NO_KEY);
      for (const r of [dry, real]) {
        expect(r.stderr + r.stdout).toContain('GONE_ONE');
        expect(r.stderr).not.toContain('DEPLOY_REMOVES_ALL_VARS');
        expect(r.stderr).not.toContain('NO_ENV_FILE');
      }
    });
  });

  test('a target whose variables are all here has no problem under --json', async () => {
    await withHarness(async (h) => {
      syncedProject(h, ['DATABASE_URL']);
      const r = await h.run(['deploy', TARGET, '--json']);
      expect(JSON.parse(r.stdout).problem).toBeUndefined();
    });
  });
});
