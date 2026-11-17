import { describe, expect, mock, test } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import type { MemberDetail, SecretIndexLocation, SecretIndexRow, ServiceClient } from '../../src/service/serviceClient';
import { loadScreenData } from '../../src/commands/projectsCommand';
import { createProjectsLoadActions } from '../../src/commands/projectsLoadActions';
import { projectsModel } from '../../src/ui/projectsScreenDriver';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyDeleteDone,
  applyManageDone,
  applyMembersLoaded,
  initialProjectsScreenState,
  render,
  visibleTabs,
} from '../../src/ui/projectsScreen';

/**
 * `capy projects` loads progressively: the list draws from `GET /projects`
 * alone; one project's secrets index is read when its Secrets (or Deployments,
 * Connectors) tab is first shown, the member list when the Users tab (or a
 * branch's access dialog) first needs it. Each is read once and kept.
 *
 * The screen is driven the way the real driver does: a key, then every effect
 * it asks for is performed and its result applied before the next key.
 */

const ENTER = '\r';
const ESC = '\x1b';
const RIGHT = '\x1b[C';
const DOWN = '\x1b[B';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const loc = (over: Partial<SecretIndexLocation> = {}): SecretIndexLocation => ({
  project_id: 'p1',
  project_name: 'web',
  branch: 'development',
  protected: false,
  service: null,
  ...over,
});

const row = (name: string, locations: readonly SecretIndexLocation[], value_hash = `h-${name}`): SecretIndexRow => ({
  name,
  value_hash,
  locations: [...locations],
  users: [],
});

const ORG_ROWS: readonly SecretIndexRow[] = [
  row('API_KEY', [loc(), loc({ project_id: 'p2', project_name: 'api' })]),
  row('DB_URL', [loc({ branch: 'production' })]),
  row('ONLY_API', [loc({ project_id: 'p2', project_name: 'api' })]),
];
const WEB_ONLY_ROWS: readonly SecretIndexRow[] = [
  row('API_KEY', [loc()]),
  row('DB_URL', [loc({ branch: 'production' })]),
];

const repo = { host: 'github.com', owner: 'acme', name: 'web', path: '.', github_repo_id: 1 };

/** What a current service sends in `GET /projects`: branches everywhere; repos and the summary on administered projects. */
const SUMMARY_PROJECTS = [
  {
    id: 'p1',
    name: 'web',
    organization_id: 'o',
    created_at: '2026-01-01T00:00:00.000Z',
    branches: [{ id: 'b1', name: 'development', is_protected: false }, { id: 'b2', name: 'production', is_protected: true }],
    repos: [repo],
    variable_count: 7,
    variables_updated_at: '2026-05-01T00:00:00.000Z',
    index_status: 'INDEXED',
  },
  {
    id: 'p2',
    name: 'api',
    organization_id: 'o',
    created_at: '2026-02-01T00:00:00.000Z',
    branches: [{ id: 'b3', name: 'development', is_protected: false }],
    repos: [],
    variable_count: null,
    variables_updated_at: null,
    index_status: 'STALE',
  },
  {
    id: 'p3',
    name: 'notmine',
    organization_id: 'o',
    created_at: '2026-03-01T00:00:00.000Z',
    branches: [{ id: 'b4', name: 'development', is_protected: false }],
    variable_count: null,
    variables_updated_at: null,
    index_status: null,
  },
];

/** An older service: no branches, repos or summary in the list. */
const OLD_PROJECTS = [
  { id: 'p1', name: 'web', organization_id: 'o', created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'p2', name: 'api', organization_id: 'o', created_at: '2026-02-01T00:00:00.000Z' },
];

const member = (userId: string, email: string): MemberDetail => ({
  membershipId: `m_${userId}`,
  userId,
  email,
  role: 'member',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  projects: [{ id: 'p1', name: 'web', role: 'member', branches: [{ id: 'b2', name: 'production', isProtected: true, hasAccess: false }] }],
});

const forbidden = (): never => {
  throw new CapyError('any words at all', ERROR_CODES.PERMISSION_DENIED, { status: 403 });
};

interface FakeOpts {
  readonly projects?: readonly unknown[];
  readonly index?: (options?: { projectId?: string }) => unknown;
  readonly members?: () => unknown;
}

/** A service client that counts every request it is asked for. */
function fakeService(opts: FakeOpts = {}): {
  readonly client: ServiceClient;
  readonly listProjects: ReturnType<typeof mock>;
  readonly listBranches: ReturnType<typeof mock>;
  readonly getOrgRepos: ReturnType<typeof mock>;
  readonly getOrgMe: ReturnType<typeof mock>;
  readonly getSecretIndex: ReturnType<typeof mock>;
  readonly listMemberDetails: ReturnType<typeof mock>;
} {
  const listProjects = mock(async () => opts.projects ?? SUMMARY_PROJECTS);
  const listBranches = mock(async (id: string) => [{ id: `${id}-b`, name: 'development', project_id: id, is_protected: false }]);
  const getOrgRepos = mock(async () => ({ org_id: 'o', repos: [] }));
  const getOrgMe = mock(async () => ({ user_id: 'u', role: 'owner', admin_projects: [{ id: 'p1', name: 'web' }, { id: 'p2', name: 'api' }] }));
  const getSecretIndex = mock(async (_orgId: string, options?: { projectId?: string }) =>
    (opts.index ?? (() => ({ org_id: 'o', rows: WEB_ONLY_ROWS, skipped: [] })))(options),
  );
  const listMemberDetails = mock(async () => (opts.members ?? (() => ({ members: [member('u1', 'dev@x.co')] })))());
  return {
    client: { listProjects, listBranches, getOrgRepos, getOrgMe, getSecretIndex, listMemberDetails } as unknown as ServiceClient,
    listProjects,
    listBranches,
    getOrgRepos,
    getOrgMe,
    getSecretIndex,
    listMemberDetails,
  };
}

type Apply = (state: ProjectsScreenState) => { readonly state: ProjectsScreenState; readonly effect: unknown };

function modelFor(client: ServiceClient) {
  return projectsModel(
    { preview: async () => ({ ok: true, lines: [] }), run: async () => ({ ok: true, lines: [] }) },
    undefined,
    async () => true,
    undefined,
    createProjectsLoadActions(client, 'o'),
  );
}

/** Performs the effect a step asked for and applies its result, until nothing more is asked. */
async function settle(model: ReturnType<typeof modelFor>, step: { readonly state: ProjectsScreenState; readonly effect: unknown }): Promise<ProjectsScreenState> {
  const effect = step.effect as Parameters<typeof model.isOwnEffect>[0] | null;
  if (effect === null || !model.isOwnEffect(effect)) return step.state;
  const apply = await new Promise<Apply>((resolve) => model.performOwn(effect, resolve as never));
  return settle(model, apply(step.state));
}

/** One key at a time, each followed by its effects' results. */
async function pressAll(model: ReturnType<typeof modelFor>, state: ProjectsScreenState, keys: readonly string[]): Promise<ProjectsScreenState> {
  if (keys.length === 0) return state;
  const next = await settle(model, model.handleKey(state, keys[0]));
  return pressAll(model, next, keys.slice(1));
}

/** The screen as the loader leaves it, ready to be driven. */
async function screenOf(service: ReturnType<typeof fakeService>): Promise<{ readonly model: ReturnType<typeof modelFor>; readonly state: ProjectsScreenState }> {
  const data = await loadScreenData(service.client, 'o');
  return { model: modelFor(service.client), state: initialProjectsScreenState({ ...data, selfUserId: 'u_me' }) };
}

const indexCalls = (service: ReturnType<typeof fakeService>): unknown[] => service.getSecretIndex.mock.calls.map((c) => c.slice(1));

describe('the list draws from GET /projects alone', () => {
  test('a service that carries the summary: exactly one request, and no index, me, members, branches or repos read', async () => {
    const service = fakeService();
    const data = await loadScreenData(service.client, 'o');
    expect(service.listProjects).toHaveBeenCalledTimes(1);
    expect(service.getSecretIndex).toHaveBeenCalledTimes(0);
    expect(service.getOrgMe).toHaveBeenCalledTimes(0);
    expect(service.listMemberDetails).toHaveBeenCalledTimes(0);
    expect(service.listBranches).toHaveBeenCalledTimes(0);
    expect(service.getOrgRepos).toHaveBeenCalledTimes(0);
    expect(data.index).toBeNull();
    expect(data.members).toBeNull();
    expect(data.lazy?.members).toBe('unloaded');
  });

  test('VARIABLES, LAST UPDATED, the repo column and the order come from the list\'s fields', async () => {
    const { state } = await screenOf(fakeService());
    const frame = strip(render(state, 120, 20));
    expect(frame).toContain('VARIABLES');
    expect(frame).toContain('LINKED REPO');
    expect(frame).toContain('LAST UPDATED');
    expect(frame).toContain('acme/web');
    const lines = frame.split('\n');
    const line = (name: string): string => lines.find((l) => l.includes(name)) ?? '';
    expect(line('web')).toMatch(/web\s+7\s/);
    // variable_count null: the dash, as when the count is not returned.
    expect(line('api')).toMatch(/api\s+—\s/);
    // Administered projects: newest variables_updated_at first, then created_at (api: Feb). A project the caller does not administer has no time and sorts last.
    expect(line('notmine')).toMatch(/notmine\s+—\s+—/);
    const order = lines.filter((l) => /^\s*▶?\s*(web|api|notmine)\s/.test(l)).map((l) => l.replace(/[▶\s]+/, '').split(/\s+/)[0]);
    expect(order).toEqual(['web', 'api', 'notmine']);
  });

  test('an older service: the list still draws, with no VARIABLES column and created_at for LAST UPDATED; the fallback requests stay', async () => {
    const service = fakeService({ projects: OLD_PROJECTS });
    const { state } = await screenOf(service);
    expect(service.listBranches).toHaveBeenCalledTimes(2);
    expect(service.getOrgRepos).toHaveBeenCalledTimes(1);
    expect(service.getSecretIndex).toHaveBeenCalledTimes(0);
    expect(service.listMemberDetails).toHaveBeenCalledTimes(0);
    const frame = strip(render(state, 120, 20));
    expect(frame).not.toContain('VARIABLES');
    expect(frame).toContain('LAST UPDATED');
    expect(frame).toContain('NAME');
    // api (Feb) sorts above web (Jan).
    expect(frame.indexOf('api')).toBeLessThan(frame.indexOf('web'));
  });
});

describe('a project\'s index is read when its Secrets tab is shown', () => {
  test('opening a project reads its index once, for that project only; reopening reads nothing', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    // The newest project is first: web.
    const opened = await pressAll(model, state, [ENTER]);
    expect(indexCalls(service)).toEqual([[{ projectId: 'p1' }]]);
    expect(opened.open?.secrets.rows.map((r) => r.name)).toEqual(['API_KEY', 'DB_URL']);
    const reopened = await pressAll(model, opened, [ESC, ENTER]);
    expect(reopened.open?.projectId).toBe('p1');
    expect(service.getSecretIndex).toHaveBeenCalledTimes(1);
  });

  test('another project is its own read', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const second = await pressAll(model, state, [ENTER, ESC, DOWN, ENTER]);
    expect(second.open?.projectId).toBe('p2');
    expect(indexCalls(service)).toEqual([[{ projectId: 'p1' }], [{ projectId: 'p2' }]]);
  });

  test('while it loads, the tab shows one loading line, and asking again is not another read', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const loading = model.handleKey(state, ENTER);
    expect(loading.effect).toEqual({ type: 'projectIndexLoad', projectId: 'p1' });
    expect(strip(render(loading.state, 120, 24))).toContain('Loading...');
    // A key pressed while it loads asks for nothing more.
    const again = model.handleKey(loading.state, DOWN);
    expect(again.effect).toBeNull();
    expect(service.getSecretIndex).toHaveBeenCalledTimes(0);
  });

  test('Deployments reads the index too, once, when it is the first index tab shown', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    // secrets (loaded on open) → users → repos → branches → deployments: still one index read.
    const deployments = await pressAll(model, state, [ENTER, RIGHT, RIGHT, RIGHT, RIGHT]);
    expect(deployments.open?.tab).toBe('deployments');
    expect(service.getSecretIndex).toHaveBeenCalledTimes(1);
  });

  test('a response holding the whole org shows the same project rows as a filtered one', async () => {
    const filtered = fakeService({ index: () => ({ org_id: 'o', rows: WEB_ONLY_ROWS, skipped: [] }) });
    const whole = fakeService({ index: () => ({ org_id: 'o', rows: ORG_ROWS, skipped: [] }) });
    const a = await screenOf(filtered);
    const b = await screenOf(whole);
    const openedFiltered = await pressAll(a.model, a.state, [ENTER]);
    const openedWhole = await pressAll(b.model, b.state, [ENTER]);
    expect(openedWhole.open?.secrets.rows).toEqual(openedFiltered.open?.secrets.rows);
    // The "also in other projects" note is shown only when the response holds those locations.
    expect(openedFiltered.open?.secrets.scope?.otherProjects).toEqual({});
    expect(Object.values(openedWhole.open?.secrets.scope?.otherProjects ?? {})).toEqual([1]);
    expect(strip(render(openedFiltered, 140, 24))).not.toContain('other project');
    expect(strip(render(openedWhole, 140, 24))).toContain('also in 1 other project');
  });

  test('a refusal (PERMISSION_DENIED) hides the index tabs, decided by the code', async () => {
    const service = fakeService({ index: forbidden });
    const { model, state } = await screenOf(service);
    const opened = await pressAll(model, state, [ENTER]);
    const project = opened.data.projects.find((p) => p.id === 'p1');
    expect(project === undefined ? [] : visibleTabs(opened.data, project)).toEqual(['users', 'repos', 'branches', 'settings']);
    // The selected tab moved off the hidden one; the member list is read because Users is now showing.
    expect(opened.open?.tab).toBe('users');
    expect(service.listMemberDetails).toHaveBeenCalledTimes(1);
  });

  test('any other failure is shown as a failed load, and asked again when the tab is selected again', async () => {
    const broken = mock((): unknown => {
      throw new CapyError('boom', ERROR_CODES.SERVICE_ERROR, { status: 500 });
    });
    const service = fakeService({ index: broken });
    const { model, state } = await screenOf(service);
    const failed = await pressAll(model, state, [ENTER]);
    expect(failed.open?.tab).toBe('secrets');
    expect(strip(render(failed, 120, 24))).toContain('Could not load.');
    // Selecting an index tab again (Deployments is four tabs along): the read is made again.
    const again = await pressAll(model, failed, [RIGHT, RIGHT, RIGHT, RIGHT]);
    expect(again.open?.tab).toBe('deployments');
    expect(service.getSecretIndex).toHaveBeenCalledTimes(2);
    expect(strip(render(again, 120, 24))).toContain('Could not load.');
  });

  test('a project the list says the caller does not administer: no Secrets tab and no index read', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const notMine = await pressAll(model, state, [ENTER, ESC, DOWN, DOWN, ENTER]);
    expect(notMine.open?.projectId).toBe('p3');
    const project = notMine.data.projects.find((p) => p.id === 'p3');
    expect(project === undefined ? [] : visibleTabs(notMine.data, project)).not.toContain('secrets');
    expect(indexCalls(service)).toEqual([[{ projectId: 'p1' }]]);
  });

  test('an older service: the Secrets tab is shown before it loads and resolves on load; an empty project says so', async () => {
    const service = fakeService({ projects: OLD_PROJECTS, index: () => ({ org_id: 'o', rows: [], skipped: [{ project_id: 'p2', project_name: 'api', code: 'NO_KEEP_FILE' }] }) });
    const { model, state } = await screenOf(service);
    const before = model.handleKey(state, ENTER).state;
    const project = before.data.projects.find((p) => p.id === 'p2');
    expect(project === undefined ? [] : visibleTabs(before.data, project)).toContain('secrets');
    const opened = await pressAll(model, state, [ENTER]);
    expect(strip(render(opened, 120, 24))).toContain('This project has no secrets yet.');
  });
});

describe('the state updates still work on a project\'s cached index', () => {
  test('a branch removed in Capy Branches drops its rows from the cached index, so reopening shows what is left; the list count is no longer known', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const opened = await pressAll(model, state, [ENTER]);
    const working: ProjectsScreenState = { ...opened, manage: { step: 'working', project: { id: 'p1', name: 'web' }, label: 'x', back: null } };
    const afterRemoval = applyManageDone(working, { ok: true, lines: [], branches: [{ id: 'b1', name: 'development', protected: false }] });
    const reopened = await pressAll(model, { ...afterRemoval, manage: null }, [ESC, ENTER]);
    expect(reopened.open?.secrets.rows.map((r) => r.name)).toEqual(['API_KEY']);
    expect(service.getSecretIndex).toHaveBeenCalledTimes(1);
    expect(reopened.data.projects.find((p) => p.id === 'p1')?.variableCount).toBeNull();
  });

  test('a removed project leaves the list and every cached index: no row counts it as another project', async () => {
    const service = fakeService({ index: () => ({ org_id: 'o', rows: ORG_ROWS, skipped: [] }) });
    const { model, state } = await screenOf(service);
    const opened = await pressAll(model, state, [ENTER]);
    expect(Object.values(opened.open?.secrets.scope?.otherProjects ?? {})).toEqual([1]);
    const pending: ProjectsScreenState = { ...opened, open: null, dialog: { step: 'deleting', project: { id: 'p2', name: 'api' } } };
    const done = applyDeleteDone(pending, 'p2', { ok: true, lines: ['done'] });
    expect(done.data.projects.map((p) => p.id)).toEqual(['p1', 'p3']);
    const reopened = await pressAll(model, done, [ENTER]);
    expect(reopened.open?.secrets.scope?.otherProjects).toEqual({});
    expect(service.getSecretIndex).toHaveBeenCalledTimes(1);
  });
});

describe('the list\'s columns follow what the list says the caller administers', () => {
  const frameOf = async (projects: readonly unknown[]): Promise<{ readonly frame: string; readonly order: readonly string[] }> => {
    const { state } = await screenOf(fakeService({ projects }));
    const frame = strip(render(state, 120, 20));
    const order = frame.split('\n').filter((l) => /^\s*▶?\s*(web|api|notmine|other)\s/.test(l)).map((l) => l.replace(/[▶\s]+/, '').split(/\s+/)[0]);
    return { frame, order };
  };
  const plain = (id: string, name: string, created: string): unknown => ({
    id,
    name,
    organization_id: 'o',
    created_at: created,
    branches: [{ id: `${id}-b`, name: 'development', is_protected: false }],
    variable_count: null,
    variables_updated_at: null,
    index_status: null,
  });

  test('a plain member: no VARIABLES and no LAST UPDATED column, no column of dashes', async () => {
    const { frame } = await frameOf([plain('p1', 'web', '2026-01-01T00:00:00.000Z'), plain('p2', 'api', '2026-02-01T00:00:00.000Z')]);
    expect(frame).toContain('NAME');
    expect(frame).not.toContain('VARIABLES');
    expect(frame).not.toContain('LAST UPDATED');
    expect(frame).not.toContain('—');
  });

  test('a project admin: the project they do not administer shows a dash and sorts last; administered ones show their time', async () => {
    const { frame, order } = await frameOf([plain('p3', 'notmine', '2026-03-01T00:00:00.000Z'), ...SUMMARY_PROJECTS.slice(0, 2)]);
    expect(frame).toContain('VARIABLES');
    expect(frame).toContain('LAST UPDATED');
    expect(order).toEqual(['web', 'api', 'notmine']);
    const line = (name: string): string => frame.split('\n').find((l) => l.includes(name)) ?? '';
    expect(line('notmine')).toMatch(/notmine\s+—\s+—/);
    // api: administered, count null, no variables_updated_at: its creation time, not a dash.
    expect(line('api')).toMatch(/api\s+—/);
    expect(line('api').trimEnd().endsWith('—')).toBe(false);
  });

  test('an administered project with no numeric count anywhere: no VARIABLES column, the times stay', async () => {
    const { frame } = await frameOf([{ ...SUMMARY_PROJECTS[1] }]);
    expect(frame).not.toContain('VARIABLES');
    expect(frame).toContain('LAST UPDATED');
  });
});

describe('the Users tab footer', () => {
  test('shows change role and invite only once the member list is in', async () => {
    const { model, state } = await screenOf(fakeService());
    const onSecrets = await pressAll(model, state, [ENTER]);
    const loading = model.handleKey(onSecrets, RIGHT);
    const during = strip(render(loading.state, 140, 24));
    expect(during).toContain('Loading...');
    expect(during).toContain('switch tab');
    expect(during).not.toContain('change role');
    expect(during).not.toContain('invite');
    const loaded = strip(render(await settle(model, loading), 140, 24));
    expect(loaded).toContain('change role');
    expect(loaded).toContain('invite');
  });
});

describe('the member list is read when the Users tab needs it', () => {
  test('not on the list, not on the Secrets tab; once on the Users tab; never again', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const onSecrets = await pressAll(model, state, [ENTER]);
    expect(service.listMemberDetails).toHaveBeenCalledTimes(0);
    const users = await pressAll(model, onSecrets, [RIGHT]);
    expect(users.open?.tab).toBe('users');
    expect(service.listMemberDetails).toHaveBeenCalledTimes(1);
    expect(strip(render(users, 120, 24))).toContain('dev@x.co');
    // Away and back, and into another project's Users tab: still one read.
    const again = await pressAll(model, users, [RIGHT, ESC, DOWN, ENTER, RIGHT]);
    expect(again.open?.projectId).toBe('p2');
    expect(service.listMemberDetails).toHaveBeenCalledTimes(1);
  });

  test('while it loads the tab shows one loading line', async () => {
    const service = fakeService();
    const { model, state } = await screenOf(service);
    const onSecrets = await pressAll(model, state, [ENTER]);
    const loading = model.handleKey(onSecrets, RIGHT);
    expect(loading.effect).toEqual({ type: 'projectMembersLoad' });
    expect(strip(render(loading.state, 120, 24))).toContain('Loading...');
  });

  test('a refusal hides the Users tab', async () => {
    const service = fakeService({ members: forbidden });
    const { model, state } = await screenOf(service);
    const users = await pressAll(model, state, [ENTER, RIGHT]);
    const project = users.data.projects.find((p) => p.id === 'p1');
    expect(project === undefined ? [] : visibleTabs(users.data, project)).not.toContain('users');
    expect(users.open?.tab).not.toBe('users');
  });
});

describe('the dialog reads the members itself when the Users tab was never shown', () => {
  const dataWith = (members: 'unloaded' | 'loaded'): ProjectsData => ({
    projects: [{ id: 'p1', name: 'web', createdAt: null, branches: [{ id: 'b2', name: 'production', protected: true }], repos: [], variableCount: 1 }],
    index: null,
    members: null,
    reposShown: true,
    lazy: { indexes: { p1: { status: 'loaded', index: { rows: [], skipped: [], coveredProjectIds: ['p1'] } } }, members, adminProjectIds: null },
  });
  test('Manage access on a protected branch asks for the member list when it is not in', () => {
    const model = projectsModel({ preview: async () => ({ ok: true, lines: [] }), run: async () => ({ ok: true, lines: [] }) });
    const open = model.handleKey(initialProjectsScreenState(dataWith('unloaded')), ENTER).state;
    // Put the open project on its branches tab directly: this test is about the dialog.
    const view = open.open;
    expect(view).not.toBeNull();
    const onBranches: ProjectsScreenState = view === null ? open : { ...open, open: { ...view, tab: 'branches' } };
    const menu = model.handleKey(onBranches, ENTER).state;
    const choose = model.handleKey(menu, DOWN).state;
    const access = model.handleKey(choose, ENTER);
    expect(access.state.manage?.step).toBe('access');
    expect(access.effect).toEqual({ type: 'projectMembersLoad' });
    expect(strip(render(access.state, 120, 24))).toContain('Loading...');
  });

  test('a refused member list leaves the dialog\'s empty list, not the loading line', () => {
    const model = projectsModel({ preview: async () => ({ ok: true, lines: [] }), run: async () => ({ ok: true, lines: [] }) });
    const open = model.handleKey(initialProjectsScreenState(dataWith('unloaded')), ENTER).state;
    const view = open.open;
    const onBranches: ProjectsScreenState = view === null ? open : { ...open, open: { ...view, tab: 'branches' } };
    const menu = model.handleKey(onBranches, ENTER).state;
    const access = model.handleKey(model.handleKey(menu, DOWN).state, ENTER);
    expect(access.effect).toEqual({ type: 'projectMembersLoad' });
    const refused = applyMembersLoaded(access.state, { ok: false, denied: true });
    expect(refused.effect).toBeNull();
    expect(refused.state.manage?.step).toBe('access');
    const frame = strip(render(refused.state, 120, 24));
    expect(frame).not.toContain('Loading...');
    expect(frame).not.toContain('Could not load.');
    expect(frame).toContain('No members in this project.');
  });

  test('nothing is asked when they are already in', () => {
    const model = projectsModel({ preview: async () => ({ ok: true, lines: [] }), run: async () => ({ ok: true, lines: [] }) });
    const open = model.handleKey(initialProjectsScreenState(dataWith('loaded')), ENTER).state;
    const view = open.open;
    const onBranches: ProjectsScreenState = view === null ? open : { ...open, open: { ...view, tab: 'branches' } };
    const menu = model.handleKey(onBranches, ENTER).state;
    const access = model.handleKey(model.handleKey(menu, DOWN).state, ENTER);
    expect(access.state.manage?.step).toBe('access');
    expect(access.effect).toBeNull();
  });
});

describe('the load actions', () => {
  test('the index is asked for with the project filter; a refusal is `denied`, any other failure is not', async () => {
    const ok = fakeService();
    expect(await createProjectsLoadActions(ok.client, 'o').loadIndex('p1')).toEqual({ ok: true, rows: WEB_ONLY_ROWS, skipped: [] });
    expect(ok.getSecretIndex).toHaveBeenCalledWith('o', { projectId: 'p1' });
    expect(await createProjectsLoadActions(fakeService({ index: forbidden }).client, 'o').loadIndex('p1')).toEqual({ ok: false, denied: true });
    const broken = (): never => {
      throw new CapyError('boom', ERROR_CODES.SERVICE_ERROR, { status: 500 });
    };
    expect(await createProjectsLoadActions(fakeService({ index: broken }).client, 'o').loadIndex('p1')).toEqual({ ok: false, denied: false });
  });

  test('a PERMISSION_DENIED-looking message with another code is not a refusal', async () => {
    const lookalike = (): never => {
      throw new CapyError('PERMISSION_DENIED', ERROR_CODES.SERVICE_ERROR, { status: 500 });
    };
    expect(await createProjectsLoadActions(fakeService({ members: lookalike }).client, 'o').loadMembers()).toEqual({ ok: false, denied: false });
  });
});
