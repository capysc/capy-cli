/**
 * The per-screen keep-migration registry (W2-A, generalizing CAP-376).
 *
 * Pins: the registry's current membership and kinds (a change here is a
 * deliberate migration, not an accident), `isKeepScreen`/`keepScreenKind`
 * lookups, and that `keepFlowUrl` builds the documented route for any
 * registered screen name — not just the original two auth flows.
 */
import { describe, expect, test } from 'bun:test';

import {
  isKeepScreen,
  KEEP_SCREENS,
  keepFlowUrl,
  keepScreenKind,
  keepScreensEnabled,
} from '../../src/ui/screens/keepScreens';

describe('KEEP_SCREENS registry', () => {
  test('lists every screen migrated onto the broker so far, with its kind', () => {
    expect(KEEP_SCREENS).toEqual([
      { name: 'auth-success', kind: 'no-submit' },
      { name: 'auth-error', kind: 'no-submit' },
      { name: 'secret-intake', kind: 'payload-both' },
      { name: 'connect-live-gate', kind: 'payload-both' },
      { name: 'org-members', kind: 'payload-both' },
    ]);
  });

  test('isKeepScreen / keepScreenKind agree with the registry', () => {
    expect(isKeepScreen('auth-success')).toBe(true);
    expect(isKeepScreen('secret-intake')).toBe(true);
    expect(isKeepScreen('branch-create')).toBe(false);

    expect(keepScreenKind('auth-error')).toBe('no-submit');
    expect(keepScreenKind('secret-intake')).toBe('payload-both');
    expect(keepScreenKind('branch-create')).toBeUndefined();
  });
});

describe('keepFlowUrl', () => {
  test('builds the documented route for any registered screen, not just auth-success/auth-error', () => {
    expect(keepFlowUrl('secret-intake', 'conn-1')).toBe(
      'https://keep.capy.sc/flow/secret-intake?c=conn-1',
    );
  });

  test('still carries the error code only for auth-error, unchanged from CAP-376', () => {
    expect(keepFlowUrl('auth-error', 'conn-1', 'AUTH_FAILED')).toBe(
      'https://keep.capy.sc/flow/auth-error?c=conn-1&code=AUTH_FAILED',
    );
    // A non-auth-error flow never gets a stray ?code=, even if a caller
    // passed one by mistake — the param is auth-error's own convention.
    expect(keepFlowUrl('secret-intake', 'conn-1', 'SOME_CODE')).toBe(
      'https://keep.capy.sc/flow/secret-intake?c=conn-1',
    );
  });
});

describe('keepScreensEnabled', () => {
  test('is the single global switch — CAPY_KEEP_SCREENS=1 only', () => {
    const saved = process.env.CAPY_KEEP_SCREENS;
    try {
      delete process.env.CAPY_KEEP_SCREENS;
      expect(keepScreensEnabled()).toBe(false);
      process.env.CAPY_KEEP_SCREENS = '1';
      expect(keepScreensEnabled()).toBe(true);
      process.env.CAPY_KEEP_SCREENS = 'true';
      expect(keepScreensEnabled()).toBe(false); // exact '1', never a loose truthy check
    } finally {
      if (saved === undefined) delete process.env.CAPY_KEEP_SCREENS;
      else process.env.CAPY_KEEP_SCREENS = saved;
    }
  });
});
