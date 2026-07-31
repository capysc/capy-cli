/**
 * The deadline the two non-wizard deploy screens open with.
 *
 * Its own file because it replaces `runBrowserWizard` with a probe, and
 * `mock.module` is process-wide in bun — `tests/run-tests.sh` runs this one in
 * its own subprocess for that reason.
 *
 * WHY IT IS WORTH A FILE. `deploy-targets` and `deploy-tokens` are the two
 * screens here that are not wizards: no Cancel, and listings whose only buttons
 * are the action itself. A run that opens one and is never answered has exactly
 * one signal available to it — silence — so the deadline IS the ending, and the
 * wizard's five-minute default is not one anybody experiences as such.
 *
 * The defect this pins was not a wrong constant. The constant was right and
 * lived beside ONE of the two screens as a local default, so
 * `chooseDeployTargetInBrowser` was called with `timeoutMs` undefined from all
 * three of its call sites and kept 300s, while the report said otherwise. The
 * default lives inside both serve functions now, where a call site cannot
 * forget it — and this is the test that a call site no longer can.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

/** Every `timeoutMs` the screens hand the wizard, in call order. */
const deadlines: Array<number | undefined> = [];

mock.module('../../src/ui/browserWizard', () => ({
  runBrowserWizard: (params: { timeoutMs?: number }) => {
    deadlines.push(params.timeoutMs);
    // Resolving as a refusal: this probe answers nothing, and every one of
    // these functions has to survive that.
    return Promise.resolve({});
  },
}));

const {
  chooseDeployTargetInBrowser,
  showDeployTokensInBrowser,
  NO_REFUSAL_TIMEOUT_MS,
} = await import('../../src/ui/deployScreens');

const TARGETS = {
  projectName: 'mikes-market',
  configPath: '/repo/.capy/deploy.json',
  purpose: 'browse' as const,
  targets: [],
  allow: ['edit', 'remove', 'new'] as const,
  open: false,
};

const TOKENS = {
  projectName: 'mikes-market',
  tokens: [],
  open: false,
};

beforeEach(() => {
  deadlines.length = 0;
});

describe('the deadline a screen with no refusal control opens with', () => {
  test('is two minutes, not the wizard s five', () => {
    expect(NO_REFUSAL_TIMEOUT_MS).toBe(120_000);
    expect(NO_REFUSAL_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000);
  });

  test('deploy-targets takes it without being told — all three call sites', async () => {
    // `capy deploy targets --web`, `capy deploy targets-remove <name> --web`
    // and the "which target?" pick inside `capy deploy --web` all reach this
    // function, and NONE of them passes a deadline. That is the point: the
    // default is the screen's, so there is no call site left to forget it.
    await chooseDeployTargetInBrowser(TARGETS);
    await chooseDeployTargetInBrowser({ ...TARGETS, view: 'confirm-remove', subjectTarget: 'legacy' });
    await chooseDeployTargetInBrowser({ ...TARGETS, purpose: 'pick', allow: ['use', 'new'] });
    expect(deadlines).toEqual([
      NO_REFUSAL_TIMEOUT_MS,
      NO_REFUSAL_TIMEOUT_MS,
      NO_REFUSAL_TIMEOUT_MS,
    ]);
  });

  test('deploy-tokens takes it too, and both take it from the same place', async () => {
    await showDeployTokensInBrowser(TOKENS);
    await showDeployTokensInBrowser({ ...TOKENS, view: 'confirm-revoke', subjectToken: 'abc' });
    expect(deadlines).toEqual([NO_REFUSAL_TIMEOUT_MS, NO_REFUSAL_TIMEOUT_MS]);
  });

  test('a caller that names its own deadline still gets it', async () => {
    // Tests do. A default that could not be overridden would make every
    // refusal test in this suite a two-minute one.
    await chooseDeployTargetInBrowser({ ...TARGETS, timeoutMs: 4_000 });
    await showDeployTokensInBrowser({ ...TOKENS, timeoutMs: 4_000 });
    expect(deadlines).toEqual([4_000, 4_000]);
  });
});
