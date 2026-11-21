/**
 * First project setup (bare `capy` in a folder with no project): what the TRACKED `keep.lock` holds afterwards.
 *
 * Setup writes keep.lock twice: first with identity and no pins (right after the project is created), then, once the
 * `.env` has been pushed, again with the pins. `FileManager.writeKeepFile` only creates the tracked file when it is
 * absent, so the second write must go through `writeInitialKeepFile` or the file the user commits carries zero pins.
 *
 * Real `FileManager`, `ProjectManager` and `SyncEngine` in a temp directory that is a real git repository, so the
 * assertions cover files on disk and the resulting scoped Git commit. The service, auth, prompts, key resolution and the global cache are faked.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';
import * as realGlobalConfig from '../../src/config/globalConfig';

const confirmEncryptAnswer = mock(() => true);
const folderAnswer = mock(() => process.cwd());

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
      if (name === 'selected') return Promise.resolve({ selected: folderAnswer() });
      if (name === 'share') return Promise.resolve({ share: false });
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
import * as interactive from '../../src/ui/interactive';
import { tracksKeepLock } from '../../src/git/keepTracking';
import { FileManager } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeEach(() => {
  // Commit only inside the fixture using its own Git identity.
  const dir = mkdtempSync(join(tmpdir(), 'capy-initial-setup-'));
  dirs(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: dir });
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
  (new CapyCommand({}, false) as unknown as { initializeProject: (share: boolean) => Promise<void> }).initializeProject(true);

const readJson = (path: string): KeepFile => JSON.parse(readFileSync(path, 'utf-8')) as KeepFile;
const trackedPath = (): string => join(process.cwd(), 'keep.lock');
const workingPath = (): string => join(process.cwd(), '.capy', 'keep.lock');
/** The root lockfile committed to the fixture's HEAD. */
const committedText = (): string => execFileSync('git', ['show', 'HEAD:keep.lock'], { cwd: process.cwd(), encoding: 'utf-8' });

describe('first setup with a .env', () => {
  test('the tracked keep.lock pins every pushed variable on the initial branch', async () => {
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=value-one\nDB_URL=value-two\n', 'utf-8');
    writeFileSync('unrelated', 'keep staged');
    execFileSync('git', ['add', '--', 'unrelated']);
    const push = fakeService();
    const writeInitial = spyOn(FileManager.prototype, 'writeInitialKeepFile');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()).toBe('unrelated');
    // The committed file carries only the pins that were pushed.
    const tracked = readJson(trackedPath());
    expect(Object.keys(tracked.variables).toSorted()).toEqual(['API_KEY', 'DB_URL']);
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

    // The setup commit already includes the pins.
    expect(committedText()).toBe(readFileSync(trackedPath(), 'utf-8'));
    const staged = JSON.parse(committedText()) as KeepFile;
    expect(Object.keys(staged.variables).toSorted()).toEqual(['API_KEY', 'DB_URL']);
    expect(staged.variables.API_KEY[0].branch).toBe('development');
    expect(staged.variables.DB_URL[0].branch).toBe('development');

    // The second write goes through the first-setup method.
    expect(writeInitial).toHaveBeenCalledTimes(1);
    const written = writeInitial.mock.calls[0][0];
    expect(Object.keys(written.variables).toSorted()).toEqual(['API_KEY', 'DB_URL']);
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
    expect((JSON.parse(committedText()) as KeepFile).variables).toEqual({});
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
    expect((JSON.parse(committedText()) as KeepFile).variables).toEqual({});
    expect(readFileSync(join(process.cwd(), '.env'), 'utf-8')).toBe(envText);
  });
});


describe('bare capy in the parent of a checkout', () => {
  test('the folder picker scopes the whole setup and the default does not install Git integration', async () => {
    const parent = process.cwd();
    const child = join(parent, 'api');
    mkdirSync(child);
    writeFileSync(join(child, '.env'), 'API_KEY=fixture\n');
    const push = fakeService();
    spyOn(interactive, 'isInteractive').mockReturnValue(true);
    folderAnswer.mockReturnValue(child);
    await new CapyCommand().execute();
    expect(process.cwd()).toBe(parent);
    expect(existsSync(join(parent, 'keep.lock'))).toBe(false);
    expect(existsSync(join(parent, '.capy'))).toBe(false);
    expect(existsSync(join(parent, '.gitignore'))).toBe(false);
    expect(readJson(join(child, 'keep.lock')).variables.API_KEY).toHaveLength(1);
    expect(tracksKeepLock(child)).toBe(false);
    expect(existsSync(join(parent, '.git', 'info', 'attributes'))).toBe(false);
    expect(existsSync(join(parent, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(execFileSync('git', ['ls-files'], { cwd: parent, encoding: 'utf8' })).toBe('');
    expect(push).toHaveBeenCalledTimes(1);
  });
  test('an agent can explicitly target a directory without browsing', async () => {
    const child = join(process.cwd(), 'selected project');
    mkdirSync(child);
    fakeService();
    folderAnswer.mockClear();
    await new CapyCommand({ protocol: true }).execute(child);
    expect(folderAnswer).not.toHaveBeenCalled();
    expect(existsSync(join(child, 'keep.lock'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
    expect(tracksKeepLock(child)).toBe(false);
  });
});
