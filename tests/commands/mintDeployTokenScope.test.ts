import { describe, test, expect, mock, afterAll } from 'bun:test';
import { hkdfSync } from 'crypto';

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
import type { FileManager } from '../../src/files/fileManager';

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

/** What `capy run` would recover — service key derived exactly as the service route does. */
function openBlob(secretsBlob: string): Record<string, string> {
  const { deployId, outerBlob, encryptedVars } = parseSecretsBlob(secretsBlob);
  const serviceKey = Buffer.from(
    hkdfSync('sha256', outerBlob, PROJECT_ID + deployId.toString('hex'), 'capy:deploy:service-key', 32),
  ).toString('hex');
  return decryptSecretsBlob(encryptedVars, PROJECT_KEY_HEX, serviceKey, deployId);
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
    expect(openBlob(minted.secretsBlob)).toEqual({
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
    expect(openBlob(minted.secretsBlob)).toEqual(ENV);
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
