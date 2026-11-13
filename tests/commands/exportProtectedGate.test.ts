/**
 * `exportCommand` (the library function that prints decrypted values) on a protected branch.
 *
 * Same rule as `capy run`: on a server-backed profile with at least one encrypted entry, the
 * server says whether the folder's branch is protected, before anything is decrypted. Protected
 * without `allowProtected` is refused with a code; an unreadable status fails closed.
 *
 * `capy export` is not a public CLI command, so the flag is an option of the function.
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
const isLocalOnly = mock(() => false);

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

const realProfile = await import('../../src/config/profileConfig');
mock.module('../../src/config/profileConfig', () => ({
  ...realProfile,
  isLocalOnly: () => isLocalOnly(),
}));

afterAll(() => mock.restore());

const { exportCommand } = await import('../../src/commands/exportCommand');

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

async function inFolder<T>(folder: Folder, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-export-gate-'));
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

/** Runs the export and returns the exit code, what it printed, and what it wrote to stderr. */
async function exportIn(folder: Folder, options: { allowProtected?: boolean; vars?: string[] } = {}) {
  const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await inFolder(folder, () => exportCommand({ format: 'json', ...options }));
    return {
      code,
      stdout: out.mock.calls.map((c) => String(c[0])).join(''),
      stderr: err.mock.calls.map((c) => String(c[0])).join(''),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

beforeEach(() => {
  [listBranches, authenticateSilent, resolveProjectKey, isLocalOnly].forEach((m) => m.mockReset());
  authenticateSilent.mockImplementation(async () => ({ success: true, user_id: 'user_1' }));
  resolveProjectKey.mockImplementation(async () => KEY);
  isLocalOnly.mockImplementation(() => false);
  listBranches.mockImplementation(async () => [
    { name: 'prod', is_protected: true },
    { name: 'dev', is_protected: false },
  ]);
});

describe('protected branch, no flag', () => {
  it('refuses with the code; nothing is decrypted, nothing is printed', async () => {
    const r = await exportIn(encryptedOn('prod'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG}]`);
    expect(r.stdout).toBe('');
    expect(resolveProjectKey).not.toHaveBeenCalled();
  });

  it('asks the server once, for this project', async () => {
    await exportIn(encryptedOn('prod'));
    expect(listBranches.mock.calls).toEqual([['proj_1']]);
  });
});

describe('protected branch, with the flag', () => {
  it('prints the values as today, and makes no branch lookup', async () => {
    const r = await exportIn(encryptedOn('prod'), { allowProtected: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ SECRET });
    expect(listBranches).not.toHaveBeenCalled();
  });
});

describe('unprotected branch', () => {
  it('prints as today without the flag', async () => {
    const r = await exportIn(encryptedOn('dev'));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ SECRET });
  });

  it('prints as today with the flag', async () => {
    const r = await exportIn(encryptedOn('dev'), { allowProtected: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ SECRET });
  });

  it('a missing var is still reported the old way', async () => {
    const r = await exportIn(encryptedOn('dev'), { vars: ['NOPE'] });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('capy export: missing var(s): NOPE\n');
  });
});

describe('status unreadable: fails closed with its own code', () => {
  const expectClosed = (r: { code: number; stdout: string; stderr: string }) => {
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`[${ERROR_CODES.PROTECTED_STATUS_UNREADABLE}]`);
    expect(r.stdout).toBe('');
    expect(resolveProjectKey).not.toHaveBeenCalled();
  };

  it('the branch list call fails', async () => {
    listBranches.mockImplementation(async () => Promise.reject(new Error('network down')));
    expectClosed(await exportIn(encryptedOn('dev')));
  });

  it('the server does not list the folder branch', async () => {
    listBranches.mockImplementation(async () => [{ name: 'other', is_protected: false }]);
    expectClosed(await exportIn(encryptedOn('dev')));
  });
});

describe('exempt: no branch lookup is made', () => {
  it('a folder with no branch signal', async () => {
    const r = await exportIn({ env: `SECRET=${SEALED}\n` });
    expect(r.code).toBe(0);
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('a plaintext-only .env on a protected branch: no auth, no lookup, no key', async () => {
    const r = await exportIn({ env: '# capy:branch=prod\nPLAIN=hello\n' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ PLAIN: 'hello' });
    expect(listBranches).not.toHaveBeenCalled();
    expect(authenticateSilent).not.toHaveBeenCalled();
    expect(resolveProjectKey).not.toHaveBeenCalled();
  });

  it('a local-only profile: no lookup', async () => {
    isLocalOnly.mockImplementation(() => true);
    const r = await exportIn(encryptedOn('prod'));
    expect(r.code).toBe(0);
    expect(listBranches).not.toHaveBeenCalled();
  });
});
