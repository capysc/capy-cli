/**
 * Single-user "lock-less" mode: a directory with no keep.lock resolves
 * identity + the branch's latest secrets from the server instead of hard
 * exiting, and every write through `writeAndSync` skips keep.lock entirely —
 * the server's latest/keep.json for org/project/branch is the only source of
 * truth. This file covers `resolveContext`'s two identity paths (`.env`
 * header, and auth + `listProjects` → the org's "default" project), the
 * lock-less write path — including the fresh-directory case where there is no
 * local `.env` at all, the normal state for a personal env that follows the
 * user across repos — and the push CAS retry loop (`pushKeepWithRetry`):
 * same-key conflicts refuse without a confirm callback, different-key
 * conflicts silently re-merge (both in the KEEP and in the pushed ENV BLOB —
 * the two have to describe the same content or the branch's stored snapshot
 * ends up self-contradictory), and a persistent conflict fails coded after
 * the retry cap.
 *
 * AuthService, ServiceClient and keyResolver.resolveProjectKey are mocked —
 * network/crypto have no place in a unit test — but ProjectManager,
 * FileManager, SyncEngine and the real AES-GCM Encryptor are the real thing
 * against a real temp directory, same convention as
 * connectDoesNotWriteValues.test.ts. `os` is mocked so writeKeepCache/
 * readKeepCache (real global-config code) land in a throwaway home instead of
 * the developer's actual ~/.capy.
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

// Declared before any mock.module() factory references it below.
const PROJECT_KEY = 'b'.repeat(64);

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
let getSecretsResult: Record<string, { env_file: string } | null> = {};
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
    async getSecrets(projectId: string, keepHash: string) {
      serviceCalls.push(['getSecrets', projectId, keepHash]);
      return getSecretsResult[keepHash] ?? null;
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
  resolveProjectKey: mock(async () => PROJECT_KEY),
}));

// The edit screen's TUI reads a real TTY; replaced with a fake that hands the
// built `state` to the test and drives `editContext.saveLocalEdits` the way a
// person pressing save would. `classifyLocalRow` etc. pass through real —
// editCommand imports them from the same module — since only `EditScreen`
// itself needs faking.
import * as realEditScreen from '../../../src/ui/editScreen';
let editScreenRunCalls: Array<{ state: any }> = [];
let editSaveEdits: Record<string, string> = {};
mock.module(join(import.meta.dir, '../../../src/ui/editScreen.ts'), () => ({
  ...realEditScreen,
  EditScreen: class {
    async run(state: any, ctx: any) {
      editScreenRunCalls.push({ state });
      await ctx.saveLocalEdits(editSaveEdits);
    }
  },
}));

afterAll(() => {
  mock.restore();
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

import { resolveContext, writeAndSync, pushKeepWithRetry } from '../../../src/commands/connectors/shared';
import { CapyError, ERROR_CODES, KeepFile } from '../../../src/types/index';
import { FileManager } from '../../../src/files/fileManager';
import { Encryptor } from '../../../src/crypto/encryptor';
import { deriveResourceId } from '../../../src/crypto/resourceId';

/** A real `KEY=capy:resourceId:ciphertext` .env line, decryptable with PROJECT_KEY. */
function cipherLine(branch: string, key: string, value: string): string {
  return `${key}=capy:${deriveResourceId(branch, key)}:${Encryptor.encrypt(value, PROJECT_KEY)}`;
}

const TEST_DIR = join(tmpdir(), `capy-lockless-ctx-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function resetState(): void {
  authResultQueue = [];
  authCalls.length = 0;
  listProjectsResult = [];
  getDecryptDataResult = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
  getSecretsResult = {};
  pushSecretsQueue = [];
  serviceCalls.length = 0;
  editScreenRunCalls = [];
  editSaveEdits = {};
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

  test('a fresh directory (no .env at all) seeds localPlaintext from the server\'s blob', async () => {
    // The normal case in single-user mode: the personal env follows the user
    // across repos, so a brand new directory has no local .env yet even
    // though the branch already has vars on the server.
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
        B: [{ resource_id: deriveResourceId('development', 'B'), branch: 'development', value_hash: 'hB' }],
      },
    };
    getDecryptDataResult = {
      env_content: [cipherLine('development', 'A', 'value-a'), cipherLine('development', 'B', 'value-b')].join('\n'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(serverKeep),
    };

    const ctx = await resolveContext({ devMode: true });

    expect(existsSync(join(TEST_DIR, '.env'))).toBe(false);
    expect(ctx.localPlaintext.A).toBe('value-a');
    expect(ctx.localPlaintext.B).toBe('value-b');
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

  test('a fresh directory (no .env): writing one new var preserves the server\'s existing vars in keep AND env blob', async () => {
    // The bug this guards: `ctx.keep` is the server's keep (rich with A and
    // B), but before the resolveContext fix, `localPlaintext` came only from
    // the (here, nonexistent) local `.env` — so `finalEnv` would be just
    // `{NEW_VAR: ...}`, and writeAndSync's prune step would read "A and B are
    // in the keep but missing from finalEnv" as an explicit local delete and
    // strip them from the pushed keep. First `capy add` in a new directory
    // must not destroy the rest of the user's env.
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
        B: [{ resource_id: deriveResourceId('development', 'B'), branch: 'development', value_hash: 'hB' }],
      },
    };
    getDecryptDataResult = {
      env_content: [cipherLine('development', 'A', 'value-a'), cipherLine('development', 'B', 'value-b')].join('\n'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(serverKeep),
    };

    let pushedKeepJson = '';
    let pushedEnvBlob = '';
    pushSecretsQueue = [
      async (_projectId, keepFile, envBlob) => {
        pushedKeepJson = keepFile;
        pushedEnvBlob = envBlob;
        return { keep_hash: 'new-hash', keep_file: keepFile };
      },
    ];

    const ctx = await resolveContext({ devMode: true });
    await writeAndSync(ctx, 'C', 'value-c', { push: true });

    const pushedKeep: KeepFile = JSON.parse(pushedKeepJson);
    expect(Object.keys(pushedKeep.variables).sort()).toEqual(['A', 'B', 'C']);

    const fm = new FileManager();
    const parsed = fm.parseEnvContent(pushedEnvBlob);
    expect(Object.keys(parsed).sort()).toEqual(['A', 'B', 'C']);
    expect(fm.decryptValue(parsed.A, PROJECT_KEY)).toBe('value-a');
    expect(fm.decryptValue(parsed.B, PROJECT_KEY)).toBe('value-b');
    expect(fm.decryptValue(parsed.C, PROJECT_KEY)).toBe('value-c');
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

  test('a different-key server change is silently re-merged into both the keep AND the pushed env blob', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    const serverKeep = serverKeepWith('OTHER_VAR', 'r-other', 'h-other');
    const otherVarLine = cipherLine('development', 'OTHER_VAR', 'other-value');
    getSecretsResult['server-hash-1'] = { env_file: otherVarLine };

    let secondBodyKeepFile: string | undefined;
    let secondBodyEnvBlob: string | undefined;
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
      async (_projectId, keepFileJson, envBlob) => {
        secondBodyKeepFile = keepFileJson;
        secondBodyEnvBlob = envBlob;
        return { keep_hash: 'final-hash', keep_file: keepFileJson };
      },
    ];

    await writeAndSync(ctx, 'NEW_VAR', 'super-secret-value', { push: true });

    const pushCalls = serviceCalls.filter((c) => c[0] === 'pushSecrets');
    expect(pushCalls.length).toBe(2);
    // First attempt used the context's own base hash; the retry used the
    // server's reported hash from the 409, not a guess.
    expect(pushCalls[1][3]).toBe('server-hash-1');
    // The rebase fetched the server's blob for the rebased hash exactly once.
    expect(serviceCalls.filter((c) => c[0] === 'getSecrets')).toEqual([
      ['getSecrets', 'proj-header', 'server-hash-1'],
    ]);

    // The retry's own request body carries both keys in the KEEP: the one
    // this call wrote, and the one that only exists because of the
    // server-side rebase — the silent re-merge the CAS retry exists to do.
    const pushedKeep: KeepFile = JSON.parse(secondBodyKeepFile!);
    expect(pushedKeep.variables.NEW_VAR?.[0]?.branch).toBe('development');
    expect(pushedKeep.variables.OTHER_VAR?.[0]?.value_hash).toBe('h-other');

    // ...and in the ENV BLOB — not just the keep entry. Without this, the
    // branch's newly-pushed snapshot would list OTHER_VAR in its keep with no
    // value for it anywhere.
    const fm = new FileManager();
    const parsedBlob = fm.parseEnvContent(secondBodyEnvBlob!);
    expect(Object.keys(parsedBlob).sort()).toEqual(['NEW_VAR', 'OTHER_VAR']);
    // Carried forward verbatim — the exact ciphertext line the server had,
    // not a re-encryption of it (this call never even saw the plaintext).
    expect(parsedBlob.OTHER_VAR).toBe(otherVarLine.split('=').slice(1).join('='));
    expect(fm.decryptValue(parsedBlob.OTHER_VAR, PROJECT_KEY)).toBe('other-value');
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

describe('EditCommand — lock-less save', () => {
  test('a fresh directory: saving one edit preserves the server\'s existing vars in keep AND env blob', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
        B: [{ resource_id: deriveResourceId('development', 'B'), branch: 'development', value_hash: 'hB' }],
      },
    };
    getDecryptDataResult = {
      env_content: [cipherLine('development', 'A', 'value-a'), cipherLine('development', 'B', 'value-b')].join('\n'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(serverKeep),
    };

    let pushedKeepJson = '';
    let pushedEnvBlob = '';
    pushSecretsQueue = [
      async (_projectId, keepFile, envBlob) => {
        pushedKeepJson = keepFile;
        pushedEnvBlob = envBlob;
        return { keep_hash: 'new-hash', keep_file: keepFile };
      },
    ];
    editSaveEdits = { C: 'value-c' };

    const { EditCommand } = await import('../../../src/commands/editCommand');
    // The edit-surface gate requires stdin+stdout TTYs before the TUI renders.
    const savedIn = process.stdin.isTTY;
    const savedOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await new EditCommand(undefined, true).execute({});
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedIn, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: savedOut, configurable: true });
    }

    expect(editScreenRunCalls.length).toBe(1);
    // The rows the screen was handed already include the server's vars —
    // proof the row-building side of the same fix is wired, not just the
    // save path.
    const rowKeys = (editScreenRunCalls[0].state.rows as Array<{ key: string }>).map((r) => r.key).sort();
    expect(rowKeys).toEqual(['A', 'B']);

    const pushedKeep: KeepFile = JSON.parse(pushedKeepJson);
    expect(Object.keys(pushedKeep.variables).sort()).toEqual(['A', 'B', 'C']);

    const fm = new FileManager();
    const parsed = fm.parseEnvContent(pushedEnvBlob);
    expect(Object.keys(parsed).sort()).toEqual(['A', 'B', 'C']);
    expect(fm.decryptValue(parsed.A, PROJECT_KEY)).toBe('value-a');
    expect(fm.decryptValue(parsed.B, PROJECT_KEY)).toBe('value-b');
    expect(fm.decryptValue(parsed.C, PROJECT_KEY)).toBe('value-c');
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
      getSecrets: async () => null,
    } as any;

    const result = await pushKeepWithRetry({
      serviceClient: fakeServiceClient,
      projectId: 'p',
      branch: 'development',
      baseKeep,
      baseHash: 'base-hash',
      buildEnvBlob: (extraLines) =>
        (['NEW_VAR=capy:rid:cipher', ...extraLines]).join('\n'),
      localVarNames: ['NEW_VAR'],
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

  test('fetches the server blob and appends a verbatim ciphertext line for a foreign key', async () => {
    const baseKeep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'd', variables: {} };
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'd',
      variables: {
        FOREIGN: [{ resource_id: 'r-foreign', branch: 'development', value_hash: 'h-foreign' }],
      },
    };
    const foreignLine = cipherLine('development', 'FOREIGN', 'foreign-value');
    const foreignValue = foreignLine.split('=').slice(1).join('=');

    let calls = 0;
    const getSecretsCalls: any[] = [];
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
      getSecrets: async (projectId: string, keepHash: string) => {
        getSecretsCalls.push([projectId, keepHash]);
        return keepHash === 'server-hash-1' ? { env_file: foreignLine } : null;
      },
    } as any;

    let lastEnvBlob = '';
    const result = await pushKeepWithRetry({
      serviceClient: fakeServiceClient,
      projectId: 'p',
      branch: 'development',
      baseKeep,
      baseHash: 'base-hash',
      buildEnvBlob: (extraLines) => {
        lastEnvBlob = (['OWN=capy:rid:cipher', ...extraLines]).join('\n');
        return lastEnvBlob;
      },
      localVarNames: ['OWN'],
      buildFinalKeep: (base) => base,
      primaryVarNames: [],
    });

    expect(getSecretsCalls).toEqual([['p', 'server-hash-1']]);
    expect(result.envBlob).toBe(lastEnvBlob);
    const fm = new FileManager();
    const parsed = fm.parseEnvContent(result.envBlob);
    expect(parsed.OWN).toBe('capy:rid:cipher');
    // Verbatim — not re-encrypted, not touched.
    expect(parsed.FOREIGN).toBe(foreignValue);
  });

  test('omits base_keep_hash on the request when no base hash is known', async () => {
    const baseKeep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'd', variables: {} };
    const seenArgs: any[] = [];
    const fakeServiceClient = {
      pushSecrets: async (...args: any[]) => {
        seenArgs.push(args);
        return { keep_hash: 'h' };
      },
      getSecrets: async () => null,
    } as any;

    await pushKeepWithRetry({
      serviceClient: fakeServiceClient,
      projectId: 'p',
      branch: 'development',
      baseKeep,
      baseHash: undefined,
      buildEnvBlob: () => '',
      localVarNames: [],
      buildFinalKeep: (base) => base,
      primaryVarNames: [],
    });

    expect(seenArgs[0][4]).toBeUndefined();
  });
});
