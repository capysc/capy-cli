import { CapyError, ERROR_CODES, type SyncState } from '../types/index';

/**
 * `sync_mode: free` is persisted evidence of the retired lockless storage
 * product. Billing is deliberately not an input: a grandfathered Keep
 * organization may still report a free tier and remains supported.
 */
export function assertSupportedKeepMode(syncState: SyncState | null): void {
  if (syncState?.sync_mode === 'free') {
    throw new CapyError(
      'This repository uses the retired lockless Keep mode. Reconnect it to an explicit Keep project before continuing.',
      ERROR_CODES.LEGACY_KEEP_MODE_UNSUPPORTED,
    );
  }
}
