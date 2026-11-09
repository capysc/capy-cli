/**
 * First project setup (bare `capy` in a folder with no project): what the TRACKED `keep.lock` holds afterwards.
 *
 * Setup writes keep.lock twice: first with identity and no pins (right after the project is created), then, once the
 * `.env` has been pushed, again with the pins. `FileManager.writeKeepFile` only creates the tracked file when it is
 * absent, so the second write must go through `writeInitialKeepFile` or the file the user commits carries zero pins.
 *
 * Real `FileManager`, `ProjectManager` and `SyncEngine` in a temp directory, so the assertions are about files on
 * disk. The service, auth, prompts, key resolution and the global cache are faked.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';
import * as realGlobalConfig from '../../src/config/globalConfig';

const confirmEncryptAnswer = mock(() => true);

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  hasOrgKey: () => true,
  resolveProjectKey: async () => 'a'.repeat(64),
}));
mock.module('../../src/config/globalConfig', () => ({
  ...realGlobalConfig,
  writeKeepCache: () => undefined,
}));
mock.module('inquirer', () => ({
  default: {
    prompt: mock((questions: unknown) => {
      const name = Array.isArray(questions) ? questions[0]?.name : (questions as { name?: string })?.name;
      if (name === 'orgId') return Promise.resolve({ orgId: 'org-1' });
      if (name === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: 'development' });
      if (name === 'confirmEncrypt') return Promise.resolve({ confirmEncrypt: confirmEncryptAnswer() });
      return Promise.resolve({});
    }),
    Separator: class Separator {},
  },
}));

import { CapyCommand } from '../../src/commands/capyCommand';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { PromptEngine } from '../../src/ui/promptEngine';
import { FileManager } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeEach(() => {
  // A folder that is not a git repository, so no hooks or staging reach a real repository.
  const dir = mkdtempSync(join(tmpdir(), 'capy-initial-setup-'));
  dirs(dir);
  process.chdir(dir);
  confirmEncryptAnswer.mockReturnValue(true);
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

/** Fakes every network and auth edge of setup; returns the push spy so a test can see what was pushed. */
function fakeService() {
  spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({
    success: true,
    user_id: 'user-1',
    user_email: 'dev@example.com',
    organization_id: 'org-1',
    organizations: [{ id: 'org-1', name: 'Acme' }],
    _auth_method: 'oauth',
  } as never);
  spyOn(ServiceClient.prototype, 'listProjects').mockResolvedValue([]);
  spyOn(ServiceClient.prototype, 'initializeProject').mockResolvedValue({
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    created: true,
  });
  spyOn(ServiceClient.prototype, 'createBranch').mockResolvedValue({
    id: 'b1', name: 'development', project_id: 'proj-1', is_protected: false,
  } as never);
  spyOn(PromptEngine.prototype, 'promptForProjectName').mockResolvedValue('demo');
  return spyOn(ServiceClient.prototype, 'pushSecrets').mockResolvedValue({ keep_hash: 'a'.repeat(64) } as never);
}

const runSetup = (): Promise<void> =>
  (new CapyCommand({}, false) as unknown as { runInitialization: () => Promise<void> }).runInitialization();

const readJson = (path: string): KeepFile => JSON.parse(readFileSync(path, 'utf-8')) as KeepFile;
const trackedPath = (): string => join(process.cwd(), 'keep.lock');
const workingPath = (): string => join(process.cwd(), '.capy', 'keep.lock');

describe('first setup with a .env', () => {
  test('the tracked keep.lock pins every pushed variable on the initial branch', async () => {
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=value-one\nDB_URL=value-two\n', 'utf-8');
    const push = fakeService();
    const writeInitial = spyOn(FileManager.prototype, 'writeInitialKeepFile');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    // The property: the committed file carries the pins that were pushed.
    const tracked = readJson(trackedPath());
    expect(Object.keys(tracked.variables).sort()).toEqual(['API_KEY', 'DB_URL']);
    Object.values(tracked.variables).forEach((entries) => {
      expect(entries).toHaveLength(1);
      expect(entries[0].branch).toBe('development');
      expect(entries[0].resource_id.length).toBeGreaterThan(0);
      expect(entries[0].value_hash).toHaveLength(16);
    });
    expect(tracked).toMatchObject({ org_id: 'org-1', project_id: 'proj-1', project_name: 'demo' });

    // Same content as what was pushed, and as the working copy.
    expect(push).toHaveBeenCalledTimes(1);
    const pushedKeep = JSON.parse(String(push.mock.calls[0][1])) as KeepFile;
    expect(tracked.variables).toEqual(pushedKeep.variables);
    expect(readFileSync(trackedPath(), 'utf-8')).toBe(readFileSync(workingPath(), 'utf-8'));

    // The second write goes through the first-setup method.
    expect(writeInitial).toHaveBeenCalledTimes(1);
    const written = writeInitial.mock.calls[0][0];
    expect(Object.keys(written.variables).sort()).toEqual(['API_KEY', 'DB_URL']);
    expect(written.variables.API_KEY[0].branch).toBe('development');
  });
});

describe('first setup that does not push', () => {
  test('no .env: the tracked keep.lock holds identity and zero pins, from the first write only', async () => {
    const push = fakeService();
    const writeInitial = spyOn(FileManager.prototype, 'writeInitialKeepFile');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    expect(existsSync(trackedPath())).toBe(true);
    expect(readJson(trackedPath())).toMatchObject({
      org_id: 'org-1', project_id: 'proj-1', project_name: 'demo', variables: {},
    });
    expect(push).not.toHaveBeenCalled();
    expect(writeInitial).not.toHaveBeenCalled();
  });

  test('declined to encrypt: the tracked keep.lock still holds identity and zero pins, and the .env is untouched', async () => {
    const envText = 'API_KEY=value-one\nDB_URL=value-two\n';
    writeFileSync(join(process.cwd(), '.env'), envText, 'utf-8');
    confirmEncryptAnswer.mockReturnValue(false);
    const push = fakeService();
    const writeInitial = spyOn(FileManager.prototype, 'writeInitialKeepFile');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    expect(readJson(trackedPath())).toMatchObject({
      org_id: 'org-1', project_id: 'proj-1', project_name: 'demo', variables: {},
    });
    expect(push).not.toHaveBeenCalled();
    expect(writeInitial).not.toHaveBeenCalled();
    expect(readFileSync(join(process.cwd(), '.env'), 'utf-8')).toBe(envText);
  });
});
