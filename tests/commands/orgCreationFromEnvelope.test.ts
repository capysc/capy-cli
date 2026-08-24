/**
 * `createOrganizationFromEnvelope` (CAP-451): org creation from a broker
 * ceremony's `first_run.kind:'create_org'` answer. Reuses
 * `createNewOrganization`'s tail (create -> derive M -> wrap -> Case A) with
 * two differences specific to this source: phrase validation BEFORE
 * `/auth/create-org`, and a numeric-suffix retry on a 409 name collision with
 * the SAME phrase (no re-ask — there is nobody left to ask on this source).
 */
import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';

const validateSeedPhrase = mock((phrase: string) => phrase === 'valid phrase words here');
const seedPhraseToMasterKey = mock(() => Buffer.alloc(32, 7));
mock.module('../../src/crypto/keyManager', () => ({
  generateSeedPhrase: mock(() => 'unused'),
  validateSeedPhrase,
  seedPhraseToMasterKey,
  CURRENT_KDF_VERSION: 2,
}));

const wrapAndSaveMasterKey = mock(async () => undefined);
mock.module('../../src/crypto/keyResolver', () => ({
  wrapAndSaveMasterKey,
}));

const runNewUserEnrollmentCalls: Array<{ deps: any; args: any }> = [];
const runNewUserEnrollment = mock(async (deps: any, args: any) => {
  runNewUserEnrollmentCalls.push({ deps, args });
  return {
    ok: true,
    credentialId: 'cred-x',
    wrapperId: 'wrapper-x',
    verified: true,
    backupEligible: true,
    backupState: false,
    orgs: [],
  };
});
mock.module('../../src/auth/deviceKey/onboarding', () => ({ runNewUserEnrollment }));

const createDeviceKeyServiceOps = mock(() => ({ ops: {}, opsForOrg: async () => ({}) }));
mock.module('../../src/auth/deviceKey/serviceOps', () => ({ createDeviceKeyServiceOps }));

const reportEnrollmentOutcome = mock(() => undefined);
mock.module('../../src/auth/deviceKey/wiring', () => ({ reportEnrollmentOutcome }));

afterAll(() => mock.restore());

import { createOrganizationFromEnvelope, MAX_NAME_SUFFIX_ATTEMPTS } from '../../src/commands/orgCreation';
import { ERROR_CODES } from '../../src/types/index';

function fakeAuthService(createOrganization: (name: string) => Promise<any>) {
  return { createOrganization } as any;
}
const fakeServiceClient = { coDecrypt: async () => ({ plaintext: '' }), wrapOuterLayer: async () => ({ ciphertext: '' }) } as any;

beforeEach(() => {
  validateSeedPhrase.mockClear();
  seedPhraseToMasterKey.mockClear();
  wrapAndSaveMasterKey.mockClear();
  runNewUserEnrollment.mockClear();
  runNewUserEnrollmentCalls.length = 0;
  createDeviceKeyServiceOps.mockClear();
  reportEnrollmentOutcome.mockClear();
});

describe('createOrganizationFromEnvelope — phrase validation', () => {
  test('an invalid phrase refuses BEFORE /auth/create-org ever runs — no org created', async () => {
    let createCalls = 0;
    const authService = fakeAuthService(async () => { createCalls++; return { id: 'org_1', workos_org_id: 'w1', name: 'Acme' }; });

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient: fakeServiceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'not a real bip39 phrase',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_RECOVERY_PHRASE });

    expect(createCalls).toBe(0);
    expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
  });

  test('a valid phrase proceeds to create the org and derive/wrap M', async () => {
    const authService = fakeAuthService(async (name: string) => ({ id: 'org_1', workos_org_id: 'w1', name }));

    const org = await createOrganizationFromEnvelope({
      authService,
      serviceClient: fakeServiceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
    });

    expect(org.id).toBe('org_1');
    expect(wrapAndSaveMasterKey).toHaveBeenCalledTimes(1);
    expect(seedPhraseToMasterKey).toHaveBeenCalledWith('valid phrase words here', 2);
    // No PRF pair supplied — Case A never runs.
    expect(runNewUserEnrollment).not.toHaveBeenCalled();
  });
});

describe('createOrganizationFromEnvelope — 409 suffix loop', () => {
  test('appends a numeric suffix and retries with the SAME phrase, never re-asking', async () => {
    const seenNames: string[] = [];
    const authService = fakeAuthService(async (name: string) => {
      seenNames.push(name);
      if (seenNames.length < 3) {
        const err: any = new Error('conflict');
        err.status = 409;
        throw err;
      }
      return { id: 'org_3', workos_org_id: 'w3', name };
    });

    const org = await createOrganizationFromEnvelope({
      authService,
      serviceClient: fakeServiceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
    });

    expect(seenNames).toEqual(['Acme', 'Acme 2', 'Acme 3']);
    expect(org.name).toBe('Acme 3');
    // The phrase is derived exactly once, from the same fixed input — a
    // retry never regenerates or re-asks for a phrase.
    expect(seedPhraseToMasterKey).toHaveBeenCalledTimes(1);
    expect(seedPhraseToMasterKey).toHaveBeenCalledWith('valid phrase words here', 2);
  });

  test('caps the retry loop instead of looping forever against a service that always says 409', async () => {
    let calls = 0;
    const authService = fakeAuthService(async () => {
      calls++;
      const err: any = new Error('conflict');
      err.status = 409;
      throw err;
    });

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient: fakeServiceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ORG_NAME_SUFFIX_EXHAUSTED });

    // Exactly the cap's worth of real create-org attempts — never one more.
    expect(calls).toBe(MAX_NAME_SUFFIX_ATTEMPTS);
  });

  test('a non-409 failure propagates without looping', async () => {
    let calls = 0;
    const authService = fakeAuthService(async () => {
      calls++;
      const err: any = new Error('server error');
      err.status = 500;
      throw err;
    });

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient: fakeServiceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(calls).toBe(1);
  });
});

/**
 * A PRF evaluation the KDF would accept: 32 bytes, base64. The canned
 * transports now reject anything else as `transport_error` — an empty or short
 * output reaching deriveDeviceKeyKek is the bug that guard exists for — so a
 * "complete PRF pair" fixture has to be a plausible one.
 */
const PRF_OUTPUT = Buffer.alloc(32, 9).toString('base64');

describe('createOrganizationFromEnvelope — canned Case A enrollment', () => {
  test('a complete PRF pair runs Case A through a canned transport with the pre-obtained result', async () => {
    const authService = fakeAuthService(async (name: string) => ({ id: 'org_1', workos_org_id: 'w1', name }));
    const prfSalt = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');

    await createOrganizationFromEnvelope({
      authService,
      serviceClient: fakeServiceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-1', prfOutput: PRF_OUTPUT, backupEligible: true, backupState: false, prfSalt },
    });

    expect(runNewUserEnrollment).toHaveBeenCalledTimes(1);
    const { deps, args } = runNewUserEnrollmentCalls[0];
    expect(args.orgId).toBe('org_1');
    // The canned transport hands back the SAME PRF result — no second
    // WebAuthn round trip, no live BrokerCeremonyTransport involved.
    const ceremonyResult = await deps.ceremony.requestEnrollment({ userId: 'user_1', prfSalt: 'irrelevant' });
    expect(ceremonyResult).toEqual({
      ok: true,
      credentialId: 'cred-1',
      prfOutput: PRF_OUTPUT,
      backupEligible: true,
      backupState: false,
    });
    expect(reportEnrollmentOutcome).toHaveBeenCalledTimes(1);
  });

  // Regression: the canned transport's `requestEnrollment` ignores whatever
  // salt it is asked to use (see the fixture above — it hands back a fixed
  // result no matter what `prfSalt` the request carries), so the ONLY way
  // `runNewUserEnrollment` ends up deriving its wrap KEK from the salt the
  // browser's WebAuthn PRF extension actually ran under is if this call
  // passes it through explicitly as `presetPrfSalt`. The bug this closes:
  // `enrollDoor` used to mint a SECOND, unrelated salt here every time,
  // silently producing a device-key door no unlock could ever open again
  // (live finding: `DEVICE_KEY_UNWRAP_FAILED` on a genuinely fresh second
  // machine, 100% reproducible, not actually intermittent).
  test('the EXACT prfSalt from the envelope is threaded through as presetPrfSalt, never re-minted', async () => {
    const authService = fakeAuthService(async (name: string) => ({ id: 'org_2', workos_org_id: 'w2', name }));
    const prfSalt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    await createOrganizationFromEnvelope({
      authService,
      serviceClient: fakeServiceClient,
      refreshToken: 'rt',
      userId: 'user_2',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-2', prfOutput: 'prf-2', backupEligible: false, backupState: true, prfSalt },
    });

    const { args } = runNewUserEnrollmentCalls[0];
    expect(args.presetPrfSalt).toBe(prfSalt);
    expect(Buffer.isBuffer(args.presetPrfSalt)).toBe(true);
  });

  test('a failed Case A enrollment does not fail org creation (best-effort)', async () => {
    runNewUserEnrollment.mockImplementationOnce(async () => {
      throw new Error('enrollment blew up');
    });
    const authService = fakeAuthService(async (name: string) => ({ id: 'org_1', workos_org_id: 'w1', name }));

    const org = await createOrganizationFromEnvelope({
      authService,
      serviceClient: fakeServiceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-1', prfOutput: 'prf-1', backupEligible: true, backupState: false },
    });

    // Org creation itself succeeded despite the enrollment failure.
    expect(org.id).toBe('org_1');
  });
});
