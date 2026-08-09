/**
 * Final-gate MAJOR-2 — the device-key ceremony URL is printed AND opened,
 * matching every other browser-opening flow in the CLI
 * (`browserWizard.ts` / `oauthServer.ts`), suppressed for non-interactive
 * callers (the MCP's `capy_sync` spawns this path with piped stdin) so the
 * relay convention still works.
 *
 * `openScreen` and `isInteractive` are mocked so this file tests
 * `relayUrl`'s OWN decision — not `openScreen`'s window-choice logic
 * (covered by `tests/ui/openScreen.test.ts`) and not the full ceremony
 * round-trip (covered by `tests/auth/deviceKey/brokerCeremonyTransport.test.ts`,
 * which never mocks these two modules and therefore never opens anything —
 * `isInteractive()` is false under `bun test`'s piped stdin regardless).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const openScreenCalls: Array<{ url: string; opts: unknown }> = [];
mock.module('../../../src/ui/openScreen', () => ({
  openScreen: mock(async (url: string, opts: unknown) => {
    openScreenCalls.push({ url, opts });
    return { via: 'suppressed' };
  }),
}));

let interactive = false;
mock.module('../../../src/ui/interactive', () => ({
  isInteractive: mock(() => interactive),
}));

afterAll(() => {
  mock.restore();
});

let relayUrl: (label: string, url: string) => void;

beforeEach(async () => {
  ({ relayUrl } = await import('../../../src/auth/deviceKey/brokerCeremonyTransport'));
  openScreenCalls.length = 0;
  interactive = false;
});

function captureLogs(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

describe('relayUrl (device-key ceremony URL): print + conditional open', () => {
  test('always prints the URL, interactive or not', () => {
    interactive = false;
    const logs = captureLogs(() => relayUrl('Unlock with your device key:', 'https://keep.capy.sc/flow/device-key?c=1'));
    expect(logs.join('\n')).toContain('https://keep.capy.sc/flow/device-key?c=1');
  });

  test('a real TTY (isInteractive() true) also opens the URL as a handoff', () => {
    interactive = true;
    captureLogs(() => relayUrl('Set up your device key:', 'https://keep.capy.sc/flow/device-key?c=2'));
    expect(openScreenCalls).toHaveLength(1);
    expect(openScreenCalls[0].url).toBe('https://keep.capy.sc/flow/device-key?c=2');
    expect(openScreenCalls[0].opts).toEqual({ kind: 'handoff' });
  });

  test('non-interactive (piped stdin — the MCP relay path) never opens a browser', () => {
    interactive = false;
    captureLogs(() => relayUrl('Unlock with your device key:', 'https://keep.capy.sc/flow/device-key?c=3'));
    expect(openScreenCalls).toHaveLength(0);
  });
});
