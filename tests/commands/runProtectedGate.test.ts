/**
 * `capy run` on a protected branch.
 *
 * The server says whether a branch is protected (the branch list). On the one path that
 * already needs the server to decrypt (server-backed profile, at least one encrypted
 * entry), `capy run` refuses a protected branch unless `--protected` was passed, and
 * refuses before anything is decrypted and before any child starts.
 *
 * The server, the key resolver and the child-process spawn are mocked, so each test can
 * assert the property: was the decrypt path reached, was a child spawned, was the server
 * asked about branches.
 */
import { mock, spyOn, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Encryptor } from '../../src/crypto/encryptor';
import { ERROR_CODES } from '../../src/types/index';

const KEY = 'ab'.repeat(32);
const SECRET = 'plain-secret-value';
const SEALED = `capy:abcde:${Encryptor.encrypt(SECRET, KEY)}`;

type BranchRow = { readonly name: string; readonly is_protected?: unknown };

const listBranches = mock(async (_projectId: string): Promise<ReadonlyArray<BranchRow>> => []);
const authenticateSilent = mock(async () => ({ success: true, user_id: 'user_1' }));
const resolveProjectKey = mock(async () => KEY);
const resolveLocalProjectKey = mock(async () => KEY);
const isLocalOnly = mock(() => false);
const spawn = mock((_cmd: string, _args: ReadonlyArray<string>, _opts: { env: Record<string, string | undefined> }) =>
  fakeChild(),
);

function fakeChild() {
  const child = {
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') queueMicrotask(() => cb(0, null));
      return child;
    },
    kill: () => undefined,
    stdio: [],
  };
  return child;
}

const realChildProcess = await import('child_process');
mock.module('child_process', () => ({
  ...realChildProcess,
  spawn: (...a: Parameters<typeof spawn>) => spawn(...a),
  spawnSync: () => ({ status: 1, stdout: '' }),
  ChildProcess: class {},
}));

const realAuth = await import('../../src/auth/authService');
mock.module('../../src/auth/authService', () => ({
  ...realAuth,
  AuthService: class {
    authenticateSilent = authenticateSilent;
    getValidToken = async () => 'token';
  },
}));

const realService = await import('../../src/service/serviceClient');
mock.module('../../src/service/serviceClient', () => ({
  ...realService,
  ServiceClient: class {
    setTokenProvider() {}
    listBranches = listBranches;
    coDecrypt = async () => ({ plaintext: '' });
    wrapOuterLayer = async () => ({ ciphertext: '' });
  },
}));

const realKeyResolver = await import('../../src/crypto/keyResolver');
mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  resolveProjectKey: (...a: []) => resolveProjectKey(...a),
}));

const realReporter = await import('../../src/core/repoLinkReporter');
mock.module('../../src/core/repoLinkReporter', () => ({
  ...realReporter,
  reportRepoLink: () => Promise.resolve(),
}));

const realProfile = await import('../../src/config/profileConfig');
mock.module('../../src/config/profileConfig', () => ({
  ...realProfile,
  isLocalOnly: () => isLocalOnly(),
}));

const realLocalUnlock = await import('../../src/core/localUnlock');
mock.module('../../src/core/localUnlock', () => ({
  ...realLocalUnlock,
  resolveLocalProjectKey: (...a: [string]) => resolveLocalProjectKey(...a),
}));

afterAll(() => mock.restore());

const { runCommand } = await import('../../src/commands/runCommand');

const KEEP = JSON.stringify({
  version: '1',
  org_id: 'org_1',
  project_id: 'proj_1',
  project_name: 'p',
  variables: {},
});

interface Folder {
  readonly env: string;
  readonly capyBranch?: string;
}

/** Runs `fn` with the process in a throwaway project folder, then puts everything back. */
async function inFolder<T>(folder: Folder, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-run-gate-'));
  const before = process.cwd();
  writeFileSync(join(dir, 'keep.lock'), KEEP);
  writeFileSync(join(dir, '.env'), folder.env);
  if (folder.capyBranch !== undefined) {
    mkdirSync(join(dir, '.capy'), { recursive: true });
    writeFileSync(join(dir, '.capy', 'branch'), folder.capyBranch);
  }
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  }
}

const encryptedOn = (branch: string): Folder => ({ env: `# capy:branch=${branch}\nSECRET=${SEALED}\n` });

/** Runs `capy run` and returns the exit code plus everything written to stderr. */
async function run(folder: Folder, options: { allowProtected?: boolean } = {}) {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await inFolder(folder, () => runCommand(['node', '-e', '0'], false, options));
    return { code, stderr: errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
  } finally {
    errors.mockRestore();
  }
}

const childEnv = () => spawn.mock.calls[0]?.[2].env;

beforeEach(() => {
  [listBranches, authenticateSilent, resolveProjectKey, resolveLocalProjectKey, isLocalOnly, spawn].forEach((m) => m.mockReset());
  authenticateSilent.mockImplementation(async () => ({ success: true, user_id: 'user_1' }));
  resolveProjectKey.mockImplementation(async () => KEY);
  resolveLocalProjectKey.mockImplementation(async () => KEY);
  isLocalOnly.mockImplementation(() => false);
  spawn.mockImplementation(() => fakeChild());
  listBranches.mockImplementation(async () => [
    { name: 'prod', is_protected: true },
    { name: 'dev', is_protected: false },
  ]);
});

describe('protected branch, no --protected', () => {
  it('refuses with the code; nothing is decrypted, no child is spawned', async () => {
    const r = await run(encryptedOn('prod'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG}]`);
    expect(resolveProjectKey).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('asks the server once, for this project', async () => {
    await run(encryptedOn('prod'));
    expect(listBranches.mock.calls).toEqual([['proj_1']]);
  });

  it('reads the branch from .capy/branch when the .env has no header', async () => {
    const r = await run({ env: `SECRET=${SEALED}\n`, capyBranch: 'prod' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG}]`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('judges the branch by the server flag, not its name', async () => {
    listBranches.mockImplementation(async () => [{ name: 'main', is_protected: true }]);
    const r = await run(encryptedOn('main'));
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG}]`);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('protected branch, with --protected', () => {
  it('runs as today: the child receives the branch values', async () => {
    const r = await run(encryptedOn('prod'), { allowProtected: true });
    expect(r.code).toBe(0);
    expect(childEnv()?.SECRET).toBe(SECRET);
    expect(resolveProjectKey).toHaveBeenCalledTimes(1);
  });

  it('makes no branch lookup at all', async () => {
    await run(encryptedOn('prod'), { allowProtected: true });
    expect(listBranches).not.toHaveBeenCalled();
  });
});

describe('unprotected branch', () => {
  it('runs as today without the flag', async () => {
    const r = await run(encryptedOn('dev'));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(childEnv()?.SECRET).toBe(SECRET);
  });

  it('runs as today with the flag', async () => {
    const r = await run(encryptedOn('dev'), { allowProtected: true });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(childEnv()?.SECRET).toBe(SECRET);
  });
});

describe('status unreadable: fails closed with its own code', () => {
  const expectClosed = (r: { code: number; stderr: string }) => {
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_STATUS_UNREADABLE}]`);
    expect(r.stderr).not.toContain(ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG);
    expect(resolveProjectKey).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  };

  it('the branch list call fails', async () => {
    listBranches.mockImplementation(async () => Promise.reject(new Error('network down')));
    expectClosed(await run(encryptedOn('dev')));
  });

  it('the server does not list the folder branch', async () => {
    listBranches.mockImplementation(async () => [{ name: 'other', is_protected: false }]);
    expectClosed(await run(encryptedOn('dev')));
  });

  it('the answer carries no usable flag', async () => {
    listBranches.mockImplementation(async () => [{ name: 'dev' }]);
    expectClosed(await run(encryptedOn('dev')));
  });

  it('--protected still runs without asking', async () => {
    listBranches.mockImplementation(async () => Promise.reject(new Error('network down')));
    const r = await run(encryptedOn('dev'), { allowProtected: true });
    expect(r.code).toBe(0);
    expect(listBranches).not.toHaveBeenCalled();
  });
});

describe('exempt: no branch lookup is made', () => {
  it('a folder with no branch signal keeps today behavior', async () => {
    const r = await run({ env: `SECRET=${SEALED}\n` });
    expect(r.code).toBe(0);
    expect(childEnv()?.SECRET).toBe(SECRET);
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('a plaintext-only .env on a protected branch: no auth, no lookup, no key', async () => {
    const r = await run({ env: '# capy:branch=prod\nPLAIN=hello\n' });
    expect(r.code).toBe(0);
    expect(childEnv()?.PLAIN).toBe('hello');
    expect(listBranches).not.toHaveBeenCalled();
    expect(authenticateSilent).not.toHaveBeenCalled();
    expect(resolveProjectKey).not.toHaveBeenCalled();
  });

  it('a local-only profile on a protected-looking branch: runs offline, no auth, no lookup', async () => {
    isLocalOnly.mockImplementation(() => true);
    const r = await run(encryptedOn('prod'));
    expect(r.code).toBe(0);
    expect(childEnv()?.SECRET).toBe(SECRET);
    expect(resolveLocalProjectKey).toHaveBeenCalledTimes(1);
    expect(listBranches).not.toHaveBeenCalled();
    expect(authenticateSilent).not.toHaveBeenCalled();
    expect(resolveProjectKey).not.toHaveBeenCalled();
  });
});
