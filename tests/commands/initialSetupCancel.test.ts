/**
 * First project setup (bare `capy` in a folder with no project): every question is asked BEFORE anything is created on
 * the service or written to the folder (CAP-859).
 *
 * Stopping at a question (Ctrl+C makes inquirer's prompt reject) must leave no project in the org, no `keep.lock`, and
 * no `.capy`. And the line that says the project was created never names a branch that was not created.
 *
 * Real `FileManager`, `ProjectManager` and `SyncEngine` in a temp directory that is a real git repository; the service,
 * auth, key resolution and the global cache are faked. Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';
import * as realGlobalConfig from '../../src/config/globalConfig';

/** The name of the prompt the person stops at (Ctrl+C), or undefined to answer them all. */
const interruptAt = mock((): string | undefined => undefined);
const branchChoice = mock(() => 'development');
const customBranch = mock(() => 'main');
const confirmEncryptAnswer = mock(() => true);
/** Every prompt asked, in order: its name and its `validate` function, when it has one. */
const asked = mock((_name: string, _validate: unknown) => undefined);

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
      const first = Array.isArray(questions) ? questions[0] : questions;
      const name: string = first?.name ?? '';
      asked(name, first?.validate);
      if (interruptAt() === name) return Promise.reject(new Error('User force closed the prompt'));
      if (name === 'orgId') return Promise.resolve({ orgId: 'org-1' });
      if (name === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: branchChoice() });
      if (name === 'branchName') return Promise.resolve({ branchName: customBranch() });
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

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'capy-setup-cancel-'));
  dirs(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
  interruptAt.mockReturnValue(undefined);
  branchChoice.mockReturnValue('development');
  customBranch.mockReturnValue('main');
  confirmEncryptAnswer.mockReturnValue(true);
  asked.mockClear();
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

/** Fakes every network and auth edge of setup; returns the two service calls that create things. */
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
  const createProject = spyOn(ServiceClient.prototype, 'initializeProject').mockResolvedValue({
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    created: true,
  });
  const createBranch = spyOn(ServiceClient.prototype, 'createBranch').mockImplementation(
    async (projectId: string, name: string) => ({ id: 'b1', name, project_id: projectId, is_protected: false }) as never,
  );
  spyOn(ServiceClient.prototype, 'pushSecrets').mockResolvedValue({ keep_hash: 'a'.repeat(64) } as never);
  spyOn(PromptEngine.prototype, 'promptForProjectName').mockResolvedValue('demo');
  return { createProject, createBranch };
}

const runSetup = (): Promise<void> =>
  (new CapyCommand({}, false) as unknown as { runInitialization: () => Promise<void> }).runInitialization();

/** Everything `run` prints, from console.log, stdout and stderr (the spinners write to stderr). */
async function printedBy(run: () => Promise<void>): Promise<string> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await run();
    return [
      ...log.mock.calls.map((call) => call.join(' ')),
      ...out.mock.calls.map((call) => String(call[0])),
      ...err.mock.calls.map((call) => String(call[0])),
    ].join('\n');
  } finally {
    log.mockRestore();
    err.mockRestore();
    out.mockRestore();
  }
}

/** Everything the folder holds, besides the `.git` the test made. */
const folderEntries = (): readonly string[] => readdirSync(process.cwd()).filter((name) => name !== '.git');

describe('stopping at a question creates nothing', () => {
  test('at the first-branch question: no project, no branch, no keep.lock, no .capy', async () => {
    const { createProject, createBranch } = fakeService();
    interruptAt.mockReturnValue('initialBranchChoice');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(runSetup()).rejects.toThrow('User force closed the prompt');
    } finally {
      log.mockRestore();
    }

    expect(createProject).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
    expect(existsSync(join(process.cwd(), 'keep.lock'))).toBe(false);
    expect(existsSync(join(process.cwd(), '.capy'))).toBe(false);
    expect(folderEntries()).toEqual([]);
  });

  test('at the custom branch name: nothing is created either', async () => {
    const { createProject, createBranch } = fakeService();
    branchChoice.mockReturnValue('other');
    interruptAt.mockReturnValue('branchName');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(runSetup()).rejects.toThrow('User force closed the prompt');
    } finally {
      log.mockRestore();
    }

    expect(createProject).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
    expect(folderEntries()).toEqual([]);
  });

  test('at the encrypt-your-.env question: nothing is created, and the .env is not touched', async () => {
    const { createProject, createBranch } = fakeService();
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=one\n', 'utf-8');
    interruptAt.mockReturnValue('confirmEncrypt');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(runSetup()).rejects.toThrow('User force closed the prompt');
    } finally {
      log.mockRestore();
    }

    expect(createProject).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
    expect(folderEntries()).toEqual(['.env']);
  });
});

describe('the questions come before the creation', () => {
  test('the project is created only after the branch and the .env questions were answered', async () => {
    const { createProject } = fakeService();
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=one\n', 'utf-8');
    // What had been asked at the moment the service was asked to create the project.
    const askedWhenCreated = mock((_: readonly string[]) => undefined);
    createProject.mockImplementation(async () => {
      askedWhenCreated(asked.mock.calls.map(([name]) => name));
      return { org_id: 'org-1', project_id: 'proj-1', project_name: 'demo', created: true };
    });
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    expect(askedWhenCreated).toHaveBeenCalledTimes(1);
    expect(askedWhenCreated.mock.calls[0][0]).toEqual(['orgId', 'initialBranchChoice', 'confirmEncrypt']);
  });

  test('a custom branch is the one created, and no line names a branch that is not that one', async () => {
    const { createBranch } = fakeService();
    branchChoice.mockReturnValue('other');
    customBranch.mockReturnValue('prod');
    const printed = await printedBy(runSetup);

    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch.mock.calls[0][1]).toBe('prod');
    expect(printed).toContain('Project created: demo');
    expect(printed).toContain('Created branch prod');
    expect(printed).not.toContain('development');
  });

  test('the custom branch question refuses a name the service would refuse, so no project is left without a branch', async () => {
    fakeService();
    branchChoice.mockReturnValue('other');
    const log = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runSetup();
    } finally {
      log.mockRestore();
    }

    const validate = asked.mock.calls.find(([name]) => name === 'branchName')?.[1] as (input: string) => string | true;
    expect(validate('')).not.toBe(true);
    expect(validate('bad name')).not.toBe(true);
    expect(validate('..x')).not.toBe(true);
    expect(validate('prod')).toBe(true);
  });
});
