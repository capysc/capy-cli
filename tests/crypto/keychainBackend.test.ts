import { describe, it, expect, afterEach } from 'bun:test';
import {
  isKeychainAvailable,
  readKeychainRoot,
  saveKeychainRootExclusive,
  saveKeychainRoot,
  wantsKeychainBackend,
} from '../../src/crypto/keychainBackend';
import { Entry } from '@napi-rs/keyring';

// Real OS keychain round-trip. This module has no dependency on
// os.homedir(), so unlike most crypto tests it isn't isolated via a temp
// HOME — it talks to the actual OS credential store. Every test below uses
// a clearly test-scoped org/user pair and cleans up after itself.
//
// Environments without a usable keychain backend (headless Linux CI
// runners without a Secret Service session are the common case) must still
// pass the suite — every real-backend test is skipped, not failed, when
// isKeychainAvailable() is false.
const TEST_ORG = '__capy_test_org__';
const TEST_USER = '__capy_test_user__';
const available = isKeychainAvailable();

function cleanupTestEntry(): void {
  try {
    new Entry('capy', `${TEST_ORG}:${TEST_USER}`).deletePassword();
  } catch {
    // already absent — fine
  }
}

describe('keychainBackend', () => {
  afterEach(cleanupTestEntry);

  it('wantsKeychainBackend defaults to false without the env var', () => {
    const prev = process.env.CAPY_LOCAL_KEY_BACKEND;
    delete process.env.CAPY_LOCAL_KEY_BACKEND;
    expect(wantsKeychainBackend()).toBe(false);
    if (prev !== undefined) process.env.CAPY_LOCAL_KEY_BACKEND = prev;
  });

  it('wantsKeychainBackend is true only when explicitly set to "keychain"', () => {
    const prev = process.env.CAPY_LOCAL_KEY_BACKEND;
    process.env.CAPY_LOCAL_KEY_BACKEND = 'keychain';
    expect(wantsKeychainBackend()).toBe(true);
    process.env.CAPY_LOCAL_KEY_BACKEND = 'something-else';
    expect(wantsKeychainBackend()).toBe(false);
    if (prev === undefined) delete process.env.CAPY_LOCAL_KEY_BACKEND;
    else process.env.CAPY_LOCAL_KEY_BACKEND = prev;
  });

  it('isKeychainAvailable returns a boolean without throwing', () => {
    expect(typeof available).toBe('boolean');
  });

  it.skipIf(!available)('reads back exactly what it wrote (32-byte root)', () => {
    const root = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(readKeychainRoot(TEST_ORG, TEST_USER)).toBeNull();

    const won = saveKeychainRootExclusive(TEST_ORG, root, TEST_USER);
    expect(won).toBe(true);

    const readBack = readKeychainRoot(TEST_ORG, TEST_USER);
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(root)).toBe(true);
  });

  it.skipIf(!available)('saveKeychainRootExclusive returns false once an entry exists', () => {
    const first = Buffer.from(Array.from({ length: 32 }, () => 1));
    const second = Buffer.from(Array.from({ length: 32 }, () => 2));

    expect(saveKeychainRootExclusive(TEST_ORG, first, TEST_USER)).toBe(true);
    expect(saveKeychainRootExclusive(TEST_ORG, second, TEST_USER)).toBe(false);

    // The first write wins — second never took.
    const readBack = readKeychainRoot(TEST_ORG, TEST_USER);
    expect(readBack!.equals(first)).toBe(true);
  });

  it.skipIf(!available)('saveKeychainRoot unconditionally overwrites (corrupt-entry recovery path)', () => {
    const first = Buffer.from(Array.from({ length: 32 }, () => 3));
    const second = Buffer.from(Array.from({ length: 32 }, () => 4));

    saveKeychainRoot(TEST_ORG, first, TEST_USER);
    saveKeychainRoot(TEST_ORG, second, TEST_USER);

    const readBack = readKeychainRoot(TEST_ORG, TEST_USER);
    expect(readBack!.equals(second)).toBe(true);
  });

  it.skipIf(!available)('readKeychainRoot rejects a value that is not a valid 32-byte root', () => {
    const entry = new Entry('capy', `${TEST_ORG}:${TEST_USER}`);
    entry.setPassword('not-a-valid-root');
    expect(readKeychainRoot(TEST_ORG, TEST_USER)).toBeNull();
  });

  it('readKeychainRoot returns null (never throws) for an account that was never created', () => {
    expect(readKeychainRoot('__capy_never_used_org__', '__capy_never_used_user__')).toBeNull();
  });
});
