/**
 * `capy deploy`'s Vercel setup against the REAL org system store (same fake
 * service + on-disk master key as `tests/system/systemStore.test.ts`): the
 * token is `_TARGET_VERCEL_TOKEN`, a one-level reference to
 * `_CONNECTOR_VERCEL_TOKEN` is offered and saved when only that one exists,
 * and the hidden prompt carries the approved instructions ("Then paste it
 * here.", naming the link's team). The setup's own questions are injected;
 * Vercel is an in-memory fake.
 *
 * mock.module is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { mock, describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { project, fakeVercelFetch, callsOf } from '../helpers/fakeVercel';
import { captureConsole } from '../helpers/testSandbox';

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
let resolveVercelSetup: typeof import('../../src/deploy/vercelSetup').resolveVercelSetup;
let ERROR_CODES: typeof import('../../src/types/index').ERROR_CODES;

beforeAll(async () => {
  openSystemStore = (await import('../../src/system/systemStore')).openSystemStore;
  resolveVercelSetup = (await import('../../src/deploy/vercelSetup')).resolveVercelSetup;
  ERROR_CODES = (await import('../../src/types/index')).ERROR_CODES;
});

beforeEach(() => {
  servers.clear();
  promptAnswers.clear();
});

/** A new org per test, with its own master key, so no test inherits another's cached store. */
const freshOrg = async (): Promise<string> => {
  const org = `org_${randomBytes(4).toString('hex')}`;
  const { wrapAndSaveMasterKey } = await import('../../src/crypto/keyResolver');
  await wrapAndSaveMasterKey(randomBytes(32), org, USER, {
    coDecrypt: async (_o: string, ct: string) => ct.slice(KMS_PREFIX.length),
    wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
  });
  return org;
};

const setValue = async (org: string, name: string, value: string): Promise<void> => {
  const store = await openSystemStore({ orgId: org, devMode: true });
  await store.set(name, value);
};

const DATA = { teams: [{ id: 'team_acme', slug: 'acme' }], projects: { team_acme: [project('prj_web', 'web')] }, envs: {} };

const answers = (script: Record<string, unknown>) => async (questions: ReadonlyArray<Record<string, unknown>>) => ({
  [String(questions[0].name)]: script[String(questions[0].name)],
});

const run = async (org: string, readOnly: boolean) => {
  const fetchMock = mock(fakeVercelFetch(DATA));
  const out = await captureConsole(() =>
    resolveVercelSetup(
      {},
      org,
      { readOnly, devMode: true },
      {
        fetch: fetchMock as never,
        env: {},
        prompt: answers({ projectUrl: 'https://vercel.com/acme/web', confirmed: true, vercelEnv: 'production' }) as never,
      },
    ),
  );
  return { ...out, fetchMock };
};

const everything = (o: { stdout: readonly string[]; stderr: readonly string[] }) => [...o.stdout, ...o.stderr].join('\n');

describe('capy deploy Vercel setup — the token, through the real system store', () => {
  it('only _CONNECTOR_VERCEL_TOKEN exists: the setup offers to reuse it, saves a ONE-LEVEL REFERENCE, and checks the project with it', async () => {
    const org = await freshOrg();
    await setValue(org, '_CONNECTOR_VERCEL_TOKEN', 'tok_connector_fake');
    promptAnswers.set('choice', 'use');
    const out = await run(org, false);
    expect(callsOf(out.fetchMock)[0].authorization).toBe('Bearer tok_connector_fake');
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' });
    const reopened = await openSystemStore({ orgId: org, devMode: true });
    expect(reopened.listNames().find((e) => e.name === '_TARGET_VERCEL_TOKEN')?.referencesName).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(everything(out)).not.toContain('tok_connector_fake');
  });

  it('nothing saved anywhere: the hidden prompt carries the approved instructions ("Then paste it here.", the link\'s team), the typed token is saved and used, and never printed', async () => {
    const org = await freshOrg();
    promptAnswers.set('value', 'tok_typed_fake');
    const out = await run(org, false);
    const stderr = out.stderr.join('\n');
    expect(stderr).toContain('Create a token at https://vercel.com/account/settings/tokens. Set Scope to the team that owns the project (acme).');
    expect(stderr).toContain('Then paste it here.');
    expect(stderr).not.toContain('capy system set');
    expect(callsOf(out.fetchMock)[0].authorization).toBe('Bearer tok_typed_fake');
    const reopened = await openSystemStore({ orgId: org, devMode: true });
    expect(reopened.get('_TARGET_VERCEL_TOKEN')).toBe('tok_typed_fake');
    expect(everything(out)).not.toContain('tok_typed_fake');
  });

  it('a dry run (read only): never asks and never saves — says there is no token, with the "save it" instructions, and sends no request', async () => {
    const org = await freshOrg();
    const out = await run(org, true);
    expect(out.fetchMock.mock.calls.length).toBe(0);
    expect(out.stderr.join('\n')).toContain('Then save it: capy system set _TARGET_VERCEL_TOKEN');
    const reopened = await openSystemStore({ orgId: org, devMode: true });
    expect(reopened.listNames()).toEqual([]);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'web', teamSlug: 'acme' });
  });

  it('read only with only the connector token: its coded refusal is shown (never borrowed silently)', async () => {
    const org = await freshOrg();
    await setValue(org, '_CONNECTOR_VERCEL_TOKEN', 'tok_connector_fake');
    const out = await run(org, true);
    expect(out.fetchMock.mock.calls.length).toBe(0);
    expect(everything(out)).toContain(ERROR_CODES.VERCEL_TARGET_KEY_MISSING);
  });
});
