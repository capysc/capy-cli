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

describe('Keep-owned organization creation', () => {
  for (const web of [false, true]) {
    test(`routes ${web ? 'browser' : 'terminal'} creation to Keep before any local ceremony`, async () => {
      await expect(createNewOrganization(originalAuth, serviceClientFor, 'refresh-before', auth.user_id, web))
        .rejects.toMatchObject({ code: 'KEEP_ONBOARDING_REQUIRED',
          details: { keep_url: expect.stringMatching(/\/signup\?intent=create-org$/) } });
      expect(createOrganization).not.toHaveBeenCalled();
      expect(generateSeedPhrase).not.toHaveBeenCalled();
      expect(createOrganizationInBrowser).not.toHaveBeenCalled();
      expect(wrapAndSaveMasterKey).not.toHaveBeenCalled();
      expect(attemptCaseAEnrollment).not.toHaveBeenCalled();
      expect(serviceClientFor).not.toHaveBeenCalled();
    });
  }
});
