/**
 * CAP-664 — the org system store's first read against a store nobody has
 * ever pushed to.
 *
 * Unlike systemStore.test.ts (which fakes the whole `ServiceClient` module),
 * this file fakes only `fetch` and drives the REAL `ServiceClient`, so the
 * real 404-interpretation logic in `classifyResponse`/`getDecryptData` runs
 * for real. It exercises both response shapes a service can send for the
 * fresh-store 404 — with the `code` field (current server) and without it
 * (older server, legacy text bridge) — and confirms `openSystemStore`
 * produces the same empty-store behavior either way, and that `set` still
 * works afterwards. See docs/org-system-store.md and
 * service/src/routes/secrets.ts's `NO_SECRETS` 404.
 */
import { mock, describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { Encryptor } from '../../src/crypto/encryptor';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-system-store-fresh-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

const USER_ID = 'user_fresh';
const KMS_PREFIX = 'KMS1.';

/** The exact 404 body the service sends for a fresh store — see secrets.ts. */
const NO_SECRETS_MESSAGE = 'No secrets have been pushed to this project yet.';

// systemStore.ts imports `inquirer` unconditionally at module load, and its
// transitive deps break the `os` mock above (an ESM default import bun can't
// satisfy against our partial mock) unless it's replaced — this file never
// exercises the interactive prompt path, so a stub is enough.
mock.module('inquirer', () => ({
  default: { prompt: async () => ({}) },
}));

mock.module('../../src/auth/authService', () => {
  class FakeAuthService {
    async authenticateSilent(_orgId?: string) {
      return { success: true, user_id: USER_ID, user_email: 'fresh@capy.sc' };
    }
    async authenticate(_orgId?: string) {
      return { success: true, user_id: USER_ID, user_email: 'fresh@capy.sc' };
    }
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999, organization_id: 'unused', user_id: USER_ID };
    }
  }
  return { AuthService: FakeAuthService };
});

/** Per-test wiring: which project id the fake service serves, and how it answers the fresh-store GET. */
interface FakeServiceState {
  projectId: string;
  secretsGetResponse: { status: number; body: Record<string, unknown> };
}
let current: FakeServiceState;

/** Every push this fake service has accepted, so `set` can be proven to have worked. */
const pushedBlobs: string[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Real ServiceClient, real classifyResponse/getDecryptData — only the wire is faked. */
const fakeFetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const body = init?.body ? JSON.parse(init.body) : undefined;

  if (method === 'POST' && /\/system-store$/.test(path)) {
    return jsonResponse(200, { project_id: current.projectId, branch: 'system' });
  }
  if (method === 'POST' && /\/co-decrypt$/.test(path)) {
    const ciphertext = body.ciphertext as string;
    return jsonResponse(200, { plaintext: ciphertext.slice(KMS_PREFIX.length) });
  }
  if (method === 'POST' && /\/wrap$/.test(path)) {
    return jsonResponse(200, { ciphertext: KMS_PREFIX + (body.plaintext as string) });
  }
  if (method === 'GET' && path.startsWith(`/secrets/${current.projectId}`)) {
    return jsonResponse(current.secretsGetResponse.status, current.secretsGetResponse.body);
  }
  if (method === 'POST' && path === `/secrets/${current.projectId}`) {
    pushedBlobs.push(body.env_blob as string);
    return jsonResponse(200, { keep_hash: 'h1', keep_file: body.keep_file });
  }
  throw new Error(`fakeFetch: no route for ${method} ${path}`);
};

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let openSystemStore: typeof import('../../src/system/systemStore').openSystemStore;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;

beforeAll(async () => {
  const ss = await import('../../src/system/systemStore');
  openSystemStore = ss.openSystemStore;
  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
  resolveProjectKey = kr.resolveProjectKey;
});

/**
 * Same KMS_PREFIX co-decrypt/wrap scheme `fakeFetch` speaks — used to
 * independently re-derive the project key `openSystemStore`/`set` used
 * internally, so a pushed value's round trip can be verified from OUTSIDE
 * the module under test rather than trusting its own internal decrypt path.
 */
function fakeKmsOps() {
  return {
    coDecrypt: async (_o: string, ct: string) => ct.slice(KMS_PREFIX.length),
    wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
  };
}

/**
 * Parses the single `KEY=capy:{resourceId}:{cipher}` line a pushed
 * `env_blob` contains in these tests (mirrors `systemStore.ts`'s own
 * private `decryptStoredValue`, kept independent here on purpose — this
 * test verifies the PROPERTY the module promises, not its internals) and
 * decrypts `cipher` with `projectKey`.
 */
function decryptPushedLine(blobLine: string, projectKey: string): string {
  const eq = blobLine.indexOf('=');
  const raw = blobLine.slice(eq + 1);
  const parts = raw.split(':');
  const cipher = parts.slice(2).join(':');
  return Encryptor.decrypt(cipher, projectKey);
}

/** Seed a real local master key for `orgId`, wrapped through the same KMS_PREFIX scheme `fakeFetch`'s /wrap and /co-decrypt speak. */
async function seedMasterKey(orgId: string): Promise<void> {
  const masterKey = randomBytes(32);
  const fakeKms = {
    coDecrypt: async (_o: string, ct: string) => ct.slice(KMS_PREFIX.length),
    wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
  };
  await wrapAndSaveMasterKey(masterKey, orgId, USER_ID, fakeKms);
}

describe('systemStore — fresh store 404 (CAP-664, NO_SECRETS)', () => {
  beforeEach(() => {
    pushedBlobs.length = 0;
    (global as any).fetch = fakeFetch;
  });

  it('a fresh store\'s 404 WITH code NO_SECRETS opens empty, and set() still works', async () => {
    const orgId = `org_fresh_with_code_${randomBytes(4).toString('hex')}`;
    current = {
      projectId: `proj_${orgId}`,
      secretsGetResponse: { status: 404, body: { error: NO_SECRETS_MESSAGE, code: 'NO_SECRETS' } },
    };
    await seedMasterKey(orgId);

    const store = await openSystemStore({ orgId, devMode: true });
    expect(store.listNames()).toEqual([]);

    // A long, high-entropy sentinel — not the 2-character `'v1'` this test
    // used to write, which random AES-GCM ciphertext can coincidentally
    // contain (reproduced once: a real push landed a base64 cipher
    // containing "v1" as a substring, failing `not.toContain('v1')` with no
    // actual leak). At this length a coincidental substring match is
    // astronomically unlikely, but the REAL proof below is the decrypt
    // round trip, not this absence check.
    const plaintext = `sentinel-${randomBytes(24).toString('hex')}`;
    await store.set('_CONNECTOR_DOKPLOY_API_KEY', plaintext);
    expect(pushedBlobs).toHaveLength(1);
    expect(pushedBlobs[0]).toContain('capy:');
    expect(pushedBlobs[0]).not.toContain(plaintext);

    // The property this test exists to prove: the pushed blob is not just
    // "doesn't look like the plaintext" but ACTUALLY decrypts, with this
    // org's own project key, back to the exact plaintext that was set.
    const projectId = current.projectId;
    const projectKey = await resolveProjectKey(orgId, projectId, USER_ID, fakeKmsOps());
    expect(decryptPushedLine(pushedBlobs[0], projectKey)).toBe(plaintext);
  });

  it('a fresh store\'s 404 WITHOUT code (legacy server, text-only) opens empty, and set() still works', async () => {
    const orgId = `org_fresh_no_code_${randomBytes(4).toString('hex')}`;
    current = {
      projectId: `proj_${orgId}`,
      secretsGetResponse: { status: 404, body: { error: NO_SECRETS_MESSAGE } },
    };
    await seedMasterKey(orgId);

    const store = await openSystemStore({ orgId, devMode: true });
    expect(store.listNames()).toEqual([]);

    const plaintext = `sentinel-${randomBytes(24).toString('hex')}`;
    await store.set('_CONNECTOR_DOKPLOY_API_KEY', plaintext);
    expect(pushedBlobs).toHaveLength(1);
    expect(pushedBlobs[0]).toContain('capy:');
    expect(pushedBlobs[0]).not.toContain(plaintext);

    const projectId = current.projectId;
    const projectKey = await resolveProjectKey(orgId, projectId, USER_ID, fakeKmsOps());
    expect(decryptPushedLine(pushedBlobs[0], projectKey)).toBe(plaintext);
  });
});
