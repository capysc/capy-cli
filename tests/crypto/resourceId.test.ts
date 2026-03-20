import { deriveResourceId } from '../../src/crypto/resourceId';

const TEST_KEY = 'test-key-for-resource-id-tests';
const OTHER_KEY = 'a-completely-different-key';

describe('deriveResourceId', () => {
  it('returns a 5-character string', () => {
    expect(deriveResourceId(TEST_KEY, 'MY_VAR')).toHaveLength(5);
  });

  it('uses only readable characters (no ambiguous 0/O/1/l/I)', () => {
    const vars = Array.from({ length: 50 }, (_, i) => `VAR_${i}`);
    for (const v of vars) {
      expect(deriveResourceId(TEST_KEY, v)).toMatch(/^[a-hjkmnp-z2-9]{5}$/);
    }
  });

  it('is deterministic — same inputs always produce the same ID', () => {
    const a = deriveResourceId(TEST_KEY, 'DATABASE_URL');
    const b = deriveResourceId(TEST_KEY, 'DATABASE_URL');
    expect(a).toBe(b);
  });

  it('produces different IDs for different variable names with the same key', () => {
    const a = deriveResourceId(TEST_KEY, 'TEST_MODE');
    const b = deriveResourceId(TEST_KEY, 'DISABLE_SENTRY');
    expect(a).not.toBe(b);
  });

  it('produces different IDs for different keys with the same variable name', () => {
    const a = deriveResourceId(TEST_KEY, 'DATABASE_URL');
    const b = deriveResourceId(OTHER_KEY, 'DATABASE_URL');
    expect(a).not.toBe(b);
  });

  it('produces different IDs when the key is rotated', () => {
    const original = deriveResourceId('key-v1', 'SECRET');
    const rotated = deriveResourceId('key-v2', 'SECRET');
    expect(original).not.toBe(rotated);
  });
});
