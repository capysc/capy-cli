/**
 * Bare `capy` as the first step of a command (src/sync/gate.ts). The runner is injected, so these are about the loop
 * and what the gate does with its answers, not about Keep (that is tests/commands/conflictProtocol.test.ts through the
 * built cli, and tests/commands/bareCapyCommit.test.ts through `CapyCommand`).
 */
import { describe, test, expect, spyOn, mock, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import type { SyncOutcome } from '../../src/commands/capyCommand';
import { conflictRefusalFor, sourceRowsOf } from '../../src/sync/conflicts';
import { FOLDER_SYNC_STOPPED, answersByProtocol, commitGated, ensureInSync, gateFirst, stopWithNothingWritten, syncFolder, type SyncRunner } from '../../src/sync/gate';
import { hashValue } from '../../src/sync/compareSecrets';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import { fakeCapyServer, pushOf, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

/** A runner that answers with `outcomes` in order, and counts how often it was asked. */
function runnerOf(...outcomes: readonly SyncOutcome[]) {
  const asked = mock((_protocol: boolean) => undefined);
  const run: SyncRunner = async (_opts, protocol) => {
    asked(protocol);
    const outcome = outcomes[asked.mock.calls.length - 1];
    if (outcome === undefined) throw new Error('the runner was asked more often than the test scripted');
    return outcome;
  };
  return { run, asked };
}

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}
const exiting = () =>
  spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);

describe('ensureInSync', () => {
  test('in sync at once: one pass, in-sync', async () => {
    const r = runnerOf('up-to-date');
    expect(await ensureInSync({}, r.run)).toBe('in-sync');
    expect(r.asked).toHaveBeenCalledTimes(1);
  });

  test('the person cancels or chooses "Continue working": stopped, and no second pass', async () => {
    const r = runnerOf('stopped');
    expect(await ensureInSync({}, r.run)).toBe('stopped');
    expect(r.asked).toHaveBeenCalledTimes(1);
  });

  test('something changed: compare again, until nothing differs (after "Individually resolve" the menu comes back)', async () => {
    const r = runnerOf('changed', 'changed', 'up-to-date');
    expect(await ensureInSync({}, r.run)).toBe('in-sync');
    expect(r.asked).toHaveBeenCalledTimes(3);
  });

  test('...or until the person stops', async () => {
    const r = runnerOf('changed', 'stopped');
    expect(await ensureInSync({}, r.run)).toBe('stopped');
  });

  test('a difference nobody can answer ends the process with exit 3 and the payload alone on stdout', async () => {
    const refusal = conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [{ project: 'p', branch: 'b', serverKeepHash: 'h', conflicts: sourceRowsOf([{ variable: 'X', type: 'changed', pinned: 'aa', local: 'aa', remote: 'bb' }], { project: 'p', branch: 'b', serverKeepHash: 'h' }) }]);
    const exit = exiting();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ensureInSync({}, async () => Promise.reject(refusal))).rejects.toBeInstanceOf(ExitSignal);
      expect(exit).toHaveBeenCalledWith(3);
      expect(log.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflicts: [{ name: 'X', pinned: 'aa', local: 'aa', remote: 'bb' }] });
    } finally {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  });

  test('any other error is thrown as it is', async () => {
    await expect(ensureInSync({}, async () => Promise.reject(new CapyError('no session', ERROR_CODES.AUTH_FAILED)))).rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
  });
});

describe('gateFirst', () => {
  test('a stop ends the command on the spot: exit 0, a word on stderr, nothing on stdout', async () => {
    const exit = exiting();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(gateFirst({}, runnerOf('stopped').run)).rejects.toBeInstanceOf(ExitSignal);
      expect(exit).toHaveBeenCalledWith(0);
      expect(log).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  });

  test('in sync: it returns and the command goes on', async () => {
    await expect(gateFirst({}, runnerOf('up-to-date').run)).resolves.toBeUndefined();
  });

  test('a failure of the sync itself (no session) ends the command with its code: JSON under --json, the error screen otherwise; a command may supply its own refusal', async () => {
    const failing: SyncRunner = async () => Promise.reject(new CapyError('no session', ERROR_CODES.AUTH_FAILED));
    const exit = exiting();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(gateFirst({ json: true }, failing)).rejects.toBeInstanceOf(ExitSignal);
      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ ok: false, code: 'AUTH_FAILED', error: 'no session' });
      const own = mock((_err: unknown) => undefined);
      await expect(
        gateFirst(
          {
            refuse: (e) => {
              own(e);
              throw new ExitSignal(7);
            },
          },
          failing,
        ),
      ).rejects.toBeInstanceOf(ExitSignal);
      expect(own).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });
});

describe('answersByProtocol', () => {
  test('--dry-run, --json, --non-tty (or no terminal) and given --resolve / --conflict answer by protocol; a terminal asks', () => {
    // stdin is not a terminal under the test runner, so "a terminal" is --non-tty's opposite only via the flags below.
    expect(answersByProtocol({ dryRun: true })).toBe(true);
    expect(answersByProtocol({ json: true })).toBe(true);
    expect(answersByProtocol({ nonTty: true })).toBe(true);
    expect(answersByProtocol({ conflictFlags: { resolve: ['A=local'], conflict: 'c_9f2e41a07b3d' } })).toBe(true);
    // A malformed flag counts as typed: the command refuses it on its own before anything is read.
    expect(answersByProtocol({ conflictFlags: { resolve: ['nonsense'] } })).toBe(true);
  });

  test('on a real terminal with nothing typed: the menu, not the protocol', () => {
    const tty = spyOn(process.stdin, 'isTTY', 'get' as never).mockReturnValue(true as never);
    try {
      expect(answersByProtocol({})).toBe(false);
      expect(answersByProtocol({ nonTty: true })).toBe(true);
    } finally {
      tty.mockRestore();
    }
  });
});

describe('commitGated: the command\'s own change, and on a stale refusal bare capy again and one more try', () => {
  const KEY = Encryptor.generateKey();
  const DEV = 'development';
  const SEED = seedServer({ projectKey: KEY, values: { [DEV]: { X: 'x-1', Y: 'y-1' } } });
  const globalDirName = `.capy-test-gate-${process.pid}`;
  const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
  beforeAll(() => {
    process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
  });
  afterAll(() => {
    rmSync(getGlobalCapyDir(), { recursive: true, force: true });
    if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
    else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
  });
  const made = mock((_: Folder) => undefined);
  afterEach(() => made.mock.calls.forEach(([folder]) => removeFolder(folder)));

  const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: 'y-1' } });

  function world(racing: Parameters<typeof fakeCapyServer>[0]) {
    const server = fakeCapyServer({ initial: SEED, ...racing });
    const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: SEED.keep as KeepFile, env: { X: 'x-1', Y: 'y-1' }, client: server.client });
    made(folder);
    return { server, folder, ctx: { ...folder.ctx, gate: {} } };
  }

  test('nobody saved in between: one upload, the gate is not run again', async () => {
    const w = world({});
    const r = runnerOf();
    const done = await commitGated(w.ctx, { set: { Z: 'z' }, remove: [] }, {}, r.run);
    expect(done.uploaded).toBe(true);
    expect(r.asked).not.toHaveBeenCalled();
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-1', Z: 'z' });
  });

  test('someone saved in between (409): bare capy runs again, the folder is read again, the change lands on top of THEIR save', async () => {
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    // Bare capy again brings the folder to Capy: here that is what the runner stands for.
    const r: SyncRunner = async () => {
      w.folder.fileManager.writeKeepFile(w.server.state().keep as KeepFile);
      w.folder.fileManager.writeEncryptedEnvFile({ X: 'x-TEAMMATE', Y: 'y-1' }, KEY, undefined, w.server.state().keep as KeepFile, DEV);
      return 'up-to-date';
    };
    const done = await commitGated(w.ctx, { set: { Z: 'z' }, remove: [] }, {}, r);
    expect(done.uploaded).toBe(true);
    const values = serverValues(w.server.state(), DEV, KEY);
    expect(values).toEqual({ X: 'x-TEAMMATE', Y: 'y-1', Z: 'z' });
    expect(w.folder.env()).toEqual(values);
    expect(w.folder.pin('X')).toBe(hashValue('x-TEAMMATE'));
  });

  test('the person stops the second gate: the command ends (exit 0) and nothing of its own was written', async () => {
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    const exit = exiting();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(commitGated(w.ctx, { set: { Z: 'z' }, remove: [] }, {}, runnerOf('stopped').run)).rejects.toBeInstanceOf(ExitSignal);
      expect(exit).toHaveBeenCalledWith(0);
      expect(serverValues(w.server.state(), DEV, KEY).Z).toBeUndefined();
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  test('a second stale refusal is thrown (SECRETS_STALE_BASE): nothing is written', async () => {
    const other = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-OTHER', Y: 'y-1' } });
    const w = world({ racing: (n) => (n === 1 ? [teammate] : n === 2 ? [other] : []) });
    await expect(commitGated(w.ctx, { set: { Z: 'z' }, remove: [] }, {}, runnerOf('up-to-date').run)).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_STALE_BASE });
    expect(serverValues(w.server.state(), DEV, KEY).Z).toBeUndefined();
  });

  test('a discovered folder\'s context carries a gate with ITS directory: the stale retry runs bare capy there, not in the working directory', async () => {
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    const dirs = mock((_cwd: string | undefined) => undefined);
    const r: SyncRunner = async (opts) => {
      dirs(opts.cwd);
      w.folder.fileManager.writeKeepFile(w.server.state().keep as KeepFile);
      w.folder.fileManager.writeEncryptedEnvFile({ X: 'x-TEAMMATE', Y: 'y-1' }, KEY, undefined, w.server.state().keep as KeepFile, DEV);
      return 'up-to-date';
    };
    const ctx = { ...w.folder.ctx, gate: { cwd: '/work/repo/svc', json: true, nonTty: true, throwConflicts: true } };
    const done = await commitGated(ctx, { set: { Z: 'z' }, remove: [] }, {}, r);
    expect(done.uploaded).toBe(true);
    expect(dirs).toHaveBeenCalledWith('/work/repo/svc');
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-TEAMMATE', Y: 'y-1', Z: 'z' });
  });

  test('a context with no gate is not retried: the stale refusal is thrown', async () => {
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    const r = runnerOf();
    await expect(commitGated(w.folder.ctx, { set: { Z: 'z' }, remove: [] }, {}, r.run)).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_STALE_BASE });
    expect(r.asked).not.toHaveBeenCalled();
  });
});


describe('another checkout than the working directory (discovery writes into several)', () => {
  const refusal = () =>
    conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [{ project: 'p', branch: 'b', serverKeepHash: 'h', conflicts: sourceRowsOf([{ variable: 'X', type: 'changed', pinned: 'aa', local: 'aa', remote: 'bb' }], { project: 'p', branch: 'b', serverKeepHash: 'h' }) }]);

  test('syncFolder asks the runner for THAT folder and says in sync when bare capy has nothing to settle', async () => {
    const seen = mock((_cwd: string | undefined) => undefined);
    const run: SyncRunner = async (opts) => {
      seen(opts.cwd);
      return 'up-to-date';
    };
    expect(await syncFolder('/work/repo/svc', { json: true, nonTty: true }, run)).toEqual({ ok: true });
    expect(seen).toHaveBeenCalledWith('/work/repo/svc');
  });

  test('syncFolder never ends the process: a difference nobody can answer comes back as the folder\'s coded result with its rows and id', async () => {
    const exit = exiting();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const refused = refusal();
      const result = await syncFolder('/work/repo/svc', { json: true, nonTty: true }, async () => Promise.reject(refused));
      expect(result).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict: refused.payload });
      expect(exit).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test('syncFolder: a stop and a failure of the sync are coded results too (the stop never exits 0 for the whole run)', async () => {
    const exit = exiting();
    try {
      expect(await syncFolder('/work/a', {}, runnerOf('stopped').run)).toMatchObject({ ok: false, code: FOLDER_SYNC_STOPPED });
      expect(await syncFolder('/work/a', {}, async () => Promise.reject(new CapyError('no session', ERROR_CODES.AUTH_FAILED)))).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
      expect(await syncFolder('/work/a', {}, async () => Promise.reject(new Error('boom')))).toMatchObject({ ok: false, code: ERROR_CODES.SERVICE_ERROR });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  test('ensureInSync with throwConflicts throws the refusal instead of ending the process', async () => {
    const exit = exiting();
    try {
      const refused = refusal();
      await expect(ensureInSync({ throwConflicts: true }, async () => Promise.reject(refused))).rejects.toBe(refused);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  test('the real runner syncs a folder by standing in it and comes back: a folder with no keep.lock has nothing to compare, a folder that does not exist yet is in sync', async () => {
    const origin = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'capy-gate-folder-'));
    try {
      expect(await syncFolder(dir, { json: true, nonTty: true })).toEqual({ ok: true });
      expect(process.cwd()).toBe(origin);
      expect(await syncFolder(join(dir, 'not', 'yet'), { json: true, nonTty: true })).toEqual({ ok: true });
      expect(process.cwd()).toBe(origin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stopWithNothingWritten', () => {
  test('exits 0', () => {
    const exit = exiting();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => stopWithNothingWritten()).toThrow(ExitSignal);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});

