import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/**
 * `capy projects` — CLI-layer wiring only. Covers: human output (one line per
 * project, branches joined, protected ones marked), `--json` shape
 * (`{ok:true, projects:[...]}`), the reserved `_system` project staying
 * hidden even when the (fake) service returns it, an empty org rendering a
 * message instead of a table, and a service failure surfacing as a coded
 * error rather than a crash.
 *
 * `resolveOrgContext` (auth + org resolution) and the spinner are mocked —
 * neither is this file's concern. `excludeSystemProject` runs UNMOCKED (the
 * real module) so the `_system` case exercises the actual filter, not a
 * stand-in for it.
 */

interface FakeProject {
  id: string;
  name: string;
  organization_id: string;
}
interface FakeBranch {
  id: string;
  name: string;
  project_id: string;
  is_protected: boolean;
}

const listProjectsImpl = mock(async (): Promise<FakeProject[]> => []);
const listBranchesImpl = mock(async (_projectId: string): Promise<FakeBranch[]> => []);

// CAP-697: the org's repo links. Unless a test says otherwise the caller may not read them (a plain member's 403).
const getOrgReposImpl = mock(async (_orgId: string): Promise<{ org_id: string; repos: unknown[] }> => {
  throw new CapyError('forbidden', ERROR_CODES.PERMISSION_DENIED);
});

const fakeServiceClient = {
  listProjects: (...args: unknown[]) => listProjectsImpl(...(args as [])),
  listBranches: (...args: [string]) => listBranchesImpl(...args),
  getOrgRepos: (...args: [string]) => getOrgReposImpl(...args),
};

mock.module('../../src/ui/spinner', () => ({
  Spinner: class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
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

let ProjectsCommand: typeof import('../../src/commands/projectsCommand').ProjectsCommand;
const importCommand = async () => {
  const mod = await import('../../src/commands/projectsCommand');
  ProjectsCommand = mod.ProjectsCommand;
};

/** Distinguishes the intentional `process.exit()` throw from a real bug, without parsing any message text. */
class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

/**
 * Runs `fn`, capturing stdout/stderr/exit code — never lets `process.exit`
 * actually exit the test runner.
 *
 * Reads each spy's `.mock.calls` BEFORE `mockRestore()`: bun's `mockRestore()`
 * clears the recorded calls on the handle it returns, so a read after restore
 * silently comes back empty rather than throwing — confirmed against bun
 * 1.3.11 with a standalone repro before writing this the mutation-avoiding way.
 */
async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});

  // `.then(ok, err)` rather than try/catch-with-reassignment: captures whatever
  // `fn()` threw (or `null`) as a plain value, so nothing here needs a `let`.
  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);

  // Must read `.mock.calls` before `mockRestore()` below — bun 1.3.11 clears
  // the recorded calls on restore, so reading after comes back silently empty.
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

const project = (id: string, name: string): FakeProject => ({ id, name, organization_id: 'org_1' });
const branch = (id: string, name: string, isProtected: boolean): FakeBranch => ({
  id,
  name,
  project_id: 'irrelevant',
  is_protected: isProtected,
});

describe('ProjectsCommand', () => {
  beforeEach(async () => {
    if (!ProjectsCommand) await importCommand();
    listProjectsImpl.mockReset();
    listBranchesImpl.mockReset();
    getOrgReposImpl.mockReset();
    getOrgReposImpl.mockImplementation(async () => {
      throw new CapyError('forbidden', ERROR_CODES.PERMISSION_DENIED);
    });
    listProjectsImpl.mockImplementation(async () => []);
    listBranchesImpl.mockImplementation(async () => []);
  });

  it('human output: one line per project, branches joined, protected marked', async () => {
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web'), project('p2', 'api')]);
    listBranchesImpl.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? [branch('b1', 'development', false), branch('b2', 'production', true)]
        : [branch('b3', 'main', false)],
    );

    const { stdout, exitCode } = await capture(() => new ProjectsCommand().execute({}));

    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('web');
    expect(stdout).toContain('development, production');
    expect(stdout).toContain('(protected)');
    expect(stdout).toContain('api');
    expect(stdout).toContain('main');
    // Only the protected branch is marked.
    expect(stdout.match(/\(protected\)/g)?.length).toBe(1);
  });

  it('--json: pure {ok, projects} shape with id/name/branches[{id,name,protected}]', async () => {
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
    listBranchesImpl.mockImplementation(async () => [branch('b1', 'production', true)]);

    const { stdout, stderr, exitCode } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe('');
    const payload = JSON.parse(stdout);
    expect(payload).toEqual({
      ok: true,
      projects: [
        {
          id: 'p1',
          name: 'web',
          branches: [{ id: 'b1', name: 'production', protected: true }],
        },
      ],
    });
  });

  it('hides the reserved _system project even if the service returns it', async () => {
    listProjectsImpl.mockImplementation(async () => [
      project('p1', 'web'),
      project('sys', '_system'),
      project('sys2', ' _SYSTEM '),
    ]);
    listBranchesImpl.mockImplementation(async () => []);

    const { stdout } = await capture(() => new ProjectsCommand().execute({ json: true }));

    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0].name).toBe('web');
    expect(JSON.stringify(payload)).not.toContain('_system');
  });

  it('empty org: human message and empty --json array', async () => {
    listProjectsImpl.mockImplementation(async () => []);

    const humanResult = await capture(() => new ProjectsCommand().execute({}));
    expect(humanResult.stdout).toContain('No projects found');

    const jsonResult = await capture(() => new ProjectsCommand().execute({ json: true }));
    expect(JSON.parse(jsonResult.stdout)).toEqual({ ok: true, projects: [] });
  });

  it('service error: coded JSON on stdout, exit 1, no partial data', async () => {
    listProjectsImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stdout, exitCode } = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      code: ERROR_CODES.SERVICE_ERROR,
      error: 'Service unavailable',
    });
  });

  it('service error in human mode: prose on stderr, exit 1', async () => {
    listProjectsImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stderr, stdout, exitCode } = await capture(() => new ProjectsCommand().execute({}));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Service unavailable');
    expect(stdout).toBe('');
  });

  describe('repo links (CAP-697)', () => {
    const link = (projectId: string, over: Record<string, unknown> = {}) => ({
      project_id: projectId,
      project_name: 'ignored',
      host: 'github.com',
      owner: 'Acme',
      name: 'mono',
      path: '.',
      github_repo_id: 123,
      last_seen_at: '2026-10-02T00:00:00.000Z',
      ...over,
    });

    it('--json: each project gains `repos` [{host, owner, name, path, github_repo_id}]; a project with none gets []', async () => {
      listProjectsImpl.mockImplementation(async () => [project('p1', 'web'), project('p2', 'api')]);
      listBranchesImpl.mockImplementation(async () => []);
      getOrgReposImpl.mockImplementation(async () => ({
        org_id: 'org_1',
        repos: [link('p1'), link('p1', { owner: 'Acme', name: 'fork', path: 'services/web', github_repo_id: null })],
      }));

      const { stdout, stderr } = await capture(() => new ProjectsCommand().execute({ json: true }));

      expect(stderr).toBe('');
      const payload = JSON.parse(stdout);
      expect(payload.projects[0].repos).toEqual([
        { host: 'github.com', owner: 'Acme', name: 'mono', path: '.', github_repo_id: 123 },
        { host: 'github.com', owner: 'Acme', name: 'fork', path: 'services/web', github_repo_id: null },
      ]);
      expect(payload.projects[1].repos).toEqual([]);
      // Additive: everything that was there still is.
      expect(Object.keys(payload.projects[0]).sort()).toEqual(['branches', 'id', 'name', 'repos']);
    });

    it('human output shows owner/name, plus /path when it is not the repo root', async () => {
      listProjectsImpl.mockImplementation(async () => [project('p1', 'web'), project('p2', 'api')]);
      listBranchesImpl.mockImplementation(async () => []);
      getOrgReposImpl.mockImplementation(async () => ({
        org_id: 'org_1',
        repos: [link('p1'), link('p2', { path: 'services/api' })],
      }));

      const { stdout } = await capture(() => new ProjectsCommand().execute({}));

      const lines = stdout.split('\n');
      expect(lines.find((l) => l.includes('web'))).toContain('Acme/mono');
      expect(lines.find((l) => l.includes('web'))).not.toContain('Acme/mono/');
      expect(lines.find((l) => l.includes('api'))).toContain('Acme/mono/services/api');
    });

    it('a plain member (403 on the repo list) still gets their projects: no `repos`, no failure, no stderr', async () => {
      listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
      listBranchesImpl.mockImplementation(async () => [branch('b1', 'main', false)]);

      const asJson = await capture(() => new ProjectsCommand().execute({ json: true }));
      expect(asJson.exitCode).toBeUndefined();
      expect(asJson.stderr).toBe('');
      expect(JSON.parse(asJson.stdout)).toEqual({
        ok: true,
        projects: [{ id: 'p1', name: 'web', branches: [{ id: 'b1', name: 'main', protected: false }] }],
      });

      const human = await capture(() => new ProjectsCommand().execute({}));
      expect(human.exitCode).toBeUndefined();
      expect(human.stdout).toContain('web');
    });

    it('a service that predates repo links (REPO_LINKS_UNSUPPORTED): repos omitted, command succeeds', async () => {
      listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
      listBranchesImpl.mockImplementation(async () => []);
      getOrgReposImpl.mockImplementation(async () => {
        throw new CapyError('not supported', ERROR_CODES.REPO_LINKS_UNSUPPORTED, { status: 404 });
      });
      const { exitCode, stdout, stderr } = await capture(() => new ProjectsCommand().execute({ json: true }));
      expect(exitCode).toBeUndefined();
      expect(stderr).toBe('');
      expect(JSON.parse(stdout).projects[0].repos).toBeUndefined();
    });

    it('any other failure of the repo list never fails the command either', async () => {
      listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
      listBranchesImpl.mockImplementation(async () => []);
      getOrgReposImpl.mockImplementation(async () => {
        throw new Error('network down');
      });
      const { exitCode, stdout } = await capture(() => new ProjectsCommand().execute({ json: true }));
      expect(exitCode).toBeUndefined();
      expect(JSON.parse(stdout).projects[0].repos).toBeUndefined();
    });
  });
});
