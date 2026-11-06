import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A folder whose keep.lock points at a deleted project (CAP-729).
 *
 * The REAL `ServiceClient` asks a local fake of the service for the folder's
 * secrets and gets the 410 / 404 the service sends. What comes out is judged
 * as a person or an agent would see it:
 *   - the "Project deleted" screen: the name, the id, the restore command, and
 *     that only an owner can restore it;
 *   - NO "recreate" advice, which belongs to PROJECT_NOT_FOUND only (the control
 *     test below proves the check can see that advice);
 *   - the folder untouched: keep.lock is byte-identical and no file appeared;
 *   - the code `PROJECT_DELETED` in `--json` and as the process's exit.
 */

import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError } from '../../src/types/index';
import { renderError, displayErrorAndExit } from '../../src/ui/errorScreen';
import { gateFirst, type SyncRunner } from '../../src/sync/gate';

const KEEP_LOCK = JSON.stringify(
  { version: 1, org_id: 'org_1', project_id: 'proj_web', project_name: 'web', variables: {} },
  null,
  2,
) + '\n';

const DELETED = { status: 410, body: { error: 'This project has been deleted', code: 'PROJECT_DELETED' } };
const MISSING = { status: 404, body: { error: 'Project not found', code: 'PROJECT_NOT_FOUND' } };

const answer = mock((): { status: number; body: unknown } => DELETED);

const server = Bun.serve({
  port: 0,
  fetch() {
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  },
});
afterAll(() => {
  server.stop(true);
  mock.restore();
});

const client = new ServiceClient(`http://localhost:${server.port}`);
client.setTokenProvider((async () => ({ access_token: 'test-token' })) as never);

/** The error the real client throws for this folder's project. */
const errorFromService = (): Promise<CapyError> =>
  client.getDecryptData('proj_web', 'development').then(
    () => {
      throw new Error('expected the service to refuse');
    },
    (err: unknown) => err as CapyError,
  );

/** A fresh folder holding just a keep.lock. */
const makeFolder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'capy-deleted-'));
  writeFileSync(join(dir, 'keep.lock'), KEEP_LOCK);
  return dir;
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

/** Runs `fn` with `dir` as the working directory, capturing stdout/stderr/exit. */
async function inFolder(dir: string, fn: () => Promise<unknown>) {
  const cwdSpy = spyOn(process, 'cwd').mockReturnValue(dir);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);
  const stdout = strip(logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n'));
  const stderr = strip(errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n'));
  const exitCode = exitSpy.mock.calls.length > 0 ? (exitSpy.mock.calls[exitSpy.mock.calls.length - 1][0] as number | undefined) : undefined;
  cwdSpy.mockRestore();
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { stdout, stderr, exitCode };
}

const setTTY = (value: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

describe('a folder whose project was deleted', () => {
  beforeEach(() => {
    answer.mockReset();
    answer.mockImplementation(() => DELETED);
    setTTY(true);
  });

  it('the real client mints PROJECT_DELETED from the 410 (its code, not its text)', async () => {
    const err = await errorFromService();

    expect(err).toBeInstanceOf(CapyError);
    expect(err.code).toBe('PROJECT_DELETED');
    expect(err.details.status).toBe(410);
  });

  it('the screen says Project deleted, names the project, and gives the restore command and the owner note', async () => {
    const err = await errorFromService();

    const screen = strip(renderError(err, { projectName: 'web', projectId: 'proj_web' }));

    expect(screen).toContain('Project deleted');
    expect(screen).toContain('web');
    expect(screen).toContain('proj_web');
    expect(screen).toContain('capy org restore-project proj_web');
    expect(screen.toLowerCase()).toContain('only an owner');
  });

  it('with no context, the name and id come from keep.lock', async () => {
    const dir = makeFolder();
    const err = await errorFromService();

    const out = await inFolder(dir, async () => displayErrorAndExit(err));

    expect(out.stdout).toContain('Project deleted');
    expect(out.stdout).toContain('"web"');
    expect(out.stdout).toContain('capy org restore-project proj_web');
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers no recreate, and never the project-not-found advice', async () => {
    const dir = makeFolder();
    const err = await errorFromService();

    const out = await inFolder(dir, async () => displayErrorAndExit(err));

    const text = out.stdout.toLowerCase();
    expect(text).not.toContain('recreate');
    expect(text).not.toContain('re-initialize');
    expect(text).not.toContain('project not found');
    expect(text).not.toContain('delete keep.lock');
    rmSync(dir, { recursive: true, force: true });
  });

  it('control: the same check does see the recreate advice on a PROJECT_NOT_FOUND', async () => {
    answer.mockImplementation(() => MISSING);
    const err = await errorFromService();

    const screen = strip(renderError(err, { projectName: 'web', projectId: 'proj_web' })).toLowerCase();

    expect(err.code).toBe('PROJECT_NOT_FOUND');
    expect(screen).toContain('recreate');
  });

  it('exits non-zero', async () => {
    const dir = makeFolder();
    const err = await errorFromService();

    const out = await inFolder(dir, async () => displayErrorAndExit(err));

    expect(out.exitCode).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keep.lock is byte-identical afterwards and no file appeared in the folder', async () => {
    const dir = makeFolder();
    const before = readFileSync(join(dir, 'keep.lock'));
    const filesBefore = readdirSync(dir).toSorted();
    const err = await errorFromService();

    await inFolder(dir, async () => displayErrorAndExit(err));

    expect(readFileSync(join(dir, 'keep.lock')).equals(before)).toBe(true);
    expect(readdirSync(dir).toSorted()).toEqual(filesBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a command run with --json reports the code PROJECT_DELETED, exits 1, and leaves keep.lock alone', async () => {
    const dir = makeFolder();
    const before = readFileSync(join(dir, 'keep.lock'));
    const filesBefore = readdirSync(dir).toSorted();
    // The gate every folder command runs first; its sync reaches the service for this folder's project.
    const sync: SyncRunner = async () => {
      throw await errorFromService();
    };

    const out = await inFolder(dir, () => gateFirst({ json: true }, sync));

    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_DELETED' });
    expect(readFileSync(join(dir, 'keep.lock')).equals(before)).toBe(true);
    expect(readdirSync(dir).toSorted()).toEqual(filesBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a command run in a terminal shows the Project deleted screen and exits 1', async () => {
    const dir = makeFolder();
    const sync: SyncRunner = async () => {
      throw await errorFromService();
    };

    const out = await inFolder(dir, () => gateFirst({}, sync));

    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain('Project deleted');
    expect(out.stdout).toContain('capy org restore-project proj_web');
    expect(out.stdout.toLowerCase()).not.toContain('recreate');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a command run off a terminal ends with the code PROJECT_DELETED on stderr and exit 1', async () => {
    setTTY(false);
    const dir = makeFolder();
    const sync: SyncRunner = async () => {
      throw await errorFromService();
    };

    const out = await inFolder(dir, () => gateFirst({}, sync));

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('PROJECT_DELETED');
    rmSync(dir, { recursive: true, force: true });
  });
});
