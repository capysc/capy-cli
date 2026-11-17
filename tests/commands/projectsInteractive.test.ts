import { describe, it, expect, spyOn, mock, afterAll, afterEach } from 'bun:test';

/**
 * `capy projects` picks its output: the interactive screen only in a terminal
 * (stdout AND stdin), and never under `--json` or `--deleted`, which keep
 * today's output. The screen's driver is mocked: this file is about the choice.
 */

const listProjectsImpl = mock(async () => [{ id: 'p1', name: 'web', organization_id: 'org_1', created_at: null }]);
const fakeServiceClient = {
  listProjects: (...args: unknown[]) => listProjectsImpl(...(args as [])),
  listBranches: async () => [],
  getOrgRepos: async () => ({ org_id: 'org_1', repos: [] }),
  getSecretIndex: async () => ({ org_id: 'org_1', rows: [], skipped: [] }),
  getOrgMe: async () => ({ user_id: 'user_1', role: 'owner', admin_projects: [{ id: 'p1', name: 'web' }] }),
  listMemberDetails: async () => ({ members: [] }),
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
    orgName: 'Acme',
    userId: 'user_1',
    userEmail: 'a@example.com',
    authService: {},
    serviceClient: fakeServiceClient,
  })),
}));

const runProjectsScreenImpl = mock(async (..._args: unknown[]) => {});
mock.module('../../src/ui/projectsScreenDriver', () => ({ runProjectsScreen: runProjectsScreenImpl }));
mock.module('../../src/commands/secretsValueDecryptor', () => ({ createLocationDecryptor: () => async () => ({ ok: false, code: 'X' }) }));

afterAll(() => mock.restore());

const { ProjectsCommand } = await import('../../src/commands/projectsCommand');

function setTTY(stdoutIsTty: boolean, stdinIsTty: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTty, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTty, configurable: true });
}

async function run(opts: { json?: boolean; deleted?: boolean; dryRun?: boolean }): Promise<string> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new ProjectsCommand().execute(opts);
    return log.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('capy projects: which output', () => {
  afterEach(() => {
    setTTY(false, false);
    runProjectsScreenImpl.mockClear();
  });

  it('opens the screen in a terminal, with the screen data and the dry-run flag', async () => {
    setTTY(true, true);
    const out = await run({ dryRun: true });
    expect(out).toBe('');
    expect(runProjectsScreenImpl).toHaveBeenCalledTimes(1);
    const [data, , , dryRun] = runProjectsScreenImpl.mock.calls[0] as [{ projects: { id: string }[] }, unknown, unknown, boolean];
    expect(data.projects.map((p) => p.id)).toEqual(['p1']);
    expect(dryRun).toBe(true);
  });

  it('--json keeps the JSON, even in a terminal', async () => {
    setTTY(true, true);
    const out = await run({ json: true });
    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(JSON.parse(out).ok).toBe(true);
  });

  it('--deleted keeps the plain listing, even in a terminal', async () => {
    setTTY(true, true);
    await run({ deleted: true });
    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(listProjectsImpl).toHaveBeenLastCalledWith({ includeDeleted: true });
  });

  it('not a terminal on both ends: today\'s plain listing', async () => {
    setTTY(true, false);
    const out = await run({});
    expect(runProjectsScreenImpl).not.toHaveBeenCalled();
    expect(out).toContain('web');
  });
});
