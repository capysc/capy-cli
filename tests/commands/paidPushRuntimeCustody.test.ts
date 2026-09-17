/** Isolated wiring regression; no real keys, files, auth, or remote writes. */
import { afterEach, expect, mock, test } from 'bun:test';
import type { ProjectManager } from '../../src/core/projectManager';
import type { FileManager } from '../../src/files/fileManager';
import type { AuthService } from '../../src/auth/authService';
import type { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const legacyKey = mock(async () => { throw new Error('LEGACY_KEY_ENC_ABSENT'); });
const runtimeKey = mock(async () => 'runtime-project-key');
const localKey = mock(async () => 'local-project-key');
const grantOps = { fetchKeyEnc: async () => '', coDecrypt: async () => '' } as const;
const makeGrantOps = mock(() => grantOps);
mock.module('../../src/crypto/keyResolver', () => ({ resolveProjectKey: legacyKey }));
mock.module('../../src/sync/projectKeyResolver', () => ({ resolveConfiguredProjectKey: runtimeKey }));
mock.module('../../src/auth/deviceKey/grantResolver', () => ({ createGrantResolutionOps: makeGrantOps }));
mock.module('../../src/core/localUnlock', () => ({ resolveLocalProjectKey: localKey }));
mock.module('../../src/ui/debug', () => ({ debugLine: () => undefined }));
mock.module('../../src/ui/spinner', () => ({ default: () => ({ start: () => ({ stop: () => undefined, fail: () => undefined }) }) }));

import { PushCommand } from '../../src/commands/pushCommand';

const fixture = () => {
  const auth = { setSessionUserId: mock(() => undefined) } as unknown as AuthService;
  const service = { setTokenProvider: mock(() => undefined) } as unknown as ServiceClient;
  const command = new PushCommand(true, {} as ProjectManager, {} as FileManager, auth, service);
  return { command, auth, service } as const;
};
const input = { localMode: false, organizationId: 'org', projectId: 'project', projectUserId: 'user_fixture',
  authResult: { success: true, user_id: 'user_fixture' } } as const;

afterEach(() => {
  for (const fn of [legacyKey, runtimeKey, localKey, makeGrantOps]) fn.mockClear();
  runtimeKey.mockImplementation(async () => 'runtime-project-key');
});

test('paid push identity uses the existing runtime resolver instead of legacy key.enc', async () => {
  const { command, auth, service } = fixture();
  expect(await command['resolvePushIdentity'](input)).toEqual({ userId: 'user_fixture', encryptionKey: 'runtime-project-key' });
  expect(runtimeKey).toHaveBeenCalledWith('org', 'project', 'user_fixture', expect.any(Object), grantOps);
  expect(makeGrantOps).toHaveBeenCalledWith(service, auth);
  expect(legacyKey).not.toHaveBeenCalled();
  expect(localKey).not.toHaveBeenCalled();
});

test('unavailable paired custody refuses without legacy or local-only fallback', async () => {
  const failure = new CapyError('Synthetic unavailable grant', ERROR_CODES.PERMISSION_DENIED);
  runtimeKey.mockImplementation(async () => { throw failure; });
  await expect(fixture().command['resolvePushIdentity'](input)).rejects.toBe(failure);
  expect(runtimeKey).toHaveBeenCalledTimes(1);
  expect(legacyKey).not.toHaveBeenCalled();
  expect(localKey).not.toHaveBeenCalled();
});

test('local-only push remains independent of account runtime custody', async () => {
  const { command, auth } = fixture();
  expect((await command['resolvePushIdentity']({ ...input, localMode: true })).encryptionKey).toBe('local-project-key');
  expect(localKey).toHaveBeenCalledWith('project');
  expect(auth.setSessionUserId).not.toHaveBeenCalled();
  expect(runtimeKey).not.toHaveBeenCalled();
  expect(makeGrantOps).not.toHaveBeenCalled();
});

test('failed authentication refuses before resolving any project key', async () => {
  await expect(fixture().command['resolvePushIdentity']({ ...input, authResult: { success: false } })).rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
  expect(runtimeKey).not.toHaveBeenCalled();
  expect(legacyKey).not.toHaveBeenCalled();
  expect(localKey).not.toHaveBeenCalled();
});

test('paid preauthentication cannot bypass the hosted caller identity pin', async () => {
  const { command, auth } = fixture();
  await expect(command['resolvePushIdentity']({ ...input, authPolicy: { nonInteractive: true, expectedUserId: 'different-user' } }))
    .rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
  expect(auth.setSessionUserId).toHaveBeenCalledWith('different-user');
  expect(runtimeKey).not.toHaveBeenCalled();
});
