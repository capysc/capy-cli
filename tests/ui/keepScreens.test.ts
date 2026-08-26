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
  isKeepReachable,
  KEEP_SCREENS,
  keepFlowUrl,
  keepLoginBridgeEnabled,
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
      // CAP-540: `capy edit`'s keep-hosted transport.
      { name: 'secret-edit', kind: 'payload-both' },
      // W2-B: the seven no-submit "ending" screens — real CLI->page payload,
      // no answer at all (see `keepPayloadRelay.ts`'s `runKeepInfoScreen`).
      { name: 'command-error', kind: 'payload-in' },
      { name: 'connect-result', kind: 'payload-in' },
      { name: 'deploy-run-result', kind: 'payload-in' },
      { name: 'rotate-progress', kind: 'payload-in' },
      { name: 'session-info', kind: 'payload-in' },
      { name: 'sync-result', kind: 'payload-in' },
      { name: 'sync-status', kind: 'payload-in' },
      { name: 'branch-list', kind: 'payload-both' },
      { name: 'connect-overwrite', kind: 'payload-both' },
      { name: 'connect-provider', kind: 'payload-both' },
      { name: 'connect-setup', kind: 'payload-both' },
      { name: 'deploy-destination', kind: 'payload-both' },
      { name: 'deploy-plan-confirm', kind: 'payload-both' },
      { name: 'deploy-targets', kind: 'payload-both' },
      { name: 'deploy-tokens', kind: 'payload-both' },
    ]);
  });

  test('isKeepScreen / keepScreenKind agree with the registry', () => {
    expect(isKeepScreen('auth-success')).toBe(true);
    expect(isKeepScreen('secret-intake')).toBe(true);
    expect(isKeepScreen('sync-status')).toBe(true);
    expect(isKeepScreen('branch-create')).toBe(false);

    expect(keepScreenKind('auth-error')).toBe('no-submit');
    expect(keepScreenKind('secret-intake')).toBe('payload-both');
    expect(keepScreenKind('sync-status')).toBe('payload-in');
    expect(keepScreenKind('branch-create')).toBeUndefined();
  });
});

describe('keepFlowUrl', () => {
  test('builds the documented route for any registered screen, not just auth-success/auth-error', () => {
    expect(keepFlowUrl('secret-intake', 'conn-1')).toBe(
      'https://keep.capy.sc/flow/secret-intake?c=conn-1',
    );
    expect(keepFlowUrl('sync-status', 'conn-1')).toBe(
      'https://keep.capy.sc/flow/sync-status?c=conn-1',
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

describe('keepLoginBridgeEnabled (CAP-374 step 1)', () => {
  test('is its OWN switch, independent of CAPY_KEEP_SCREENS', () => {
    const savedBridge = process.env.CAPY_KEEP_LOGIN_BRIDGE;
    const savedScreens = process.env.CAPY_KEEP_SCREENS;
    try {
      delete process.env.CAPY_KEEP_LOGIN_BRIDGE;
      process.env.CAPY_KEEP_SCREENS = '1';
      expect(keepLoginBridgeEnabled()).toBe(false);

      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      delete process.env.CAPY_KEEP_SCREENS;
      expect(keepLoginBridgeEnabled()).toBe(true);

      process.env.CAPY_KEEP_LOGIN_BRIDGE = 'true';
      expect(keepLoginBridgeEnabled()).toBe(false); // exact '1', never a loose truthy check
    } finally {
      if (savedBridge === undefined) delete process.env.CAPY_KEEP_LOGIN_BRIDGE;
      else process.env.CAPY_KEEP_LOGIN_BRIDGE = savedBridge;
      if (savedScreens === undefined) delete process.env.CAPY_KEEP_SCREENS;
      else process.env.CAPY_KEEP_SCREENS = savedScreens;
    }
  });
});

describe('isKeepReachable', () => {
  test('true when the origin answers any HTTP status at all', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok', { status: 200 }) });
    try {
      expect(await isKeepReachable(`http://127.0.0.1:${server.port}`)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test('true even for a redirect or error status — reachability, not success', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 503 }) });
    try {
      expect(await isKeepReachable(`http://127.0.0.1:${server.port}`)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test('false on connection refused (nothing listening)', async () => {
    // Port 9 (discard) refuses connections on every platform this runs on.
    expect(await isKeepReachable('http://127.0.0.1:9')).toBe(false);
  });

  test('false on timeout — a hung origin must not block sign-in for long', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 5_000));
        return new Response('too slow');
      },
    });
    try {
      const start = Date.now();
      const reachable = await isKeepReachable(`http://127.0.0.1:${server.port}`, { timeoutMs: 100 });
      expect(reachable).toBe(false);
      expect(Date.now() - start).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test('injectable fetch implementation is honored', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    expect(await isKeepReachable('http://example.invalid', { fetchImpl: fakeFetch })).toBe(true);
    expect(called).toBe(true);
  });
});
