import { expect, mock, test } from 'bun:test';
import { authenticatePush, verifyPushIdentity } from '../../src/auth/pushAuthentication';
import { ERROR_CODES, type AuthResult } from '../../src/types/index';

function fixture(results: readonly AuthResult[] = [{ success: false }], interactive: AuthResult = { success: true, user_id: 'expected' }) {
  const silent = mock(async (): Promise<AuthResult> => results.at(-1)!);
  for (const result of results.slice(0, -1)) silent.mockImplementationOnce(async () => result);
  return { setSessionUserId: mock((_id: string) => undefined), authenticateSilent: silent,
    authenticate: mock(async () => interactive) };
}

test('noninteractive failure never enters interactive authentication', async () => {
  const auth = fixture();
  await expect(authenticatePush(auth, 'org', { nonInteractive: true, expectedUserId: 'expected' }))
    .rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
  expect(auth.authenticateSilent).toHaveBeenCalledTimes(2);
  expect(auth.authenticate).not.toHaveBeenCalled();
  expect(auth.setSessionUserId).toHaveBeenCalledWith('expected');
});

test('a successful wrong-account result fails without trying another account', async () => {
  const auth = fixture([{ success: true, user_id: 'other' }]);
  await expect(authenticatePush(auth, 'org', { nonInteractive: true, expectedUserId: 'expected' }))
    .rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
  expect(auth.authenticateSilent).toHaveBeenCalledTimes(1);
  expect(auth.authenticate).not.toHaveBeenCalled();
});

test('same pinned account can use the existing unscoped silent session', async () => {
  const auth = fixture([{ success: false }, { success: true, user_id: 'expected' }]);
  expect(await authenticatePush(auth, 'org', { nonInteractive: true, expectedUserId: 'expected' }))
    .toMatchObject({ success: true, user_id: 'expected' });
  expect(auth.authenticate).not.toHaveBeenCalled();
});

test('interactive fallback remains available to interactive callers', async () => {
  const auth = fixture();
  expect(await authenticatePush(auth, 'org')).toMatchObject({ success: true, user_id: 'expected' });
  expect(auth.authenticate).toHaveBeenCalledWith('org');
});

test('preauthenticated results still enforce the expected user', () => {
  expect(() => verifyPushIdentity({ success: true, user_id: 'other' }, { expectedUserId: 'expected' }))
    .toThrow(expect.objectContaining({ code: ERROR_CODES.AUTH_FAILED }));
});
