import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { nonceEqual, isLoopbackHost, isAllowedOrigin } from '../../src/commands/intakeSecurity';

describe('nonceEqual', () => {
  test('true for identical nonces', () => {
    const n = randomBytes(32).toString('hex');
    expect(nonceEqual(n, n)).toBe(true);
  });
  test('false for different nonces', () => {
    expect(nonceEqual(randomBytes(32).toString('hex'), randomBytes(32).toString('hex'))).toBe(false);
  });
  test('false for length mismatch or non-string', () => {
    expect(nonceEqual('abc', 'abcd')).toBe(false);
    expect(nonceEqual(undefined, 'abcd')).toBe(false);
    expect(nonceEqual(123, 'abcd')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  test('only the exact bound loopback host passes', () => {
    expect(isLoopbackHost('127.0.0.1:5000', 5000)).toBe(true);
    expect(isLoopbackHost('127.0.0.1:5001', 5000)).toBe(false);
    expect(isLoopbackHost('evil.com', 5000)).toBe(false);
    expect(isLoopbackHost('localhost:5000', 5000)).toBe(false);
    expect(isLoopbackHost(undefined, 5000)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  test('absent origin allowed; present must match exactly', () => {
    expect(isAllowedOrigin(undefined, 5000)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5000', 5000)).toBe(true);
    expect(isAllowedOrigin('http://evil.com', 5000)).toBe(false);
    expect(isAllowedOrigin('https://127.0.0.1:5000', 5000)).toBe(false);
  });
});
