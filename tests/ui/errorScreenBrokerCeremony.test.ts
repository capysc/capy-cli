/**
 * CAP-451 item 2: under `--broker-ceremony` a failure must never open or
 * print a loopback error page — there is no local browser to send it to,
 * `--web` notwithstanding (broker-ceremony wins over `--web`, same posture
 * as `capyCommand.ts`'s `noWizardStops`). The failure's own coded
 * `blocked`/`failed` step in the flow's JSON envelope (or, for an escaped
 * exception, `onboardCommand.ts`'s own JSON error object — see that file's
 * catch block) is the only surface it gets.
 */
import { mock, describe, test, expect, spyOn, afterEach } from 'bun:test';

const serveEndingPage = mock(async () => undefined);
mock.module('../../src/ui/endingPage', () => ({ serveEndingPage }));
mock.module('../../src/ui/commandErrorScreen', () => ({ buildCommandErrorData: mock(() => ({})) }));

import { displayErrorAndExit } from '../../src/ui/errorScreen';
import { setWebMode, setBrokerCeremonyMode } from '../../src/ui/webMode';
import { CapyError, ERROR_CODES } from '../../src/types/index';

afterEach(() => {
  setWebMode(false);
  setBrokerCeremonyMode(false);
  serveEndingPage.mockClear();
});

describe('displayErrorAndExit — broker-ceremony wins over --web', () => {
  test('never serves a loopback error page when broker-ceremony mode is on, even under --web', async () => {
    setWebMode(true);
    setBrokerCeremonyMode(true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await displayErrorAndExit(new CapyError('denied', ERROR_CODES.PERMISSION_DENIED));
    } finally {
      exitSpy.mockRestore();
    }
    expect(serveEndingPage).not.toHaveBeenCalled();
  });

  test('still serves the loopback page under plain --web with broker-ceremony off (unchanged)', async () => {
    setWebMode(true);
    setBrokerCeremonyMode(false);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await displayErrorAndExit(new CapyError('denied', ERROR_CODES.PERMISSION_DENIED));
    } finally {
      exitSpy.mockRestore();
    }
    expect(serveEndingPage).toHaveBeenCalledTimes(1);
  });

  test('never serves a page when --web is off, regardless of broker-ceremony (unchanged)', async () => {
    setWebMode(false);
    setBrokerCeremonyMode(true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await displayErrorAndExit(new CapyError('denied', ERROR_CODES.PERMISSION_DENIED));
    } finally {
      exitSpy.mockRestore();
    }
    expect(serveEndingPage).not.toHaveBeenCalled();
  });
});
