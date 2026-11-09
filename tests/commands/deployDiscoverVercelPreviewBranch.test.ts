/**
 * `capy deploy vercel --discover` (CAP-730): the branch of a preview environment.
 *
 * Production keeps the project's production branch. The all-branches preview's branch is the deploy PR base, so it is
 * a LONG-LIVED branch: the candidates are only the production branch, the GitHub default branch and the branches
 * preview variables are scoped to. Recent preview deployments never add a candidate; they rank the ones there are.
 * One candidate: it, certain. Several: ranked by deployments, scoped variables, default branch; certain only when every
 * signal that names a candidate names the winner. A custom environment uses its branch rule. A preview scoped to a
 * branch never becomes an empty proposal. The deployments call failing is a coded notice, never a failed discovery.
 * Names, ids and counts only.
 */
import { describe, test, expect } from 'bun:test';
import { runDeployVercelDiscover } from '../../src/commands/deployDiscover/vercel';
import { inferPreviewBranch, leadersOf } from '../../src/commands/deployDiscover/vercelBranch';
import type { BranchSignal } from '../../src/commands/deployDiscover/facts';
import { createVercelClient } from '../../src/deploy/vercelApi';
import type { FakeProject } from '../helpers/deployDiscoverWorld';
import type { FakeVercelData, RawEnv } from '../helpers/fakeVercel';
import { fakeVercelFetch, project as vercelProject } from '../helpers/fakeVercel';
import { SENTINEL_VERCEL, makeVercelWorld } from '../helpers/deployDiscoverVercelWorld';

const PRJ = 'prj_ss';
const SVC_PREVIEW = `${PRJ}:preview`;
const SVC_SCOPED = `${PRJ}:preview@develop`;

const env = (id: string, key: string, over: Partial<RawEnv> = {}): RawEnv => ({
  id,
  key,
  type: 'plain',
  target: ['preview'],
  listValue: SENTINEL_VERCEL,
  ...over,
});

interface Setup {
  readonly production?: string;
  readonly defaultBranch?: string;
  readonly deployments?: ReadonlyArray<string | null>;
  readonly deploymentsStatus?: number;
  readonly scoped?: ReadonlyArray<{ branch: string; names: readonly string[] }>;
  readonly custom?: FakeVercelData['custom'];
  readonly extraEnvs?: readonly RawEnv[];
  readonly capyBranches?: Readonly<Record<string, readonly string[]>>;
}

const capyProject = (branches: Readonly<Record<string, readonly string[]>>): readonly FakeProject[] => [
  { id: 'proj_ss', name: 'slidespeak', repos: [{ owner: 'acme', name: 'ss', path: '.' }], branches: branches as Record<string, string[]> },
];

function worldOf(setup: Setup = {}) {
  const scopedEnvs = (setup.scoped ?? []).flatMap(({ branch, names }) => names.map((n, i) => env(`s_${branch}_${i}`, n, { gitBranch: branch })));
  const data: FakeVercelData = {
    teams: [{ id: 'team_1', slug: 'acme-team' }],
    projects: {
      team_1: [vercelProject(PRJ, 'slidespeak-app', { link: { type: 'github', org: 'acme', repo: 'ss', productionBranch: setup.production ?? 'main' } })],
      personal: [],
    },
    envs: {
      [PRJ]: [
        env('p1', 'API_KEY', { target: ['production', 'preview'] }),
        env('p2', 'DB_URL', { target: ['production', 'preview'] }),
        ...scopedEnvs,
        ...(setup.extraEnvs ?? []),
      ],
    },
    ...(setup.custom === undefined ? {} : { custom: setup.custom }),
    deployments: { [PRJ]: (setup.deployments ?? []).map((branch) => ({ branch })) },
    ...(setup.deploymentsStatus === undefined ? {} : { deploymentsStatus: { [PRJ]: setup.deploymentsStatus } }),
  };
  return makeVercelWorld({
    data,
    projects: capyProject(setup.capyBranches ?? { production: ['API_KEY', 'DB_URL'], preview: ['API_KEY', 'DB_URL'] }),
    repos: { 'acme/ss': { defaultBranch: setup.defaultBranch ?? setup.production ?? 'main', branches: ['main', 'develop', 'staging', 'release'] } },
  });
}

async function discover(setup: Setup = {}) {
  const world = worldOf(setup);
  const result = await runDeployVercelDiscover({}, world.io);
  const body = result.body as any;
  const previewService = body.services.find((s: any) => s.service_id === SVC_PREVIEW);
  const previewProposal = body.proposals.find((p: any) => p.service_id === SVC_PREVIEW);
  return { world, result, body, previewService, previewProposal };
}

const deploys = (branch: string, n: number): readonly string[] => Array.from({ length: n }, () => branch);

describe('preview branch: candidates are long-lived branches; deployments only rank them', () => {
  test('(a) default branch = production = main, deployments spread over feature branches: main, certain; the feature branches are one total, not a list', async () => {
    const { previewProposal, previewService, body } = await discover({
      deployments: [...deploys('feat/SLI-191', 3), ...deploys('fix/replicate-output-shape', 3), ...deploys('feature-b', 2)],
    });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewService.branch).toBe('main');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(previewProposal.evidence.git_branch).toEqual({
      basis: 'production_branch_only',
      signals: [{ code: 'RECENT_PREVIEW_DEPLOYMENTS', branches: [], other_branches: 8 }],
    });
    expect(JSON.stringify(body)).not.toContain('SLI-191');
  });

  test('(b) only a one-off capy/* import branch was deployed, once: main, certain', async () => {
    const { previewProposal } = await discover({ deployments: ['capy/vercel-import-20261104-2058'] });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(previewProposal.evidence.git_branch.basis).toBe('production_branch_only');
  });

  test('(c) the slidespeak-app shape (production main, default develop, scoped develop, develop 25 deploys, many features, main 0): develop, certain, counts only for candidates', async () => {
    const features = Array.from({ length: 20 }, (_, i) => `feature-${i}`);
    const { previewProposal, previewService, body } = await discover({
      defaultBranch: 'develop',
      scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }],
      deployments: [...deploys('develop', 25), ...features],
    });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewService.branch).toBe('develop');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(previewProposal.evidence.git_branch.basis).toBe('signals_agree');
    expect(previewProposal.evidence.git_branch.signals).toEqual([
      { code: 'RECENT_PREVIEW_DEPLOYMENTS', branches: [{ branch: 'develop', weight: 25 }], other_branches: 20 },
      { code: 'BRANCH_SCOPED_VARIABLES', branches: [{ branch: 'develop', weight: 1, names: ['NEW_FLAG'], shadows: [] }] },
      { code: 'GITHUB_DEFAULT_BRANCH', branches: [{ branch: 'develop', weight: 1 }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('feature-7');
  });

  test('(d) default develop but the deployments are mostly on main: main wins the ranking, needs_review, every signal listed', async () => {
    const { previewProposal } = await discover({ defaultBranch: 'develop', deployments: [...deploys('main', 6), ...deploys('develop', 1), 'feature-a'] });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewProposal.confidence.branch).toBe('needs_review');
    expect(previewProposal.evidence.git_branch.basis).toBe('strongest_signal');
    expect(previewProposal.evidence.git_branch.signals).toEqual([
      { code: 'RECENT_PREVIEW_DEPLOYMENTS', branches: [{ branch: 'main', weight: 6 }, { branch: 'develop', weight: 1 }], other_branches: 1 },
      { code: 'GITHUB_DEFAULT_BRANCH', branches: [{ branch: 'develop', weight: 1 }] },
    ]);
  });

  test('a branch that was only deployed from never becomes a candidate, however many deployments it has', async () => {
    const { previewProposal } = await discover({ defaultBranch: 'develop', deployments: deploys('feat/x', 40) });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.confidence.branch).toBe('certain');
  });

  test('deployments with no git branch (a CLI deploy) count for no branch', async () => {
    const { previewProposal } = await discover({ deployments: [null, null, 'develop'] });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewProposal.evidence.git_branch.signals).toEqual([{ code: 'RECENT_PREVIEW_DEPLOYMENTS', branches: [], other_branches: 1 }]);
  });
});

describe('preview git branch: scoped variables and the default branch', () => {
  test('branch-scoped variables: the branch with the most scoped variables, with their names and the names the all-branches preview shadows', async () => {
    const { previewProposal } = await discover({ scoped: [{ branch: 'develop', names: ['DB_URL', 'NEW_FLAG'] }, { branch: 'staging', names: ['ONLY_STAGING'] }] });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.evidence.git_branch.signals).toEqual([
      {
        code: 'BRANCH_SCOPED_VARIABLES',
        branches: [
          { branch: 'develop', weight: 2, names: ['DB_URL', 'NEW_FLAG'], shadows: ['DB_URL'] },
          { branch: 'staging', weight: 1, names: ['ONLY_STAGING'], shadows: [] },
        ],
      },
    ]);
    expect(previewProposal.confidence.branch).toBe('certain');
  });

  test('the GitHub default branch, when it differs from the production branch', async () => {
    const { previewProposal } = await discover({ defaultBranch: 'develop' });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.evidence.git_branch.signals).toEqual([{ code: 'GITHUB_DEFAULT_BRANCH', branches: [{ branch: 'develop', weight: 1 }] }]);
    expect(previewProposal.confidence.branch).toBe('certain');
  });

  test('a default branch equal to the production branch is not a signal', async () => {
    const { previewProposal } = await discover({ defaultBranch: 'main', production: 'main' });
    expect(previewProposal.evidence.git_branch.signals).toEqual([]);
  });
});

describe('preview git branch: ranking and disagreement', () => {
  test('all three signals name the same branch: that branch, certain, every signal listed', async () => {
    const { previewProposal } = await discover({
      defaultBranch: 'develop',
      deployments: deploys('develop', 3),
      scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }],
    });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(previewProposal.evidence.git_branch.basis).toBe('signals_agree');
    expect(previewProposal.evidence.git_branch.signals.map((s: any) => s.code)).toEqual([
      'RECENT_PREVIEW_DEPLOYMENTS',
      'BRANCH_SCOPED_VARIABLES',
      'GITHUB_DEFAULT_BRANCH',
    ]);
  });

  test('deployments outrank scoped variables and the default branch among the candidates: needs_review, every signal listed', async () => {
    const { previewProposal } = await discover({
      defaultBranch: 'release',
      deployments: deploys('release', 4),
      scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }],
    });
    expect(previewProposal.git_branch).toBe('release');
    expect(previewProposal.confidence.branch).toBe('needs_review');
    expect(previewProposal.evidence.git_branch.basis).toBe('strongest_signal');
    expect(previewProposal.evidence.git_branch.signals.map((s: any) => s.code)).toEqual([
      'RECENT_PREVIEW_DEPLOYMENTS',
      'BRANCH_SCOPED_VARIABLES',
      'GITHUB_DEFAULT_BRANCH',
    ]);
  });

  test('scoped variables outrank the default branch when no candidate was deployed', async () => {
    const { previewProposal } = await discover({ defaultBranch: 'release', scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }] });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.confidence.branch).toBe('needs_review');
  });

  test('a tie in deployments between candidates is broken by the next criterion, and is not agreement', async () => {
    const { previewProposal } = await discover({ deployments: ['main', 'staging'], defaultBranch: 'staging' });
    expect(previewProposal.git_branch).toBe('staging');
    expect(previewProposal.confidence.branch).toBe('needs_review');
  });

  test('a tie nothing else breaks is settled by branch name, and needs_review', async () => {
    const { previewProposal } = await discover({ scoped: [{ branch: 'staging', names: ['A'] }, { branch: 'develop', names: ['B'] }] });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.confidence.branch).toBe('needs_review');
  });

  test('no other long-lived branch: the production branch, certain, whatever else was read', async () => {
    const { previewProposal, previewService } = await discover({ production: 'main', defaultBranch: 'main' });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewService.branch).toBe('main');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(previewProposal.evidence.git_branch).toEqual({ basis: 'production_branch_only', signals: [] });
  });

  test('a proposal that needs review is in the next step\'s review list', async () => {
    const { body, previewProposal } = await discover({ defaultBranch: 'release', scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }] });
    expect(body.next_steps.find((s: any) => s.action === 'review').proposal_ids).toContain(previewProposal.proposal_id);
  });

  test('production keeps the production branch whatever the signals say', async () => {
    const { body } = await discover({ defaultBranch: 'develop', deployments: deploys('develop', 9), scoped: [{ branch: 'develop', names: ['X'] }] });
    const production = body.proposals.find((p: any) => p.service_id === `${PRJ}:production`);
    expect(production.git_branch).toBe('main');
    expect(production.evidence.git_branch).toBeUndefined();
    expect(body.services.find((s: any) => s.service_id === `${PRJ}:production`).git_branch_signals).toBeUndefined();
  });
});

describe('preview git branch: the deployments call', () => {
  test('asks for preview deployments of the project, with a limit, team-scoped, by GET', async () => {
    const { world } = await discover({ deployments: deploys('develop', 1) });
    const call = world.vercelCalls().find((c) => new URL(c.url).pathname === '/v6/deployments');
    expect(call).toBeDefined();
    const url = new URL(call!.url);
    expect(call!.method).toBe('GET');
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: PRJ, target: 'preview', limit: '100', teamId: 'team_1' });
  });

  test.each([403, 500, 404])('HTTP %i: no signal and a coded notice; discovery still succeeds and the other signals are used', async (status) => {
    const { result, body, previewProposal } = await discover({ deploymentsStatus: status, defaultBranch: 'develop' });
    expect(result.exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.notices).toContainEqual({ code: 'VERCEL_PREVIEW_DEPLOYMENTS_UNAVAILABLE', detail: 'slidespeak-app' });
    expect(previewProposal.git_branch).toBe('develop');
    expect(previewProposal.evidence.git_branch.signals.map((s: any) => s.code)).toEqual(['GITHUB_DEFAULT_BRANCH']);
  });

  test('a failed call with no other long-lived branch: the production branch, plus the notice (deployments never decide alone)', async () => {
    const { body, previewProposal } = await discover({ deploymentsStatus: 403 });
    expect(previewProposal.git_branch).toBe('main');
    expect(previewProposal.confidence.branch).toBe('certain');
    expect(body.notices.map((n: any) => n.code)).toContain('VERCEL_PREVIEW_DEPLOYMENTS_UNAVAILABLE');
  });

  test('a call that works adds no notice', async () => {
    const { body } = await discover({ deployments: deploys('develop', 1) });
    expect(body.notices.map((n: any) => n.code)).not.toContain('VERCEL_PREVIEW_DEPLOYMENTS_UNAVAILABLE');
  });

  test('not asked at all for a project with no all-branches preview variables', async () => {
    const world = makeVercelWorld({
      data: {
        teams: [{ id: 'team_1', slug: 'acme-team' }],
        projects: { team_1: [vercelProject(PRJ, 'slidespeak-app', { link: { type: 'github', org: 'acme', repo: 'ss', productionBranch: 'main' } })], personal: [] },
        envs: { [PRJ]: [env('p1', 'API_KEY', { target: ['production'] })] },
      },
      projects: capyProject({ production: ['API_KEY'] }),
      repos: { 'acme/ss': { defaultBranch: 'main', branches: ['main'] } },
    });
    await runDeployVercelDiscover({}, world.io);
    expect(world.vercelCalls().some((c) => new URL(c.url).pathname === '/v6/deployments')).toBe(false);
  });
});

describe('plan mode', () => {
  test('does not read deployments: the plan names its own git branch', async () => {
    const plan = JSON.stringify({ version: 1, entries: [{ project_id: 'proj_ss', branch: 'preview', service_id: SVC_PREVIEW, git_branch: 'develop', vars: ['API_KEY'] }] });
    const base = worldOf({ deployments: deploys('develop', 1) });
    const result = await runDeployVercelDiscover({ plan: 'plan.json', dryRun: true }, { ...base.io, readFile: () => plan });
    expect((result.body as any).ok).toBe(true);
    expect(base.vercelCalls().some((c) => new URL(c.url).pathname === '/v6/deployments')).toBe(false);
  });
});

describe('preview git branch: records scoped to a git branch', () => {
  const scoped = [{ branch: 'develop', names: ['NEW_FLAG'] }];

  test('a scoped preview with no variable in common with its Capy branch is NOT a proposal: it stays unresolved with a coded reason, and the real preview proposal is the only one', async () => {
    const { body, previewProposal } = await discover({
      scoped,
      capyBranches: { production: ['API_KEY', 'DB_URL'], preview: ['API_KEY', 'DB_URL'], develop: ['SOMETHING_ELSE'] },
    });
    expect(body.proposals.map((p: any) => p.service_id)).not.toContain(SVC_SCOPED);
    expect(body.proposals.filter((p: any) => p.service_id.startsWith(`${PRJ}:preview`))).toHaveLength(1);
    expect(previewProposal.competing_proposal_ids).toEqual([]);
    expect(body.unresolved).toContainEqual({
      reason: 'BRANCH_SCOPED_NO_VARIABLES',
      service_id: SVC_SCOPED,
      project_id: 'proj_ss',
      candidates: [{ project_id: 'proj_ss', project_name: 'slidespeak', branch: 'develop' }],
    });
    expect(body.next_steps.find((s: any) => s.action === 'resolve').service_ids).toContain(SVC_SCOPED);
  });

  test('the scoped variables are evidence on the preview proposal and are not among its variables', async () => {
    const { previewProposal } = await discover({
      scoped,
      capyBranches: { production: ['API_KEY', 'DB_URL'], preview: ['API_KEY', 'DB_URL', 'NEW_FLAG'], develop: ['SOMETHING_ELSE'] },
    });
    expect(previewProposal.plan_entry.vars).toEqual(['API_KEY', 'DB_URL']);
    expect(previewProposal.evidence.git_branch.signals[0]).toMatchObject({ code: 'BRANCH_SCOPED_VARIABLES', branches: [{ branch: 'develop', names: ['NEW_FLAG'] }] });
  });

  test('the scoped service is still listed in the facts, with its names, and keeps the production branch as its PR base', async () => {
    const { body } = await discover({ scoped, defaultBranch: 'develop' });
    expect(body.services.find((s: any) => s.service_id === SVC_SCOPED)).toMatchObject({ git_branch_scope: 'develop', env_var_names: ['NEW_FLAG'], branch: 'main' });
  });

  test('a scoped preview that does share variables with its Capy branch is still proposed, aimed at its own git-branch-scoped records', async () => {
    const { body } = await discover({
      scoped: [{ branch: 'develop', names: ['DB_URL'] }],
      capyBranches: { production: ['API_KEY', 'DB_URL'], preview: ['API_KEY', 'DB_URL'], develop: ['DB_URL'] },
    });
    const proposal = body.proposals.find((p: any) => p.service_id === SVC_SCOPED);
    expect(proposal.plan_entry.vars).toEqual(['DB_URL']);
    expect(proposal.target).toMatchObject({ vercelEnv: 'preview', gitBranch: 'develop', branch: 'develop' });
  });
});

describe('custom environments with a branch rule', () => {
  const customEnvs = (matcher: { type: string; pattern: string } | undefined): Pick<Setup, 'custom' | 'extraEnvs' | 'capyBranches'> => ({
    custom: { [PRJ]: [{ id: 'env_stg', slug: 'staging', ...(matcher === undefined ? {} : { branchMatcher: matcher }) }] },
    extraEnvs: [env('c1', 'DB_URL', { target: [], customEnvironmentIds: ['env_stg'] })],
    capyBranches: { production: ['API_KEY', 'DB_URL'], preview: ['API_KEY', 'DB_URL'], staging: ['DB_URL'] },
  });
  const stagingProposal = (body: any) => body.proposals.find((p: any) => p.service_id === `${PRJ}:custom:staging`);

  test('an exact rule names the branch: certain', async () => {
    const { body } = await discover(customEnvs({ type: 'equals', pattern: 'staging' }));
    expect(stagingProposal(body).git_branch).toBe('staging');
    expect(stagingProposal(body).confidence.branch).toBe('certain');
    expect(stagingProposal(body).evidence.git_branch).toEqual({
      basis: 'custom_environment_rule',
      signals: [{ code: 'CUSTOM_ENVIRONMENT_RULE', branches: [{ branch: 'staging', weight: 1 }], rule: { type: 'equals', pattern: 'staging' } }],
    });
  });

  test('a prefix rule names no single branch: the production branch, needs_review, the rule listed', async () => {
    const { body } = await discover(customEnvs({ type: 'startsWith', pattern: 'release/' }));
    expect(stagingProposal(body).git_branch).toBe('main');
    expect(stagingProposal(body).confidence.branch).toBe('needs_review');
    expect(stagingProposal(body).evidence.git_branch).toEqual({
      basis: 'custom_environment_pattern',
      signals: [{ code: 'CUSTOM_ENVIRONMENT_RULE', branches: [], rule: { type: 'startsWith', pattern: 'release/' } }],
    });
  });

  test('no rule: as before, the production branch with no judgement', async () => {
    const { body } = await discover(customEnvs(undefined));
    expect(stagingProposal(body).git_branch).toBe('main');
    expect(stagingProposal(body).evidence.git_branch).toBeUndefined();
  });

  test('a rule type the client does not know is dropped, not guessed', async () => {
    const { body } = await discover(customEnvs({ type: 'regex', pattern: '.*' }));
    expect(stagingProposal(body).evidence.git_branch).toBeUndefined();
  });
});

describe('preview git branch: names only', () => {
  test('no value, and no value-route call, appears anywhere', async () => {
    const { body, world } = await discover({ deployments: deploys('develop', 2), scoped: [{ branch: 'develop', names: ['NEW_FLAG'] }], defaultBranch: 'develop' });
    expect(JSON.stringify(body)).not.toContain(SENTINEL_VERCEL);
    expect(world.vercelCalls().every((c) => !c.url.includes('/v1/projects/') && !c.url.includes('decrypt'))).toBe(true);
  });
});

describe('inferPreviewBranch (pure)', () => {
  const signal = (code: BranchSignal['code'], ...branches: ReadonlyArray<readonly [string, number]>): BranchSignal => ({
    code,
    branches: branches.map(([branch, weight]) => ({ branch, weight })),
  });

  test('leadersOf lists every branch tied for the top weight', () => {
    expect(leadersOf(signal('RECENT_PREVIEW_DEPLOYMENTS', ['b', 3], ['a', 3], ['c', 1]))).toEqual(['a', 'b']);
  });

  test('deployments alone add no candidate: the production branch, certain', () => {
    expect(inferPreviewBranch([signal('RECENT_PREVIEW_DEPLOYMENTS', ['feat/x', 9], ['fix/y', 3])], 'main')).toMatchObject({
      branch: 'main',
      confidence: 'certain',
      basis: 'production_branch_only',
      candidates: ['main'],
    });
  });

  test('candidates are the production branch, the default branch and the scoped branches only', () => {
    const inferred = inferPreviewBranch(
      [signal('RECENT_PREVIEW_DEPLOYMENTS', ['feat/x', 9]), signal('BRANCH_SCOPED_VARIABLES', ['staging', 2]), signal('GITHUB_DEFAULT_BRANCH', ['develop', 1])],
      'main',
    );
    expect(inferred.candidates).toEqual(['develop', 'main', 'staging']);
  });

  test('the default branch alone beats the production branch, and everyone naming it is agreement', () => {
    expect(inferPreviewBranch([signal('RECENT_PREVIEW_DEPLOYMENTS', ['feat/x', 9]), signal('GITHUB_DEFAULT_BRANCH', ['develop', 1])], 'main')).toMatchObject({
      branch: 'develop',
      confidence: 'certain',
      basis: 'signals_agree',
    });
  });

  test('a signal that disagrees with itself (a tie between candidates) is not agreement', () => {
    expect(inferPreviewBranch([signal('BRANCH_SCOPED_VARIABLES', ['a', 1], ['b', 1])], 'main')).toMatchObject({ branch: 'a', confidence: 'needs_review' });
  });

  test('without a production branch and without candidates the answer is null, needs_review', () => {
    expect(inferPreviewBranch([], null)).toMatchObject({ branch: null, confidence: 'needs_review', basis: 'no_signals' });
  });

  test('without a production branch, a single named candidate is the answer', () => {
    expect(inferPreviewBranch([signal('GITHUB_DEFAULT_BRANCH', ['develop', 1])], null)).toMatchObject({ branch: 'develop', confidence: 'certain' });
  });
});

describe('the Vercel client: preview deployments and branch rules', () => {
  const client = (fake: FakeVercelData) => ({ api: createVercelClient('t', { fetch: fakeVercelFetch(fake), sleep: async () => {} }) });
  const data = (over: Partial<FakeVercelData>): FakeVercelData => ({ projects: {}, envs: {}, ...over });

  test('reads githubCommitRef only; a deployment without one still comes back, with no branch', async () => {
    const { api } = client(data({ deployments: { p: [{ branch: 'develop' }, { branch: null }] } }));
    expect(await api.listPreviewDeployments('p', 'team_1', 10)).toEqual([{ id: 'dpl_p_0', gitBranch: 'develop' }, { id: 'dpl_p_1' }]);
  });

  test('a custom environment\'s branch matcher is parsed; an unknown type is dropped', async () => {
    const { api } = client(
      data({
        custom: {
          p: [
            { id: 'a', slug: 'a', branchMatcher: { type: 'endsWith', pattern: '-stg' } },
            { id: 'b', slug: 'b', branchMatcher: { type: 'glob', pattern: '*' } },
            { id: 'c', slug: 'c' },
          ],
        },
      }),
    );
    expect(await api.listCustomEnvironments('p')).toEqual([{ id: 'a', slug: 'a', branchMatcher: { type: 'endsWith', pattern: '-stg' } }, { id: 'b', slug: 'b' }, { id: 'c', slug: 'c' }]);
  });
});
