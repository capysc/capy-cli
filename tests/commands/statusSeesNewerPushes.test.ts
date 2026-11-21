import { mock, spyOn, describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CAP-858: `capy status` must see what Capy holds NOW for the branch, not what the folder already has.
 *
 * Two folders share a project and branch; one pushes; the other runs `status`. The real `StatusCommand` runs in a
 * real folder on disk. Only its edges are faked: the key (`resolveProjectKey`), the sign-in (`authenticateSilent`)
 * and the service (`getDecryptData`, served by the in-memory fake server the commit tests use). Exit, stdout and
 * stderr are captured the way a script reading the command would see them.
 */
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(async () => KEY),
}));

import { StatusCommand, remoteChangesOf } from '../../src/commands/statusCommand';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { Encryptor } from '../../src/crypto/encryptor';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import { fakeCapyServer, pushOf, seedServer } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder } from '../helpers/folderWorld';
import { withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const KEY = Encryptor.generateKey();
const DEV = 'development';
/** A value that must never appear in anything `status` prints. */
const SECRET = 'plaintext-that-must-not-leak-7f3a';

const SEED = seedServer({ projectKey: KEY, values: { [DEV]: { KEPT: 'k-1', CHANGES: 'c-1', GOES: 'g-1' } } });

afterAll(() => mock.restore());

/** Folder A, pinned to and holding exactly what the server holds, plus a fake Capy that other folders can push to. */
function world() {
  const server = fakeCapyServer({ initial: SEED });
  const folder = makeFolder({
    projectKey: KEY,
    branch: DEV,
    keep: SEED.keep as KeepFile,
    env: { KEPT: 'k-1', CHANGES: 'c-1', GOES: 'g-1' },
    client: server.client,
  });
  return { server, folder };
}

/** What another folder pushes: the branch now holds exactly `values`. */
const pushFromFolderB = (values: Record<string, string>) => pushOf({ projectKey: KEY, branch: DEV, values });

const ANSI = /\x1b\[[0-9;]*m/g;
const render = (calls: readonly unknown[][]): string => calls.map((args) => args.map(String).join(' ')).join('\n').replace(ANSI, '');

/** Runs `fn` as the CLI would in `dir`: cwd, sign-in and the service are the fakes; stdout, stderr and exit are captured. */
async function runIn(
  dir: string,
  getDecryptData: (...args: unknown[]) => Promise<unknown>,
  fn: () => Promise<void>,
) {
  return withIsolatedGlobalDir(async () => {
    const cwd = spyOn(process, 'cwd').mockReturnValue(dir);
    const auth = spyOn(AuthService.prototype, 'authenticateSilent').mockResolvedValue({ success: true, user_id: 'user-a' } as never);
    const service = spyOn(ServiceClient.prototype, 'getDecryptData').mockImplementation(getDecryptData as never);
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fn();
      return {
        stdout: render(log.mock.calls),
        stderr: render(err.mock.calls),
        exitCodes: exit.mock.calls.map(([code]) => code),
        serviceCalls: service.mock.calls,
      };
    } finally {
      [cwd, auth, service, exit, log, err].forEach((spy) => spy.mockRestore());
    }
  });
}

const statusJson = async (w: ReturnType<typeof world>) => {
  const run = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand().execute({ json: true }));
  return { run, report: JSON.parse(run.stdout) };
};

describe('status reads what Capy holds now, not what the folder already has', () => {
  test('control: nothing pushed since this folder last synced is in sync, with no changes on Capy', async () => {
    const w = world();
    const { report } = await statusJson(w);
    expect(report.inSync).toBe(true);
    expect(report.remoteMatchesPinned).toBe(true);
    expect(report.remoteHasChanges).toBe(false);
    expect(report.remoteChanges).toEqual({ new: [], changed: [], removed: [] });
    removeFolder(w.folder);
  });

  test('a variable pushed from another folder is reported as new on Capy, and the folder is not in sync', async () => {
    const w = world();
    w.server.tape(pushFromFolderB({ KEPT: 'k-1', CHANGES: 'c-1', GOES: 'g-1', FROM_B: SECRET }));

    const { run, report } = await statusJson(w);

    expect(report.inSync).toBe(false);
    expect(report.remoteMatchesPinned).toBe(false);
    expect(report.localMatchesPinned).toBe(true);
    expect(report.remoteHasChanges).toBe(true);
    expect(report.remoteChanges).toEqual({ new: ['FROM_B'], changed: [], removed: [] });
    expect(report.remoteFailure).toBeNull();
    // Hashes only: the value that was pushed is nowhere in the output.
    expect(run.stdout).not.toContain(SECRET);
    removeFolder(w.folder);
  });

  test('a value changed and a name removed on Capy are reported as changed and removed', async () => {
    const w = world();
    w.server.tape(pushFromFolderB({ KEPT: 'k-1', CHANGES: SECRET }));

    const { run, report } = await statusJson(w);

    expect(report.remoteChanges).toEqual({ new: [], changed: ['CHANGES'], removed: ['GOES'] });
    expect(report.inSync).toBe(false);
    expect(run.stdout).not.toContain(SECRET);
    removeFolder(w.folder);
  });

  test('asks for the latest of the branch (no pinned keep_hash), the way bare capy does', async () => {
    const w = world();
    const { run } = await statusJson(w);
    expect(run.serviceCalls).toHaveLength(1);
    const [projectId, branch, keepHash, includeLatest] = run.serviceCalls[0] as unknown[];
    expect([projectId, branch, keepHash, includeLatest]).toEqual(['proj', DEV, undefined, true]);
    removeFolder(w.folder);
  });

  test('the human screen says Capy has changes and what to run, and still prints no value', async () => {
    const w = world();
    w.server.tape(pushFromFolderB({ KEPT: 'k-1', CHANGES: 'c-1', GOES: 'g-1', FROM_B: SECRET }));

    const run = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand().execute());

    expect(run.stdout).toContain('Remote has changes (1 difference)');
    expect(run.stdout).toContain('FROM_B');
    expect(run.stdout).toContain('(new on remote)');
    expect(run.stdout).not.toContain(SECRET);
    removeFolder(w.folder);
  });
});

describe('status from a git hook (terse)', () => {
  test('stays silent when Capy has nothing this folder lacks', async () => {
    const w = world();
    const run = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand(true).execute());
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    removeFolder(w.folder);
  });

  test('says one line when Capy has newer pushes', async () => {
    const w = world();
    w.server.tape(pushFromFolderB({ KEPT: 'k-1', CHANGES: 'c-1', GOES: 'g-1', FROM_B: SECRET }));
    const run = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand(true).execute());
    expect(run.stdout.split('\n')).toHaveLength(1);
    expect(run.stdout).toContain('1 secret differs from remote');
    expect(run.stdout).not.toContain(SECRET);
    removeFolder(w.folder);
  });

  test('bounds its wait on Capy to seconds, where a normal run keeps the client default', async () => {
    const w = world();
    const terse = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand(true).execute());
    const normal = await runIn(w.folder.dir, w.server.getDecryptData, () => new StatusCommand().execute({ json: true }));
    expect((terse.serviceCalls[0] as unknown[])[5]).toBe(3000);
    expect((normal.serviceCalls[0] as unknown[])[5]).toBeUndefined();
    removeFolder(w.folder);
  });

  test('with the network down: prints nothing, does not fail, and reports no change', async () => {
    const w = world();
    const down = async () => {
      throw new CapyError('Cannot reach Capy', ERROR_CODES.NETWORK_ERROR);
    };
    const run = await runIn(w.folder.dir, down, () => new StatusCommand(true).execute());
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(run.exitCodes.filter((code) => code !== 0)).toEqual([]);
    removeFolder(w.folder);
  });

  test('with the network down, --json still reports remoteFailure and no changes on Capy', async () => {
    const w = world();
    const down = async () => {
      throw new CapyError('Cannot reach Capy', ERROR_CODES.NETWORK_ERROR);
    };
    const run = await runIn(w.folder.dir, down, () => new StatusCommand().execute({ json: true }));
    const report = JSON.parse(run.stdout);
    expect(report.remoteFailure).toBe('network_error');
    expect(report.remoteHasChanges).toBe(false);
    expect(report.inSync).toBe(true);
    removeFolder(w.folder);
  });
});

describe('status in a folder with no keep.lock', () => {
  test('--json prints a coded result and exits 1, not a sentence and 0', async () => {
    await withTempDir('capy-status-empty', async (dir) => {
      const w = world();
      const run = await runIn(dir, w.server.getDecryptData, () => new StatusCommand().execute({ json: true }));
      const result = JSON.parse(run.stdout);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ERROR_CODES.NO_KEEP_FILE);
      expect(typeof result.error).toBe('string');
      expect(run.exitCodes[0]).toBe(1);
      expect(run.serviceCalls).toHaveLength(0);
      removeFolder(w.folder);
    });
  });

  test('without --json the plain sentence is unchanged, and the hook form stays silent', async () => {
    await withTempDir('capy-status-empty', async (dir) => {
      const w = world();
      const human = await runIn(dir, w.server.getDecryptData, () => new StatusCommand().execute());
      expect(human.stdout).toContain('No keep.lock found');
      expect(human.exitCodes).toEqual([]);
      const terse = await runIn(dir, w.server.getDecryptData, () => new StatusCommand(true).execute({ json: true }));
      expect(terse.stdout).toBe('');
      expect(terse.exitCodes).toEqual([]);
      removeFolder(w.folder);
    });
  });
});

describe('remoteChangesOf', () => {
  test('sorts diffs by what Capy did: new, changed, removed; a row only this folder changed is not on Capy', () => {
    const changes = remoteChangesOf([
      { variable: 'NEW', type: 'new', remote: 'r' },
      { variable: 'CHG', type: 'changed', pinned: 'p', local: 'p', remote: 'r' },
      { variable: 'GONE', type: 'deleted', pinned: 'p', local: 'p' },
      { variable: 'MINE', type: 'changed', pinned: 'p', local: 'l', remote: 'p' },
    ]);
    expect(changes).toEqual({ new: ['NEW'], changed: ['CHG'], removed: ['GONE'] });
  });
});
