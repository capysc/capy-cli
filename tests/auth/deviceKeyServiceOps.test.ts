import { describe, it, expect } from 'bun:test';
import { isFreshAuthRequired, withFreshAuthRetry } from '../../src/auth/deviceKey/serviceOps';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/** The exact error shape serviceClient mints from a 403 FreshAuthRequiredError body. */
const freshAuth403 = () =>
  new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
    status: 403,
    detail: 'token too old',
    code: ERROR_CODES.FRESH_AUTH_REQUIRED,
    data: {
      error: 'token too old',
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      remediation: 'refresh_and_retry',
      max_token_age_seconds: 300,
    },
  });

describe('FRESH_AUTH_REQUIRED retry dance (CAP-379 contract)', () => {
  it('recognises the coded 403 by structured fields only', () => {
    expect(isFreshAuthRequired(freshAuth403())).toBe(true);
  });

  it('does NOT match on the code alone when the remediation enum is absent', () => {
    const noRemediation = new CapyError('x', ERROR_CODES.PERMISSION_DENIED, {
      status: 403,
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED },
    });
    expect(isFreshAuthRequired(noRemediation)).toBe(false);
  });

  it('does not match other 403s, other codes, or non-CapyErrors', () => {
    expect(
      isFreshAuthRequired(
        new CapyError('x', ERROR_CODES.PERMISSION_DENIED, {
          status: 403,
          code: ERROR_CODES.MEMBERSHIP_REVOKED,
        }),
      ),
    ).toBe(false);
    expect(isFreshAuthRequired(new CapyError('x', ERROR_CODES.NETWORK_ERROR))).toBe(false);
    expect(isFreshAuthRequired(new Error('token too old'))).toBe(false);
  });

  it('forces one refresh and retries exactly once on the coded refusal', async () => {
    let refreshes = 0;
    let attempts = 0;
    const result = await withFreshAuthRetry(
      async () => {
        refreshes++;
        return true;
      },
      async () => {
        attempts++;
        if (attempts === 1) throw freshAuth403();
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
  });

  it('a second coded refusal propagates — the dance is one round, never a loop', async () => {
    let refreshes = 0;
    let attempts = 0;
    try {
      await withFreshAuthRetry(
        async () => {
          refreshes++;
          return true;
        },
        async () => {
          attempts++;
          throw freshAuth403();
        },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(isFreshAuthRequired(err)).toBe(true);
    }
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
  });

  it('unrelated failures pass through with no refresh', async () => {
    let refreshes = 0;
    try {
      await withFreshAuthRetry(
        async () => {
          refreshes++;
          return true;
        },
        async () => {
          throw new CapyError('down', ERROR_CODES.NETWORK_ERROR);
        },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.NETWORK_ERROR);
    }
    expect(refreshes).toBe(0);
  });
});
