import { expect, test } from 'bun:test';
import { authResponseErrorMessage } from '../../src/auth/session/http';
test('preserves returned error and diagnostic code', () => {
  expect(authResponseErrorMessage({ error: 'Access was denied.', code: 'DENIED' }, 403)).toBe('Access was denied. (DENIED)');
  expect(authResponseErrorMessage({ message: 'Provider unavailable', code: 'UPSTREAM' }, 503)).toBe('Provider unavailable (UPSTREAM)');
});
test('code-only refresh failures explain the problem without claiming missing membership', () => {
  const message = authResponseErrorMessage({ code: 'AUTH_REFRESH_RETRY' }, 503);
  expect(message).toContain('could not confirm your session refresh');
  expect(message).toContain('AUTH_REFRESH_RETRY');
  expect(message).not.toContain('administrator');
});
test('missing membership uses the requested access guidance', () => {
  expect(authResponseErrorMessage({ code: 'AUTH_ORGANIZATION_ACCESS_DENIED' }, 403)).toContain('Please ask the organization administrator for access');
});
test('empty response retains HTTP status with an actionable fallback', () => {
  expect(authResponseErrorMessage({}, 503)).toBe('The authentication service could not complete this request. Please retry shortly. (HTTP 503)');
});
