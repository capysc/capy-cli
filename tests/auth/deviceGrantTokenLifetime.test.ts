import { expect, test } from 'bun:test';
import { deviceGrantTokenAfterConfirmation } from '../../src/auth/deviceGrantTokenLifetime';

const jwt = (exp: unknown): string => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
const token = (access_token: string | null, expires_in = 300) => ({ access_token, refresh_token: 'synthetic-refresh', expires_in });

test('confirmation time is deducted from the advertised grant lifetime', () => {
  const original = token(null);
  expect(deviceGrantTokenAfterConfirmation(original, 1_000_000, 1_120_000).expires_in).toBe(180);
  expect(original.expires_in).toBe(300);
});

test('the signed token expiry bounds a device grant received after token issuance', () => {
  expect(deviceGrantTokenAfterConfirmation(token(jwt(1300)), 1_030_000, 1_120_000).expires_in).toBe(180);
});

test('a token that expires while the human decides is installed as needing refresh', () => {
  expect(deviceGrantTokenAfterConfirmation(token(jwt(1300)), 1_000_000, 1_400_000).expires_in).toBe(0);
});

test('a later JWT expiry cannot extend the original advertised lifetime', () => {
  expect(deviceGrantTokenAfterConfirmation(token(jwt(2000)), 1_000_000, 1_120_000).expires_in).toBe(180);
});

test('unavailable or malformed expiry claims retain only the remaining advertised lifetime', () => {
  for (const accessToken of [null, 'not-a-jwt', jwt('1300'), jwt(null)]) {
    expect(deviceGrantTokenAfterConfirmation(token(accessToken), 1_000_000, 1_120_000).expires_in).toBe(180);
  }
});

test('fractional remaining seconds round down and invalid lifetimes cannot extend access', () => {
  expect(deviceGrantTokenAfterConfirmation(token(jwt(1300)), 1_000_000, 1_120_100).expires_in).toBe(179);
  expect(deviceGrantTokenAfterConfirmation(token(null, Number.POSITIVE_INFINITY), 1_000_000, 1_120_000).expires_in).toBe(0);
});
