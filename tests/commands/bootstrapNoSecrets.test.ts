/**
 * Bootstrapping an existing project into an empty folder: a 404 from the service that is CODED `NO_SECRETS` means the
 * project is empty (a stub keep.lock is written); anything else is a failure and is thrown. The decision is the code
 * (`serviceClient.classifyResponse` mints it once, from the response), never the wording of the message.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  resolveProjectKey: async () => 'a'.repeat(64),
}));

import { CapyCommand } from '../../src/commands/capyCommand';
import { FileManager } from '../../src/files/fileManager';
import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const PROJECT = { id: 'proj-1', name: 'demo', organization_id: 'org-1' };

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeEach(() => {
  // A folder that is not a git repository: bootstrapping installs hooks into the working directory's repository.
  const dir = mkdtempSync(join(tmpdir(), 'capy-bootstrap-'));
  dirs(dir);
  process.chdir(dir);
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

/** A command whose service answers `getDecryptData` with `failure` (the one call the bootstrap makes before it decides). */
function commandFailingWith(failure: unknown): CapyCommand {
  spyOn(ServiceClient.prototype, 'listBranches').mockResolvedValue([{ id: 'dev', project_id: PROJECT.id, name: 'team-dev', is_protected: false }]);
  spyOn(ServiceClient.prototype, 'getDecryptData').mockRejectedValue(failure);
  return new CapyCommand({}, false);
}

const bootstrap = (cmd: CapyCommand): Promise<void> =>
  (cmd as unknown as { bootstrapExistingProject: (p: typeof PROJECT, org: string, user: string) => Promise<void> }).bootstrapExistingProject(PROJECT, 'org-1', 'user-1');

describe('bootstrapExistingProject: an empty project is decided by the code', () => {
  test('404 coded NO_SECRETS, whatever the message says: a stub keep.lock is written and the run goes on', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await bootstrap(commandFailingWith(new CapyError('This wording could be anything', ERROR_CODES.NO_SECRETS, { status: 404 })));
      expect(readFileSync(join(process.cwd(), '.capy/branch'), 'utf8').trim()).toBe('team-dev');
      expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(true);
      expect(JSON.parse(readFileSync(join(process.cwd(), 'keep.lock'), 'utf-8'))).toMatchObject({ project_id: 'proj-1', variables: {} });
    } finally {
      log.mockRestore();
    }
  });

  test('a 404 that merely SAYS "No secrets" but is coded otherwise is a failure: the wording decides nothing', async () => {
    const failure = new CapyError('No secrets stored for this project', ERROR_CODES.SERVICE_ERROR, { status: 404 });
    await expect(bootstrap(commandFailingWith(failure))).rejects.toBe(failure);
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
  });

  test('NO_SECRETS on another status is not an empty project either', async () => {
    const failure = new CapyError('x', ERROR_CODES.NO_SECRETS, { status: 500 });
    await expect(bootstrap(commandFailingWith(failure))).rejects.toBe(failure);
  });
});

test('attach resolves the selected branch and preserves a populated .env for the usual conflict decision', async () => {
  const local = 'NAME=local-fixture\n';
  writeFileSync('.env', local);
  const branch = 'personal';
  const keep = { version: '3.0', org_id: PROJECT.organization_id, project_id: PROJECT.id, project_name: PROJECT.name, variables: {} };
  spyOn(ServiceClient.prototype, 'listBranches').mockResolvedValue([{ id: 'b', project_id: PROJECT.id, name: branch, is_protected: false }]);
  const read = spyOn(ServiceClient.prototype, 'getDecryptData').mockResolvedValue({
    keep_file: JSON.stringify(keep), env_content: 'NAME=capy:fixture:opaque', decrypt_key: '', expires_at: '',
  });
  const boundary = new CapyCommand();
  const compare = spyOn(boundary as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockImplementation(async () => {
    expect(readFileSync('.env', 'utf8')).toBe(local);
    expect(readFileSync('.capy/branch', 'utf8')).toBe(branch);
    return 'stopped';
  });
  await bootstrap(boundary);
  expect(compare).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(PROJECT.id, branch, undefined, true);
  expect(new FileManager().readEnvFile()).toEqual({ NAME: 'local-fixture' });
});
