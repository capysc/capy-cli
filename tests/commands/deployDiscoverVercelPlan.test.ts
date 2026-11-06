/**
 * `capy deploy vercel --discover --plan <file> --dry-run` (CAP-696): validating a plan, changing nothing.
 *
 * The properties under test: a plan that is valid prints the lines a person approves and the `plan_id`
 * that ties `--confirm` to exactly this plan; every error is path-precise and coded; several Vercel
 * projects may ship one Capy branch (a monorepo) but the same environment twice is a duplicate; only the
 * projects a plan names have their environments read; nothing is written anywhere.
 *
 * Fakes only (`tests/helpers/deployDiscoverVercelWorld.ts`).
 */
import { describe, test, expect } from 'bun:test';
import { runDeployVercelDiscover } from '../../src/commands/deployDiscover/vercel';
import {
  ENTRY_CFG,
  ENTRY_DUO_A,
  ENTRY_DUO_B,
  ENTRY_MADMIN,
  ENTRY_MWEB,
  ENTRY_SHOP,
  ENTRY_SHOP_FEATURE,
  ENTRY_SHOP_PREVIEW,
  ENTRY_SHOP_STAGING,
  P_MWEB,
  P_SHOP,
  SENTINEL_VERCEL,
  SVC,
  VercelWorld,
  makeVercelWorld,
  planFile,
} from '../helpers/deployDiscoverVercelWorld';

const PLAN = 'plan.json';

async function dryRun(text: string, world: VercelWorld = makeVercelWorld({ files: { [PLAN]: text } })) {
  const result = await runDeployVercelDiscover({ plan: PLAN, dryRun: true }, world.io);
  return { world, exitCode: result.exitCode, body: result.body as any };
}

const nothingWritten = (world: VercelWorld): void => {
  expect(world.github.createBlob).not.toHaveBeenCalled();
  expect(world.github.createTree).not.toHaveBeenCalled();
  expect(world.github.createCommit).not.toHaveBeenCalled();
  expect(world.github.createRef).not.toHaveBeenCalled();
  expect(world.github.createPull).not.toHaveBeenCalled();
};

const ENTRIES = [ENTRY_SHOP, ENTRY_SHOP_PREVIEW, ENTRY_SHOP_FEATURE, ENTRY_SHOP_STAGING, ENTRY_MWEB, ENTRY_MADMIN, ENTRY_DUO_A, ENTRY_DUO_B];

describe('dry run: a valid plan', () => {
  test('prints the plan, its plan_id, the lines to relay, the PRs it would open, and the confirm command; writes nothing', async () => {
    const { body, exitCode, world } = await dryRun(planFile(ENTRIES));
    expect(exitCode).toBe(0);
    expect(body).toMatchObject({ ok: true, dry_run: true });
    expect(body.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.plan.version).toBe(1);
    expect(body.plan.entries).toHaveLength(8);
    expect(body.summary_lines).toHaveLength(8);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/duo', 'acme/mono', 'acme/shop']);
    expect(body.prs.find((p: any) => p.repo === 'acme/mono')).toMatchObject({ base: 'main', files: ['apps/admin/.capy/deploy.json', 'apps/web/.capy/deploy.json'] });
    expect(body.next_steps.at(-1)).toEqual({ run: `capy deploy vercel --discover --plan ${PLAN} --confirm ${body.plan_id}` });
    nothingWritten(world);
  });

  test('a summary line names the Capy project and branch, the Vercel project and environment, the PR base and the number of variables', async () => {
    const { body } = await dryRun(planFile([ENTRY_SHOP_FEATURE, ENTRY_SHOP_STAGING]));
    expect(body.summary_lines).toEqual([
      'shop · feature-x → Vercel shop-web preview@feature-x (main), 1 vars',
      'shop · staging → Vercel shop-web staging (main), 1 vars',
    ]);
  });

  test('the plan_id does not depend on the order of entries or of variables, and changes when an entry does', async () => {
    const a = await dryRun(planFile(ENTRIES));
    const b = await dryRun(planFile([...ENTRIES].reverse().map((e) => ({ ...e, vars: [...e.vars].reverse() }))));
    expect(b.body.plan_id).toBe(a.body.plan_id);
    const c = await dryRun(planFile(ENTRIES.slice(1)));
    expect(c.body.plan_id).not.toBe(a.body.plan_id);
  });

  test('two Vercel projects of one monorepo may ship the same Capy branch of the same Capy project', async () => {
    const { body, exitCode } = await dryRun(planFile([ENTRY_DUO_A, ENTRY_DUO_B]));
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.prs).toHaveLength(1);
    expect(body.prs[0].targets).toEqual(['vercel-production', 'vercel-production-2']);
  });

  test('an entry whose environment already has a target is reported already_configured and is not in the PR preview', async () => {
    const { body } = await dryRun(planFile([ENTRY_CFG, ENTRY_SHOP]));
    expect(body.already_configured).toEqual([{ project_id: ENTRY_CFG.project_id, branch: 'production', service_id: SVC.cfgProd, target_name: 'vercel-production' }]);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/shop']);
    expect(body.summary_lines).toContain('configured · production: already configured (vercel-production), nothing to do');
  });

  test('only the projects the plan names have their environments read', async () => {
    const { world } = await dryRun(planFile([ENTRY_SHOP]));
    const urls = world.vercelCalls().map((c) => c.url);
    expect(urls.filter((u) => u.includes('/env')).every((u) => u.includes('prj_shop'))).toBe(true);
    expect(urls.some((u) => u.includes('prj_mweb'))).toBe(false);
  });

  test('no value anywhere in the output', async () => {
    const { body } = await dryRun(planFile(ENTRIES));
    expect(JSON.stringify(body)).not.toContain(SENTINEL_VERCEL);
  });
});

describe('dry run: errors are path-precise and coded, and nothing is changed', () => {
  test('an unknown service id', async () => {
    const { body, exitCode, world } = await dryRun(planFile([{ ...ENTRY_SHOP, service_id: 'prj_shop:custom:nope' }]));
    expect(exitCode).toBe(1);
    expect(body.code).toBe('PLAN_INVALID');
    expect(body.errors).toContainEqual({ path: 'entries[0].service_id', code: 'SERVICE_NOT_FOUND' });
    nothingWritten(world);
  });

  test('the same environment twice is DUPLICATE_ENTRY, at the later entry', async () => {
    const { body } = await dryRun(planFile([ENTRY_SHOP, ENTRY_SHOP]));
    expect(body.errors).toEqual([{ path: 'entries[1]', code: 'DUPLICATE_ENTRY' }]);
  });

  test('a variable the Capy branch does not hold', async () => {
    const { body } = await dryRun(planFile([{ ...ENTRY_SHOP, vars: ['DB_URL', 'NOPE'] }]));
    expect(body.errors).toEqual([{ path: 'entries[0].vars[1]', code: 'VAR_NOT_FOUND' }]);
  });

  test('a Capy branch the project does not have', async () => {
    const { body } = await dryRun(planFile([{ ...ENTRY_SHOP, branch: 'nope' }]));
    expect(body.errors).toContainEqual({ path: 'entries[0].branch', code: 'BRANCH_NOT_FOUND' });
  });

  test('a PR base the repo does not have', async () => {
    const { body } = await dryRun(planFile([{ ...ENTRY_SHOP, git_branch: 'nope' }]));
    expect(body.errors).toEqual([{ path: 'entries[0].git_branch', code: 'BRANCH_NOT_FOUND' }]);
  });

  test('a Capy project that is not linked to the Vercel project\'s repo', async () => {
    const { body } = await dryRun(planFile([{ ...ENTRY_SHOP, project_id: P_MWEB, vars: ['WEB_KEY'], branch: 'production' }]));
    expect(body.errors).toContainEqual({ path: 'entries[0].service_id', code: 'REPO_MISMATCH' });
  });

  test('a project that does not exist (or the caller cannot see)', async () => {
    const { body } = await dryRun(planFile([{ ...ENTRY_SHOP, project_id: 'proj_nope' }]));
    expect(body.errors).toContainEqual({ path: 'entries[0].project_id', code: 'PROJECT_NOT_FOUND' });
  });

  test('a plan file that is not a plan: the shape errors come first, before anything is looked up', async () => {
    const { body, world } = await dryRun(JSON.stringify({ version: 1, entries: [{ project_id: P_SHOP }] }));
    expect(body.code).toBe('PLAN_INVALID');
    expect(body.errors.map((e: any) => e.path)).toEqual(expect.arrayContaining(['entries[0].branch', 'entries[0].service_id', 'entries[0].git_branch', 'entries[0].vars']));
    expect(world.fetchMock).not.toHaveBeenCalled();
  });

  test('an unreadable plan file is PLAN_FILE_UNREADABLE', async () => {
    const world = makeVercelWorld();
    const result = await runDeployVercelDiscover({ plan: 'missing.json', dryRun: true }, world.io);
    expect((result.body as any).code).toBe('PLAN_FILE_UNREADABLE');
  });

  test('--confirm without --plan is PLAN_REQUIRED', async () => {
    const result = await runDeployVercelDiscover({ confirm: 'abc' }, makeVercelWorld().io);
    expect((result.body as any).code).toBe('PLAN_REQUIRED');
  });

  test('a real run without --confirm is refused with the id to confirm (exit 3), and writes nothing', async () => {
    const world = makeVercelWorld({ files: { [PLAN]: planFile([ENTRY_SHOP]) } });
    const result = await runDeployVercelDiscover({ plan: PLAN }, world.io);
    expect(result.exitCode).toBe(3);
    expect((result.body as any).code).toBe('PLAN_CONFIRM_REQUIRED');
    expect((result.body as any).unanswered[0]).toMatchObject({ id: 'confirm', flag: '--confirm' });
    nothingWritten(world);
  });

  test('the token is checked before anything is read: missing, and nothing is requested', async () => {
    const world = makeVercelWorld({ token: null, files: { [PLAN]: planFile([ENTRY_SHOP]) } });
    const { body } = await dryRun(planFile([ENTRY_SHOP]), world);
    expect(body.code).toBe('VERCEL_TOKEN_MISSING');
    expect(world.fetchMock).not.toHaveBeenCalled();
  });
});
