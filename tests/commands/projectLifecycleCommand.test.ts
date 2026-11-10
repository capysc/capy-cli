import { describe, it, expect, spyOn, mock, afterAll, beforeEach, afterEach } from 'bun:test';

/**
 * `capy project delete` and `capy project restore` (CAP-729).
 *
 * The REAL `ServiceClient` talks HTTP to a local fake of the service, so these
 * tests see exactly what goes on the wire (the method, the path, the body) and
 * run the real status/`code` classification on the way back. In particular:
 * "`--dry-run` sends no write" is asserted as "no DELETE request ever arrived",
 * not as "a mock was not called".
 *
 * Only org resolution (auth) and the inquirer prompt are replaced.
 * `mock.module()` is process-wide: tests/run-tests.sh runs this file isolated.
 */

import { ServiceClient } from '../../src/service/serviceClient';

type Reply = { readonly status: number; readonly body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

/** (method, path with query, raw body) -> the fake service's answer. Replaced per test. */
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

/** What the person answers when asked. Replaced per test. */
const fakePrompt = mock(async (_questions: unknown) => ({ confirmed: true }));
const createPromptModule = mock((_opts: unknown) => fakePrompt);
mock.module('inquirer', () => ({
  default: { prompt: fakePrompt, createPromptModule },
}));

afterAll(() => {
  server.stop(true);
  mock.restore();
});

/** Distinguishes the intentional `process.exit()` throw from a real bug, without parsing message text. */
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

/** Runs `fn`, capturing stdout/stderr and the exit code; `process.exit` never exits the runner. */
async function capture(fn: () => Promise<void>): Promise<Captured> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});

  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);

  // Read the calls BEFORE mockRestore(): bun clears them on restore.
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
const writes = () => requests().filter((r) => r.method === 'DELETE' || r.method === 'POST');
const deletes = () => requests().filter((r) => r.method === 'DELETE');

const WEB = { id: 'proj_web', name: 'web' };
const API = { id: 'proj_api', name: 'api' };
const LIVE = [WEB, API].map((p) => ({ ...p, organization_id: 'org_1' }));

const TOKEN = { deploy_id: 'dep_1', label: 'prod web', created_at: '2026-10-01T00:00:00.000Z' };
const OWNER_ONLY = reply(403, { error: 'Only the organization owner can delete a project', code: 'PROJECT_DELETE_OWNER_ONLY' });

/** A service that lists `projects`, reports `tokens` as unrevoked, and answers the write with `onWrite`. */
/** A keep.lock with `count` variables, each on `branch`. Names only matter; nothing else is read. */
const keepWith = (count: number, branch: string) => JSON.stringify({
  version: '3.0',
  variables: Object.fromEntries(Array.from({ length: count }, (_, i) => [`VAR_${i}`, [{ branch }]])),
});

function service(opts: {
  projects?: readonly object[];
  tokens?: readonly object[];
  /** Per project id: its branches and how many variables its keep.lock has. Absent = unreadable. */
  contents?: Readonly<Record<string, { readonly branches: readonly string[]; readonly variables: number }>>;
  onWrite?: (method: string, path: string, body: string) => Reply;
}) {
  const { projects = LIVE, tokens = [], contents = {}, onWrite = () => reply(500, { error: 'no write expected' }) } = opts;
  respond.mockImplementation((method, path, body) => {
    const branchList = method === 'GET' ? /^\/projects\/([^/?]+)\/branches$/.exec(path) : null;
    if (branchList) {
      const c = contents[branchList[1]];
      return c ? reply(200, { branches: c.branches.map((name) => ({ name })) }) : reply(500, { error: 'unreadable' });
    }
    const latest = method === 'GET' ? /^\/secrets\/([^/?]+)\?branch=([^&]+)$/.exec(path) : null;
    if (latest) {
      const c = contents[latest[1]];
      return c ? reply(200, { env_file: '', keep_hash: 'h', keep_file: keepWith(c.variables, decodeURIComponent(latest[2])) }) : reply(500, { error: 'unreadable' });
    }
    if (method === 'GET' && path.startsWith('/projects')) return reply(200, { projects });
    if (method === 'GET' && path.endsWith('/deploy-tokens')) {
      return reply(200, { tokens: tokens.map((t) => ({ created_by: 'user_1', revoked_at: null, ...t })) });
    }
    return onWrite(method, path, body);
  });
}

const deleted = (id: string, name: string) =>
  reply(200, { ok: true, project: { id, name, deleted_at: '2026-11-05T12:00:00.000Z' }, live_deploy_tokens: [] });

// After the mocks above: the command module picks up the replaced org resolution and prompt.
const { deleteProjectCommand, restoreProjectCommand } = await import('../../src/commands/projectLifecycleCommand');

describe('capy project delete', () => {
  beforeEach(() => {
    respond.mockReset();
    fakePrompt.mockReset();
    fakePrompt.mockImplementation(async () => ({ confirmed: true }));
    createPromptModule.mockClear();
    setTTY(false);
  });
  afterEach(() => setTTY(false));

  describe('confirmation', () => {
    it('off a terminal without --yes: refuses with CONFIRMATION_REQUIRED (exit 3) and a confirm elicitation, writing nothing', async () => {
      service({ onWrite: () => deleted('proj_web', 'web') });

      const out = await capture(() => deleteProjectCommand('web', { json: true }));

      expect(out.exitCode).toBe(3);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED', elicitation: { kind: 'confirm' } });
      expect(writes()).toEqual([]);
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('--non-tty on a real terminal refuses the same way', async () => {
      setTTY(true);
      service({});

      const out = await capture(() => deleteProjectCommand('web', { json: true, nonTty: true }));

      expect(out.exitCode).toBe(3);
      expect(JSON.parse(out.stdout).code).toBe('CONFIRMATION_REQUIRED');
      expect(writes()).toEqual([]);
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('the prompt defaults to no, and shows the project and its live tokens first', async () => {
      setTTY(true);
      service({ tokens: [TOKEN], onWrite: () => deleted('proj_web', 'web') });
      fakePrompt.mockImplementation(async () => ({ confirmed: false }));

      const out = await capture(() => deleteProjectCommand('web', {}));

      const question = (fakePrompt.mock.calls[0][0] as Array<{ type: string; default: boolean }>)[0];
      expect(question.type).toBe('confirm');
      expect(question.default).toBe(false);
      expect(out.stdout).toContain('web');
      expect(out.stdout).toContain('proj_web');
      expect(out.stdout).toContain('dep_1');
      expect(out.stdout).toContain('prod web');
      expect(out.stdout).toContain('Cancelled.');
      expect(deletes()).toEqual([]);
    });

    it('--json in a terminal is agent mode, as for create: the confirm elicitation, no prompt, nothing deleted', async () => {
      setTTY(true);
      service({});

      const out = await capture(() => deleteProjectCommand('web', { json: true }));

      expect(out.exitCode).toBe(3);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED', elicitation: { kind: 'confirm' } });
      expect(fakePrompt).not.toHaveBeenCalled();
      expect(deletes()).toEqual([]);
    });

    it('answering yes sends one DELETE for the resolved id, with no force', async () => {
      setTTY(true);
      service({ onWrite: () => deleted('proj_web', 'web') });

      const out = await capture(() => deleteProjectCommand('web', {}));

      expect(deletes()).toEqual([{ method: 'DELETE', path: '/orgs/org_1/projects/proj_web', body: '' }]);
      expect(out.stdout).toContain('Deleted project web');
      expect(out.stdout).toContain('capy project restore proj_web');
    });

    it('--yes skips the question and the token read, even off a terminal', async () => {
      service({ onWrite: () => deleted('proj_web', 'web') });

      await capture(() => deleteProjectCommand('web', { yes: true }));

      expect(fakePrompt).not.toHaveBeenCalled();
      expect(requests().map((r) => r.method)).toEqual(['GET', 'DELETE']);
      expect(requests().some((r) => r.path.endsWith('/deploy-tokens'))).toBe(false);
    });
  });

  describe('--force and live deploy tokens', () => {
    it('--force sends {"force":true}', async () => {
      service({ onWrite: () => deleted('proj_web', 'web') });

      await capture(() => deleteProjectCommand('web', { yes: true, force: true }));

      expect(deletes()).toHaveLength(1);
      expect(JSON.parse(deletes()[0].body)).toEqual({ force: true });
    });

    it('a 409 PROJECT_HAS_LIVE_DEPLOY_TOKENS lists the tokens and says --force deletes anyway (human)', async () => {
      service({
        onWrite: () =>
          reply(409, { error: 'The project has live deploy tokens', code: 'PROJECT_HAS_LIVE_DEPLOY_TOKENS', live_deploy_tokens: [TOKEN] }),
      });

      const out = await capture(() => deleteProjectCommand('web', { yes: true }));

      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('dep_1');
      expect(out.stderr).toContain('prod web');
      expect(out.stderr).toContain('--force');
      expect(out.stderr).toContain('next restart');
      expect(out.stdout).toBe('');
    });

    it('the same refusal under --json: code and the token list on stdout, pure JSON', async () => {
      service({
        onWrite: () =>
          reply(409, { error: 'The project has live deploy tokens', code: 'PROJECT_HAS_LIVE_DEPLOY_TOKENS', live_deploy_tokens: [TOKEN] }),
      });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_HAS_LIVE_DEPLOY_TOKENS', live_deploy_tokens: [TOKEN] });
      expect(out.stderr).toBe('');
    });

    it('a revoked token is not listed as live in the preview', async () => {
      setTTY(true);
      service({ tokens: [TOKEN, { ...TOKEN, deploy_id: 'dep_old', revoked_at: '2026-10-02T00:00:00.000Z' }] });
      fakePrompt.mockImplementation(async () => ({ confirmed: false }));

      const out = await capture(() => deleteProjectCommand('web', {}));

      expect(out.stdout).toContain('dep_1');
      expect(out.stdout).not.toContain('dep_old');
    });
  });

  describe('--dry-run', () => {
    it('sends no DELETE (and no other write), needs no terminal, and says nothing was deleted', async () => {
      service({ tokens: [TOKEN], onWrite: () => deleted('proj_web', 'web') });

      const out = await capture(() => deleteProjectCommand('web', { dryRun: true }));

      expect(out.exitCode).toBeUndefined();
      expect(requests().length).toBeGreaterThan(0);
      expect(writes()).toEqual([]);
      expect(fakePrompt).not.toHaveBeenCalled();
      expect(out.stdout).toContain('proj_web');
      expect(out.stdout).toContain('dep_1');
      expect(out.stdout).toContain('Dry run');
    });

    it('--yes --force --dry-run still sends no write', async () => {
      service({ tokens: [TOKEN], onWrite: () => deleted('proj_web', 'web') });

      await capture(() => deleteProjectCommand('web', { dryRun: true, yes: true, force: true }));

      expect(writes()).toEqual([]);
    });

    it('--json shape: the project, the live tokens, and whether --force would be needed', async () => {
      service({ tokens: [TOKEN] });

      const out = await capture(() => deleteProjectCommand('web', { dryRun: true, json: true }));

      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        dry_run: true,
        project: { id: 'proj_web', name: 'web' },
        live_deploy_tokens: [{ ...TOKEN, created_by: 'user_1', revoked_at: null }],
        requires_force: true,
      });
      expect(writes()).toEqual([]);
    });

    it('with no live tokens, requires_force is false', async () => {
      service({});

      const out = await capture(() => deleteProjectCommand('web', { dryRun: true, json: true }));

      expect(JSON.parse(out.stdout)).toMatchObject({ live_deploy_tokens: [], requires_force: false });
    });
  });

  describe('--json', () => {
    it('success: the service answer on stdout, nothing else', async () => {
      service({ onWrite: () => deleted('proj_web', 'web') });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(out.exitCode).toBeUndefined();
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        project: { id: 'proj_web', name: 'web', deleted_at: '2026-11-05T12:00:00.000Z' },
        live_deploy_tokens: [],
      });
      expect(out.stderr).toBe('');
    });
  });

  describe('refusals are coded', () => {
    it('owner only: the 403 surfaces as PROJECT_DELETE_OWNER_ONLY (json)', async () => {
      service({ onWrite: () => OWNER_ONLY });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_DELETE_OWNER_ONLY' });
    });

    it('owner only, human: prose on stderr, nothing on stdout, exit 1', async () => {
      service({ onWrite: () => OWNER_ONLY });

      const out = await capture(() => deleteProjectCommand('web', { yes: true }));

      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('owner');
      expect(out.stdout).toBe('');
    });

    it('the system store: SYSTEM_STORE_IMMUTABLE', async () => {
      service({ onWrite: () => reply(403, { error: 'The org system store cannot be deleted', code: 'SYSTEM_STORE_IMMUTABLE' }) });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(JSON.parse(out.stdout).code).toBe('SYSTEM_STORE_IMMUTABLE');
    });

    it('a plain 403 stays PERMISSION_DENIED (the unwrapping is only for the two known codes)', async () => {
      service({ onWrite: () => reply(403, { error: 'nope', code: 'MEMBERSHIP_REVOKED' }) });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(JSON.parse(out.stdout).code).toBe('PERMISSION_DENIED');
    });

    it('already deleted: 410 PROJECT_DELETED', async () => {
      service({ onWrite: () => reply(410, { error: 'This project has been deleted', code: 'PROJECT_DELETED' }) });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(JSON.parse(out.stdout).code).toBe('PROJECT_DELETED');
    });

    it('a name that matches no project: PROJECT_NOT_FOUND before anything is read, asked or sent', async () => {
      service({ onWrite: () => reply(404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' }) });

      const out = await capture(() => deleteProjectCommand('nope', { json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' });
      expect(JSON.parse(out.stdout).elicitation).toBeUndefined();
      expect(requests().filter((r) => r.path !== '/projects')).toEqual([]);
    });

    it('an id that matches no listed project still goes to the service, which answers for it', async () => {
      const id = '5b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
      service({ onWrite: () => reply(404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' }) });

      const out = await capture(() => deleteProjectCommand(id, { yes: true, json: true }));

      expect(deletes()[0].path).toBe(`/orgs/org_1/projects/${id}`);
      expect(JSON.parse(out.stdout).code).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('resolving the name', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
    const TWINS = [
      { id: 'proj_new', name: 'web', organization_id: 'org_1', created_at: daysAgo(1) },
      { id: 'proj_old', name: 'web', organization_id: 'org_1', created_at: daysAgo(3) },
    ];
    const TWIN_CONTENTS = {
      proj_old: { branches: ['development'], variables: 45 },
      proj_new: { branches: ['development'], variables: 1 },
    };

    it('an ambiguous name, agent: PROJECT_AMBIGUOUS (exit 3) with a pick-one elicitation, oldest first, nothing deleted even with --yes', async () => {
      service({ projects: TWINS, contents: TWIN_CONTENTS, onWrite: () => deleted('proj_old', 'web') });

      const out = await capture(() => deleteProjectCommand('web', { yes: true, json: true }));

      expect(out.exitCode).toBe(3);
      const body = JSON.parse(out.stdout);
      expect(body).toMatchObject({ ok: false, code: 'PROJECT_AMBIGUOUS', elicitation: { kind: 'form', question: 'Which web?' } });
      expect(body.elicitation.fields).toEqual([{
        name: 'project',
        type: 'string',
        pattern: '^(proj_old|proj_new)$',
        options: [
          { value: 'proj_old', label: 'web · 45 variables · created 3 days ago' },
          { value: 'proj_new', label: 'web · 1 variable · created 1 day ago' },
        ],
      }]);
      expect(body.elicitation.answer).toEqual({ rerun: 'capy project delete <project> --json' });
      expect(body.elicitation.display).toContain('| 1 | web · 45 variables · created 3 days ago |');
      expect(deletes()).toEqual([]);
    });

    it('an ambiguous name keeps --force in the rerun, and an unreadable count is said, never 0', async () => {
      service({ projects: TWINS, contents: { proj_old: TWIN_CONTENTS.proj_old } });

      const out = await capture(() => deleteProjectCommand('web', { force: true, json: true }));

      const body = JSON.parse(out.stdout);
      expect(body.elicitation.answer.rerun).toBe('capy project delete <project> --force --json');
      expect(body.elicitation.fields[0].options[1].label).toBe('web · variables could not be read · created 1 day ago');
      expect(body.elicitation.details.matches[1]).toMatchObject({ id: 'proj_new', variables: null });
    });

    it('an ambiguous name with no creation dates (an older service) still asks, without the dates', async () => {
      service({ projects: TWINS.map(({ created_at: _c, ...p }) => p), contents: TWIN_CONTENTS });

      const out = await capture(() => deleteProjectCommand('web', { json: true }));

      expect(JSON.parse(out.stdout).elicitation.fields[0].options.map((o: { label: string }) => o.label))
        .toEqual(['web · 1 variable', 'web · 45 variables']);
    });

    it('an ambiguous name, terminal: an arrow-key list, then the usual yes/no, then the chosen one is deleted', async () => {
      setTTY(true);
      service({ projects: TWINS, contents: TWIN_CONTENTS, onWrite: () => deleted('proj_old', 'web') });
      fakePrompt.mockImplementation(async (questions: unknown) => {
        const q = (questions as ReadonlyArray<{ name: string; choices?: ReadonlyArray<{ name: string; value: string }> }>)[0];
        return q.name === 'projectId' ? { projectId: q.choices?.[0].value } : { confirmed: true };
      });

      await capture(() => deleteProjectCommand('web', {}));

      const asked = fakePrompt.mock.calls.map(([q]) => (q as ReadonlyArray<{ name: string; message: string; choices?: ReadonlyArray<{ name: string }> }>)[0]);
      expect(asked.map((q) => q.name)).toEqual(['projectId', 'confirmed']);
      expect(asked[0].message).toBe('Which web?');
      expect(asked[0].choices?.map((c) => c.name)).toEqual(['web · 45 variables · created 3 days ago', 'web · 1 variable · created 1 day ago']);
      expect(deletes().map((d) => d.path)).toEqual(['/orgs/org_1/projects/proj_old']);
    });

    it('an ambiguous name, human: both ids on stderr', async () => {
      service({
        projects: [
          { id: 'proj_a1', name: 'web', organization_id: 'org_1' },
          { id: 'proj_a2', name: 'web', organization_id: 'org_1' },
        ],
      });

      const out = await capture(() => deleteProjectCommand('web', { yes: true }));

      expect(out.stderr).toContain('proj_a1');
      expect(out.stderr).toContain('proj_a2');
      expect(deletes()).toEqual([]);
    });

    it('an id works where a name would, and wins over a project whose name is that id', async () => {
      service({
        projects: [{ id: 'proj_web', name: 'web', organization_id: 'org_1' }, { id: 'proj_x', name: 'proj_web', organization_id: 'org_1' }],
        onWrite: () => deleted('proj_web', 'web'),
      });

      await capture(() => deleteProjectCommand('proj_web', { yes: true }));

      expect(deletes()[0].path).toBe('/orgs/org_1/projects/proj_web');
    });

    it('the org system store is never a match: its name is not found, and nothing is sent', async () => {
      service({ projects: [{ id: 'proj_sys', name: '_system', organization_id: 'org_1' }], onWrite: () => reply(404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' }) });

      const out = await capture(() => deleteProjectCommand('_system', { yes: true, json: true }));

      expect(JSON.parse(out.stdout).code).toBe('PROJECT_NOT_FOUND');
      expect(deletes()).toEqual([]);
    });
  });
});

describe('capy project restore', () => {
  beforeEach(() => {
    respond.mockReset();
    fakePrompt.mockReset();
    fakePrompt.mockImplementation(async () => ({ confirmed: true }));
    createPromptModule.mockClear();
    setTTY(false);
  });
  afterEach(() => setTTY(false));

  const DELETED = { id: 'proj_old', name: 'old', organization_id: 'org_1', deleted_at: '2026-11-05T12:00:00.000Z' };
  const restored = reply(200, { ok: true, project: { id: 'proj_old', name: 'old' } });

  it('--yes: asks the service for the listing with include_deleted=1, then POSTs the restore', async () => {
    service({ projects: [DELETED], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('old', { yes: true }));

    expect(requests().map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /projects?include_deleted=1',
      'POST /orgs/org_1/projects/proj_old/restore',
    ]);
    expect(out.stdout).toContain('Restored project old');
  });

  it('--json: {ok, project} on stdout and nothing on stderr', async () => {
    service({ projects: [DELETED], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('old', { yes: true, json: true }));

    expect(JSON.parse(out.stdout)).toEqual({ ok: true, project: { id: 'proj_old', name: 'old' } });
    expect(out.stderr).toBe('');
  });

  it('an id works', async () => {
    service({ projects: [DELETED], onWrite: () => restored });

    await capture(() => restoreProjectCommand('proj_old', { yes: true }));

    expect(writes().map((r) => r.path)).toEqual(['/orgs/org_1/projects/proj_old/restore']);
  });

  it('prompts with a default of no; answering no restores nothing', async () => {
    setTTY(true);
    service({ projects: [DELETED], onWrite: () => restored });
    fakePrompt.mockImplementation(async () => ({ confirmed: false }));

    const out = await capture(() => restoreProjectCommand('old', {}));

    const question = (fakePrompt.mock.calls[0][0] as Array<{ default: boolean }>)[0];
    expect(question.default).toBe(false);
    expect(out.stdout).toContain('Cancelled.');
    expect(writes()).toEqual([]);
  });

  it('off a terminal without --yes: CONFIRMATION_REQUIRED (exit 3) with a confirm elicitation, restoring nothing', async () => {
    service({ projects: [DELETED], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('old', { json: true }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(body.elicitation).toMatchObject({
      kind: 'confirm',
      question: 'Restore project old?',
      details: { org: { id: 'org_1' }, project: { id: 'proj_old', name: 'old', deleted_at: '2026-11-05T12:00:00.000Z' } },
      answer: { yes: 'capy project restore proj_old --yes --json' },
    });
    expect(body.elicitation.display).toContain('| Project | old (proj_old) |');
    expect(body.elicitation.display).toContain('| Deleted | 2026-11-05T12:00:00.000Z |');
    expect(fakePrompt).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('two deleted projects with one name, no --yes: the pick-one rerun has no --yes, so the yes/no comes next', async () => {
    service({ projects: [DELETED, { ...DELETED, id: 'proj_old2' }], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('old', { json: true }));

    expect(JSON.parse(out.stdout).elicitation.answer.rerun).toBe('capy project restore <project> --json');
    expect(writes()).toEqual([]);
  });

  it('a project that is not deleted: 409 PROJECT_NOT_DELETED', async () => {
    service({
      projects: [{ id: 'proj_web', name: 'web', organization_id: 'org_1', deleted_at: null }],
      onWrite: () => reply(409, { error: 'The project is not deleted', code: 'PROJECT_NOT_DELETED' }),
    });

    const out = await capture(() => restoreProjectCommand('web', { yes: true, json: true }));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NOT_DELETED' });
  });

  it('owner only: PROJECT_DELETE_OWNER_ONLY, and an id still reaches the service when the listing hides deleted projects', async () => {
    const id = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    service({ projects: [], onWrite: () => reply(403, { error: 'Only the organization owner can restore a project', code: 'PROJECT_DELETE_OWNER_ONLY' }) });

    const out = await capture(() => restoreProjectCommand(id, { yes: true, json: true }));

    expect(writes()[0].path).toBe(`/orgs/org_1/projects/${id}/restore`);
    expect(JSON.parse(out.stdout).code).toBe('PROJECT_DELETE_OWNER_ONLY');
  });

  it('a name shared by a live and a deleted project restores the deleted one', async () => {
    service({
      projects: [{ id: 'proj_live', name: 'old', organization_id: 'org_1', deleted_at: null }, DELETED],
      onWrite: () => restored,
    });

    await capture(() => restoreProjectCommand('old', { yes: true }));

    expect(writes()[0].path).toBe('/orgs/org_1/projects/proj_old/restore');
  });

  it('two deleted projects with the same name: PROJECT_AMBIGUOUS (exit 3) with a pick-one elicitation whose rerun keeps --yes', async () => {
    service({ projects: [DELETED, { ...DELETED, id: 'proj_old2' }], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('old', { yes: true, json: true }));

    expect(out.exitCode).toBe(3);
    const body = JSON.parse(out.stdout);
    expect(body).toMatchObject({ code: 'PROJECT_AMBIGUOUS', elicitation: { kind: 'form' } });
    expect(body.elicitation.fields[0].options.map((o: { value: string }) => o.value)).toEqual(['proj_old', 'proj_old2']);
    expect(body.elicitation.answer.rerun).toBe('capy project restore <project> --yes --json');
    expect(writes()).toEqual([]);
  });

  it('a name that matches no project: PROJECT_NOT_FOUND, nothing sent', async () => {
    service({ projects: [DELETED], onWrite: () => restored });

    const out = await capture(() => restoreProjectCommand('nope', { yes: true, json: true }));

    expect(JSON.parse(out.stdout).code).toBe('PROJECT_NOT_FOUND');
    expect(writes()).toEqual([]);
  });
});
