import { describe, expect, test } from 'bun:test';
import { SecretsScreenState, applyRepos, handleKey, initialSecretsScreenState, render, tokenizeKeys } from '../../src/ui/secretsScreen';
import { type EditFlow, isRowEntry, repoEntries, reposOfEntries } from '../../src/ui/secretsEditFlow';
import { type DeployFlow, allPicked, applyDeployPlanLoaded, pickedRows, renderDeploy, stepDeploy } from '../../src/ui/secretsDeployFlow';
import { createDeployActionsWith } from '../../src/commands/secretsDeployActions';
import type { RepoTarget } from '../../src/commands/secretsSet';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import { ERROR_CODES } from '../../src/types/index';
import { LINKS as WORLD_LINKS, fakeAdapter, fakeGithub, fakeService, indexRows, makeEnv, standardRepos } from '../helpers/batchDeployWorld';

/**
 * A project linked to more than one repo row, in the two screens: the person picks the row. Nothing is read from
 * GitHub to choose, and a project with one row is asked nothing.
 */

const ESC = '\x1b';
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_E = '\x05';
const SPACE = ' ';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// ── The edit screen ──────────────────────────────────────────────────────────

const row: SecretIndexRow = {
  name: 'API_KEY',
  value_hash: 'hash1',
  locations: [
    { project_id: 'p1', project_name: 'backend', branch: 'production', protected: false, service: null },
    { project_id: 'p2', project_name: 'worker', branch: 'production', protected: false, service: null },
  ],
  users: [],
};

const linkOf = (project: 'p1' | 'p2', path: string): OrgRepoLink => ({
  project_id: project,
  project_name: project === 'p1' ? 'backend' : 'worker',
  host: 'github.com',
  owner: 'Acme',
  name: 'mono',
  path,
  github_repo_id: 1,
  last_seen_at: '',
});
const REAL = linkOf('p1', 'backend');
const TEMP = linkOf('p1', '.claude/capy-temp');
const WORKER = linkOf('p2', 'worker');

const press = (state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((s, k) => handleKey(s, k).state, state);
const flowOf = (state: SecretsScreenState): EditFlow => state.edit as EditFlow;
/** The edit dialog on its repo list, with these links. */
const atRepos = (links: readonly OrgRepoLink[]): SecretsScreenState => {
  const typed = press(press(initialSecretsScreenState([row]), CTRL_E), ...tokenizeKeys('new-value'), ENTER, ENTER);
  return applyRepos(typed, { ok: true, links, bases: { 'github.com/acme/mono': 'main' } });
};
const reposFlow = (state: SecretsScreenState) => flowOf(state) as Extract<EditFlow, { step: 'repos' }>;
const fileAt = (path: string, project = 'p1') => ({ project_id: project, project_name: project === 'p1' ? 'backend' : 'worker', path });
const target = (...files: ReturnType<typeof fileAt>[]): RepoTarget => ({ host: 'github.com', owner: 'Acme', name: 'mono', files });

describe('the edit screen\'s repo list', () => {
  test('entries: a repo\'s single-row projects stay one entry; each row of a project with several is its own', () => {
    const entries = repoEntries([target(fileAt('backend'), fileAt('.claude/capy-temp'), fileAt('worker', 'p2'))]);

    expect(entries.map((e) => e.files.map((f) => f.path))).toEqual([['worker'], ['backend'], ['.claude/capy-temp']]);
    expect(entries.map((e) => isRowEntry(e, entries))).toEqual([false, true, true]);
    expect(reposOfEntries(entries)).toEqual([target(fileAt('worker', 'p2'), fileAt('backend'), fileAt('.claude/capy-temp'))]);
  });

  test('a project with one row is listed and ticked exactly as before', () => {
    const flow = reposFlow(atRepos([REAL, WORKER]));

    expect(flow.targets).toHaveLength(1);
    expect(flow.box.checked).toEqual([0]);
    expect(strip(render(atRepos([REAL, WORKER]), 100, 30))).not.toContain('none picked');
  });

  test('a project with two rows: each row is listed with its folder and neither is ticked', () => {
    const state = atRepos([REAL, TEMP, WORKER]);
    const flow = reposFlow(state);
    const frame = strip(render(state, 110, 30));

    expect(flow.targets).toHaveLength(3);
    expect(flow.box.checked).toEqual([0]);
    expect(frame).toContain('Acme/mono/backend');
    expect(frame).toContain('Acme/mono/.claude/capy-temp');
    expect(frame).toContain('none picked');
  });

  test('Enter with no row picked opens no PR for that project: its files are not in the run', () => {
    const ran = handleKey(atRepos([REAL, TEMP, WORKER]), ENTER);
    const effect = ran.effect as { type: string; request: { repos: readonly RepoTarget[] } };

    expect(effect.type).toBe('runSet');
    expect(effect.request.repos).toEqual([target(fileAt('worker', 'p2'))]);
  });

  test('the picked row, and only it, joins its repo\'s PR', () => {
    const picked = press(atRepos([REAL, TEMP, WORKER]), DOWN, SPACE);
    const ran = handleKey(picked, ENTER);
    const effect = ran.effect as { type: string; request: { repos: readonly RepoTarget[] } };

    expect(strip(render(picked, 110, 30))).not.toContain('none picked');
    expect(effect.request.repos).toEqual([target(fileAt('worker', 'p2'), fileAt('backend'))]);
  });
});

// ── The deploy screen ────────────────────────────────────────────────────────

const [deployRow] = indexRows();
const AMBIGUOUS = [{ project_id: 'pA', project_name: 'backend', rows: ['Acme/mono/backend', 'Acme/mono/.claude/capy-temp'] }];
const planning: DeployFlow = { step: 'planning', row: deployRow };
const atDeployRepos = (): Extract<DeployFlow, { step: 'repos' }> =>
  applyDeployPlanLoaded(planning, { ok: false, code: ERROR_CODES.PR_REPO_AMBIGUOUS, ambiguous: AMBIGUOUS }) as Extract<DeployFlow, { step: 'repos' }>;

describe('the deploy screen', () => {
  test('a plan that needs a choice opens the repo list, with the rows and none ticked', () => {
    const flow = atDeployRepos();
    const frame = strip(renderDeploy(flow, 100, 24).lines.join('\n'));

    expect(flow.step).toBe('repos');
    expect(flow.box.checked).toEqual([]);
    expect(frame).toContain('Acme/mono/backend');
    expect(frame).toContain('Acme/mono/.claude/capy-temp');
    expect(strip(renderDeploy(flow, 100, 24).footer)).not.toContain('enter');
  });

  test('Enter does nothing until every project has a row', () => {
    const stepped = stepDeploy(atDeployRepos(), ENTER);

    expect(stepped.effect).toBeNull();
    expect(stepped.flow?.step).toBe('repos');
  });

  test('space picks the row; Enter reads the plan again with the choice', () => {
    const picked = stepDeploy(atDeployRepos(), SPACE).flow as Extract<DeployFlow, { step: 'repos' }>;
    const stepped = stepDeploy(picked, ENTER);

    expect(allPicked(picked)).toBe(true);
    expect(pickedRows(picked)).toEqual([{ project_id: 'pA', row: 'Acme/mono/backend' }]);
    expect(stepped.flow).toEqual({ step: 'planning', row: deployRow });
    expect(stepped.effect).toEqual({ type: 'loadDeployPlan', row: deployRow, choices: [{ project_id: 'pA', row: 'Acme/mono/backend' }] });
  });

  test('Esc cancels with nothing read or written', () => {
    const stepped = stepDeploy(atDeployRepos(), ESC);

    expect(stepped.flow).toBeNull();
    expect(stepped.effect).toBeNull();
  });

  test('any other failure to read the plan still ends in its code', () => {
    expect(applyDeployPlanLoaded(planning, { ok: false, code: ERROR_CODES.SERVICE_ERROR })?.step).toBe('done');
  });
});

describe('the deploy screen\'s plan read', () => {
  const mine = WORLD_LINKS.find((l) => l.project_id === 'pA') as OrgRepoLink;
  const extra: OrgRepoLink = { ...mine, path: '.claude/capy-temp' };
  const rig = (links: readonly OrgRepoLink[]) => {
    const github = fakeGithub(standardRepos());
    const { env } = makeEnv(fakeService(), github, fakeAdapter());
    return { github, actions: createDeployActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...links] }) }, 'org1', env, false) };
  };
  const rowValue = (l: OrgRepoLink): string => (l.path === '.' ? `${l.owner}/${l.name}` : `${l.owner}/${l.name}/${l.path}`);

  test('a project with two rows and no choice: no plan, the rows to choose between, and nothing read from GitHub', async () => {
    const r = rig([...WORLD_LINKS, extra]);
    const loaded = await r.actions.loadPlan(deployRow);

    expect(loaded).toEqual({
      ok: false,
      code: ERROR_CODES.PR_REPO_AMBIGUOUS,
      ambiguous: [{ project_id: 'pA', project_name: mine.project_name, rows: [rowValue(mine), rowValue(extra)] }],
    });
    expect(r.github.getFile.mock.calls).toHaveLength(0);
  });

  test('with the choice, the plan is the plan a project with only that row gets', async () => {
    const chosen = await rig([...WORLD_LINKS, extra]).actions.loadPlan(deployRow, [{ project_id: 'pA', row: rowValue(mine) }]);
    const single = await rig(WORLD_LINKS).actions.loadPlan(deployRow);

    expect(chosen.ok).toBe(true);
    expect(chosen).toEqual(single);
  });
});
