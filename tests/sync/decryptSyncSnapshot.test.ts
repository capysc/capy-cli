import { expect, test } from 'bun:test';
import { decryptSyncSnapshot } from '../../src/sync/decryptSyncSnapshot';

test('returns a complete successfully decrypted snapshot', () => {
  expect(decryptSyncSnapshot({ A: 'a', B: 'b' }, (value) => `${value}-opened`)).toEqual({ A: 'a-opened', B: 'b-opened' });
});

test('refuses the whole snapshot if any entry fails without leaking error text', () => {
  try {
    decryptSyncSnapshot({ A: 'readable', B: 'unreadable' }, (value) => {
      if (value === 'unreadable') throw new Error('PRIVATE_SECRET_SENTINEL');
      return 'PRIVATE_PLAINTEXT';
    });
    throw new Error('EXPECTED_DECRYPTION_REFUSAL');
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: 'DECRYPT_KEY_MISMATCH' });
    expect(String(error)).not.toContain('PRIVATE');
  }
});

test('an empty snapshot remains empty', () => {
  expect(decryptSyncSnapshot({}, () => { throw new Error('not called'); })).toEqual({});
});
