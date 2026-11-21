/**
 * Joining an existing project from a folder with no keep.lock: the branch comes from the project's own branch list,
 * never from an assumed name. The person is always asked, even when the project has one branch, and
 * off a terminal the run stops with a code that names them and writes nothing.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  resolveProjectKey: async () => 'a'.repeat(64),
}));

import inquirer from 'inquirer';
import { CapyCommand } from '../../src/commands/capyCommand';
import { ServiceClient } from '../../src/service/serviceClient';
import { AuthService } from '../../src/auth/authService';
import { Branch, CapyError, CliOptions, ERROR_CODES } from '../../src/types/index';

const PROJECT = { id: 'proj-1', name: 'marketing', organization_id: 'org-1' };
const branchNamed = (name: string, is_protected = false): Branch => ({ id: `id-${name}`, name, project_id: PROJECT.id, is_protected });
const NO_SECRETS = new CapyError('empty', ERROR_CODES.NO_SECRETS, { status: 404 });

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'capy-bootstrap-branch-'));
  dirs(dir);
  process.chdir(dir);
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

/** A command for a project with `branches`, every one of them empty. Returns the command and the spy on the read. */
function commandFor(branches: readonly Branch[], options: CliOptions = {}) {
  spyOn(ServiceClient.prototype, 'listBranches').mockResolvedValue([...branches]);
  const read = spyOn(ServiceClient.prototype, 'getDecryptData').mockRejectedValue(NO_SECRETS);
  return { cmd: new CapyCommand(options, false), read };
}

const bootstrap = (cmd: CapyCommand): Promise<void> =>
  (cmd as unknown as { bootstrapExistingProject: (p: typeof PROJECT, org: string, user: string) => Promise<void> }).bootstrapExistingProject(PROJECT, 'org-1', 'user-1');

const activeBranch = (): string => readFileSync(join(process.cwd(), '.capy', 'branch'), 'utf-8').trim();

describe('bootstrapExistingProject: the branch comes from the project', () => {
  test('a single branch is still asked about, and the pick (not "development") is the branch', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt').mockResolvedValue({ selected: 'prod' } as never);
    try {
      const { cmd, read } = commandFor([branchNamed('prod')]);
      await bootstrap(cmd);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[1]).toBe('prod');
      expect(activeBranch()).toBe('prod');
    } finally {
      prompt.mockRestore();
      log.mockRestore();
    }
  });

  test('a single branch off a terminal: stops with NO_ACTIVE_BRANCH naming it, reads and writes nothing', async () => {
    const { cmd, read } = commandFor([branchNamed('prod')], { protocol: true });
    const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
    expect((refusal as CapyError).code).toBe(ERROR_CODES.NO_ACTIVE_BRANCH);
    expect((refusal as CapyError).details?.branches).toEqual(['prod']);
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
  });

  test('several branches at a terminal: the person is asked, and their pick is the branch', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt').mockResolvedValue({ selected: 'staging' } as never);
    try {
      const { cmd, read } = commandFor([branchNamed('prod'), branchNamed('staging')]);
      await bootstrap(cmd);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[1]).toBe('staging');
      expect(activeBranch()).toBe('staging');
    } finally {
      prompt.mockRestore();
      log.mockRestore();
    }
  });

  test('several branches off a terminal: stops with NO_ACTIVE_BRANCH naming them, reads and writes nothing', async () => {
    const { cmd, read } = commandFor([branchNamed('prod'), branchNamed('development')], { protocol: true });
    const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(CapyError);
    expect((refusal as CapyError).code).toBe(ERROR_CODES.NO_ACTIVE_BRANCH);
    expect((refusal as CapyError).details?.branches).toEqual(['prod', 'development']);
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
    expect(existsSync(join(process.cwd(), '.capy'))).toBe(false);
  });

  test('bare capy with nobody to answer, in a folder that is no project yet: SETUP_NEEDS_TTY on stdout, exit 3, no sign-in, no picker, nothing written', async () => {
    class Exit extends Error {
      constructor(readonly code: number | undefined) {
        super('exit');
      }
    }
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt');
    const signIn = spyOn(AuthService.prototype, 'authenticate');
    try {
      const ended = await new CapyCommand({ protocol: true }, false).execute().then(() => undefined, (err: unknown) => err);
      expect((ended as Exit).code).toBe(3);
      expect(JSON.parse(log.mock.calls.map((c) => c.join(' ')).join('\n'))).toMatchObject({ ok: false, code: 'SETUP_NEEDS_TTY' });
      expect(prompt).not.toHaveBeenCalled();
      expect(signIn).not.toHaveBeenCalled();
      expect(existsSync(join(process.cwd(), '.capy'))).toBe(false);
    } finally {
      exit.mockRestore();
      log.mockRestore();
      prompt.mockRestore();
      signIn.mockRestore();
    }
  });

  test('a project with no branches: the person names the first branch, it is created, and the join goes on with it', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ initialBranchChoice: 'other' } as never)
      .mockResolvedValueOnce({ branchName: 'prod' } as never)
      .mockResolvedValueOnce({ protect: true } as never);
    const create = spyOn(ServiceClient.prototype, 'createBranch').mockResolvedValue(branchNamed('prod', true));
    try {
      const { cmd, read } = commandFor([]);
      await bootstrap(cmd);
      expect(create.mock.calls).toEqual([[PROJECT.id, 'prod', true]]);
      expect(read.mock.calls[0]?.[1]).toBe('prod');
      expect(activeBranch()).toBe('prod');
    } finally {
      prompt.mockRestore();
      create.mockRestore();
      log.mockRestore();
    }
  });

  test('a project with no branches, joined by someone who cannot create one: FIRST_BRANCH_NEEDS_ADMIN, nothing written', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ initialBranchChoice: 'development' } as never)
      .mockResolvedValueOnce({ protect: false } as never);
    const create = spyOn(ServiceClient.prototype, 'createBranch').mockRejectedValue(
      new CapyError('denied', ERROR_CODES.PERMISSION_DENIED, { status: 403 }),
    );
    try {
      const { cmd, read } = commandFor([]);
      const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
      expect((refusal as CapyError).code).toBe(ERROR_CODES.FIRST_BRANCH_NEEDS_ADMIN);
      expect(read).not.toHaveBeenCalled();
      expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
    } finally {
      prompt.mockRestore();
      create.mockRestore();
      log.mockRestore();
    }
  });

  test('a project with no branches and nobody to answer stops with BRANCH_NOT_FOUND: no branch is created or assumed', async () => {
    const create = spyOn(ServiceClient.prototype, 'createBranch');
    try {
      const { cmd, read } = commandFor([], { protocol: true });
      const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
      expect((refusal as CapyError).code).toBe(ERROR_CODES.BRANCH_NOT_FOUND);
      expect(create).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
    } finally {
      create.mockRestore();
    }
  });
});
