/**
 * CAP-664 — the org system store.
 *
 * Property tests, not shape tests: every "no plaintext leaked" assertion
 * greps the actual bytes written to disk and the actual bytes sent to the
 * fake service, rather than checking that a function merely returned
 * something. Maps to docs/org-system-store.md's numbered Proofs where noted.
 */
import { mock, describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

// Mock homedir to an isolated temp dir — must come before any import that
// touches os.homedir() (globalConfig.ts resolves it lazily, but keeping this
// first matches every other test in this suite).
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-system-store-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

const ORG_A = 'org_a';
const USER_A = 'user_a';
const KMS_PREFIX = 'KMS1.';

/** One fake "server" per org: the system project + its current ciphertext. */
interface FakeServer {
  projectId: string;
  role: 'owner' | 'admin' | 'member' | 'project-admin';
  envBlob: string;
  keepFile?: string;
  keepHash: string;
  pushCount: number;
}
const servers = new Map<string, FakeServer>();
/** Every network call the fake ServiceClient receives, in order — proves "before any network call". */
const calls: string[] = [];

function serverFor(orgId: string): FakeServer {
  const existing = servers.get(orgId);
  if (existing) return existing;
  const fresh: FakeServer = { projectId: `proj_${orgId}`, role: 'owner', envBlob: '', keepHash: 'h0', pushCount: 0 };
  servers.set(orgId, fresh);
  return fresh;
}
function serverForProject(projectId: string): FakeServer {
  for (const s of servers.values()) if (s.projectId === projectId) return s;
  throw new Error(`no fake server for project ${projectId}`);
}
function throwAdminOnly(): never {
  const err: any = new Error('owners/admins only');
  err.name = 'CapyError';
  err.code = 'PERMISSION_DENIED';
  err.details = { status: 403, code: 'SYSTEM_STORE_ADMIN_ONLY' };
  // Real CapyError isn't imported here to avoid pulling the real module in
  // before mocks are wired; systemStore.ts checks `err instanceof CapyError`,
  // so this constructs one from the REAL class via a lazy require.
  const { CapyError, ERROR_CODES } = require('../../src/types/index');
  throw new CapyError('owners/admins only', ERROR_CODES.PERMISSION_DENIED, { status: 403, code: 'SYSTEM_STORE_ADMIN_ONLY' });
}

mock.module('../../src/service/serviceClient', () => {
  class FakeServiceClient {
    setTokenProvider() {}
    async getOrCreateSystemStore(orgId: string) {
      calls.push('getOrCreateSystemStore');
      const s = serverFor(orgId);
      if (s.role !== 'owner' && s.role !== 'admin') throwAdminOnly();
      return { project_id: s.projectId, branch: 'system' };
    }
    async getDecryptData(projectId: string, _branch?: string, _keepHash?: string, _includeLatest?: boolean) {
      calls.push('getDecryptData');
      const s = serverForProject(projectId);
      if (s.role !== 'owner' && s.role !== 'admin') throwAdminOnly();
      return {
        env_content: s.envBlob,
        decrypt_key: '',
        expires_at: new Date().toISOString(),
        keep_file: s.keepFile,
        keep_hash: s.keepHash,
      };
    }
    async pushSecrets(projectId: string, keepFile: string, envBlob: string, _branch: string) {
      calls.push('pushSecrets');
      const s = serverForProject(projectId);
      if (s.role !== 'owner' && s.role !== 'admin') throwAdminOnly();
      s.envBlob = envBlob;
      s.keepFile = keepFile;
      s.pushCount += 1;
      s.keepHash = `h${s.pushCount}`;
      return { keep_hash: s.keepHash, keep_file: s.keepFile };
    }
    async coDecrypt(_orgId: string, ciphertext: string) {
      calls.push('coDecrypt');
      if (!ciphertext.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
      return { plaintext: ciphertext.slice(KMS_PREFIX.length) };
    }
    async wrapOuterLayer(_orgId: string, plaintext: string) {
      calls.push('wrapOuterLayer');
      return { ciphertext: KMS_PREFIX + plaintext };
    }
  }
  return { ServiceClient: FakeServiceClient };
});

mock.module('../../src/auth/authService', () => {
  class FakeAuthService {
    async authenticateSilent(_orgId?: string) {
      return { success: true, user_id: USER_A, user_email: 'a@capy.sc' };
    }
    async authenticate(_orgId?: string) {
      return { success: true, user_id: USER_A, user_email: 'a@capy.sc' };
    }
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999, organization_id: ORG_A, user_id: USER_A };
    }
  }
  return { AuthService: FakeAuthService };
});

let promptedWith: any[] = [];
let promptQueue: any[] = [];
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (questions: any) => {
      promptedWith.push(questions);
      const next = promptQueue.shift();
      return next ?? {};
    }),
  },
}));

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

// Dynamic imports so every module above sees the mocks.
let openSystemStore: typeof import('../../src/system/systemStore').openSystemStore;
let getConnectorSecret: typeof import('../../src/system/systemStore').getConnectorSecret;
let assertValidConnectorName: typeof import('../../src/system/systemStore').assertValidConnectorName;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;
let Encryptor: typeof import('../../src/crypto/encryptor').Encryptor;
let getSystemStoreDir: typeof import('../../src/config/globalConfig').getSystemStoreDir;
let getSystemKeepPath: typeof import('../../src/config/globalConfig').getSystemKeepPath;
let getSystemSyncStatePath: typeof import('../../src/config/globalConfig').getSystemSyncStatePath;
let getGlobalCapyDir: typeof import('../../src/config/globalConfig').getGlobalCapyDir;
let CapyError: typeof import('../../src/types/index').CapyError;
let ERROR_CODES: typeof import('../../src/types/index').ERROR_CODES;

beforeAll(async () => {
  const ss = await import('../../src/system/systemStore');
  openSystemStore = ss.openSystemStore;
  getConnectorSecret = ss.getConnectorSecret;
  assertValidConnectorName = ss.assertValidConnectorName;

  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
  resolveProjectKey = kr.resolveProjectKey;

  const enc = await import('../../src/crypto/encryptor');
  Encryptor = enc.Encryptor;

  const gc = await import('../../src/config/globalConfig');
  getSystemStoreDir = gc.getSystemStoreDir;
  getSystemKeepPath = gc.getSystemKeepPath;
  getSystemSyncStatePath = gc.getSystemSyncStatePath;
  getGlobalCapyDir = gc.getGlobalCapyDir;

  const types = await import('../../src/types/index');
  CapyError = types.CapyError;
  ERROR_CODES = types.ERROR_CODES;
});

/** Seed a REAL master key on disk for (orgId, userId), wrapped through the same KMS_PREFIX scheme the fake ServiceClient speaks. */
async function seedMasterKey(orgId: string, userId: string): Promise<void> {
  const masterKey = randomBytes(32);
  const fakeKms = {
    coDecrypt: async (_o: string, ct: string) => ct.slice(KMS_PREFIX.length),
    wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
  };
  await wrapAndSaveMasterKey(masterKey, orgId, userId, fakeKms);
}

/** Every byte written under the global dir, concatenated — for a plaintext-leak grep. */
function allWrittenBytes(): string {
  const root = getGlobalCapyDir();
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf-8'));
    }
  };
  walk(root);
  return out.join('\n');
}

describe('systemStore', () => {
  beforeEach(async () => {
    servers.clear();
    calls.length = 0;
    promptedWith = [];
    promptQueue = [];
    await seedMasterKey(ORG_A, USER_A);
  });

  it('set → list → get round-trips through a fresh open, and no plaintext ever touches disk or the pushed blob (Proof 1, 2)', async () => {
    const SENTINEL = `sentinel-${randomBytes(8).toString('hex')}`;
    const NAME = '_CONNECTOR_DOKPLOY_API_KEY';

    const store1 = await openSystemStore({ orgId: ORG_A, devMode: true });
    await store1.set(NAME, SENTINEL);

    // Fresh open — proves persistence through the fake server + local cache,
    // not just an in-memory snapshot from the same handle.
    const store2 = await openSystemStore({ orgId: ORG_A, devMode: true });
    expect(store2.get(NAME)).toBe(SENTINEL);
    expect(store2.listNames().map((e) => e.name)).toEqual([NAME]);

    // Proof 1: the sentinel never appears in anything written under the
    // global dir, nor in the blob actually pushed to the fake service.
    expect(allWrittenBytes().includes(SENTINEL)).toBe(false);
    expect(serverFor(ORG_A).envBlob.includes(SENTINEL)).toBe(false);
    expect(serverFor(ORG_A).envBlob.includes('capy:')).toBe(true);

    // Proof 2: the stored ciphertext decrypts with the REAL derived project
    // key (real Encryptor + resolveProjectKey), independent of the module
    // under test.
    const projectKey = await resolveProjectKey(ORG_A, serverFor(ORG_A).projectId, USER_A, {
      coDecrypt: async (_o, ct) => ct.slice(KMS_PREFIX.length),
      wrapOuterLayer: async (_o, pt) => KMS_PREFIX + pt,
    });
    const line = serverFor(ORG_A).envBlob.split('\n').find((l) => l.startsWith(`${NAME}=`))!;
    const cipher = line.slice(line.indexOf('capy:') + 'capy:'.length).split(':').slice(1).join(':');
    expect(Encryptor.decrypt(cipher, projectKey)).toBe(SENTINEL);
  });

  it('creates orgs/<orgId>/system/{keep.lock,sync-state} at 0700/0600', async () => {
    const store = await openSystemStore({ orgId: ORG_A, devMode: true });
    await store.set('_CONNECTOR_FOO_KEY', 'v');

    const dirMode = statSync(getSystemStoreDir(ORG_A)).mode & 0o777;
    const keepMode = statSync(getSystemKeepPath(ORG_A)).mode & 0o777;
    const syncMode = statSync(getSystemSyncStatePath(ORG_A)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(keepMode).toBe(0o600);
    expect(syncMode).toBe(0o600);
  });

  it('remove() drops the entry from a subsequent open', async () => {
    const store = await openSystemStore({ orgId: ORG_A, devMode: true });
    await store.set('_CONNECTOR_FOO_KEY', 'v1');
    await store.remove('_CONNECTOR_FOO_KEY');

    const store2 = await openSystemStore({ orgId: ORG_A, devMode: true });
    expect(store2.get('_CONNECTOR_FOO_KEY')).toBeNull();
    expect(store2.listNames()).toEqual([]);
  });

  it('rejects a bad name before any network call (Proof: SYSTEM_STORE_BAD_NAME)', () => {
    expect(() => assertValidConnectorName('NOT_A_CONNECTOR_NAME')).toThrow();
    try {
      assertValidConnectorName('NOT_A_CONNECTOR_NAME');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as any).code).toBe(ERROR_CODES.SYSTEM_STORE_BAD_NAME);
    }
    expect(calls).toEqual([]);
  });

  it('rejects a bad name from get/set/remove on an open store too', async () => {
    const store = await openSystemStore({ orgId: ORG_A, devMode: true });
    expect(() => store.get('bad')).toThrow();
    await expect(store.set('bad', 'v')).rejects.toThrow();
    await expect(store.remove('bad')).rejects.toThrow();
  });

  it('a non-admin/non-owner gets a typed SYSTEM_STORE_ADMIN_ONLY on open (read) and on write (Proof 3, 9)', async () => {
    serverFor(ORG_A).role = 'member';
    await expect(openSystemStore({ orgId: ORG_A, devMode: true })).rejects.toMatchObject({
      code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY,
    });

    // Demotion (Proof 9): an admin who could read before is refused the
    // moment their live role changes — nothing is cached across opens.
    serverFor(ORG_A).role = 'admin';
    const store = await openSystemStore({ orgId: ORG_A, devMode: true });
    expect(store.listNames()).toEqual([]);
    serverFor(ORG_A).role = 'member';
    await expect(openSystemStore({ orgId: ORG_A, devMode: true })).rejects.toMatchObject({
      code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY,
    });
  });

  it('owner and admin roles both succeed on read and write', async () => {
    for (const role of ['owner', 'admin'] as const) {
      servers.clear();
      await seedMasterKey(ORG_A, USER_A);
      serverFor(ORG_A).role = role;
      const store = await openSystemStore({ orgId: ORG_A, devMode: true });
      await store.set('_CONNECTOR_FOO_KEY', 'v');
      const reopened = await openSystemStore({ orgId: ORG_A, devMode: true });
      expect(reopened.listNames().map((e) => e.name)).toEqual(['_CONNECTOR_FOO_KEY']);
      expect(reopened.get('_CONNECTOR_FOO_KEY')).toBe('v');
    }
  });

  it('git-less: running inside a repo touches nothing in it (Proof 7)', async () => {
    const repo = mkdtempSync(join(require('os').tmpdir(), 'capy-system-store-repo-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email "t@example.com" && git config user.name "t"', { cwd: repo });
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe('');

      // No --org: openSystemStore must resolve org from opts only (no keep.lock
      // here), still never touching the repo. Explicit --org keeps this test
      // deterministic without needing a full resolveOrgContext auth flow.
      const store = await openSystemStore({ orgId: ORG_A, devMode: true });
      await store.set('_CONNECTOR_FOO_KEY', 'v');
      await store.remove('_CONNECTOR_FOO_KEY');
      store.listNames();

      expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe('');
      // Belt-and-braces: nothing was created in the repo directory itself either.
      expect(readdirSync(repo).sort()).toEqual(['.git']);
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('getConnectorSecret', () => {
    it('returns the value when the entry is already present', async () => {
      const store = await openSystemStore({ orgId: ORG_A, devMode: true });
      await store.set('_CONNECTOR_DOKPLOY_API_KEY', 'present-value');

      const value = await getConnectorSecret('_CONNECTOR_DOKPLOY_API_KEY', { orgId: ORG_A, devMode: true, interactive: false });
      expect(value).toBe('present-value');
      expect(promptedWith).toEqual([]);
    });

    it('missing + non-interactive → null, with zero prompts', async () => {
      const value = await getConnectorSecret('_CONNECTOR_DOKPLOY_API_KEY', { orgId: ORG_A, devMode: true, interactive: false });
      expect(value).toBeNull();
      expect(promptedWith).toEqual([]);
    });

    it('missing + interactive → prompts once (hidden input), saves, and returns the value', async () => {
      promptQueue.push({ value: 'typed-secret' });
      const value = await getConnectorSecret('_CONNECTOR_DOKPLOY_API_KEY', { orgId: ORG_A, devMode: true, interactive: true });
      expect(value).toBe('typed-secret');
      expect(promptedWith).toHaveLength(1);
      expect(promptedWith[0][0].type).toBe('password');

      // Saved — a later non-interactive call sees it without prompting again.
      const again = await getConnectorSecret('_CONNECTOR_DOKPLOY_API_KEY', { orgId: ORG_A, devMode: true, interactive: false });
      expect(again).toBe('typed-secret');
      expect(promptedWith).toHaveLength(1);
    });
  });
});
