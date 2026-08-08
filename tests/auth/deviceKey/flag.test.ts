import { afterEach, describe, expect, test } from 'bun:test';
import { deviceKeysEnabled } from '../../../src/auth/deviceKey/flag';

const ORIGINAL = process.env.CAPY_DEVICE_KEYS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL;
});

describe('deviceKeysEnabled', () => {
  test('is OFF by default (unset)', () => {
    delete process.env.CAPY_DEVICE_KEYS;
    expect(deviceKeysEnabled()).toBe(false);
  });

  test('is OFF for any value other than the literal "1"', () => {
    for (const v of ['true', 'yes', 'on', '0', '']) {
      process.env.CAPY_DEVICE_KEYS = v;
      expect(deviceKeysEnabled()).toBe(false);
    }
  });

  test('is ON only for "1"', () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    expect(deviceKeysEnabled()).toBe(true);
  });
});
