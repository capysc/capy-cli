import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/**
 * `capy projects` — CLI-layer wiring only. Covers: human output (one line per
 * project, branches joined, protected ones marked), `--json` shape
 * (`{ok:true, projects:[...]}`), the reserved `_system` project staying
 * hidden even when the (fake) service returns it, an empty org rendering a
 * message instead of a table, a service failure surfacing as a coded
 * error rather than a crash, and (below, in a separate `describe`) the
 * interactive-screen TTY gate added alongside the type-to-search view: both
 * streams must be real TTYs AND `--json` must be absent, or the command
 * falls straight through to the exact same static output asserted above —
 * modeled on `secretsCommand.test.ts`'s own CAP-680 gate tests.
 *
 * `resolveOrgContext` (auth + org resolution) and the spinner are mocked —
 * neither is this file's concern. `excludeSystemProject` runs UNMOCKED (the
 * real module) so the `_system` case exercises the actual filter, not a
 * stand-in for it. The interactive screen's own driver is mocked too (its
 * behavior is covered by `tests/ui/projectsScreen.test.ts` and
 * `tests/ui/projectsScreenDriver.test.ts`, not here).
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

const fakeServiceClient = {
  listProjects: (...args: unknown[]) => listProjectsImpl(...(args as [])),
  listBranches: (...args: [string]) => listBranchesImpl(...args),
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

// The interactive screen's own dynamic import (`projectsCommand.ts` only
// reaches this when it decides to go interactive) — mocked so a TTY-mode
// test never actually takes over the terminal.
const runProjectsScreenImpl = mock(async (..._args: unknown[]) => {});
mock.module('../../src/ui/projectsScreenDriver', () => ({
  runProjectsScreen: runProjectsScreenImpl,
}));

afterAll(() => mock.restore());

/** Sets BOTH `process.stdout.isTTY` and `process.stdin.isTTY` — the command only treats a run as "a real terminal" when both are true. Mirrors `secretsCommand.test.ts`'s own helper. */
function setTTY(stdoutIsTty: boolean, stdinIsTty: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTty, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTty, configurable: true });
}

// Top-level `await import` (not a lazily-assigned `let`, guarded per-test) —
// every `mock.module(...)` call above already ran by the time this line
// executes, so the mocks are in place before the real module (and its own
// imports) resolve. `secretsCommand.test.ts` uses the same pattern for the
// same reason.
const { ProjectsCommand } = await import('../../src/commands/projectsCommand');

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
    listProjectsImpl.mockReset();
    listBranchesImpl.mockReset();
    listProjectsImpl.mockImplementation(async () => []);
    listBranchesImpl.mockImplementation(async () => []);
    runProjectsScreenImpl.mockClear();
    // The bun test process itself is not a TTY on either stream, but a
    // previous test may have flipped one — start every test from the same
    // known-false baseline (same reasoning as `secretsCommand.test.ts`).
    setTTY(false, false);
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
});

describe('ProjectsCommand — interactive launch (type-to-search, matching capy secrets)', () => {
  beforeEach(async () => {
    listProjectsImpl.mockReset();
    listBranchesImpl.mockReset();
    listProjectsImpl.mockImplementation(async () => []);
    listBranchesImpl.mockImplementation(async () => []);
    runProjectsScreenImpl.mockClear();
    setTTY(false, false);
  });
  afterAll(() => setTTY(false, false));

  it('launches the interactive screen when BOTH stdout and stdin are TTYs', async () => {
    setTTY(true, true);
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
    listBranchesImpl.mockImplementation(async () => [branch('b1', 'production', true)]);

    const { stdout, exitCode } = await capture(() => new ProjectsCommand().execute({}));

    expect(exitCode).toBeUndefined();
    expect(runProjectsScreenImpl).toHaveBeenCalledTimes(1);
    // The screen owns the terminal — this command never itself console.logs
    // anything once it hands off.
    expect(stdout).toBe('');
  });

  it('does NOT launch the interactive screen when only ONE of stdout/stdin is a TTY — falls back to the static table instead', async () => {
    setTTY(true, false);
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
    listBranchesImpl.mockImplementation(async () => []);

    const { stdout } = await capture(() => new ProjectsCommand().execute({}));

    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(stdout).toContain('web');
  });

  it('does NOT launch the interactive screen when stdout is a TTY but stdin is not', async () => {
    setTTY(false, true);
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);

    const { stdout } = await capture(() => new ProjectsCommand().execute({}));

    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(stdout).toContain('web');
  });

  it('does NOT launch the interactive screen under --json, even on a full TTY — --json output is byte-for-byte identical to the non-TTY path', async () => {
    setTTY(true, true);
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web')]);
    listBranchesImpl.mockImplementation(async () => [branch('b1', 'production', true)]);

    const ttyJson = await capture(() => new ProjectsCommand().execute({ json: true }));
    setTTY(false, false);
    const nonTtyJson = await capture(() => new ProjectsCommand().execute({ json: true }));

    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(ttyJson.stdout).toBe(nonTtyJson.stdout);
  });

  it('passes the exact same ProjectSummary[] to the interactive screen that --json would have printed', async () => {
    setTTY(true, true);
    listProjectsImpl.mockImplementation(async () => [project('p1', 'web'), project('p2', 'api')]);
    listBranchesImpl.mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? [branch('b1', 'production', true)] : [],
    );

    await capture(() => new ProjectsCommand().execute({}));

    expect(runProjectsScreenImpl).toHaveBeenCalledTimes(1);
    const passed = runProjectsScreenImpl.mock.calls[0]?.[0] as Array<{ name: string }> | undefined;
    expect(passed?.map((p) => p.name)).toEqual(['web', 'api']);
  });

  it('service error while genuinely interactive (both streams TTYs, no --json): prose on stderr, exit 1, nothing on stdout', async () => {
    setTTY(true, true);
    listProjectsImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stderr, stdout, exitCode } = await capture(() => new ProjectsCommand().execute({}));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Service unavailable');
    expect(stdout).toBe('');
    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
  });
});
