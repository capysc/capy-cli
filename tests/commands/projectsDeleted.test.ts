import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';

/**
 * `capy projects --deleted`: the listing includes deleted
 * projects, each marked deleted with its date; a plain listing is unchanged.
 *
 * Org resolution and the spinner are replaced; `projectsCommand` and the
 * `_system` filter run for real. `mock.module()` is process-wide, so
 * tests/run-tests.sh runs this file isolated.
 */

interface FakeProject {
  id: string;
  name: string;
  organization_id: string;
  deleted_at?: string | null;
}

const listProjectsImpl = mock(async (_options?: { includeDeleted?: boolean }): Promise<FakeProject[]> => []);
const listBranchesImpl = mock(async (_projectId: string) => [{ id: 'b1', name: 'development', project_id: 'x', is_protected: false }]);

const fakeServiceClient = {
  listProjects: (options?: { includeDeleted?: boolean }) => listProjectsImpl(options),
  listBranches: (projectId: string) => listBranchesImpl(projectId),
  getOrgRepos: async () => {
    throw new Error('not readable');
  },
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
    userEmail: 'owner@example.com',
    authService: {},
    serviceClient: fakeServiceClient,
  })),
}));

afterAll(() => mock.restore());

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

const LIVE: FakeProject = { id: 'proj_web', name: 'web', organization_id: 'org_1', deleted_at: null };
const GONE: FakeProject = { id: 'proj_old', name: 'old', organization_id: 'org_1', deleted_at: '2026-11-05T12:30:00.000Z' };

// After the mocks above.
const { ProjectsCommand } = await import('../../src/commands/projectsCommand');

describe('ProjectsCommand --deleted', () => {
  beforeEach(() => {
    listProjectsImpl.mockReset();
    listBranchesImpl.mockClear();
  });

  it('asks the service for deleted projects too', async () => {
    listProjectsImpl.mockImplementation(async () => [LIVE, GONE]);

    await capture(() => new ProjectsCommand().execute({ deleted: true }));

    expect(listProjectsImpl.mock.calls[0]).toEqual([{ includeDeleted: true }]);
  });

  it('a plain listing asks exactly as it always did (no option)', async () => {
    listProjectsImpl.mockImplementation(async () => [LIVE]);

    await capture(() => new ProjectsCommand().execute({}));

    expect(listProjectsImpl.mock.calls[0][0]).toBeUndefined();
  });

  it('human output: the deleted project is marked deleted with its date; the live one shows its branches', async () => {
    listProjectsImpl.mockImplementation(async () => [LIVE, GONE]);

    const out = await capture(() => new ProjectsCommand().execute({ deleted: true }));

    const lines = out.stdout.split('\n');
    const oldLine = lines.find((l) => l.includes('old')) ?? '';
    const webLine = lines.find((l) => l.includes('web')) ?? '';
    expect(oldLine).toContain('deleted 2026-11-05');
    expect(webLine).toContain('development');
    expect(webLine).not.toContain('deleted');
  });

  it('does not ask for the branches of a deleted project (the service answers 410 for them)', async () => {
    listProjectsImpl.mockImplementation(async () => [LIVE, GONE]);

    await capture(() => new ProjectsCommand().execute({ deleted: true }));

    expect(listBranchesImpl.mock.calls.map((c) => c[0])).toEqual(['proj_web']);
  });

  it('--json: every project carries deleted_at (null when live) and a deleted one has no branches', async () => {
    listProjectsImpl.mockImplementation(async () => [LIVE, GONE]);

    const out = await capture(() => new ProjectsCommand().execute({ deleted: true, json: true }));

    const parsed = JSON.parse(out.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.projects).toEqual([
      { id: 'proj_web', name: 'web', branches: [{ id: 'b1', name: 'development', protected: false }], deleted_at: null },
      { id: 'proj_old', name: 'old', branches: [], deleted_at: '2026-11-05T12:30:00.000Z' },
    ]);
  });

  it('a plain --json listing has no deleted_at field', async () => {
    listProjectsImpl.mockImplementation(async () => [{ id: 'proj_web', name: 'web', organization_id: 'org_1' }]);

    const out = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(JSON.parse(out.stdout).projects[0]).not.toHaveProperty('deleted_at');
  });
});
