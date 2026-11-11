import { describe, expect, test } from 'bun:test';
import type { SecretIndexLocation, SecretIndexRow } from '../../src/service/serviceClient';
import {
  type ProjectItem,
  type ProjectsData,
  type ProjectsScreenState,
  filteredProjects,
  handleKey,
  initialProjectsScreenState,
  lastUpdatedOf,
  otherProjectCounts,
  projectIndexState,
  projectRows,
  render,
  variableCount,
} from '../../src/ui/projectsScreen';
import { filteredRows, scopeRowKey } from '../../src/ui/secretsScreen';

const ESC = '\x1b';
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
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

const project = (over: Partial<ProjectItem> = {}): ProjectItem => ({
  id: 'p1',
  name: 'web',
  createdAt: '2026-01-01T00:00:00.000Z',
  branches: [{ name: 'development', protected: false }],
  repos: [],
  ...over,
});

const ROWS: readonly SecretIndexRow[] = [
  row('API_KEY', [loc({ changed_at: '2026-03-01T00:00:00.000Z' }), loc({ project_id: 'p2', project_name: 'api' }), loc({ project_id: 'p3', project_name: 'web' })]),
  row('DB_URL', [loc({ branch: 'production', changed_at: '2026-05-01T00:00:00.000Z' })]),
  row('DB_URL', [loc({ branch: 'development' })], 'h-other'),
  row('ONLY_API', [loc({ project_id: 'p2', project_name: 'api' })]),
];

const data = (over: Partial<ProjectsData> = {}): ProjectsData => ({
  projects: [
    project(),
    project({ id: 'p2', name: 'api', repos: [{ host: 'github.com', owner: 'acme', name: 'api', path: '.', github_repo_id: 1 }] }),
    project({ id: 'p3', name: 'web', createdAt: null }),
    project({ id: 'p4', name: 'empty', createdAt: '2026-02-02T00:00:00.000Z' }),
  ],
  index: { rows: ROWS, skipped: [], coveredProjectIds: ['p1', 'p2', 'p3', 'p4'] },
  members: [],
  reposShown: true,
  ...over,
});

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);
const type = (state: ProjectsScreenState, text: string): ProjectsScreenState => press(state, ...Array.from(text));

describe('project data from the secrets index', () => {
  test('a project id filter keeps only that project\'s locations, and drops rows with none there', () => {
    const rows = projectRows(ROWS, 'p1');
    expect(rows.map((r) => r.name)).toEqual(['API_KEY', 'DB_URL', 'DB_URL']);
    expect(rows.every((r) => r.locations.every((l) => l.project_id === 'p1'))).toBe(true);
    // Same NAME, other project id: never mixed in.
    expect(projectRows(ROWS, 'p3').map((r) => r.name)).toEqual(['API_KEY']);
  });

  test('"also in N other projects" counts distinct OTHER project ids, same-named projects included', () => {
    const counts = otherProjectCounts(ROWS, 'p1');
    expect(counts[scopeRowKey(ROWS[0])]).toBe(2);
    expect(counts[scopeRowKey(ROWS[1])]).toBeUndefined();
    expect(otherProjectCounts(ROWS, 'p2')[scopeRowKey(ROWS[0])]).toBe(2);
    expect(otherProjectCounts(ROWS, 'p2')[scopeRowKey(ROWS[3])]).toBeUndefined();
  });

  test('variables count distinct names; null when the index was not returned for the project', () => {
    const d = data();
    expect(variableCount(d.index, 'p1')).toBe(2);
    expect(variableCount(d.index, 'p4')).toBe(0);
    expect(variableCount(null, 'p1')).toBeNull();
    expect(variableCount({ ...d.index!, skipped: [{ project_id: 'p1', project_name: 'web', code: 'KEEP_UNREADABLE' }] }, 'p1')).toBeNull();
  });

  test('last updated is the latest changed_at, falling back to the creation time, else unknown', () => {
    const d = data();
    expect(lastUpdatedOf(d.index, d.projects[0])).toBe('2026-05-01T00:00:00.000Z');
    // No changed_at on any location: the project's creation time.
    expect(lastUpdatedOf(d.index, d.projects[1])).toBe('2026-01-01T00:00:00.000Z');
    expect(lastUpdatedOf(d.index, d.projects[2])).toBeNull();
    // No secrets yet: creation time.
    expect(lastUpdatedOf(d.index, d.projects[3])).toBe('2026-02-02T00:00:00.000Z');
    // Not returned: unknown.
    expect(lastUpdatedOf(null, d.projects[0])).toBeNull();
  });

  test('index state: rows, empty (covered, nothing pushed), hidden (no index, skipped, or not covered)', () => {
    const d = data();
    expect(projectIndexState(d.index, 'p1')).toBe('rows');
    expect(projectIndexState(d.index, 'p4')).toBe('empty');
    expect(projectIndexState(null, 'p1')).toBe('hidden');
    expect(projectIndexState({ ...d.index!, coveredProjectIds: ['p1'] }, 'p4')).toBe('hidden');
    // Coverage unknown: only a project with rows counts.
    expect(projectIndexState({ ...d.index!, coveredProjectIds: null }, 'p4')).toBe('hidden');
    expect(projectIndexState({ ...d.index!, coveredProjectIds: null }, 'p1')).toBe('rows');
    expect(projectIndexState({ ...d.index!, skipped: [{ project_id: 'p1', project_name: 'web', code: 'X' }] }, 'p1')).toBe('hidden');
  });
});

describe('project list', () => {
  test('type to filter by project name; Esc clears the search, then quits', () => {
    const s = type(initialProjectsScreenState(data()), 'API');
    expect(filteredProjects(s).map((p) => p.id)).toEqual(['p2']);
    const cleared = press(s, ESC);
    expect(cleared.query).toBe('');
    expect(cleared.quit).toBe(false);
    expect(press(cleared, ESC).quit).toBe(true);
  });

  test('every column the service returned is shown', () => {
    const frame = strip(render(initialProjectsScreenState(data()), 120, 20));
    expect(frame).toContain('NAME');
    expect(frame).toContain('VARIABLES');
    expect(frame).toContain('LINKED REPO');
    expect(frame).toContain('LAST UPDATED');
    expect(frame).toContain('acme/api');
  });

  test('a member (index 403, repo links 403) sees the Name column only', () => {
    const frame = strip(render(initialProjectsScreenState(data({ index: null, reposShown: false })), 120, 20));
    expect(frame).toContain('NAME');
    expect(frame).not.toContain('VARIABLES');
    expect(frame).not.toContain('LINKED REPO');
    expect(frame).not.toContain('LAST UPDATED');
  });

  test('no line is wider than the terminal', () => {
    const frame = render(initialProjectsScreenState(data()), 50, 20);
    expect(strip(frame).split('\n').every((l) => Array.from(l).length <= 50)).toBe(true);
  });

  test('Enter opens the project under the cursor', () => {
    const s = press(initialProjectsScreenState(data()), DOWN, '\r');
    expect(s.open?.projectId).toBe('p2');
  });
});

describe('inside a project: the embedded secrets screen', () => {
  const opened = (): ProjectsScreenState => press(initialProjectsScreenState(data()), '\r');

  test('shows only this project\'s rows, titled with the project name, with the shared-value note', () => {
    const s = opened();
    expect(s.open?.secrets.rows.map((r) => r.name)).toEqual(['API_KEY', 'DB_URL', 'DB_URL']);
    const frame = strip(render(s, 140, 24));
    expect(frame).toContain('web (3 secrets)');
    expect(frame).toContain('also in 2 other projects');
    expect(frame).not.toContain('capy secrets');
  });

  test('typing searches the project\'s secrets; Esc clears it, then goes back to the list', () => {
    const s = type(opened(), 'DB');
    expect(filteredRows(s.open!.secrets).map((r) => r.name)).toEqual(['DB_URL', 'DB_URL']);
    const cleared = press(s, ESC);
    expect(cleared.open?.secrets.search.query).toBe('');
    const back = press(cleared, ESC);
    expect(back.open).toBeNull();
    expect(back.quit).toBe(false);
  });

  test('←/→ move the secrets list\'s column (Tab is the project screen\'s)', () => {
    const s = press(opened(), RIGHT);
    expect(s.open?.secrets.column).toBe('branch');
  });

  test('Enter opens the row\'s details and asks for its value, exactly as capy secrets does', () => {
    const result = handleKey(opened(), '\r');
    expect(result.effect).toMatchObject({ type: 'fetchValue' });
    expect(result.state.open?.secrets.popup).not.toBeNull();
    // Esc closes the details, and stays in the project.
    const closed = press(result.state, ESC);
    expect(closed.open?.secrets.popup).toBeNull();
    expect(closed.open).not.toBeNull();
  });

  test('Ctrl+E starts the shared edit flow on this project\'s row', () => {
    const result = handleKey(opened(), '\x05');
    expect(result.state.open?.secrets.edit).not.toBeNull();
    expect(result.effect).toMatchObject({ type: 'fetchValue' });
  });

  test('Ctrl-C quits from inside a project', () => {
    expect(press(opened(), '\x03').quit).toBe(true);
  });
});

describe('inside a project: tabs', () => {
  const TAB = '\t';
  const SHIFT_TAB = `${ESC}[Z`;
  const members = [
    { membershipId: 'm1', userId: 'u1', email: 'owner@acme.dev', role: 'owner', status: 'active', createdAt: 'x', projects: [] },
    { membershipId: 'm2', userId: 'u2', email: 'pa@acme.dev', role: 'project-admin', status: 'active', createdAt: 'x', projects: [{ id: 'p1', name: 'web', role: 'project-admin' as const, branches: [] }] },
    { membershipId: 'm3', userId: 'u3', email: 'other@acme.dev', role: 'member', status: 'active', createdAt: 'x', projects: [{ id: 'p2', name: 'api', role: 'member' as const, branches: [] }] },
  ];
  const withTargets: readonly SecretIndexRow[] = [
    row('API_KEY', [
      loc({ branch: 'production', targets: [{ provider: 'vercel', target: 'web-app', deployed_at: '2026-04-01T00:00:00.000Z', stale: false }], connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'web-svc' } }),
      loc({ branch: 'development', service: { provider: 'dokploy' } }),
    ]),
    row('DB_URL', [loc({ branch: 'production', targets: [{ provider: 'vercel', target: 'web-app', deployed_at: '2026-03-01T00:00:00.000Z', stale: true, pending: true }] })]),
  ];
  const full = (): ProjectsData => data({ members, index: { rows: withTargets, skipped: [], coveredProjectIds: ['p1', 'p2', 'p3', 'p4'] } });
  const openFirst = (d: ProjectsData): ProjectsScreenState => press(initialProjectsScreenState(d), '\r');
  const tabs = (n: number): readonly string[] => Array.from({ length: n }, () => TAB);

  test('Secrets is selected when a project opens; Tab walks every tab in order and wraps, Shift-Tab goes back', () => {
    const s0 = openFirst(full());
    expect(s0.open?.tab).toBe('secrets');
    const order = [1, 2, 3, 4, 5, 6].map((n) => press(s0, ...tabs(n)).open?.tab);
    expect(order).toEqual(['users', 'repos', 'branches', 'deployments', 'connectors', 'secrets']);
    expect(press(s0, SHIFT_TAB).open?.tab).toBe('connectors');
  });

  test('the tab bar names every tab, and Esc on any tab goes back to the list', () => {
    const s = press(openFirst(full()), TAB);
    const frame = strip(render(s, 140, 24));
    ['Secrets', 'Users', 'Git repos', 'Capy branches', 'Deployments', 'Connectors'].forEach((label) => expect(frame).toContain(label));
    expect(press(s, ESC).open).toBeNull();
  });

  test('a member: tabs whose data the service did not return are hidden, not shown empty', () => {
    const member = data({ index: null, reposShown: false, members, projects: [project({ repos: undefined })] });
    const s = openFirst(member);
    expect(s.open?.tab).toBe('users');
    expect([s, press(s, TAB), press(s, TAB, TAB)].map((x) => x.open?.tab)).toEqual(['users', 'branches', 'users']);
    const frame = strip(render(s, 140, 24));
    expect(frame).not.toContain('Secrets');
    expect(frame).not.toContain('Git repos');
    expect(frame).not.toContain('Deployments');
    expect(frame).not.toContain('Connectors');
  });

  test('without the member list, the Users tab is hidden', () => {
    const s = openFirst(data({ members: null }));
    expect(press(s, TAB).open?.tab).toBe('repos');
  });

  test('Users: the project\'s members with their project role, plus org owners and admins', () => {
    const s = press(openFirst(full()), TAB);
    const frame = strip(render(s, 140, 24));
    expect(frame).toContain('owner@acme.dev');
    expect(frame).toMatch(/pa@acme\.dev\s+project-admin/);
    expect(frame).not.toContain('other@acme.dev');
  });

  test('Capy branches and Git repos come from GET /projects', () => {
    const d = data({ projects: [project({ branches: [{ name: 'production', protected: true }], repos: [{ host: 'github.com', owner: 'acme', name: 'web', path: 'apps/web', github_repo_id: 3 }] })] });
    const s = openFirst(d);
    expect(strip(render(press(s, TAB, TAB), 120, 20))).toContain('acme/web/apps/web');
    expect(strip(render(press(s, TAB, TAB, TAB), 120, 20))).toContain('production (protected)');
  });

  test('Deployments: one line per target and branch, latest delivery, behind and pending as capy secrets says them', () => {
    const s = press(openFirst(full()), ...tabs(4));
    expect(s.open?.tab).toBe('deployments');
    const frame = strip(render(s, 140, 24));
    const target = frame.split('\n').filter((l) => l.includes('[vercel] web-app'));
    expect(target).toHaveLength(1);
    expect(target[0]).toContain('production');
    expect(target[0]).toContain('needs deploy (pending)');
    expect(frame).not.toMatch(/token/i);
  });

  test('Connectors: per variable and branch, connector.provider first, service.provider as the fallback', () => {
    const s = press(openFirst(full()), SHIFT_TAB);
    expect(s.open?.tab).toBe('connectors');
    const frame = strip(render(s, 140, 24));
    expect(frame).toMatch(/API_KEY\s+production\s+\[dokploy\] web-svc/);
    expect(frame).toMatch(/API_KEY\s+development\s+\[dokploy\]/);
    expect(frame).not.toContain('DB_URL');
  });

  test('a project with no secrets yet: the Secrets tab says so and how to fix it', () => {
    const s = press(initialProjectsScreenState(data()), DOWN, DOWN, DOWN, '\r');
    expect(s.open?.projectId).toBe('p4');
    expect(s.open?.tab).toBe('secrets');
    const frame = strip(render(s, 120, 20));
    expect(frame).toContain('This project has no secrets yet.');
    expect(frame).toContain('capy push');
    // Typing does nothing there; Tab still moves on.
    expect(type(s, 'abc').open?.secrets.search.query).toBe('');
    expect(press(s, TAB).open?.tab).toBe('users');
  });

  test('while the secrets details are open, Tab is theirs (it cycles their column), not the project\'s', () => {
    const s = press(openFirst(full()), '\r', TAB);
    expect(s.open?.tab).toBe('secrets');
    expect(s.open?.secrets.popup?.locationColumn).toBe('connector');
  });

  test('the secrets search survives a trip to another tab', () => {
    const s = press(type(openFirst(full()), 'DB'), TAB, SHIFT_TAB);
    expect(s.open?.tab).toBe('secrets');
    expect(s.open?.secrets.search.query).toBe('DB');
  });

  test('Ctrl+X inside a project (on any tab) opens the delete question for that project', () => {
    const fromSecrets = handleKey(openFirst(full()), '\x18');
    expect(fromSecrets.effect).toEqual({ type: 'projectDeletePreview', project: { id: 'p1', name: 'web' } });
    const fromBranches = handleKey(press(openFirst(full()), ...tabs(3)), '\x18');
    expect(fromBranches.state.dialog).toEqual({ step: 'loading', project: { id: 'p1', name: 'web' } });
    // While the edit dialog is open, Ctrl+X is the edit dialog's key, not a delete.
    const editing = press(openFirst(full()), '\x05');
    expect(handleKey(editing, '\x18').state.dialog).toBeNull();
  });

  test('no line of any tab is wider than the terminal', () => {
    const s0 = openFirst(full());
    const frames = [0, 1, 2, 3, 4, 5].map((n) => render(press(s0, ...tabs(n)), 50, 16));
    expect(frames.every((f) => strip(f).split('\n').every((l) => Array.from(l).length <= 50))).toBe(true);
  });
});
