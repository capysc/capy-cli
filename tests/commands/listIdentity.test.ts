import { expect, mock, test } from 'bun:test';
import { CapyError, ERROR_CODES, type AuthResult } from '../../src/types';
import { requireListIdentity } from '../../src/commands/listMetadata';

const authenticated = (userId: string): AuthResult => ({
  success: true,
  user_id: userId,
  organization_id: 'org_fixture',
  organizations: [],
});

test('list identity accepts the exact authenticated account', async () => {
  const authenticate = mock(async () => authenticated('user_fixture'));
  await expect(requireListIdentity({ authenticate }, 'user_fixture', 'org_fixture'))
    .resolves.toEqual(authenticated('user_fixture'));
  expect(authenticate).toHaveBeenCalledWith('org_fixture');
});

test('list identity refuses a missing or mismatched authenticated account', async () => {
  await expect(requireListIdentity({ authenticate: async () => ({ success: false }) }, 'user_fixture'))
    .rejects.toEqual(expect.objectContaining<Partial<CapyError>>({ code: ERROR_CODES.AUTH_FAILED }));
  await expect(requireListIdentity({ authenticate: async () => authenticated('other_user') }, 'user_fixture'))
    .rejects.toEqual(expect.objectContaining<Partial<CapyError>>({ code: ERROR_CODES.AUTH_FAILED }));
});
