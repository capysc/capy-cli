/**
 * CAP-402 — `displayAndConfirmRecoveryPhrase` is the ONE place in the CLI
 * that prints a full recovery phrase (a master-key-equivalent secret) to
 * stdout. Every caller (org creation, `capy byoc` local-only setup) shares
 * it, so the safety gate belongs here, once, rather than re-checked (or
 * forgotten) at each call site.
 *
 * The bug this pins: the function used to print unconditionally — no TTY
 * check at all — so an agent shelling `capy` directly (piped/non-TTY stdin,
 * no `--web`) had the phrase land straight in its own transcript. These
 * tests prove the opposite for a non-interactive run (refuses, phrase never
 * hits stdout/stderr) and prove the terminal path is UNCHANGED for a real
 * human at a real TTY (still prints, still confirms, still offers to copy).
 */
import { mock, describe, test, expect, afterEach, spyOn } from 'bun:test';

const promptMock = mock(async (_questions: any) => ({ confirmed: true }));
mock.module('inquirer', () => ({
  default: { prompt: promptMock },
}));

const promptCopyToClipboardMock = mock(async (_text: string, _indent?: string) => {});
mock.module('../../src/ui/clipboard', () => ({
  promptCopyToClipboard: promptCopyToClipboardMock,
}));

import { displayAndConfirmRecoveryPhrase } from '../../src/ui/recoveryPhrase';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const PHRASE = 'zebra whale night lemon tiger cliff ' + Array.from({ length: 18 }, (_, i) => `w${i}`).join(' ');
const BODY_LINES = ['This recovery phrase generates the master key.'];

/** Everything the function wrote, in order — same helper shape as the other command-level tests. */
function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return {
    out: () => buf,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

const savedIsTTY = process.stdin.isTTY;
const withTty = (value: boolean | undefined) => {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
};

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
  promptMock.mockClear();
  promptCopyToClipboardMock.mockClear();
});

describe('displayAndConfirmRecoveryPhrase — no real terminal', () => {
  test('refuses with a coded error instead of printing the phrase', async () => {
    withTty(false);
    const cap = captureOutput();
    let caught: unknown;
    try {
      await displayAndConfirmRecoveryPhrase(PHRASE, BODY_LINES);
    } catch (err) {
      caught = err;
    } finally {
      cap.restore();
    }

    expect(caught).toBeInstanceOf(CapyError);
    expect((caught as CapyError).code).toBe(ERROR_CODES.RECOVERY_PHRASE_UNSAFE_SURFACE);

    // The whole point: the phrase itself never reached stdout or stderr —
    // not even the first word of it, not partially, not inside some other
    // line.
    expect(cap.out()).not.toContain(PHRASE);
    for (const word of PHRASE.split(' ')) {
      expect(cap.out()).not.toContain(word);
    }
    // Nor did it ever ask a question nobody piped in could answer.
    expect(promptMock).not.toHaveBeenCalled();
    expect(promptCopyToClipboardMock).not.toHaveBeenCalled();
  });

  test('also refuses when isTTY is undefined (the common piped/CI/agent shape)', async () => {
    withTty(undefined);
    const cap = captureOutput();
    let caught: unknown;
    try {
      await displayAndConfirmRecoveryPhrase(PHRASE, BODY_LINES);
    } catch (err) {
      caught = err;
    } finally {
      cap.restore();
    }
    expect((caught as CapyError)?.code).toBe(ERROR_CODES.RECOVERY_PHRASE_UNSAFE_SURFACE);
    expect(cap.out()).not.toContain(PHRASE);
  });
});

describe('displayAndConfirmRecoveryPhrase — a real terminal', () => {
  test('a human at a real TTY still gets today\'s display: unchanged behavior', async () => {
    withTty(true);
    const cap = captureOutput();
    try {
      await displayAndConfirmRecoveryPhrase(PHRASE, BODY_LINES);
    } finally {
      cap.restore();
    }

    // The phrase IS on the safest surface available — a real human terminal.
    expect(cap.out()).toContain(PHRASE);
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(promptCopyToClipboardMock).toHaveBeenCalledTimes(1);
  });
});
