/** ISOLATED (mock.module): checked creation authority and mutation retry boundary. */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthService } from '../../src/auth/authService';
import type { ServiceClient } from '../../src/service/serviceClient';

const createOrganization = mock();
const createOrganizationInBrowser = mock();
const generateSeedPhrase = mock(() => 'fixture phrase retained only in memory');
const masterKey = Buffer.alloc(32, 1);
const wrapAndSaveMasterKey = mock(async (..._args: readonly unknown[]) => undefined);
const attemptCaseAEnrollment = mock(async () => ({ ok: true }));
const org = { id: 'org-created', workos_org_id: 'workos-created', name: 'Created' } as const;
const auth = { success: true, user_id: 'user_creator', organization_id: org.id, organizations: [org] } as const;
const replacementAuth = { getValidToken: async () => ({ authority: 'replacement' }) } as unknown as AuthService;
const originalAuth = { createOrganization } as unknown as AuthService;
const scopedCoDecrypt = mock(async () => ({ plaintext: 'fixture wrapped result' }));
const scopedWrap = mock(async () => ({ ciphertext: 'fixture ciphertext' }));
const scopedClient = { coDecrypt: scopedCoDecrypt, wrapOuterLayer: scopedWrap } as unknown as ServiceClient;
const serviceClientFor = mock(() => scopedClient);
const installed = { organization: org, auth, authService: replacementAuth } as const;

mock.module('../../src/crypto/keyManager', () => ({
  generateSeedPhrase,
  seedPhraseToMasterKey: () => masterKey,
  CURRENT_KDF_VERSION: 2,
}));
mock.module('../../src/crypto/keyResolver', () => ({ wrapAndSaveMasterKey }));
mock.module('../../src/auth/deviceKey/wiring', () => ({ attemptCaseAEnrollment }));
mock.module('../../src/ui/onboardingWeb', () => ({ createOrganizationInBrowser }));
mock.module('../../src/ui/spinner', () => ({
  default: () => ({ start: () => ({ succeed: mock(), fail: mock() }) }),
}));

import { createNewOrganization, type DeviceKeyEnrollmentOptions } from '../../src/commands/orgCreation';

beforeEach(() => {
  [createOrganization, createOrganizationInBrowser, generateSeedPhrase, wrapAndSaveMasterKey,
    attemptCaseAEnrollment, scopedCoDecrypt, scopedWrap, serviceClientFor].forEach((fn) => fn.mockClear());
  createOrganization.mockResolvedValue(installed);
  createOrganizationInBrowser.mockResolvedValue({ name: org.name, cancelled: false });
  wrapAndSaveMasterKey.mockResolvedValue(undefined);
  attemptCaseAEnrollment.mockResolvedValue({ ok: true });
});

const run = (enrollment?: DeviceKeyEnrollmentOptions) =>
  createNewOrganization(originalAuth, serviceClientFor, 'refresh-before', auth.user_id, true, enrollment);

describe('organization creation installation propagation', () => {
  test('wraps and enrolls through replacement authority and returns the same context', async () => {
    const enrollment = {
      ctx: { authService: originalAuth, serviceClient: {} as ServiceClient, devMode: true,
        userId: auth.user_id, organizations: [] },
      orglessToken: 'prior-orgless-token',
    } as DeviceKeyEnrollmentOptions;
    const result = await run(enrollment);
    expect(serviceClientFor).toHaveBeenCalledWith(replacementAuth);
    expect(result).toEqual({ ...installed, serviceClient: scopedClient });
    const ops = wrapAndSaveMasterKey.mock.calls[0]?.[3] as unknown as Readonly<{
      coDecrypt: (orgId: string, ciphertext: string) => Promise<string>;
    }>;
    expect(await ops.coDecrypt(org.id, 'fixture ciphertext')).toBe('fixture wrapped result');
    expect(scopedCoDecrypt).toHaveBeenCalledWith(org.id, 'fixture ciphertext');
    expect(attemptCaseAEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      ctx: expect.objectContaining({ authService: replacementAuth, serviceClient: scopedClient,
        organizations: [org], activeOrgId: org.id }),
      orgId: org.id,
      orglessToken: 'prior-orgless-token',
    }));
    expect(enrollment.ctx.authService).toBe(originalAuth);
  });

  test('only exact pre-refresh conflict retries the name with the same phrase', async () => {
    createOrganization.mockRejectedValueOnce({ code: 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH' });
    const result = await run();
    expect(result.organization).toEqual(org);
    expect(createOrganization).toHaveBeenCalledTimes(2);
    expect(generateSeedPhrase).toHaveBeenCalledTimes(1);
    const requests = createOrganizationInBrowser.mock.calls.map((call) => call[0]) as ReadonlyArray<Readonly<{
      phrase: string; nameOnly: boolean;
    }>>;
    expect(requests[0]?.phrase).toBe(requests[1]?.phrase);
    expect(requests[1]?.nameOnly).toBe(true);
    expect(wrapAndSaveMasterKey).toHaveBeenCalledTimes(1);
  });

  test('generic provider conflict is propagated without creation retry or local wrapping', async () => {
    const failure = { status: 409 };
    createOrganization.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(createOrganization).toHaveBeenCalledTimes(1);
    expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
  });

  test('a wrapping conflict cannot return to the create call even with the safe provider code', async () => {
    const failure = { status: 409, code: 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH' };
    wrapAndSaveMasterKey.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(createOrganization).toHaveBeenCalledTimes(1);
    expect(attemptCaseAEnrollment).not.toHaveBeenCalled();
  });

  test('an enrollment conflict cannot repeat creation or wrapping', async () => {
    const failure = { status: 409, code: 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH' };
    attemptCaseAEnrollment.mockRejectedValueOnce(failure);
    await expect(run({ ctx: { userId: auth.user_id } as DeviceKeyEnrollmentOptions['ctx'],
      orglessToken: null })).rejects.toBe(failure);
    expect(createOrganization).toHaveBeenCalledTimes(1);
    expect(wrapAndSaveMasterKey).toHaveBeenCalledTimes(1);
  });
});
