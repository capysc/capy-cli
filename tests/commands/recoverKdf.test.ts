/**
 * recover — KDF version detection (real wiring).
 *
 * Unlike recoverCommand.test.ts (which mocks keyResolver), this exercises the
 * REAL keyResolver + keyManager + FileManager + globalConfig so the new
 * findOrgCiphertextOracle + resolveProjectKeyByTrial path actually runs.
 *
 * recover must reproduce the org's existing M exactly — a wrong KDF version
 * would write a key.enc that corrupts the org for every other member. It learns
 * the version by trial-decrypting a piece of the org's own ciphertext fetched
 * from the server. These tests prove it writes the right-version M and refuses
 * a phrase that matches nothing.
 */
import { mock, describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempHome = mkdtempSync(join(tmpdir(), 'capy-recover-kdf-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

let answers: Record<string, any> = {};
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (q: any) => {
      const arr = Array.isArray(q) ? q : [q];
      const out: Record<string, any> = {};
      for (const item of arr) {
        if (!(item.name in answers)) throw new Error(`unexpected prompt: ${item.name}`);
        out[item.name] = answers[item.name];
      }
      return out;
    }),
  },
}));

const FAKE_USER_ID = 'user_kdf';
const ORG = 'org-kdf';
const PROJECT = 'proj-kdf';
const FAKE_ORGS = [{ id: ORG, workos_org_id: 'workos-kdf', name: 'KdfOrg' }];

mock.module('../../src/auth/authService', () => ({
  AuthService: class FakeAuthService {
    constructor(_apiUrl?: string, _devMode?: boolean, _userId?: string) {}
    async authenticateSilent(orgId?: string) {
      return { success: true, user_id: FAKE_USER_ID, user_email: 'v@capy.sc', organizations: FAKE_ORGS, organization_id: orgId };
    }
    getValidToken() { return Promise.resolve('tok'); }
  },
}));

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class FakeProjectManager {
    async detectProjectState() { return { initialized: false, userId: FAKE_USER_ID }; }
  },
}));

// What the fake server returns from getDecryptData — set per test.
let serverEnvContent = '';
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class FakeServiceClient {
    constructor(_apiUrl?: string) {}
    setTokenProvider(_fn: any) {}
    coDecrypt(_o: string, _c: string) { return Promise.resolve({ plaintext: 'unused' }); }
    wrapOuterLayer(_o: string, pt: string) { return Promise.resolve({ ciphertext: 'kms:' + pt }); }
    listProjects() { return Promise.resolve([{ id: PROJECT, name: 'p', organization_id: ORG }]); }
    getDecryptData(_pid: string) { return Promise.resolve({ env_content: serverEnvContent }); }
  },
}));

class ExitError extends Error { constructor(public code: number) { super(`exit:${code}`); } }
const originalExit = process.exit;
(process as any).exit = (code?: number) => { throw new ExitError(code ?? 0); };

let RecoverCommand: any;
let km: typeof import('../../src/crypto/keyManager');
let gc: typeof import('../../src/config/globalConfig');
let lkr: typeof import('../../src/crypto/localKeyRoot');
let Encryptor: typeof import('../../src/crypto/encryptor').Encryptor;

beforeAll(async () => {
  ({ RecoverCommand } = await import('../../src/commands/recoverCommand'));
  km = await import('../../src/crypto/keyManager');
  gc = await import('../../src/config/globalConfig');
  lkr = await import('../../src/crypto/localKeyRoot');
  ({ Encryptor } = await import('../../src/crypto/encryptor'));
});

afterAll(() => {
  mock.restore();
  (process as any).exit = originalExit;
  rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  answers = {};
  serverEnvContent = '';
  rmSync(join(tempHome, '.capy'), { recursive: true, force: true });
});

// A server env blob with one value encrypted under the given version's project key.
function envBlobForVersion(version: 1 | 2, phrase: string): string {
  const pk = km.deriveProjectKey(km.seedPhraseToMasterKey(phrase, version), PROJECT, ORG);
  return `SECRET=capy:res1:${Encryptor.encrypt('server-secret', pk)}`;
}

// Recover the M that recover wrote to disk (strip fake KMS layer, unwrap inner).
// The inner blob is AAD-bound and keyed by HKDF(K_local) — recover mints this
// machine's local.key alongside key.enc, so unwrap with the root it wrote.
function writtenMasterKey(): Buffer {
  const outer = gc.readMasterKey(ORG, FAKE_USER_ID);
  if (!outer) throw new Error('no key written');
  const inner = outer.replace(/^kms:/, '');
  const kLocal = gc.readLocalRoot(ORG, FAKE_USER_ID);
  if (!kLocal) throw new Error('no local.key written');
  return km.decryptMasterKey(
    inner,
    lkr.deriveLocalInnerKey(kLocal),
    km.masterKeyAAD(FAKE_USER_ID, ORG),
  );
}

describe('RecoverCommand — KDF version detection', () => {
  test('legacy v1 org: detects v1 from ciphertext and writes the v1 master key', async () => {
    const phrase = km.generateSeedPhrase();
    serverEnvContent = envBlobForVersion(1, phrase);
    answers = { orgId: ORG, seedPhrase: phrase };

    await new RecoverCommand().execute();

    expect(writtenMasterKey().equals(km.seedPhraseToMasterKey(phrase, 1))).toBe(true);
    expect(writtenMasterKey().equals(km.seedPhraseToMasterKey(phrase, 2))).toBe(false);
  });

  test('current v2 org: detects v2 and writes the v2 master key', async () => {
    const phrase = km.generateSeedPhrase();
    serverEnvContent = envBlobForVersion(2, phrase);
    answers = { orgId: ORG, seedPhrase: phrase };

    await new RecoverCommand().execute();

    expect(writtenMasterKey().equals(km.seedPhraseToMasterKey(phrase, 2))).toBe(true);
  });

  test('phrase that matches no ciphertext is rejected and nothing is written', async () => {
    const real = km.generateSeedPhrase();
    let wrong = km.generateSeedPhrase();
    while (wrong === real) wrong = km.generateSeedPhrase();
    serverEnvContent = envBlobForVersion(1, real);
    answers = { orgId: ORG, seedPhrase: wrong };

    await expect(new RecoverCommand().execute()).rejects.toBeInstanceOf(ExitError);
    expect(gc.readMasterKey(ORG, FAKE_USER_ID)).toBeNull();
  });
});
