import { expect, mock, test } from 'bun:test';
const authenticate = mock(async () => ({ success: true, user_id: 'fixture-owner', organization_id: 'other-org' }));
const readRoot = mock(() => { throw new Error('must refuse before reading custody'); });
const custody = mock(async () => { throw new Error('must refuse before cryptographic operations'); });
const token = mock(async () => { throw new Error('must refuse before obtaining a transport token'); });
mock.module('../../src/core/projectManager', () => ({ ProjectManager: class { detectProjectState = async () => ({ initialized: true, userId: 'fixture-owner' }); } }));
mock.module('../../src/auth/authService', () => ({ AuthService: class { authenticateSilent = authenticate; getValidToken = token; }, silentAuthFailureMessage: () => 'fixture' }));
mock.module('../../src/config/globalConfig', () => ({ readLocalRoot: readRoot }));
mock.module('../../src/auth/pairing/existingFilesystemCustody', () => ({ inspectExistingFilesystemCustody: custody }));
import { runWithFlowInteraction } from '../../src/ui/flowInteraction';
const operation = mock(async () => undefined);
const descriptor = {command:'rotate',continuationTool:'capy_rotate_continue',expectedUserId:'fixture-owner',organizationId:'fixture-org'} as const;

test('an unexpected organization is refused before touching custody, token or command', async () => {
  await expect(runWithFlowInteraction(operation,true,descriptor)).rejects.toMatchObject({code:'AUTH_ORGANIZATION_MISMATCH'});
  expect(authenticate).toHaveBeenCalledWith('fixture-org');
  expect(readRoot).not.toHaveBeenCalled();
  expect(custody).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});

test('a changed user is refused before touching custody, token or command', async () => {
  authenticate.mockResolvedValueOnce({success:true,user_id:'other-owner',organization_id:'fixture-org'});
  await expect(runWithFlowInteraction(operation,true,descriptor)).rejects.toMatchObject({code:'AUTH_ACCOUNT_MISMATCH'});
  expect(readRoot).not.toHaveBeenCalled();
  expect(custody).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});
