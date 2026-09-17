import { beforeEach, describe, expect, mock, test } from 'bun:test';

const auth = {
  authenticateSilent: mock(async () => ({ success: true, user_id: 'user_free', organization_id: 'org_free' })),
  getValidToken: mock(async () => null),
};
const service = {
  setTokenProvider: mock(() => undefined),
  getBillingStatus: mock(async () => ({ tier: 'free', grandfathered: false })),
};
const resolved = mock(async () => ({ remoteKeepExists: true, userId: 'user_free', orgId: 'org_free', projectId: 'project_default', branch: 'development',
  keep: { org_id: 'org_free', project_id: 'project_default' } }));

mock.module('../../src/auth/authService', () => ({ AuthService: mock(() => auth) }));
mock.module('../../src/service/serviceClient', () => ({ ServiceClient: mock(() => service) }));
mock.module('../../src/commands/connectors/shared', () => ({ resolveContext: resolved }));

import { resolveFixedRotationContext } from '../../src/commands/rotateContext';
import { ERROR_CODES } from '../../src/types';

const target = { orgId: 'org_free', projectId: 'project_default', userId: 'user_free', branch: 'development' as const };

beforeEach(() => {
  auth.authenticateSilent.mockImplementation(async () => ({ success: true, user_id: 'user_free', organization_id: 'org_free' }));
  service.getBillingStatus.mockImplementation(async () => ({ tier: 'free', grandfathered: false }));
  resolved.mockImplementation(async () => ({ remoteKeepExists: true, userId: 'user_free', orgId: 'org_free', projectId: 'project_default', branch: 'development',
    keep: { org_id: 'org_free', project_id: 'project_default' } }));
  resolved.mockClear();
});

describe('resolveFixedRotationContext', () => {
  test('refuses an authenticated user or organization mismatch before resolving lockless context', async () => {
    auth.authenticateSilent.mockImplementation(async () => ({ success: true, user_id: 'user_other', organization_id: 'org_free' }));
    await expect(resolveFixedRotationContext(target, true)).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(resolved).not.toHaveBeenCalled();
  });

  test('refuses when free billing changed before resolving context', async () => {
    service.getBillingStatus.mockImplementation(async () => ({ tier: 'business', grandfathered: false }));
    await expect(resolveFixedRotationContext(target, true)).rejects.toMatchObject({ code: ERROR_CODES.PLAN_CHANGED });
    expect(resolved).not.toHaveBeenCalled();
  });

  test('refuses absent remote state and a mismatched resolved target', async () => {
    resolved.mockImplementation(async () => ({ remoteKeepExists: false, userId: 'user_free', orgId: 'org_free', projectId: 'project_default', branch: 'development', keep: { org_id: 'org_free', project_id: 'project_default' } }));
    await expect(resolveFixedRotationContext(target, true)).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    resolved.mockImplementation(async () => ({ remoteKeepExists: true, userId: 'user_free', orgId: 'org_free', projectId: 'other', branch: 'development', keep: { org_id: 'org_free', project_id: 'other' } }));
    await expect(resolveFixedRotationContext(target, true)).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('uses the noninteractive existing-key-only lockless resolver for the fixed target', async () => {
    await expect(resolveFixedRotationContext(target, true)).resolves.toMatchObject({ projectId: 'project_default' });
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ forceLockless: true, existingKeyOnly: true, nonInteractive: true, devMode: true }));
  });
});
