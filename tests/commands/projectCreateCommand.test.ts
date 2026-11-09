import { describe, it, expect, spyOn, mock, afterAll, beforeEach, afterEach } from 'bun:test';

/**
 * `capy org create-project` (CAP-748).
 *
 * The REAL `ServiceClient` talks HTTP to a local fake of the service, so "creates nothing" is asserted as
 * "no POST /projects ever arrived". Only org resolution (auth) and the inquirer prompt are replaced.
 * `mock.module()` is process-wide: tests/run-tests.sh runs this file isolated.
 */

import { ServiceClient } from '../../src/service/serviceClient';

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

const fakePrompt = mock(async (_questions: unknown) => ({ projectName: 'typed-in-terminal' }));
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

const LIVE = [
  { id: 'proj_web', name: 'web', organization_id: 'org_1' },
  { id: 'proj_other_org', name: 'api', organization_id: 'org_2' },
];

/** A service that lists `projects` and answers a create with `onCreate`. */
function service(opts: { projects?: readonly object[]; onCreate?: (body: string) => Reply }) {
  const { projects = LIVE, onCreate = (body: string) => {
    const { name } = JSON.parse(body) as { name: string };
    return reply(201, { id: 'proj_new', name, organization_id: 'org_1', s3_prefix: 'org_1/proj_new' });
  } } = opts;
  respond.mockImplementation((method, path, body) => {
    if (method === 'GET' && path.startsWith('/projects')) return reply(200, { projects });
    if (method === 'POST' && path === '/projects') return onCreate(body);
    return reply(500, { error: 'unexpected request' });
  });
}

const { createProjectCommand, existingProjectNamed } = await import('../../src/commands/projectCreateCommand');

describe('capy org create-project', () => {
  beforeEach(() => {
    respond.mockReset();
    fakePrompt.mockClear();
    setTTY(false);
  });
  afterEach(() => setTTY(false));

  it('with no name in agent mode: PROJECT_NAME_REQUIRED (exit 3) and a form elicitation, creating nothing', async () => {
    service({});
    const out = await capture(() => createProjectCommand(undefined, { json: true }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ ok: false, code: 'PROJECT_NAME_REQUIRED', elicitation: { kind: 'form' } });
    expect(body.elicitation.fields[0]).toMatchObject({ name: 'name', type: 'string', pattern: '^[a-zA-Z0-9-_]+$' });
    expect(body.elicitation.details).toEqual({ org: { id: 'org_1', name: 'Acme' } });
    expect(body.elicitation.display).toContain('| Org | Acme |');
    expect(creates()).toEqual([]);
    expect(fakePrompt).not.toHaveBeenCalled();
  });

  it('creates the project with the name given', async () => {
    service({});
    const out = await capture(() => createProjectCommand('new-app', { json: true }));

    expect(out.exitCode).toBeUndefined();
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, project: { id: 'proj_new', name: 'new-app' }, org: { id: 'org_1', name: 'Acme' } });
    expect(creates().map((r) => JSON.parse(r.body))).toEqual([{ name: 'new-app', organization_id: 'org_1' }]);
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
    const out = await capture(() => createProjectCommand('api', { json: true }));

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
    const ok = await capture(() => createProjectCommand('new-app', { json: true, dryRun: true }));
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, dry_run: true, project: { name: 'new-app' } });

    const clash = await capture(() => createProjectCommand('web', { json: true, dryRun: true }));
    expect(JSON.parse(clash.stdout).code).toBe('PROJECT_NAME_EXISTS');
    expect(creates()).toEqual([]);
  });

  it('the free-tier limit keeps its code', async () => {
    service({ onCreate: () => reply(402, { error: 'limit', code: 'QUOTA_EXCEEDED', kind: 'project', limit: 3 }) });
    const out = await capture(() => createProjectCommand('new-app', { json: true }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout).code).toBe('QUOTA_EXCEEDED');
  });

  it('in a terminal with no name: asks with the init prompt, then creates', async () => {
    setTTY(true);
    service({});
    const out = await capture(() => createProjectCommand(undefined, {}));

    expect(fakePrompt).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBeUndefined();
    expect(creates().map((r) => JSON.parse(r.body).name)).toEqual(['typed-in-terminal']);
  });
});

describe('existingProjectNamed', () => {
  it('matches only in the same org, trimmed and ignoring case', () => {
    expect(existingProjectNamed(LIVE, 'org_1', ' Web ')).toEqual({ id: 'proj_web', name: 'web' });
    expect(existingProjectNamed(LIVE, 'org_1', 'api')).toBeUndefined();
    expect(existingProjectNamed(LIVE, 'org_1', 'webs')).toBeUndefined();
  });
});
