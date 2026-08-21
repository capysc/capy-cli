/**
 * CAP-304 single-user "lock-less" mode: a directory with no keep.lock resolves
 * identity + the branch's latest secrets from the server instead of hard
 * exiting, and every write through `writeAndSync` skips keep.lock entirely —
 * the server's latest/keep.json for org/project/branch is the only source of
 * truth. This file covers `resolveContext`'s two identity paths (`.env`
 * header, and auth + `listProjects` → the org's "default" project), the
 * lock-less write path, and the push CAS retry loop (`pushKeepWithRetry`) —
 * same-key conflicts refuse without a confirm callback, different-key
 * conflicts silently re-merge, and a persistent conflict fails coded after
 * the retry cap.
 *
 * AuthService, ServiceClient and keyResolver.resolveProjectKey are mocked —
 * network/crypto have no place in a unit test — but ProjectManager,
 * FileManager and SyncEngine are the real thing against a real temp
 * directory, same convention as connectDoesNotWriteValues.test.ts. `os` is
 * mocked so writeKeepCache/readKeepCache (real global-config code) land in a
 * throwaway home instead of the developer's actual ~/.capy.
 */
import { mock, describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(require('os').tmpdir(), 'capy-lockless-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => TEMP_HOME };
});

type AuthResult = { success: boolean; user_id?: string; organization_id?: string; error?: string };

let authResultQueue: AuthResult[] = [];
const authCalls: Array<{ method: string; orgId?: string }> = [];
mock.module(join(import.meta.dir, '../../../src/auth/authService.ts'), () => ({
  AuthService: class {
    constructor(_apiUrl?: string, _devMode?: boolean, _sessionUserId?: string) {}
    async authenticateSilent(orgId?: string): Promise<AuthResult> {
      authCalls.push({ method: 'authenticateSilent', orgId });
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    async authenticate(orgId?: string): Promise<AuthResult> {
      authCalls.push({ method: 'authenticate', orgId });
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999, organization_id: 'org-x', user_id: 'user-x' };
    }
  },
}));

type Project = { id: string; name: string; organization_id: string };

let listProjectsResult: Project[] = [];
let getDecryptDataResult: any = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
type PushImpl = (
  projectId: string,
  keepFile: string,
  envBlob: string,
  branch: string,
  baseKeepHash?: string,
) => Promise<{ keep_hash: string; keep_file?: string }>;
let pushSecretsQueue: PushImpl[] = [];
const serviceCalls: any[] = [];
mock.module(join(import.meta.dir, '../../../src/service/serviceClient.ts'), () => ({
  ServiceClient: class {
    constructor(_apiUrl?: string, _devMode?: boolean) {}
    setTokenProvider() {}
    async listProjects(): Promise<Project[]> {
      serviceCalls.push(['listProjects']);
      return listProjectsResult;
    }
    async getDecryptData(projectId: string, branch?: string) {
      serviceCalls.push(['getDecryptData', projectId, branch]);
      return getDecryptDataResult;
    }
    async pushSecrets(projectId: string, keepFile: string, envBlob: string, branch: string, baseKeepHash?: string) {
      serviceCalls.push(['pushSecrets', projectId, branch, baseKeepHash]);
      const next = pushSecretsQueue.shift();
      if (next) return next(projectId, keepFile, envBlob, branch, baseKeepHash);
      return { keep_hash: 'a'.repeat(64) };
    }
    async coDecrypt() {
      return { plaintext: '' };
    }
    async wrapOuterLayer() {
      return { ciphertext: '' };
    }
  },
}));

mock.module(join(import.meta.dir, '../../../src/crypto/keyResolver.ts'), () => ({
  resolveProjectKey: mock(async () => 'b'.repeat(64)),
}));

afterAll(() => {
  mock.restore();
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

import { resolveContext, writeAndSync, pushKeepWithRetry } from '../../../src/commands/connectors/shared';
import { CapyError, ERROR_CODES, KeepFile } from '../../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-lockless-ctx-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function resetState(): void {
  authResultQueue = [];
  authCalls.length = 0;
  listProjectsResult = [];
  getDecryptDataResult = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
  pushSecretsQueue = [];
  serviceCalls.length = 0;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  resetState();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeEnvHeader(): void {
  writeFileSync(join(TEST_DIR, '.env'), '# capy:org_id=org-header\n# capy:project_id=proj-header\n\n');
}

describe('resolveContext — lock-less identity resolution', () => {
  test('.env header resolves org/project without touching listProjects, and writes no keep.lock', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });

    expect(ctx.lockless).toBe(true);
    expect(ctx.orgId).toBe('org-header');
    expect(ctx.projectId).toBe('proj-header');
    expect(ctx.branch).toBe('development');
    expect(serviceCalls.some((c) => c[0] === 'listProjects')).toBe(false);
    expect(existsSync(join(TEST_DIR, 'keep.lock'))).toBe(false);
  });

  test('no .env header falls back to auth + listProjects, resolving the org\'s "default" project', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [
      { id: 'proj-other', name: 'not-default', organization_id: 'org-1' },
      { id: 'proj-1', name: 'default', organization_id: 'org-1' },
    ];

    const ctx = await resolveContext({ devMode: true });

    expect(ctx.orgId).toBe('org-1');
    expect(ctx.projectId).toBe('proj-1');
    expect(serviceCalls.some((c) => c[0] === 'listProjects')).toBe(true);
    expect(existsSync(join(TEST_DIR, 'keep.lock'))).toBe(false);
  });

  test('no "default" project on the org fails with a coded PROJECT_NOT_FOUND', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-other', name: 'not-default', organization_id: 'org-1' }];

    await expect(resolveContext({ devMode: true })).rejects.toMatchObject({
      code: ERROR_CODES.PROJECT_NOT_FOUND,
    });
  });

  test('branch defaults to "development" with no .env header, .capy/branch, or keep.lock signal', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];

    const ctx = await resolveContext({ devMode: true });

    expect(ctx.branch).toBe('development');
  });
});

describe('writeAndSync — lock-less writes', () => {
  test('never writes keep.lock; writes the .env identity header; writes the keep cache', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];
    pushSecretsQueue = [async () => ({ keep_hash: 'c'.repeat(64) })];

    const ctx = await resolveContext({ devMode: true });
    await writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', { push: true });

    expect(existsSync(join(TEST_DIR, 'keep.lock'))).toBe(false);

    const envContent = readFileSync(join(TEST_DIR, '.env'), 'utf-8');
    expect(envContent).toContain('# capy:org_id=org-header');
    expect(envContent).toContain('# capy:project_id=proj-header');
    expect(envContent).toContain('NEW_VAR=capy:');

    const cachePath = join(TEMP_HOME, '.capy', 'keep', 'org-header', 'proj-header', 'c'.repeat(64));
    expect(existsSync(cachePath)).toBe(true);
  });
});

describe('push CAS retry (pushKeepWithRetry, via writeAndSync)', () => {
  function serverKeepWith(varName: string, resourceId: string, valueHash: string): KeepFile {
    return {
      version: '3.0',
      org_id: 'org-header',
      project_id: 'proj-header',
      project_name: 'default',
      variables: {
        [varName]: [{ resource_id: resourceId, branch: 'development', value_hash: valueHash }],
      },
    };
  }

  test('a different-key server change is silently re-merged and both keys survive the retry', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    const serverKeep = serverKeepWith('OTHER_VAR', 'r-other', 'h-other');

    let secondBodyKeepFile: string | undefined;
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
      async (_projectId, keepFileJson) => {
        secondBodyKeepFile = keepFileJson;
        return { keep_hash: 'final-hash', keep_file: keepFileJson };
      },
    ];

    await writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', { push: true });

    const pushCalls = serviceCalls.filter((c) => c[0] === 'pushSecrets');
    expect(pushCalls.length).toBe(2);
    // First attempt used the context's own base hash; the retry used the
    // server's reported hash from the 409, not a guess.
    expect(pushCalls[1][3]).toBe('server-hash-1');

    // The retry's own request body carries both keys: the one this call
    // wrote, and the one that only exists because of the server-side rebase
    // — the silent re-merge the CAS retry exists to do.
    const pushedKeep: KeepFile = JSON.parse(secondBodyKeepFile!);
    expect(pushedKeep.variables.NEW_VAR?.[0]?.branch).toBe('development');
    expect(pushedKeep.variables.OTHER_VAR?.[0]?.value_hash).toBe('h-other');
  });

  test('the same key changing on the server refuses without a confirm callback', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    const serverKeep = serverKeepWith('NEW_VAR', 'r-someone-else', 'h-someone-else');

    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
    ];

    await expect(
      writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', { push: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_KEEP_HASH });

    // Refused before a second attempt — nothing was clobbered.
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(1);
  });

  test('the same key changing on the server overwrites when confirmOverwrite says yes', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    const serverKeep = serverKeepWith('NEW_VAR', 'r-someone-else', 'h-someone-else');
    const confirmCalls: string[][] = [];

    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
      async (_projectId, keepFileJson) => ({ keep_hash: 'final-hash', keep_file: keepFileJson }),
    ];

    await writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', {
      push: true,
      confirmOverwrite: async (names) => {
        confirmCalls.push(names);
        return true;
      },
    });

    expect(confirmCalls).toEqual([['NEW_VAR']]);
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(2);
  });

  test('a persistently stale push fails coded after the retry cap', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    const serverKeep = serverKeepWith('OTHER_VAR', 'r-other', 'h-other');
    const alwaysStale: PushImpl = async () => {
      throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
        status: 409,
        keep_hash: 'server-hash-forever',
        keep_file: JSON.stringify(serverKeep),
      });
    };
    pushSecretsQueue = [alwaysStale, alwaysStale, alwaysStale, alwaysStale, alwaysStale];

    await expect(
      writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', { push: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_KEEP_HASH });

    // Default cap is 3 retries → 4 attempts total (1 initial + 3 retries).
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(4);
  });
});

describe('pushKeepWithRetry — direct unit coverage', () => {
  test("a different-key conflict rebases via SyncEngine.spliceKeepBranch and preserves both keys' entries", async () => {
    const baseKeep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        NEW_VAR: [],
      },
    };
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        OTHER_VAR: [{ resource_id: 'r-other', branch: 'development', value_hash: 'h-other' }],
      },
    };

    let calls = 0;
    const fakeServiceClient = {
      pushSecrets: async (_projectId: string, keepFile: string) => {
        calls++;
        if (calls === 1) {
          throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
            status: 409,
            keep_hash: 'server-hash-1',
            keep_file: JSON.stringify(serverKeep),
          });
        }
        return { keep_hash: 'final-hash', keep_file: keepFile };
      },
    } as any;

    const result = await pushKeepWithRetry({
      serviceClient: fakeServiceClient,
      projectId: 'p',
      branch: 'development',
      baseKeep,
      baseHash: 'base-hash',
      envBlob: 'NEW_VAR=capy:rid:cipher',
      buildFinalKeep: (base) => ({
        ...base,
        variables: {
          ...base.variables,
          NEW_VAR: [{ resource_id: 'r-new', branch: 'development', value_hash: 'h-new' }],
        },
      }),
      primaryVarNames: ['NEW_VAR'],
    });

    expect(calls).toBe(2);
    expect(result.keep_hash).toBe('final-hash');
    expect(result.finalKeep.variables.NEW_VAR[0].value_hash).toBe('h-new');
    expect(result.finalKeep.variables.OTHER_VAR[0].value_hash).toBe('h-other');
  });

  test('omits base_keep_hash on the request when no base hash is known', async () => {
    const baseKeep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'd', variables: {} };
    const seenArgs: any[] = [];
    const fakeServiceClient = {
      pushSecrets: async (...args: any[]) => {
        seenArgs.push(args);
        return { keep_hash: 'h' };
      },
    } as any;

    await pushKeepWithRetry({
      serviceClient: fakeServiceClient,
      projectId: 'p',
      branch: 'development',
      baseKeep,
      baseHash: undefined,
      envBlob: '',
      buildFinalKeep: (base) => base,
      primaryVarNames: [],
    });

    expect(seenArgs[0][4]).toBeUndefined();
  });
});
