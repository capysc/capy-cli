/**
 * `createOrganizationFromEnvelope` (CAP-451/CAP-542): org creation from a
 * broker ceremony's `first_run.kind:'create_org'` answer.
 *
 * CAP-542 replaced the old `/auth/create-org` call (`AuthService.createOrganization`)
 * with the mint-ceremony rail (`ServiceClient.mintPersonalOrgCeremony`):
 * name-collision suffixing moved server-side (no more CLI-side retry loop),
 * the mint-ceremony call claims this device's key-mint lease in the same
 * round trip that creates the org, auth is re-scoped to the new org via
 * `authenticateSilent` (the old endpoint returned org-scoped tokens
 * directly; this one does not), and the lease is finalized
 * (`finalizeKeyMintOrThrow`, never swallowed to a false success) after the
 * local key is saved.
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

const runNewUserEnrollment = mock(async (_deps: any, _args: any) => {
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

import { createOrganizationFromEnvelope } from '../../src/commands/orgCreation';
import { ERROR_CODES, CapyError } from '../../src/types/index';

/**
 * Every fake method below is a bun `mock()`, which already tracks its own
 * `.mock.calls` (arguments per invocation) and `.mock.invocationCallOrder`
 * (a GLOBAL monotonic index shared across every mock in the file) — reading
 * those after the fact is enough to assert both "was this called" and
 * "in what order relative to that other mock", with no hand-rolled shared
 * log or counter to keep in sync.
 */
interface AuthServiceOpts {
  orgless?: { success: boolean; _orgless_access_token?: string; error?: string; error_code?: string };
  pin?: (orgId: string) => { success: boolean; error?: string; error_code?: string };
}

function fakeAuthService(opts: AuthServiceOpts = {}): any {
  return {
    authenticateSilent: mock(async (orgId?: string) => {
      if (orgId === undefined) {
        return opts.orgless ?? { success: true, _orgless_access_token: 'orgless-tok' };
      }
      return opts.pin ? opts.pin(orgId) : { success: true, organization_id: orgId };
    }),
    getValidToken: mock(async () => null),
  };
}

interface ServiceClientOpts {
  mint?: (name?: string) => any;
  finalize?: () => any;
}

function fakeServiceClient(opts: ServiceClientOpts = {}): any {
  return {
    setTokenProvider: mock(() => undefined),
    mintPersonalOrgCeremony: mock(async (name?: string) => {
      if (opts.mint) return opts.mint(name);
      return {
        org_id: 'org_1',
        project_id: 'proj_1',
        mint_claim: { key_state: 'minting', expires_at: '2099-01-01T00:00:00Z' },
        organization: { id: 'org_1', workos_org_id: 'w1', name: name ?? 'Acme' },
      };
    }),
    finalizeKeyMint: mock(async () => {
      if (opts.finalize) return opts.finalize();
      return { key_state: 'minted' };
    }),
    coDecrypt: async () => ({ plaintext: '' }),
    wrapOuterLayer: async () => ({ ciphertext: '' }),
  };
}

/** The order index of a mock's Nth (default 1st) call, for ordering assertions across different fakes. */
function orderOf(fn: { mock: { invocationCallOrder: number[] } }, callIndex = 0): number {
  return fn.mock.invocationCallOrder[callIndex];
}

beforeEach(() => {
  validateSeedPhrase.mockClear();
  seedPhraseToMasterKey.mockClear();
  wrapAndSaveMasterKey.mockClear();
  runNewUserEnrollment.mockClear();
  createDeviceKeyServiceOps.mockClear();
  reportEnrollmentOutcome.mockClear();
});

describe('createOrganizationFromEnvelope — phrase validation', () => {
  test('an invalid phrase refuses BEFORE any network call — no org minted', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'not a real bip39 phrase',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_RECOVERY_PHRASE });

    expect(authService.authenticateSilent).not.toHaveBeenCalled();
    expect(serviceClient.setTokenProvider).not.toHaveBeenCalled();
    expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
  });
});

describe('createOrganizationFromEnvelope — mint-ceremony sequence', () => {
  test('a valid phrase mints via the ceremony, re-scopes, derives/wraps M, and finalizes — in order', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();

    const org = await createOrganizationFromEnvelope({
      authService,
      serviceClient,
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

    // authenticateSilent is called TWICE: once org-less (no args), once to
    // re-scope (with the minted org id) — in that order.
    expect(authService.authenticateSilent.mock.calls).toEqual([[], ['org_1']]);
    expect(orderOf(authService.authenticateSilent, 0)).toBeLessThan(orderOf(serviceClient.setTokenProvider, 0));
    expect(orderOf(serviceClient.setTokenProvider, 0)).toBeLessThan(orderOf(serviceClient.mintPersonalOrgCeremony, 0));
    expect(orderOf(serviceClient.mintPersonalOrgCeremony, 0)).toBeLessThan(orderOf(authService.authenticateSilent, 1));
    expect(orderOf(authService.authenticateSilent, 1)).toBeLessThan(orderOf(serviceClient.finalizeKeyMint, 0));
  });

  test('the org-less bearer is obtained and the org re-scoped BEFORE the master key is ever derived or wrapped', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();

    await createOrganizationFromEnvelope({
      authService,
      serviceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
    });

    // authenticateSilent's SECOND call (index 1) is the re-scope — it must
    // happen before the master key is ever derived/wrapped, and finalize
    // must be the very last thing this run does.
    const pinOrder = orderOf(authService.authenticateSilent, 1);
    expect(pinOrder).toBeLessThan(orderOf(wrapAndSaveMasterKey, 0));
    expect(orderOf(serviceClient.finalizeKeyMint, 0)).toBeGreaterThan(orderOf(wrapAndSaveMasterKey, 0));
  });

  test('the mint-ceremony call receives the base name — collision suffixing is server-side now, no CLI-side retry loop', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();

    await createOrganizationFromEnvelope({
      authService,
      serviceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
    });

    expect(serviceClient.mintPersonalOrgCeremony).toHaveBeenCalledTimes(1);
    expect(serviceClient.mintPersonalOrgCeremony).toHaveBeenCalledWith('Acme');
  });

  test('mint-ceremony ALREADY_PROVISIONED (409) is a coded failure — never retried, never finalized', async () => {
    const err = new CapyError('already provisioned', ERROR_CODES.ALREADY_PROVISIONED, { status: 409 });
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient({ mint: () => { throw err; } });

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toBe(err);

    expect(serviceClient.finalizeKeyMint).not.toHaveBeenCalled();
    expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
  });

  test('a failed org-less bearer refuses before the mint-ceremony call ever runs', async () => {
    const authService = fakeAuthService({ orgless: { success: false, error: 'offline', error_code: 'network' } });
    const serviceClient = fakeServiceClient();

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK_ERROR });

    expect(serviceClient.mintPersonalOrgCeremony).not.toHaveBeenCalled();
  });

  test('a failed re-scope after a successful mint is a coded failure, never a silently org-less success', async () => {
    const authService = fakeAuthService({
      pin: () => ({ success: false, error: 'lag', error_code: 'server_error' }),
    });
    const serviceClient = fakeServiceClient();

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SERVICE_ERROR });

    expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
    expect(serviceClient.finalizeKeyMint).not.toHaveBeenCalled();
  });

  test('a finalize conflict is a coded failure, never swallowed into a false success — the phrase is void', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient({
      finalize: () => { throw new CapyError('not claimed', ERROR_CODES.KEY_MINT_NOT_CLAIMED, { status: 409 }); },
    });

    await expect(
      createOrganizationFromEnvelope({
        authService,
        serviceClient,
        refreshToken: 'rt',
        userId: 'user_1',
        name: 'Acme',
        phrase: 'valid phrase words here',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.KEY_MINT_NOT_CLAIMED });

    // The local save DID happen (finalize runs after it) — this asserts the
    // ORDERING invariant, not that the write never occurred.
    expect(wrapAndSaveMasterKey).toHaveBeenCalledTimes(1);
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
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();
    const prfSalt = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');

    await createOrganizationFromEnvelope({
      authService,
      serviceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-1', prfOutput: PRF_OUTPUT, backupEligible: true, backupState: false, prfSalt },
    });

    expect(runNewUserEnrollment).toHaveBeenCalledTimes(1);
    const [deps, args] = runNewUserEnrollment.mock.calls[0];
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
    // Case A runs AFTER the org is re-scoped and the key is wrapped, but
    // BEFORE finalize — the lease is only finalized once everything else
    // this ceremony can do has been attempted.
    const enrollIdx = runNewUserEnrollment.mock.invocationCallOrder[0];
    const finalizeIdx = serviceClient.finalizeKeyMint.mock.invocationCallOrder[0];
    expect(enrollIdx).toBeLessThan(finalizeIdx);
  });

  test('the EXACT prfSalt from the envelope is threaded through as presetPrfSalt, never re-minted', async () => {
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();
    const prfSalt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    await createOrganizationFromEnvelope({
      authService,
      serviceClient,
      refreshToken: 'rt',
      userId: 'user_2',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-2', prfOutput: PRF_OUTPUT, backupEligible: false, backupState: true, prfSalt },
    });

    const [, args] = runNewUserEnrollment.mock.calls[0];
    expect(args.presetPrfSalt).toBe(prfSalt);
    expect(Buffer.isBuffer(args.presetPrfSalt)).toBe(true);
  });

  test('a failed Case A enrollment does not fail org creation (best-effort) — finalize still runs', async () => {
    runNewUserEnrollment.mockImplementationOnce(async () => {
      throw new Error('enrollment blew up');
    });
    const authService = fakeAuthService();
    const serviceClient = fakeServiceClient();

    const org = await createOrganizationFromEnvelope({
      authService,
      serviceClient,
      refreshToken: 'rt',
      userId: 'user_1',
      name: 'Acme',
      phrase: 'valid phrase words here',
      prf: { credentialId: 'cred-1', prfOutput: PRF_OUTPUT, backupEligible: true, backupState: false },
    });

    // Org creation itself succeeded despite the enrollment failure.
    expect(org.id).toBe('org_1');
    expect(serviceClient.finalizeKeyMint).toHaveBeenCalledTimes(1);
  });
});
