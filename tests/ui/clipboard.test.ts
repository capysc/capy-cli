import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { promptCopyToClipboard } from '../../src/ui/clipboard';

describe('promptCopyToClipboard', () => {
  const originalCi = process.env.CI;
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    process.env.CI = originalCi;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    mock.restore();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    process.env.CI = originalCi;
  });

  test('returns immediately in CI without prompting for keyboard input', async () => {
    process.env.CI = 'true';

    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const setRawModeSpy = stdin.setRawMode
      ? spyOn(stdin, 'setRawMode').mockImplementation(() => undefined)
      : null;

    await promptCopyToClipboard('secret');

    expect(writeSpy).not.toHaveBeenCalled();
    if (setRawModeSpy) {
      expect(setRawModeSpy).not.toHaveBeenCalled();
    }
  });
});
