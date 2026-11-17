import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/**
 * `capy projects` against a service that answers the whole listing in ONE
 * response (branches, repos and a variable summary inside `GET /projects`):
 * no per-project branch request and no repo request are sent. Against a
 * service that sends none of those fields the command still sends exactly the
 * requests it always did (tests/commands/projectsCommand.test.ts covers that).
 *
 * Org resolution and the spinner are replaced; `projectsCommand` and the
 * `_system` filter run for real. `mock.module()` is process-wide, so
 * tests/run-tests.sh runs this file isolated.
 */

interface FakeListedProject {
  id: string;
  name: string;
  organization_id: string;
  deleted_at?: string | null;
  branches?: Array<{ id: string; name: string; is_protected: boolean }>;
  repos?: Array<{ host: string; owner: string; name: string; path: string; github_repo_id: number | null }>;
  variable_count?: number | null;
  variables_updated_at?: string | null;
  index_status?: string | null;
}

const listProjectsImpl = mock(async (_options?: { includeDeleted?: boolean }): Promise<FakeListedProject[]> => []);
const listBranchesImpl = mock(async (_projectId: string) => [{ id: 'old-b', name: 'old-style', project_id: 'x', is_protected: false }]);
const getOrgReposImpl = mock(async (_orgId: string): Promise<{ org_id: string; repos: unknown[] }> => ({ org_id: 'org_1', repos: [] }));

const fakeServiceClient = {
  listProjects: (options?: { includeDeleted?: boolean }) => listProjectsImpl(options),
  listBranches: (projectId: string) => listBranchesImpl(projectId),
  getOrgRepos: (orgId: string) => getOrgReposImpl(orgId),
};

mock.module('../../src/ui/spinner', () => ({
  Spinner: class {
    start() {
      return this;
    }
    succeed() {}
    fail() {}
    stop() {}
  },
}));

mock.module('../../src/core/orgContext', () => ({
  resolveOrgContext: mock(async () => ({
    orgId: 'org_1',
    userId: 'user_1',
    userEmail: 'a@example.com',
    authService: {},
    serviceClient: fakeServiceClient,
  })),
}));

afterAll(() => mock.restore());

// Imported after the module mocks above are registered, so the command sees the fakes.
const { ProjectsCommand } = await import('../../src/commands/projectsCommand');

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);
  const stdout = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  const exitCalls = exitSpy.mock.calls;
  const exitCode = exitCalls.length > 0 ? (exitCalls[exitCalls.length - 1][0] as number | undefined) : undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode, stdout, stderr };
}

const NEWEST = '2026-11-10T08:30:00.000Z';

const webProject: FakeListedProject = {
  id: 'p1',
  name: 'web',
  organization_id: 'org_1',
  branches: [
    { id: 'b1', name: 'development', is_protected: false },
    { id: 'b2', name: 'production', is_protected: true },
  ],
  repos: [{ host: 'github.com', owner: 'Acme', name: 'mono', path: 'services/web', github_repo_id: 123 }],
  variable_count: 7,
  variables_updated_at: NEWEST,
  index_status: 'INDEXED',
};

const apiProject: FakeListedProject = {
  id: 'p2',
  name: 'api',
  organization_id: 'org_1',
  branches: [{ id: 'b3', name: 'main', is_protected: false }],
  repos: [],
  variable_count: 1,
  variables_updated_at: null,
  index_status: 'INDEXED',
};

describe('ProjectsCommand with a service that lists everything in one response', () => {
  beforeEach(() => {
    listProjectsImpl.mockReset();
    listBranchesImpl.mockReset();
    getOrgReposImpl.mockReset();
    listProjectsImpl.mockImplementation(async () => [webProject, apiProject]);
    listBranchesImpl.mockImplementation(async () => [{ id: 'old-b', name: 'old-style', project_id: 'x', is_protected: false }]);
    getOrgReposImpl.mockImplementation(async () => ({ org_id: 'org_1', repos: [] }));
  });

  it('sends one project request: no branch request per project and no repo request', async () => {
    const { exitCode } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(exitCode).toBeUndefined();
    expect(listProjectsImpl).toHaveBeenCalledTimes(1);
    expect(listBranchesImpl).not.toHaveBeenCalled();
    expect(getOrgReposImpl).not.toHaveBeenCalled();
  });

  it('--json keeps the current shape and adds the count, the updated time and the index status', async () => {
    const { stdout, stderr } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      projects: [
        {
          id: 'p1',
          name: 'web',
          branches: [
            { id: 'b1', name: 'development', protected: false },
            { id: 'b2', name: 'production', protected: true },
          ],
          repos: [{ host: 'github.com', owner: 'Acme', name: 'mono', path: 'services/web', github_repo_id: 123 }],
          variable_count: 7,
          variables_updated_at: NEWEST,
          index_status: 'INDEXED',
        },
        {
          id: 'p2',
          name: 'api',
          branches: [{ id: 'b3', name: 'main', protected: false }],
          repos: [],
          variable_count: 1,
          variables_updated_at: null,
          index_status: 'INDEXED',
        },
      ],
    });
  });

  it('human output shows branches, protected marks, repos and the count', async () => {
    const { stdout } = await capture(() => new ProjectsCommand().execute({}));

    const lines = stdout.split('\n');
    const web = lines.find((l) => l.includes('web')) ?? '';
    expect(web).toContain('development, production');
    expect(web).toContain('(protected)');
    expect(web).toContain('Acme/mono/services/web');
    expect(web).toContain('7 variables');
    expect(lines.find((l) => l.includes('api'))).toContain('1 variable');
    expect(lines.find((l) => l.includes('api'))).not.toContain('1 variables');
  });

  it('an unknown count (null) is passed through as null in --json and is not printed as 0', async () => {
    listProjectsImpl.mockImplementation(async () => [
      { id: 'p1', name: 'web', organization_id: 'org_1', branches: [], variable_count: null, variables_updated_at: null, index_status: 'STALE' },
    ]);

    const asJson = await capture(() => new ProjectsCommand().execute({ json: true }));
    expect(JSON.parse(asJson.stdout).projects[0]).toEqual({
      id: 'p1',
      name: 'web',
      branches: [],
      variable_count: null,
      variables_updated_at: null,
      index_status: 'STALE',
    });

    const human = await capture(() => new ProjectsCommand().execute({}));
    expect(human.stdout).not.toContain('variable');
    expect(human.stdout).not.toMatch(/\b0\b/);
  });

  it('a caller who may not read repos (no `repos` anywhere) gets their projects and sends no repo request', async () => {
    listProjectsImpl.mockImplementation(async () => [
      { id: 'p1', name: 'web', organization_id: 'org_1', branches: [{ id: 'b1', name: 'main', is_protected: false }], variable_count: null, variables_updated_at: null, index_status: null },
    ]);

    const { stdout, stderr, exitCode } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe('');
    expect(getOrgReposImpl).not.toHaveBeenCalled();
    expect(listBranchesImpl).not.toHaveBeenCalled();
    const [only] = JSON.parse(stdout).projects;
    expect(only.repos).toBeUndefined();
    expect(only.branches).toEqual([{ id: 'b1', name: 'main', protected: false }]);
  });

  it('--deleted: a deleted project comes with its empty branches and no branch request', async () => {
    listProjectsImpl.mockImplementation(async () => [
      { ...webProject, deleted_at: null },
      { id: 'p9', name: 'old', organization_id: 'org_1', deleted_at: '2026-11-05T12:30:00.000Z', branches: [], repos: [], variable_count: null, variables_updated_at: null, index_status: null },
    ]);

    const { stdout } = await capture(() => new ProjectsCommand().execute({ json: true, deleted: true }));

    expect(listProjectsImpl).toHaveBeenCalledWith({ includeDeleted: true });
    expect(listBranchesImpl).not.toHaveBeenCalled();
    expect(getOrgReposImpl).not.toHaveBeenCalled();
    const [live, gone] = JSON.parse(stdout).projects;
    expect(live.deleted_at).toBeNull();
    expect(live.branches).toHaveLength(2);
    expect(gone).toEqual({
      id: 'p9',
      name: 'old',
      branches: [],
      deleted_at: '2026-11-05T12:30:00.000Z',
      repos: [],
      variable_count: null,
      variables_updated_at: null,
      index_status: null,
    });
  });

  it('hides the reserved _system project even if the service returns it', async () => {
    listProjectsImpl.mockImplementation(async () => [webProject, { id: 'sys', name: '_system', organization_id: 'org_1', branches: [], repos: [] }]);

    const { stdout } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(JSON.parse(stdout).projects.map((p: { name: string }) => p.name)).toEqual(['web']);
  });

  it('a service failure is still a coded error', async () => {
    listProjectsImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stdout, exitCode } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ ok: false, code: ERROR_CODES.SERVICE_ERROR, error: 'Service unavailable' });
  });
});

describe('ProjectsCommand with a service that sends none of the new fields', () => {
  beforeEach(() => {
    listProjectsImpl.mockReset();
    listBranchesImpl.mockReset();
    getOrgReposImpl.mockReset();
  });

  it('still sends one branch request per project and one repo request, and prints no summary', async () => {
    listProjectsImpl.mockImplementation(async () => [
      { id: 'p1', name: 'web', organization_id: 'org_1' },
      { id: 'p2', name: 'api', organization_id: 'org_1' },
    ]);
    listBranchesImpl.mockImplementation(async () => [{ id: 'b1', name: 'main', project_id: 'x', is_protected: false }]);
    getOrgReposImpl.mockImplementation(async () => ({ org_id: 'org_1', repos: [] }));

    const { stdout } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(listBranchesImpl).toHaveBeenCalledTimes(2);
    expect(getOrgReposImpl).toHaveBeenCalledTimes(1);
    const [first] = JSON.parse(stdout).projects;
    expect(Object.keys(first).toSorted()).toEqual(['branches', 'id', 'name', 'repos']);
  });
});
