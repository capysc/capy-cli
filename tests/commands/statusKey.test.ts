import { expect, test, mock } from 'bun:test';
import { randomBytes } from 'crypto';
import { resolveExistingStatusKey } from '../../src/commands/statusKey';
import { encryptMasterKey, deriveProjectKey, deriveWrappingKey, masterKeyAAD } from '../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../src/crypto/localKeyRoot';

const orgId = 'org_fixture';
const projectId = 'project_fixture';
const userId = 'user_fixture';

test('status unwraps an existing modern key without a migration capability', async () => {
  const root = randomBytes(32);
  const master = randomBytes(32);
  const inner = encryptMasterKey(master, deriveLocalInnerKey(root), masterKeyAAD(userId, orgId));
  const coDecrypt = mock(async () => inner);
  expect(await resolveExistingStatusKey({ orgId, projectId, userId, root, keyBlob: 'outer', coDecrypt }))
    .toBe(deriveProjectKey(master, projectId, orgId));
  expect(coDecrypt).toHaveBeenCalledWith(orgId, 'outer');
});

test('status refuses missing key custody before calling the service', async () => {
  const coDecrypt = mock(async () => 'unused');
  for (const custody of [{ root: null, keyBlob: 'outer' }, { root: randomBytes(32), keyBlob: null }]) {
    await expect(resolveExistingStatusKey({ orgId, projectId, userId, ...custody, coDecrypt }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  }
  expect(coDecrypt).not.toHaveBeenCalled();
});

test('status refuses legacy wrapped material rather than migrating or minting', async () => {
  const inner = encryptMasterKey(randomBytes(32), deriveWrappingKey(userId, orgId), masterKeyAAD(userId, orgId));
  await expect(resolveExistingStatusKey({ orgId, projectId, userId, root: randomBytes(32), keyBlob: 'outer', coDecrypt: async () => inner }))
    .rejects.toMatchObject({ code: 'DEVICE_KEY_UNWRAP_FAILED' });
});
