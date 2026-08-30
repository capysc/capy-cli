import { afterEach, describe, expect, test } from 'bun:test';
import { deviceKeysEnabled } from '../../../src/auth/deviceKey/flag';

const ORIGINAL = process.env.CAPY_DEVICE_KEYS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL;
});

// Permanently ON as of onboarding v2 (2026-08-30): the device-key rail IS
// the product — `capy pair` is the only pairing path — so the env var is no
// longer consulted. See src/auth/deviceKey/flag.ts.
describe('deviceKeysEnabled', () => {
  test('is ON with the env var unset', () => {
    delete process.env.CAPY_DEVICE_KEYS;
    expect(deviceKeysEnabled()).toBe(true);
  });

  test('is ON regardless of any env value, including attempts to turn it off', () => {
    for (const v of ['true', 'yes', 'on', '0', '', '1']) {
      process.env.CAPY_DEVICE_KEYS = v;
      expect(deviceKeysEnabled()).toBe(true);
    }
  });
});
