import { describe, it, expect, spyOn, mock, afterAll, beforeEach, afterEach } from 'bun:test';

/**
 * `capy project create` (CAP-748).
 *
 * The REAL `ServiceClient` talks HTTP to a local fake of the service, so "creates nothing" is asserted as
 * "no POST /projects ever arrived". Only org resolution (auth) and the inquirer prompt are replaced.
 * `mock.module()` is process-wide: tests/run-tests.sh runs this file isolated.
 */

import { ServiceClient } from '../../src/service/serviceClient';
import { ProjectManager } from '../../src/core/projectManager';

type Reply = { readonly status: number; readonly body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

const respond = mock((_method: string, _path: string, _body: string): Reply => reply(500, { error: 'unexpected request' }));

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const answer = respond(req.method, `${url.pathname}${url.search}`, await req.text());
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  },
});

const client = new ServiceClient(`http://localhost:${server.port}`);
client.setTokenProvider((async () => ({ access_token: 'test-token' })) as never);

mock.module('../../src/core/orgContext', () => ({
  resolveOrgContext: mock(async () => ({
    orgId: 'org_1',
    orgName: 'Acme',
    userId: 'user_1',
    userEmail: 'owner@example.com',
    authService: {},
    serviceClient: client,
  })),
}));

/** What the person "types" in a terminal, keyed by the prompt's `name`. */
const TERMINAL_ANSWERS: Readonly<Record<string, string | boolean>> = {
  projectName: 'typed-in-terminal',
  initialBranchChoice: 'development',
  branchName: 'typed-branch',
  protect: false,
};
const answerFor = (questions: unknown, answers: Readonly<Record<string, string | boolean>>) => {
  const name = (questions as ReadonlyArray<{ readonly name: string }>)[0].name;
  return { [name]: answers[name] };
};
const fakePrompt = mock(async (questions: unknown) => answerFor(questions, TERMINAL_ANSWERS));
mock.module('inquirer', () => ({
  default: { prompt: fakePrompt, createPromptModule: mock(() => fakePrompt) },
}));

afterAll(() => {
  server.stop(true);
  mock.restore();
});

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(fn: () => Promise<void>): Promise<Captured> {
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

const setTTY = (value: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

const requests = () => respond.mock.calls.map(([method, path, body]) => ({ method, path, body }));
const creates = () => requests().filter((r) => r.method === 'POST' && r.path === '/projects');
const branchCreates = () => requests()
  .filter((r) => r.method === 'POST' && r.path === '/projects/proj_new/branches')
  .map((r) => JSON.parse(r.body) as { name: string; is_protected: boolean });
const BRANCH_DESCRIPTION = 'A Capy branch works like a git branch. Capy branches can be used to set different variables for different environments.';

const LIVE = [
  { id: 'proj_web', name: 'web', organization_id: 'org_1' },
  { id: 'proj_other_org', name: 'api', organization_id: 'org_2' },
];

/** A service that lists `projects`, answers a create with `onCreate` and a branch create with `onBranch`. */
function service(opts: { projects?: readonly object[]; onCreate?: (body: string) => Reply; onBranch?: (body: string) => Reply }) {
  const { projects = LIVE, onCreate = (body: string) => {
    const { name } = JSON.parse(body) as { name: string };
    return reply(201, { id: 'proj_new', name, organization_id: 'org_1', s3_prefix: 'org_1/proj_new' });
  }, onBranch = (body: string) => {
    const { name, is_protected } = JSON.parse(body) as { name: string; is_protected: boolean };
    return reply(201, { id: 'br_new', project_id: 'proj_new', name, is_protected });
  } } = opts;
  respond.mockImplementation((method, path, body) => {
    if (method === 'GET' && path.startsWith('/projects')) return reply(200, { projects });
    if (method === 'POST' && path === '/projects') return onCreate(body);
    if (method === 'POST' && path === '/projects/proj_new/branches') return onBranch(body);
    return reply(500, { error: 'unexpected request' });
  });
}

const { createProjectCommand, createProjectOptsFrom, existingProjectNamed } = await import('../../src/commands/projectCreateCommand');

describe('capy project create', () => {
  beforeEach(() => {
    respond.mockReset();
    fakePrompt.mockClear();
    fakePrompt.mockImplementation(async (questions: unknown) => answerFor(questions, TERMINAL_ANSWERS));
    setTTY(false);
  });
  afterEach(() => setTTY(false));

  it('with no name in agent mode: PROJECT_NAME_REQUIRED (exit 3) and a form asking for name, branch and protection, creating nothing', async () => {
    service({});
    const out = await capture(() => createProjectCommand(undefined, { json: true }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ ok: false, code: 'PROJECT_NAME_REQUIRED', elicitation: { kind: 'form' } });
    expect(body.elicitation.fields[0]).toMatchObject({ name: 'name', type: 'string', pattern: '^[a-zA-Z0-9-_]+$' });
    expect(body.elicitation.fields[0].question).toBe('What should the project be called?');
    expect(body.elicitation.fields[1]).toEqual({
      name: 'branch',
      type: 'string',
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
      question: 'What should its first branch be called?',
      default: 'development',
      description: BRANCH_DESCRIPTION,
    });
    expect(body.elicitation.fields[2]).toEqual({
      name: 'protected',
      type: 'string',
      pattern: '^(yes|no)$',
      question: 'Make the first branch a protected branch? (invite-only)',
      default: 'no',
      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    });
    expect(body.elicitation.answer).toEqual({ rerun: 'capy project create <name> --branch <branch> --protected <protected> --json' });
    expect(body.elicitation.display).toContain('| Protected | to choose |');
    expect(body.elicitation.details).toEqual({ org: { id: 'org_1', name: 'Acme' } });
    expect(body.elicitation.display).toContain('| Org | Acme |');
    expect(body.elicitation.display).toContain(BRANCH_DESCRIPTION);
    expect(creates()).toEqual([]);
    expect(fakePrompt).not.toHaveBeenCalled();
  });

  it('the folder name is suggested only when no live project in the org has it', async () => {
    service({});
    const folder = spyOn(ProjectManager.prototype, 'getDefaultProjectName');

    folder.mockReturnValue('web');
    const taken = JSON.parse((await capture(() => createProjectCommand(undefined, { json: true }))).stdout);
    folder.mockReturnValue('fresh-folder');
    const free = JSON.parse((await capture(() => createProjectCommand(undefined, { json: true }))).stdout);
    folder.mockRestore();

    expect(taken.elicitation.fields[0].default).toBeUndefined();
    expect(free.elicitation.fields[0].default).toBe('fresh-folder');
  });

  it('with a name but no --branch in agent mode: BRANCH_NAME_REQUIRED (exit 3), the form keeps the name, creating nothing', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ ok: false, code: 'BRANCH_NAME_REQUIRED', elicitation: { kind: 'form' } });
    expect(body.elicitation.fields.map((f: { name: string; default?: string }) => [f.name, f.default])).toEqual([
      ['name', 'new-app'],
      ['branch', 'development'],
      ['protected', 'no'],
    ]);
    expect(body.elicitation.display).toContain('| Project | new-app |');
    expect(creates()).toEqual([]);
    expect(fakePrompt).not.toHaveBeenCalled();
  });

  it('with a name and branch but no --protected in agent mode: BRANCH_PROTECTION_REQUIRED (exit 3), the question names the branch', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'staging' }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ ok: false, code: 'BRANCH_PROTECTION_REQUIRED', elicitation: { kind: 'form' } });
    expect(body.elicitation.fields[2].question).toBe('Make "staging" a protected branch? (invite-only)');
    expect(body.elicitation.display).toContain('| First branch | staging |');
    expect(creates()).toEqual([]);
  });

  it('--protected yes creates the first branch protected', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'production', protectedAnswer: 'yes' }));

    expect(JSON.parse(out.stdout).branch).toEqual({ name: 'production', protected: true });
    expect(branchCreates()).toEqual([{ name: 'production', is_protected: true }]);
  });

  it('--protected with anything but yes or no: BRANCH_PROTECTION_INVALID before any request', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'staging', protectedAnswer: 'maybe' }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ code: 'BRANCH_PROTECTION_INVALID', options: ['yes', 'no'] });
    expect(requests()).toEqual([]);
  });

  it('creates the project, then its first branch, unprotected', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'staging', protectedAnswer: 'no' }));

    expect(out.exitCode).toBeUndefined();
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      project: { id: 'proj_new', name: 'new-app' },
      branch: { name: 'staging', protected: false },
      org: { id: 'org_1', name: 'Acme' },
    });
    expect(creates().map((r) => JSON.parse(r.body))).toEqual([{ name: 'new-app', organization_id: 'org_1' }]);
    expect(branchCreates()).toEqual([{ name: 'staging', is_protected: false }]);
  });

  it('the project is made but its branch is not: BRANCH_CREATE_FAILED with the project, so nobody thinks nothing happened', async () => {
    service({ onBranch: () => reply(500, { error: 'boom' }) });
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'development', protectedAnswer: 'no' }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: false,
      code: 'BRANCH_CREATE_FAILED',
      project: { id: 'proj_new', name: 'new-app' },
      branch: { name: 'development', protected: false },
    });
  });

  it('a branch name the service would refuse: BRANCH_NAME_INVALID before any request', async () => {
    service({});
    const bad = ['-dev', 'a..b', 'has space', 'x'.repeat(129)];
    const outs = await bad.reduce<Promise<readonly Captured[]>>(
      async (acc, branch) => [...(await acc), await capture(() => createProjectCommand('new-app', { json: true, branch }))],
      Promise.resolve([]),
    );

    expect(outs.map((o) => [o.exitCode, JSON.parse(o.stdout).code])).toEqual(bad.map(() => [1, 'BRANCH_NAME_INVALID']));
    expect(requests()).toEqual([]);
  });

  it('a name a live project in the org already has: PROJECT_NAME_EXISTS, creating nothing (ignores case and spaces)', async () => {
    service({});
    const out = await capture(() => createProjectCommand('WEB', { json: true }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NAME_EXISTS', project: { id: 'proj_web', name: 'web' } });
    expect(creates()).toEqual([]);
  });

  it('a name used only in another org is not a clash', async () => {
    service({});
    const out = await capture(() => createProjectCommand('api', { json: true, branch: 'development', protectedAnswer: 'no' }));

    expect(out.exitCode).toBeUndefined();
    expect(creates()).toHaveLength(1);
  });

  it('a name that breaks the rule: PROJECT_NAME_INVALID before any request', async () => {
    service({});
    const out = await capture(() => createProjectCommand('has space', { json: true }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NAME_INVALID', pattern: '^[a-zA-Z0-9-_]+$' });
    expect(requests()).toEqual([]);
  });

  it('the reserved system store name: PROJECT_NAME_RESERVED before any request', async () => {
    service({});
    const out = await capture(() => createProjectCommand('_System', { json: true }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout).code).toBe('PROJECT_NAME_RESERVED');
    expect(requests()).toEqual([]);
  });

  it('--dry-run checks the name (including clashes) and creates nothing', async () => {
    service({});
    const ok = await capture(() => createProjectCommand('new-app', { json: true, dryRun: true, branch: 'development', protectedAnswer: 'no' }));
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, dry_run: true, project: { name: 'new-app' }, branch: { name: 'development', protected: false } });

    const clash = await capture(() => createProjectCommand('web', { json: true, dryRun: true, branch: 'development', protectedAnswer: 'no' }));
    expect(JSON.parse(clash.stdout).code).toBe('PROJECT_NAME_EXISTS');
    expect(creates()).toEqual([]);
    expect(branchCreates()).toEqual([]);
  });

  it('the free-tier limit keeps its code', async () => {
    service({ onCreate: () => reply(402, { error: 'limit', code: 'QUOTA_EXCEEDED', kind: 'project', limit: 3 }) });
    const out = await capture(() => createProjectCommand('new-app', { json: true, branch: 'development', protectedAnswer: 'no' }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout).code).toBe('QUOTA_EXCEEDED');
    expect(branchCreates()).toEqual([]);
  });

  it('in a terminal with nothing given: asks the name, says what a branch is, asks the branch and whether it is protected, then creates both', async () => {
    setTTY(true);
    service({});
    const out = await capture(() => createProjectCommand(undefined, {}));

    expect(fakePrompt.mock.calls.map(([q]) => (q as ReadonlyArray<{ name: string }>)[0].name)).toEqual(['projectName', 'initialBranchChoice', 'protect']);
    expect(out.stdout).toContain(BRANCH_DESCRIPTION);
    expect(out.exitCode).toBeUndefined();
    expect(creates().map((r) => JSON.parse(r.body).name)).toEqual(['typed-in-terminal']);
    expect(branchCreates()).toEqual([{ name: 'development', is_protected: false }]);
  });

  it('in a terminal, "another branch" asks for its name', async () => {
    setTTY(true);
    service({});
    fakePrompt.mockImplementation(async (questions: unknown) =>
      answerFor(questions, { ...TERMINAL_ANSWERS, initialBranchChoice: 'other' }));
    const out = await capture(() => createProjectCommand('new-app', {}));
    fakePrompt.mockImplementation(async (questions: unknown) => answerFor(questions, TERMINAL_ANSWERS));

    expect(out.exitCode).toBeUndefined();
    expect(branchCreates()).toEqual([{ name: 'typed-branch', is_protected: false }]);
  });

  it('in a terminal, yes to the protected question creates the branch protected', async () => {
    setTTY(true);
    service({});
    fakePrompt.mockImplementation(async (questions: unknown) => answerFor(questions, { ...TERMINAL_ANSWERS, protect: true }));
    await capture(() => createProjectCommand('new-app', {}));
    fakePrompt.mockImplementation(async (questions: unknown) => answerFor(questions, TERMINAL_ANSWERS));

    expect(branchCreates()).toEqual([{ name: 'development', is_protected: true }]);
  });

  it('in a terminal, a name that clashes is refused before the branch is asked', async () => {
    setTTY(true);
    service({});
    const out = await capture(() => createProjectCommand('web', {}));

    expect(out.exitCode).toBe(1);
    expect(fakePrompt).not.toHaveBeenCalled();
    expect(creates()).toEqual([]);
  });
});

describe('existingProjectNamed', () => {
  it('matches only in the same org, trimmed and ignoring case', () => {
    expect(existingProjectNamed(LIVE, 'org_1', ' Web ')).toEqual({ id: 'proj_web', name: 'web' });
    expect(existingProjectNamed(LIVE, 'org_1', 'api')).toBeUndefined();
    expect(existingProjectNamed(LIVE, 'org_1', 'webs')).toBeUndefined();
  });
});

describe('createProjectOptsFrom', () => {
  const merged = (opts: Record<string, unknown>) => createProjectOptsFrom({ optsWithGlobals: () => opts });

  it('--non-tty means --json: agent mode always answers in JSON', () => {
    expect(merged({ nonTty: true }).json).toBe(true);
    expect(merged({ json: true }).json).toBe(true);
    expect(merged({}).json).toBe(false);
  });
});
