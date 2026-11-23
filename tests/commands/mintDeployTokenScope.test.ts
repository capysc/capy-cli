import { describe, test, expect, mock, afterAll } from 'bun:test';
import { hkdfSync } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The project key comes from on-disk key material in real runs; here it is a
// fixed value so the mint itself — selection, encryption, blob layout — is
// what's under test. mock.module is process-wide: this file runs isolated.
const PROJECT_KEY_HEX = '11'.repeat(32);
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: async () => PROJECT_KEY_HEX,
}));
afterAll(() => mock.restore());

import {
  mintDeployToken,
  MissingSelectedVarsError,
  EmptyEnvError,
} from '../../src/commands/deployTokenCommand';
import { parseSecretsBlob, decryptSecretsBlob } from '../../src/crypto/deployRuntime';
import type { ServiceClient } from '../../src/service/serviceClient';
import { FileManager } from '../../src/files/fileManager';

const PROJECT_ID = 'proj_1';

const ENV = {
  DATABASE_URL: 'postgres://db',
  STRIPE_KEY: 'sk_live_x',
  UNRELATED_SECRET: 'must-not-ship',
};

const fakeFm = (env: Record<string, string>) =>
  ({
    readEnvFile: () => env,
    decryptValue: (v: string) => v,
  }) as unknown as FileManager;

/** KMS stands in as identity: the outer blob IS the inner blob. */
const identityService = {
  createDeployToken: async (_o: string, _d: string, _p: string, innerBlob: string) => ({
    outer_blob: innerBlob,
  }),
  coDecrypt: async () => {
    throw new Error('not used');
  },
  wrapOuterLayer: async () => {
    throw new Error('not used');
  },
} as unknown as ServiceClient;

/** Any touch of the service fails the test. */
const untouchable = new Proxy({} as ServiceClient, {
  get: (_t, prop) => {
    throw new Error(`service touched: ${String(prop)}`);
  },
});

/** The service key, derived exactly as the service route does (KMS stands in as identity here). */
function serviceKeyOf(secretsBlob: string): { serviceKey: string; parsed: ReturnType<typeof parseSecretsBlob> } {
  const parsed = parseSecretsBlob(secretsBlob);
  const serviceKey = Buffer.from(
    hkdfSync('sha256', parsed.outerBlob, PROJECT_ID + parsed.deployId.toString('hex'), 'capy:deploy:service-key', 32),
  ).toString('hex');
  return { serviceKey, parsed };
}

/** What `capy run` would recover, given the minted per-deploy key. */
function openBlob(minted: { secretsBlob: string; deployKey: string }, keyHex: string = minted.deployKey): Record<string, string> {
  const { serviceKey, parsed } = serviceKeyOf(minted.secretsBlob);
  return decryptSecretsBlob(parsed.encryptedVars, keyHex, serviceKey, parsed.deployId);
}

describe('mintDeployToken — per-target selection', () => {
  test('with vars, the bundle holds exactly the selected variables', async () => {
    const minted = await mintDeployToken({
      serviceClient: identityService,
      fm: fakeFm(ENV),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
      vars: ['DATABASE_URL', 'STRIPE_KEY'],
    });
    expect(openBlob(minted)).toEqual({
      DATABASE_URL: 'postgres://db',
      STRIPE_KEY: 'sk_live_x',
    });
    expect(minted.secretCount).toBe(2);
    expect(minted.deployId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('without vars, every .env value ships (token+docs flow unchanged)', async () => {
    const minted = await mintDeployToken({
      serviceClient: identityService,
      fm: fakeFm(ENV),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
    });
    expect(openBlob(minted)).toEqual(ENV);
  });

  test('a selected variable missing from .env fails before any service call', async () => {
    const err = await mintDeployToken({
      serviceClient: untouchable,
      fm: fakeFm(ENV),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
      vars: ['DATABASE_URL', 'GONE_VAR'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingSelectedVarsError);
    expect(err.missing).toEqual(['GONE_VAR']);
  });

  test('an empty .env fails before any service call', async () => {
    const err = await mintDeployToken({
      serviceClient: untouchable,
      fm: fakeFm({}),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EmptyEnvError);
  });
});

// ---------------------------------------------------------------------------
// Revocable deploys: a deploy target holds a RANDOM per-deploy key, never the
// project key. The project key is only used on the developer's machine to open
// `capy:` values before they are re-encrypted for the deploy.
// ---------------------------------------------------------------------------

/** A service that records what the mint sends it (KMS is identity, as above). */
function recordingService() {
  const createDeployToken = mock(async (...args: unknown[]) => ({ outer_blob: args[3] as string }));
  const service = {
    createDeployToken,
    coDecrypt: async () => {
      throw new Error('not used');
    },
    wrapOuterLayer: async () => {
      throw new Error('not used');
    },
  } as unknown as ServiceClient;
  return { service, calls: () => createDeployToken.mock.calls as unknown[][] };
}

/** A real FileManager over a temp folder whose `.env` holds real `capy:` lines, written by the CLI's own writer. */
function withRealCapyEnv<T>(plain: Record<string, string>, fn: (fm: FileManager, capyLines: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-mint-blast-'));
  const fm = new FileManager(dir);
  fm.writeEncryptedEnvFile(plain, PROJECT_KEY_HEX, undefined, null, 'main');
  const capyLines = fm.readEnvFile();
  return fn(fm, capyLines).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('mintDeployToken — the project key never reaches the deploy target', () => {
  test('no value in the minted artifact can decrypt a capy: line; the project key can (positive control)', async () => {
    await withRealCapyEnv({ DATABASE_URL: 'postgres://real-db', API_TOKEN: 'tok_real' }, async (fm, capyLines) => {
      const line = capyLines.DATABASE_URL;
      expect(line.startsWith('capy:')).toBe(true);

      // Positive control: the project key opens the very same ciphertext.
      expect(fm.decryptValue(line, PROJECT_KEY_HEX)).toBe('postgres://real-db');

      const { service, calls } = recordingService();
      const minted = await mintDeployToken({
        serviceClient: service,
        fm,
        orgId: 'org_1',
        projectId: PROJECT_ID,
        userId: 'user_1',
      });

      // The mint did open the capy: values (the deploy carries them in plaintext form)...
      expect(openBlob(minted)).toEqual({ DATABASE_URL: 'postgres://real-db', API_TOKEN: 'tok_real' });

      // ...but nothing it handed back is a key that opens them offline.
      const blobBytes = Buffer.from(minted.secretsBlob, 'base64');
      const everyWindow = Array.from({ length: Math.max(0, blobBytes.length - 31) }, (_, i) =>
        blobBytes.subarray(i, i + 32).toString('hex'),
      );
      const candidates = [
        minted.deployKey,
        minted.secretsBlob,
        minted.deployId,
        ...Object.values(minted).map(String),
        ...everyWindow,
        // The inner blob and the outer blob the service saw and returned.
        ...calls().flatMap((c) => [String(c[3]), Buffer.from(String(c[3]), 'base64').toString('hex')]),
      ];
      expect(candidates.length).toBeGreaterThan(100);
      const opened = candidates.filter((candidate) => {
        try {
          return fm.decryptValue(line, candidate) === 'postgres://real-db';
        } catch {
          return false;
        }
      });
      expect(opened).toEqual([]);
    });
  });

  test('the project key does not appear in the returned object or in anything sent to the service', async () => {
    await withRealCapyEnv({ DATABASE_URL: 'postgres://real-db' }, async (fm) => {
      const { service, calls } = recordingService();
      const minted = await mintDeployToken({
        serviceClient: service,
        fm,
        orgId: 'org_1',
        projectId: PROJECT_ID,
        userId: 'user_1',
      });
      const pkBytes = Buffer.from(PROJECT_KEY_HEX, 'hex');
      const forms = [PROJECT_KEY_HEX, pkBytes.toString('base64')];

      const returned = JSON.stringify(minted);
      expect(forms.filter((f) => returned.includes(f))).toEqual([]);
      expect(Object.keys(minted)).not.toContain('projectKey');

      const sent = JSON.stringify(calls());
      expect(forms.filter((f) => sent.includes(f))).toEqual([]);
      // The inner blob is plain random bytes: it does not carry the key in any decoded form either.
      const inner = Buffer.from(String(calls()[0][3]), 'base64');
      expect(inner.length).toBe(32);
      expect(inner.includes(pkBytes)).toBe(false);
    });
  });

  test('round trip: the deploy key + service key open the blob; the project key does not', async () => {
    const minted = await mintDeployToken({
      serviceClient: identityService,
      fm: fakeFm(ENV),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
    });
    expect(minted.deployKey).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.deployKey).not.toBe(PROJECT_KEY_HEX);
    expect(openBlob(minted)).toEqual(ENV);
    expect(() => openBlob(minted, PROJECT_KEY_HEX)).toThrow();
  });

  test('each mint gets its own deploy key', async () => {
    const mint = () =>
      mintDeployToken({ serviceClient: identityService, fm: fakeFm(ENV), orgId: 'org_1', projectId: PROJECT_ID, userId: 'user_1' });
    const [a, b] = await Promise.all([mint(), mint()]);
    expect(a.deployKey).not.toBe(b.deployKey);
  });

  test('createDeployToken is called with credential_generation deploy_key', async () => {
    const { service, calls } = recordingService();
    await mintDeployToken({
      serviceClient: service,
      fm: fakeFm(ENV),
      orgId: 'org_1',
      projectId: PROJECT_ID,
      userId: 'user_1',
    });
    expect(calls()).toHaveLength(1);
    expect(calls()[0].slice(0, 3)).toEqual(['org_1', expect.stringMatching(/^[0-9a-f]{64}$/), PROJECT_ID]);
    expect(calls()[0][4]).toBe('deploy_key');
  });
});
