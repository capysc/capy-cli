import { describe, it, expect, spyOn, mock, afterAll, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * `capy projects rename`.
 *
 * The REAL `ServiceClient` talks HTTP to a local fake of the service, so "changes nothing" is asserted as "no PATCH
 * ever arrived" and "keep.lock is byte-identical". Only org resolution (auth) and the inquirer prompt are replaced
 * (the prompt only to prove it is never opened). `mock.module()` is process-wide: tests/run-tests.sh runs this
 * file isolated. Every test runs inside its own temporary folder.
 */

import { ServiceClient } from '../../src/service/serviceClient';
import { serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

type Reply = { readonly status: number; readonly body: unknown; readonly raw?: string };
const reply = (status: number, body: unknown): Reply => ({ status, body });
/** An answer whose body is sent as given, not as JSON. */
const rawReply = (status: number, raw: string): Reply => ({ status, body: null, raw });

const respond = mock((_method: string, _path: string, _body: string): Reply => reply(500, { error: 'unexpected request' }));

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const answer = respond(req.method, `${url.pathname}${url.search}`, await req.text());
    return new Response(answer.raw ?? JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
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

const fakePrompt = mock(async () => ({}));
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

const requests = () => respond.mock.calls.map(([method, path, body]) => ({ method, path, body }));
const renames = () => requests().filter((r) => r.method === 'PATCH');

const KEEP: KeepFile = {
  version: '3.0',
  org_id: 'org_1',
  project_id: 'proj_web',
  project_name: 'old-name',
  variables: {
    API_KEY: [{ resource_id: 'r-1', branch: 'development', value_hash: 'h-1' }],
    DB_URL: [{ resource_id: 'r-2', branch: 'production', value_hash: 'h-2' }],
  },
} as unknown as KeepFile;

const LISTING = [
  { id: 'proj_web', name: 'old-name', organization_id: 'org_1' },
  { id: 'proj_api', name: 'Api', organization_id: 'org_1' },
  { id: 'proj_other_org', name: 'elsewhere', organization_id: 'org_2' },
];

/** A service that lists `projects` and answers the rename with `onRename`. */
function service(opts: { projects?: readonly object[]; onRename?: (body: string) => Reply } = {}) {
  const {
    projects = LISTING,
    onRename = (body: string) => {
      const { name } = JSON.parse(body) as { name: string };
      return reply(200, { ok: true, changed: true, project: { id: 'proj_web', name }, previous_name: 'old-name' });
    },
  } = opts;
  respond.mockImplementation((method, path, body) => {
    if (method === 'GET' && path.startsWith('/projects')) return reply(200, { projects });
    if (method === 'PATCH' && path === '/orgs/org_1/projects/proj_web') return onRename(body);
    return reply(500, { error: 'unexpected request' });
  });
}

const git = (cwd: string, ...args: readonly string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

const originalCwd = process.cwd();
/** Every test folder lives under this one, removed when the file is done. */
const ROOT = mkdtempSync(join(tmpdir(), 'capy-rename-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function freshFolder(): string {
  const dir = join(ROOT, randomUUID());
  mkdirSync(dir);
  return dir;
}

/** A fresh temporary folder, entered for the test. `lock` is written as its keep.lock (none when null). */
function enterFolder(lock: string | null = serializeKeep(KEEP)): string {
  const dir = freshFolder();
  if (lock !== null) writeFileSync(join(dir, 'keep.lock'), lock);
  process.chdir(dir);
  return dir;
}

const lockOf = (dir: string, relative: string = 'keep.lock') => readFileSync(join(dir, relative), 'utf-8');
const renamedLock = (name: string) => serializeKeep({ ...KEEP, project_name: name });

/** A git repo whose origin is the given remote, with a keep.lock in `sub` (the repo root when empty). Entered. */
function enterRepo(remote: string, sub: string, currentName: string = 'old-name'): string {
  const root = freshFolder();
  git(root, 'init', '-q');
  git(root, 'remote', 'add', 'origin', remote);
  const dir = sub === '' ? root : join(root, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep.lock'), serializeKeep({ ...KEEP, project_name: currentName }));
  process.chdir(dir);
  return dir;
}

const { renameProjectCommand, renameProjectOptsFrom } = await import('../../src/commands/projectRenameCommand');

describe('capy projects rename', () => {
  beforeEach(() => {
    respond.mockReset();
    fakePrompt.mockClear();
    service();
  });
  afterEach(() => process.chdir(originalCwd));

  describe('success', () => {
    it('renames through the service, then changes project_name in keep.lock and nothing else; --json is pure JSON on stdout', async () => {
      const dir = enterFolder();
      const before = lockOf(dir);

      const out = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(out.exitCode).toBeUndefined();
      expect(renames()).toEqual([{ method: 'PATCH', path: '/orgs/org_1/projects/proj_web', body: JSON.stringify({ name: 'new-name' }) }]);
      expect(lockOf(dir)).toBe(before.replace('"project_name": "old-name"', '"project_name": "new-name"'));
      expect(lockOf(dir)).toBe(renamedLock('new-name'));
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        changed: true,
        project: { id: 'proj_web', name: 'new-name' },
        previous_name: 'old-name',
        keep_lock: { updated: ['keep.lock'] },
        org: { id: 'org_1', name: 'Acme' },
      });
      expect(out.stderr).toBe('');
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('also rewrites the working copy under .capy/ when there is one', async () => {
      const dir = enterFolder();
      mkdirSync(join(dir, '.capy'));
      writeFileSync(join(dir, '.capy', 'keep.lock'), serializeKeep(KEEP));

      const out = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(lockOf(dir)).toBe(renamedLock('new-name'));
      expect(lockOf(dir, '.capy/keep.lock')).toBe(renamedLock('new-name'));
      expect(JSON.parse(out.stdout).keep_lock.updated).toEqual(['keep.lock', '.capy/keep.lock']);
    });

    it('writes the name the service stored (trimmed), not the one typed', async () => {
      const dir = enterFolder();
      service({ onRename: () => reply(200, { ok: true, changed: true, project: { id: 'proj_web', name: 'stored' }, previous_name: 'old-name' }) });

      await capture(() => renameProjectCommand('typed', { json: true }));

      expect(lockOf(dir)).toBe(renamedLock('stored'));
    });

    it('when the service had nothing to change, still brings keep.lock to the service name', async () => {
      const dir = enterFolder(renamedLock('stale-local-name'));
      service({ onRename: () => reply(200, { ok: true, changed: false, project: { id: 'proj_web', name: 'new-name' } }) });

      const out = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, changed: false, project: { name: 'new-name' }, previous_name: 'stale-local-name' });
      expect(lockOf(dir)).toBe(renamedLock('new-name'));
    });

    it('in a terminal (no --json) prints prose on stdout and no JSON', async () => {
      enterFolder();
      const out = await capture(() => renameProjectCommand('new-name', {}));

      expect(out.exitCode).toBeUndefined();
      expect(out.stdout).toContain('new-name');
      expect(() => JSON.parse(out.stdout)).toThrow();
    });
  });

  describe('names', () => {
    it('accepts a monorepo-form name with `/`', async () => {
      const dir = enterFolder();
      service({ onRename: (b) => reply(200, { ok: true, changed: true, project: { id: 'proj_web', name: (JSON.parse(b) as { name: string }).name } }) });

      const out = await capture(() => renameProjectCommand('slidespeak-monorepo/backend', { json: true }));

      expect(out.exitCode).toBeUndefined();
      expect(renames().map((r) => JSON.parse(r.body))).toEqual([{ name: 'slidespeak-monorepo/backend' }]);
      expect(lockOf(dir)).toBe(renamedLock('slidespeak-monorepo/backend'));
    });

    const refused: ReadonlyArray<readonly [string, string, string]> = [
      ['an empty segment (double slash)', 'repo//backend', 'PROJECT_NAME_INVALID'],
      ['a leading slash', '/backend', 'PROJECT_NAME_INVALID'],
      ['a trailing slash', 'repo/', 'PROJECT_NAME_INVALID'],
      ['a segment with a space', 'repo/my backend', 'PROJECT_NAME_INVALID'],
      ['a segment with a dot', 'repo/back.end', 'PROJECT_NAME_INVALID'],
      ['a space in a plain name', 'has space', 'PROJECT_NAME_INVALID'],
      ['the reserved name', '_system', 'PROJECT_NAME_RESERVED'],
      ['the reserved name as a segment', 'repo/_system', 'PROJECT_NAME_RESERVED'],
      ['a name longer than the cap', 'a'.repeat(256), 'PROJECT_NAME_INVALID'],
      ['a monorepo name longer than the cap', `repo/${'a'.repeat(251)}`, 'PROJECT_NAME_INVALID'],
    ];
    for (const [label, name, code] of refused) {
      it(`refuses ${label} with ${code}, before anything is sent, keep.lock untouched`, async () => {
        const dir = enterFolder();
        const before = lockOf(dir);

        const out = await capture(() => renameProjectCommand(name, { json: true }));

        expect(out.exitCode).toBe(1);
        expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code });
        expect(requests()).toEqual([]);
        expect(lockOf(dir)).toBe(before);
      });
    }

    it('accepts a name exactly at the cap', async () => {
      enterFolder();
      const name = 'a'.repeat(255);
      const out = await capture(() => renameProjectCommand(name, { json: true }));

      expect(out.exitCode).toBeUndefined();
      expect(renames()).toHaveLength(1);
    });

    it('refuses a name another project has: the service code PROJECT_NAME_EXISTS, with the clashing project, keep.lock byte-identical', async () => {
      const dir = enterFolder();
      const before = lockOf(dir);
      service({
        onRename: () => reply(409, { error: 'already', code: 'PROJECT_NAME_EXISTS', existing_project: { id: 'proj_api', name: 'Api' } }),
      });

      const out = await capture(() => renameProjectCommand('api', { json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NAME_EXISTS', project: { id: 'proj_api', name: 'Api' } });
      expect(lockOf(dir)).toBe(before);
    });
  });

  describe('no project in the folder', () => {
    it('refuses with NO_KEEP_FILE, sends nothing', async () => {
      enterFolder(null);
      const out = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'NO_KEEP_FILE' });
      expect(requests()).toEqual([]);
    });

    it('refuses with NO_KEEP_FILE even with no name, before asking anything', async () => {
      enterFolder(null);
      const out = await capture(() => renameProjectCommand(undefined, { json: true }));

      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'NO_KEEP_FILE' });
      expect(requests()).toEqual([]);
    });
  });

  describe('a refusal by the service leaves keep.lock byte-identical', () => {
    const cases: ReadonlyArray<readonly [string, Reply, string]> = [
      ['not the owner (403)', reply(403, { error: 'owner only', code: 'PROJECT_DELETE_OWNER_ONLY' }), 'PROJECT_DELETE_OWNER_ONLY'],
      ['the system store (403)', reply(403, { error: 'system', code: 'SYSTEM_STORE_IMMUTABLE' }), 'SYSTEM_STORE_IMMUTABLE'],
      ['another organization (403)', reply(403, { error: 'no', code: 'PERMISSION_DENIED' }), 'PERMISSION_DENIED'],
      ['a deleted project (410)', reply(410, { error: 'gone', code: 'PROJECT_DELETED' }), 'PROJECT_DELETED'],
      ['an unknown project (404)', reply(404, { error: 'missing', code: 'PROJECT_NOT_FOUND' }), 'PROJECT_NOT_FOUND'],
      ['a name the service refuses (400)', reply(400, { error: 'bad', code: 'PROJECT_NAME_INVALID' }), 'PROJECT_NAME_INVALID'],
      ['the reserved name (400)', reply(400, { error: 'reserved', code: 'PROJECT_NAME_RESERVED' }), 'PROJECT_NAME_RESERVED'],
      ['a failure (500)', reply(500, { error: 'boom', code: 'SERVICE_ERROR' }), 'SERVICE_ERROR'],
      ['a service without the route (404, no code)', reply(404, {}), 'SERVICE_ERROR'],
    ];
    for (const [label, answer, code] of cases) {
      it(`${label}: refuses with ${code}`, async () => {
        const dir = enterFolder();
        mkdirSync(join(dir, '.capy'));
        writeFileSync(join(dir, '.capy', 'keep.lock'), serializeKeep(KEEP));
        const before = [lockOf(dir), lockOf(dir, '.capy/keep.lock')];
        service({ onRename: () => answer });

        const out = await capture(() => renameProjectCommand('new-name', { json: true }));

        expect(out.exitCode).toBe(1);
        expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code });
        expect([lockOf(dir), lockOf(dir, '.capy/keep.lock')]).toEqual(before);
      });
    }

    it('the human refusal goes to stderr, nothing to stdout', async () => {
      enterFolder();
      service({ onRename: () => reply(403, { error: 'owner only', code: 'PROJECT_DELETE_OWNER_ONLY' }) });

      const out = await capture(() => renameProjectCommand('new-name', {}));

      expect(out.exitCode).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).not.toBe('');
    });
  });

  describe('a keep.lock copy that cannot be rewritten is found out before the service is called', () => {
    const unreadable: ReadonlyArray<readonly [string, string, 'tracked' | 'working']> = [
      ['the tracked copy is not JSON', '{ not json', 'tracked'],
      ['the working copy is not JSON', '{ not json', 'working'],
      ['the tracked copy is not an object', '[]', 'tracked'],
      ['the working copy has no variables key', JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_web', project_name: 'old-name' }), 'working'],
      ['the tracked copy has no variables key', JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_web', project_name: 'old-name' }), 'tracked'],
    ];
    for (const [label, bad, which] of unreadable) {
      for (const dryRun of [false, true]) {
        it(`${label}${dryRun ? ' (dry run)' : ''}: INVALID_FORMAT, no request at all, both files byte-identical`, async () => {
          const dir = enterFolder(which === 'tracked' ? bad : serializeKeep(KEEP));
          mkdirSync(join(dir, '.capy'));
          writeFileSync(join(dir, '.capy', 'keep.lock'), which === 'working' ? bad : serializeKeep(KEEP));
          const before = [lockOf(dir), lockOf(dir, '.capy/keep.lock')];

          const out = await capture(() => renameProjectCommand('new-name', { json: true, dryRun }));

          // A tracked copy that is not JSON is already refused when the folder is read; both are coded, before any request.
          expect(out.exitCode).toBe(1);
          expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
          expect(JSON.parse(out.stdout).renamed).toBeUndefined();
          expect(requests()).toEqual([]);
          expect([lockOf(dir), lockOf(dir, '.capy/keep.lock')]).toEqual(before);
        });
      }
    }
  });

  describe('when keep.lock cannot be written after the service renamed', () => {
    it('refuses with KEEP_LOCK_UPDATE_FAILED and says the project was renamed; a re-run repairs the file', async () => {
      if (process.getuid?.() === 0) return; // root writes through a read-only file
      const dir = enterFolder();
      const path = join(dir, 'keep.lock');
      const before = lockOf(dir);
      chmodSync(path, 0o444);

      const out = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({
        ok: false,
        code: 'KEEP_LOCK_UPDATE_FAILED',
        renamed: true,
        project: { id: 'proj_web', name: 'new-name' },
        previous_name: 'old-name',
      });
      expect(renames()).toHaveLength(1);
      expect(lockOf(dir)).toBe(before);

      // The file is writable again: the same command, run once more, finishes the job (the service has nothing to change).
      chmodSync(path, 0o644);
      service({ onRename: () => reply(200, { ok: true, changed: false, project: { id: 'proj_web', name: 'new-name' } }) });
      const again = await capture(() => renameProjectCommand('new-name', { json: true }));

      expect(again.exitCode).toBeUndefined();
      expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, changed: false });
      expect(lockOf(dir)).toBe(renamedLock('new-name'));
    });
  });

  describe('a 200 from the service that is not the renamed project', () => {
    const malformed: ReadonlyArray<readonly [string, Reply]> = [
      ['{ok:true} with no project', reply(200, { ok: true })],
      ['a null body', reply(200, null)],
      ['an array body', reply(200, [])],
      ['a project with no name', reply(200, { ok: true, changed: true, project: { id: 'proj_web' } })],
      ['a project with an empty name', reply(200, { ok: true, changed: true, project: { id: 'proj_web', name: '' } })],
      ['a project with no id', reply(200, { ok: true, changed: true, project: { name: 'new-name' } })],
      ['another project', reply(200, { ok: true, changed: true, project: { id: 'proj_api', name: 'new-name' } })],
      ['a body that is not JSON', rawReply(200, '<html>gateway</html>')],
      ['an empty body', rawReply(200, '')],
    ];
    for (const [label, answer] of malformed) {
      it(`${label}: SERVICE_ERROR, never "renamed", keep.lock untouched`, async () => {
        const dir = enterFolder();
        mkdirSync(join(dir, '.capy'));
        writeFileSync(join(dir, '.capy', 'keep.lock'), serializeKeep(KEEP));
        const before = [lockOf(dir), lockOf(dir, '.capy/keep.lock')];
        service({ onRename: () => answer });

        const out = await capture(() => renameProjectCommand('new-name', { json: true }));

        expect(out.exitCode).toBe(1);
        const body = JSON.parse(out.stdout);
        expect(body).toMatchObject({ ok: false, code: 'SERVICE_ERROR' });
        expect(body.renamed).toBeUndefined();
        expect(renames()).toHaveLength(1);
        expect([lockOf(dir), lockOf(dir, '.capy/keep.lock')]).toEqual(before);
      });
    }
  });

  describe('--dry-run', () => {
    it('changes nothing on the server or on disk, and says what would change', async () => {
      const dir = enterFolder();
      const before = lockOf(dir);

      const out = await capture(() => renameProjectCommand('new-name', { json: true, dryRun: true }));

      expect(out.exitCode).toBeUndefined();
      expect(renames()).toEqual([]);
      expect(requests().every((r) => r.method === 'GET')).toBe(true);
      expect(lockOf(dir)).toBe(before);
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        dry_run: true,
        project: { id: 'proj_web', name: 'old-name' },
        new_name: 'new-name',
        changed: true,
        keep_lock: { would_update: ['keep.lock'] },
        org: { id: 'org_1', name: 'Acme' },
      });
    });

    it('in a terminal says in prose that nothing was changed', async () => {
      enterFolder();
      const out = await capture(() => renameProjectCommand('new-name', { dryRun: true }));

      expect(out.stdout).toContain('Nothing was changed');
      expect(renames()).toEqual([]);
    });

    it('refuses a name another live project has, as the real run would, still changing nothing', async () => {
      const dir = enterFolder();
      const before = lockOf(dir);

      const taken = await capture(() => renameProjectCommand('api', { json: true, dryRun: true }));

      expect(taken.exitCode).toBe(1);
      expect(JSON.parse(taken.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NAME_EXISTS', project: { id: 'proj_api', name: 'Api' } });
      expect(renames()).toEqual([]);
      expect(lockOf(dir)).toBe(before);
    });

    it('does not count a project of another organization, nor itself', async () => {
      enterFolder();
      const other = await capture(() => renameProjectCommand('elsewhere', { json: true, dryRun: true }));
      const itself = await capture(() => renameProjectCommand('OLD-NAME', { json: true, dryRun: true }));

      expect(JSON.parse(other.stdout)).toMatchObject({ ok: true, dry_run: true });
      expect(JSON.parse(itself.stdout)).toMatchObject({ ok: true, dry_run: true });
    });

    it('refuses with PROJECT_NOT_FOUND when the service does not list the project', async () => {
      enterFolder();
      service({ projects: [{ id: 'proj_api', name: 'Api', organization_id: 'org_1' }] });

      const out = await capture(() => renameProjectCommand('new-name', { json: true, dryRun: true }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' });
    });

    it('refuses an invalid name the same way, with nothing sent', async () => {
      enterFolder();
      const out = await capture(() => renameProjectCommand('has space', { json: true, dryRun: true }));

      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NAME_INVALID' });
      expect(requests()).toEqual([]);
    });
  });

  describe('with no name', () => {
    it('refuses with PROJECT_NAME_REQUIRED (exit 3) and a form, never opening a prompt, changing nothing', async () => {
      const dir = enterFolder();
      const before = lockOf(dir);

      const out = await capture(() => renameProjectCommand(undefined, { json: true }));

      expect(out.exitCode).toBe(3);
      const body = JSON.parse(out.stdout);
      expect(body).toMatchObject({
        ok: false,
        code: 'PROJECT_NAME_REQUIRED',
        project: { id: 'proj_web', name: 'old-name' },
        org: { id: 'org_1', name: 'Acme' },
        elicitation: { kind: 'form', answer: { rerun: 'capy projects rename <name> --json' } },
      });
      expect(body.elicitation.fields).toHaveLength(1);
      expect(body.elicitation.fields[0]).toMatchObject({ name: 'name', type: 'string' });
      expect(new RegExp(body.elicitation.fields[0].pattern).test('slidespeak-monorepo/backend')).toBe(true);
      expect(new RegExp(body.elicitation.fields[0].pattern).test('a b')).toBe(false);
      expect(body.elicitation.display).toContain('| Org | Acme |');
      expect(renames()).toEqual([]);
      expect(lockOf(dir)).toBe(before);
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('offers nothing as the default outside a git repo', async () => {
      enterFolder();
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBeUndefined();
    });

    it('offers the monorepo name of a subfolder as the default', async () => {
      enterRepo('git@github.com:SlideSpeak/slidespeak-monorepo.git', 'backend');
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBe('slidespeak-monorepo/backend');
      expect(body.elicitation.display).toContain('| New name | slidespeak-monorepo/backend |');
    });

    it('offers a nested subfolder with each segment on its own', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'services/Back End');
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBe('slidespeak-monorepo/services/back-end');
    });

    it('offers just the repo name at the repo root', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', '');
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBe('slidespeak-monorepo');
    });

    it('does not offer a default that another live project has, ignoring case', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'backend');
      service({ projects: [...LISTING, { id: 'proj_taken', name: 'SlideSpeak-Monorepo/Backend', organization_id: 'org_1' }] });
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBeUndefined();
    });

    it('does not offer a default that is the name the project already has', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'backend', 'slidespeak-monorepo/backend');
      service({ projects: [{ id: 'proj_web', name: 'slidespeak-monorepo/backend', organization_id: 'org_1' }] });
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBeUndefined();
    });

    it('does not count a same-named project of another organization as taking the default', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'backend');
      service({ projects: [...LISTING, { id: 'proj_x', name: 'slidespeak-monorepo/backend', organization_id: 'org_2' }] });
      const body = JSON.parse((await capture(() => renameProjectCommand(undefined, { json: true }))).stdout);

      expect(body.elicitation.fields[0].default).toBe('slidespeak-monorepo/backend');
    });

    it('in a terminal (no --json) refuses on stderr with the suggestion, still no prompt', async () => {
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'backend');
      const out = await capture(() => renameProjectCommand(undefined, {}));

      expect(out.exitCode).toBe(3);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('slidespeak-monorepo/backend');
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('a dry run with no name is the same refusal', async () => {
      enterFolder();
      const out = await capture(() => renameProjectCommand(undefined, { json: true, dryRun: true }));

      expect(out.exitCode).toBe(3);
      expect(JSON.parse(out.stdout)).toMatchObject({ code: 'PROJECT_NAME_REQUIRED' });
    });
  });

  describe('--project names the project, from any folder', () => {
    /** A service that also renames `proj_api`, and lists `projects`. */
    function serviceFor(projects: readonly object[] = LISTING) {
      respond.mockImplementation((method, path, body) => {
        if (method === 'GET' && path.startsWith('/projects')) return reply(200, { projects });
        if (method === 'PATCH' && path === '/orgs/org_1/projects/proj_api') {
          const { name } = JSON.parse(body) as { name: string };
          return reply(200, { ok: true, changed: true, project: { id: 'proj_api', name }, previous_name: 'Api' });
        }
        if (method === 'PATCH' && path === '/orgs/org_1/projects/proj_web') {
          const { name } = JSON.parse(body) as { name: string };
          return reply(200, { ok: true, changed: true, project: { id: 'proj_web', name }, previous_name: 'old-name' });
        }
        return reply(500, { error: 'unexpected request' });
      });
    }

    it('by name, in a folder with no keep.lock: renames through the service and writes no file', async () => {
      serviceFor();
      const dir = enterFolder(null);

      const out = await capture(() => renameProjectCommand('new-api', { json: true, project: 'Api' }));

      expect(out.exitCode).toBeUndefined();
      expect(renames()).toEqual([{ method: 'PATCH', path: '/orgs/org_1/projects/proj_api', body: JSON.stringify({ name: 'new-api' }) }]);
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        changed: true,
        project: { id: 'proj_api', name: 'new-api' },
        previous_name: 'Api',
        keep_lock: { updated: [] },
        org: { id: 'org_1', name: 'Acme' },
      });
      expect(readdirSync(dir)).toEqual([]);
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('by id', async () => {
      serviceFor();
      enterFolder(null);

      const out = await capture(() => renameProjectCommand('new-api', { json: true, project: 'proj_api' }));

      expect(out.exitCode).toBeUndefined();
      expect(renames().map((r) => r.path)).toEqual(['/orgs/org_1/projects/proj_api']);
      expect(JSON.parse(out.stdout).project).toEqual({ id: 'proj_api', name: 'new-api' });
    });

    it('in a folder of another project: that folder\'s keep.lock is byte-identical', async () => {
      serviceFor();
      const dir = enterFolder();
      const before = lockOf(dir);

      const out = await capture(() => renameProjectCommand('new-api', { json: true, project: 'Api' }));

      expect(out.exitCode).toBeUndefined();
      expect(renames().map((r) => r.path)).toEqual(['/orgs/org_1/projects/proj_api']);
      expect(lockOf(dir)).toBe(before);
      expect(JSON.parse(out.stdout).keep_lock).toEqual({ updated: [] });
    });

    it('in the folder of that same project: keep.lock follows the new name', async () => {
      serviceFor();
      const dir = enterFolder();

      const out = await capture(() => renameProjectCommand('new-name', { json: true, project: 'proj_web' }));

      expect(out.exitCode).toBeUndefined();
      expect(lockOf(dir)).toBe(renamedLock('new-name'));
      expect(JSON.parse(out.stdout).keep_lock).toEqual({ updated: ['keep.lock'] });
    });

    it('a name no project of this organization has is PROJECT_NOT_FOUND, and nothing is sent', async () => {
      serviceFor();
      enterFolder(null);

      const out = await capture(() => renameProjectCommand('new-name', { json: true, project: 'elsewhere' }));

      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' });
      expect(renames()).toEqual([]);
    });

    it('several projects with that name is PROJECT_AMBIGUOUS (exit 3) with a pick-one elicitation, and nothing is sent', async () => {
      serviceFor([
        { id: 'proj_api', name: 'Api', organization_id: 'org_1' },
        { id: 'proj_api_2', name: 'Api', organization_id: 'org_1' },
      ]);
      enterFolder(null);

      const out = await capture(() => renameProjectCommand('new-api', { json: true, project: 'Api' }));

      expect(out.exitCode).toBe(3);
      const body = JSON.parse(out.stdout);
      expect(body).toMatchObject({ ok: false, code: 'PROJECT_AMBIGUOUS' });
      expect(body.elicitation.answer.rerun).toBe('capy projects rename new-api --project <project> --json');
      expect(body.elicitation.fields[0].options.map((o: { value: string }) => o.value).sort()).toEqual(['proj_api', 'proj_api_2']);
      expect(renames()).toEqual([]);
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('--dry-run says what would change and sends no rename', async () => {
      serviceFor();
      enterFolder(null);

      const out = await capture(() => renameProjectCommand('new-api', { json: true, dryRun: true, project: 'Api' }));

      expect(out.exitCode).toBeUndefined();
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        dry_run: true,
        project: { id: 'proj_api', name: 'Api' },
        new_name: 'new-api',
        changed: true,
        keep_lock: { would_update: [] },
        org: { id: 'org_1', name: 'Acme' },
      });
      expect(renames()).toEqual([]);
    });

    it('with no name: PROJECT_NAME_REQUIRED, the rerun carries the project id, and no name is suggested', async () => {
      serviceFor();
      enterRepo('git@github.com:slidespeak/slidespeak-monorepo.git', 'backend');

      const out = await capture(() => renameProjectCommand(undefined, { json: true, project: 'Api' }));

      expect(out.exitCode).toBe(3);
      const body = JSON.parse(out.stdout);
      expect(body).toMatchObject({ ok: false, code: 'PROJECT_NAME_REQUIRED', project: { id: 'proj_api', name: 'Api' } });
      expect(body.elicitation.answer.rerun).toBe('capy projects rename <name> --project proj_api --json');
      expect(body.elicitation.fields[0].default).toBeUndefined();
      expect(renames()).toEqual([]);
    });

    it('a name that breaks the rule is refused before anything is sent', async () => {
      serviceFor();
      enterFolder(null);

      const out = await capture(() => renameProjectCommand('bad name!', { json: true, project: 'Api' }));

      expect(out.exitCode).toBe(1);
      expect(requests()).toEqual([]);
    });

    it('the option is read from the merged view', () => {
      expect(renameProjectOptsFrom({ optsWithGlobals: () => ({ project: 'Api' }) }).project).toBe('Api');
    });
  });

  describe('options', () => {
    it('--non-tty means --json, and --dry-run is read from the merged view', () => {
      const opts = renameProjectOptsFrom({ optsWithGlobals: () => ({ nonTty: true, dryRun: true }) });

      expect(opts).toEqual({ json: true, nonTty: true, dryRun: true });
    });

    it('defaults to a real, human run', () => {
      expect(renameProjectOptsFrom({ optsWithGlobals: () => ({}) })).toEqual({ json: false, nonTty: false, dryRun: false });
    });
  });
});
