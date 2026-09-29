/**
 * CAP-657 "no trap" follow-up: `keypressPreflightMenu` (`ui/keypressConfirm.ts`).
 *
 * The raw-keypress-reading behavior itself (TTY present, a real key pressed)
 * has no test seam — `setRawMode` throws on a stream that isn't actually
 * TTY-backed even with `isTTY` faked true, the same limitation
 * `deployDokploySystemStoreToken.test.ts` documents for `keypressConfirm`
 * and `deployPreflightNoTrap.test.ts` works around by injecting the MENU's
 * decision directly into `resolvePreflightWithRecovery`. What IS directly
 * testable, with no faking at all, is the non-TTY fallback: `bun test`'s
 * own stdin is never a TTY, so calling the real function here proves it
 * resolves immediately to `'cancel'` and never hangs waiting for input that
 * can't arrive — the exact property `deployCommand.ts` relies on to gate
 * the whole recovery menu on `process.stdin.isTTY === true` in the first
 * place: if the menu ever hung on a non-TTY, that gate would be pointless.
 */
import { describe, test, expect } from 'bun:test';
import { keypressPreflightMenu, keypressConfirm } from '../../src/ui/keypressConfirm';

describe('keypressPreflightMenu — non-TTY fallback (CAP-657)', () => {
  test('resolves to "cancel" immediately when stdin is not a TTY', async () => {
    expect(process.stdin.isTTY).not.toBe(true);
    const action = await keypressPreflightMenu({ message: 'Preflight failed. What now?' });
    expect(action).toBe('cancel');
  });

  test('never attaches a stdin listener on a non-TTY (nothing left to clean up)', async () => {
    const before = process.stdin.listenerCount('data');
    await keypressPreflightMenu({ message: 'x' });
    expect(process.stdin.listenerCount('data')).toBe(before);
  });
});

describe('keypressConfirm — non-TTY fallback (unchanged by CAP-657, shares the same reader)', () => {
  test('still defaults to "cancel" on a non-TTY with no explicit default', async () => {
    const action = await keypressConfirm({ message: 'Deploy now?' });
    expect(action).toBe('cancel');
  });

  test('honors an explicit nonInteractiveDefault', async () => {
    const action = await keypressConfirm({ message: 'Deploy now?', nonInteractiveDefault: 'confirm' });
    expect(action).toBe('confirm');
  });
});
