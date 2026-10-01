/**
 * The Vercel API-mode token comes from the org system store (CAP-696):
 * `_TARGET_VERCEL_TOKEN`, which may be a one-level reference to
 * `_CONNECTOR_VERCEL_TOKEN`. Run against the REAL system store (same fake
 * service + on-disk master key as `tests/system/systemStore.test.ts`), so the
 * reference is saved and followed by the real code, not by a stand-in.
 *
 * mock.module is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { mock, describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-vercel-token-store-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

const ORG = 'org_a';
const USER = 'user_a';
const KMS_PREFIX = 'KMS1.';

interface FakeServer {
  projectId: string;
  role: 'owner' | 'member';
  envBlob: string;
  keepFile?: string;
  keepHash: string;
  pushCount: number;
}
const servers = new Map<string, FakeServer>();
const serverFor = (orgId: string): FakeServer =>
  servers.get(orgId) ?? servers.set(orgId, { projectId: `proj_${orgId}`, role: 'owner', envBlob: '', keepHash: 'h0', pushCount: 0 }).get(orgId)!;
const serverForProject = (projectId: string): FakeServer => {
  const found = [...servers.values()].find((s) => s.projectId === projectId);
  if (!found) throw new Error(`no fake server for project ${projectId}`);
  return found;
};
function refuseNonAdmin(s: FakeServer): void {
  if (s.role === 'owner') return;
  const { CapyError, ERROR_CODES } = require('../../src/types/index');
  throw new CapyError('owners/admins only', ERROR_CODES.PERMISSION_DENIED, { status: 403, code: 'SYSTEM_STORE_ADMIN_ONLY' });
}

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async getOrCreateSystemStore(orgId: string) {
      const s = serverFor(orgId);
      refuseNonAdmin(s);
      return { project_id: s.projectId, branch: 'system' };
    }
    async getDecryptData(projectId: string) {
      const s = serverForProject(projectId);
      refuseNonAdmin(s);
      return { env_content: s.envBlob, decrypt_key: '', expires_at: new Date().toISOString(), keep_file: s.keepFile, keep_hash: s.keepHash };
    }
    async pushSecrets(projectId: string, keepFile: string, envBlob: string) {
      const s = serverForProject(projectId);
      refuseNonAdmin(s);
      s.envBlob = envBlob;
      s.keepFile = keepFile;
      s.pushCount += 1;
      s.keepHash = `h${s.pushCount}`;
      return { keep_hash: s.keepHash, keep_file: s.keepFile };
    }
    async coDecrypt(_orgId: string, ciphertext: string) {
      return { plaintext: ciphertext.slice(KMS_PREFIX.length) };
    }
    async wrapOuterLayer(_orgId: string, plaintext: string) {
      return { ciphertext: KMS_PREFIX + plaintext };
    }
  },
}));
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return { success: true, user_id: USER, user_email: 'a@capy.sc' };
    }
    async authenticate() {
      return { success: true, user_id: USER, user_email: 'a@capy.sc' };
    }
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999, organization_id: ORG, user_id: USER };
    }
  },
}));
const promptAnswers = new Map<string, unknown>();
mock.module('inquirer', () => ({
  default: { prompt: mock(async (questions: Array<{ name: string }>) => ({ [questions[0].name]: promptAnswers.get(questions[0].name) })) },
}));

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let openSystemStore: typeof import('../../src/system/systemStore').openSystemStore;
let resolveVercelTargetToken: typeof import('../../src/deploy/vercelTargetApi').resolveVercelTargetToken;
let getVercelTargetSecretFromStore: typeof import('../../src/deploy/vercelTargetApi').getVercelTargetSecretFromStore;
let VERCEL_TARGET_SECRET_NAME: string;
let VERCEL_CONNECTOR_SECRET_NAME: string;
let ERROR_CODES: typeof import('../../src/types/index').ERROR_CODES;

beforeAll(async () => {
  openSystemStore = (await import('../../src/system/systemStore')).openSystemStore;
  const api = await import('../../src/deploy/vercelTargetApi');
  resolveVercelTargetToken = api.resolveVercelTargetToken;
  getVercelTargetSecretFromStore = api.getVercelTargetSecretFromStore;
  VERCEL_TARGET_SECRET_NAME = api.VERCEL_TARGET_SECRET_NAME;
  VERCEL_CONNECTOR_SECRET_NAME = api.VERCEL_CONNECTOR_SECRET_NAME;
  ERROR_CODES = (await import('../../src/types/index')).ERROR_CODES;
  const { wrapAndSaveMasterKey } = await import('../../src/crypto/keyResolver');
  await wrapAndSaveMasterKey(randomBytes(32), ORG, USER, {
    coDecrypt: async (_o: string, ct: string) => ct.slice(KMS_PREFIX.length),
    wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
  });
});

beforeEach(() => {
  servers.clear();
  promptAnswers.clear();
});

const setValue = async (name: string, value: string): Promise<void> => {
  const store = await openSystemStore({ orgId: ORG, devMode: true });
  await store.set(name, value);
};

const resolve = (over: { interactive?: boolean; env?: Record<string, string | undefined> } = {}) =>
  resolveVercelTargetToken({
    env: over.env ?? {},
    interactive: over.interactive ?? false,
    orgId: ORG,
    devMode: true,
    getSecret: getVercelTargetSecretFromStore,
  });

describe('Vercel target token — org system store', () => {
  it('the names are the documented ones', () => {
    expect(VERCEL_TARGET_SECRET_NAME).toBe('_TARGET_VERCEL_TOKEN');
    expect(VERCEL_CONNECTOR_SECRET_NAME).toBe('_CONNECTOR_VERCEL_TOKEN');
  });

  it('a literal _TARGET_VERCEL_TOKEN resolves, from the system store', async () => {
    await setValue(VERCEL_TARGET_SECRET_NAME, 'tok_literal_fake');
    expect(await resolve()).toEqual({ ok: true, value: 'tok_literal_fake', source: 'system' });
  });

  it('a one-level reference to _CONNECTOR_VERCEL_TOKEN resolves to the connector value, and follows it when it changes', async () => {
    await setValue(VERCEL_CONNECTOR_SECRET_NAME, 'tok_connector_fake');
    // Interactive run: choose to reuse the connector token — the store saves a REFERENCE.
    promptAnswers.set('choice', 'use');
    expect(await resolve({ interactive: true })).toEqual({ ok: true, value: 'tok_connector_fake', source: 'system' });

    const reopened = await openSystemStore({ orgId: ORG, devMode: true });
    expect(reopened.listNames().find((e) => e.name === VERCEL_TARGET_SECRET_NAME)?.referencesName).toBe(VERCEL_CONNECTOR_SECRET_NAME);

    // Later, non-interactive (the sandbox case): the reference resolves with no prompt.
    expect(await resolve()).toEqual({ ok: true, value: 'tok_connector_fake', source: 'system' });
    // It is a reference, not a copy: rotating the connector token rotates what deploy uses.
    await setValue(VERCEL_CONNECTOR_SECRET_NAME, 'tok_rotated_fake');
    expect(await resolve()).toEqual({ ok: true, value: 'tok_rotated_fake', source: 'system' });
  });

  it('only the connector token exists + non-interactive: a coded refusal, nothing borrowed silently', async () => {
    await setValue(VERCEL_CONNECTOR_SECRET_NAME, 'tok_connector_fake');
    expect(await resolve()).toEqual({ ok: false, code: ERROR_CODES.VERCEL_TARGET_KEY_MISSING });
  });

  it('nothing anywhere: VERCEL_TOKEN_MISSING; $VERCEL_TOKEN is the last resort', async () => {
    expect(await resolve()).toEqual({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING });
    expect(await resolve({ env: { VERCEL_TOKEN: 'tok_env_fake' } })).toEqual({ ok: true, value: 'tok_env_fake', source: 'env' });
  });

  it('a non-admin caller: the store refuses with its own code, passed through', async () => {
    serverFor(ORG).role = 'member';
    expect(await resolve()).toEqual({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
  });
});
