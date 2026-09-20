import { expect, test } from 'bun:test';
import { ERROR_CODES, type SyncState } from '../../src/types';
import { assertSupportedKeepMode } from '../../src/sync/legacyKeepMode';

const syncState = (syncMode?: 'free' | 'paid'): SyncState => ({
  last_sync: '2026-09-17T00:00:00.000Z',
  synced_variables: [],
  ...(syncMode ? { sync_mode: syncMode } : {}),
});

test('only persisted retired free storage is rejected', () => {
  expect(() => assertSupportedKeepMode(syncState('free'))).toThrow(
    expect.objectContaining({ code: ERROR_CODES.LEGACY_KEEP_MODE_UNSUPPORTED }),
  );
  expect(() => assertSupportedKeepMode(syncState('paid'))).not.toThrow();
  expect(() => assertSupportedKeepMode(syncState())).not.toThrow();
});
