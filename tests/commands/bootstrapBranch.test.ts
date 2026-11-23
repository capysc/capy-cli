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

  test('--branch naming one of the project branches answers the question: no picker, and that branch is joined', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt');
    try {
      const { cmd, read } = commandFor([branchNamed('prod'), branchNamed('staging')], { setup: { branch: 'staging', json: false, nonTty: false, agentMode: false } });
      await bootstrap(cmd);
      expect(prompt).not.toHaveBeenCalled();
      expect(read.mock.calls[0]?.[1]).toBe('staging');
      expect(activeBranch()).toBe('staging');
    } finally {
      prompt.mockRestore();
      log.mockRestore();
    }
  });

  test('--branch naming a branch the project does not have: BRANCH_NOT_FOUND naming its branches, reads and writes nothing', async () => {
    const { cmd, read } = commandFor([branchNamed('prod')], { setup: { branch: 'development', json: false, nonTty: false, agentMode: false } });
    const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
    expect((refusal as CapyError).code).toBe(ERROR_CODES.BRANCH_NOT_FOUND);
    expect((refusal as CapyError).details?.branches).toEqual(['prod']);
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
  });

  test('a project with no branches: the person names the first branch, it is created, and the join goes on with it', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ initialBranchChoice: 'other' } as never)
      .mockResolvedValueOnce({ branchName: 'prod' } as never);
    const create = spyOn(ServiceClient.prototype, 'createBranch').mockResolvedValue(branchNamed('prod'));
    try {
      const { cmd, read } = commandFor([]);
      await bootstrap(cmd);
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(create.mock.calls).toEqual([[PROJECT.id, 'prod', false]]);
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
      .mockResolvedValueOnce({ initialBranchChoice: 'development' } as never);
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

  test('a project with no branches, joined by someone whose membership was revoked: the refusal the service gave is kept', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const prompt = spyOn(inquirer, 'prompt').mockResolvedValueOnce({ initialBranchChoice: 'development' } as never);
    const revoked = new CapyError('revoked', ERROR_CODES.PERMISSION_DENIED, { status: 403, code: 'MEMBERSHIP_REVOKED' });
    const create = spyOn(ServiceClient.prototype, 'createBranch').mockRejectedValue(revoked);
    try {
      const { cmd } = commandFor([]);
      const refusal = await bootstrap(cmd).then(() => undefined, (err: unknown) => err);
      expect(refusal).toBe(revoked);
    } finally {
      prompt.mockRestore();
      create.mockRestore();
      log.mockRestore();
    }
  });

  test('the branch list is refused by the service (no access): that refusal is kept, not reported as "service unreachable"', async () => {
    const denied = new CapyError('denied', ERROR_CODES.PERMISSION_DENIED, { status: 403 });
    spyOn(ServiceClient.prototype, 'listBranches').mockRejectedValue(denied);
    const read = spyOn(ServiceClient.prototype, 'getDecryptData').mockRejectedValue(NO_SECRETS);
    const refusal = await bootstrap(new CapyCommand({}, false)).then(() => undefined, (err: unknown) => err);
    expect(refusal).toBe(denied);
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
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
