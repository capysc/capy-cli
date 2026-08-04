/**
 * The two routes, as pure functions.
 *
 * These exist for the reason `branchCreatePlan.test.ts` exists: the rail a
 * person reads, the diagram `renderRotationPlan` prints and the array a
 * headless caller parses are claimed to be the same object, and a claim nobody
 * pins is a claim that drifts. Everything asserted here is a claim about a run
 * — which stops it has, which it will never reach, and what settled the ones it
 * is not going to ask about.
 */
import { describe, test, expect } from 'bun:test';
import { connectPlan, rotationPlan, cap } from '../../src/commands/connectors/plans';
import { pushOutcomeFor } from '../../src/commands/connectCommand';

describe('connectPlan', () => {
  const BASE = { provider: 'stripe', branch: 'development', requiresTool: 'stripe', requiresAuth: true, push: true };

  test('declares the whole route in the order connect() travels it', () => {
    const stops = connectPlan({ ...BASE, standing: 'var' });
    expect(stops.map((s) => s.id)).toEqual(['cli', 'var', 'mode', 'auth', 'account', 'push']);
    // No `refresh`. It re-ran `stripe login`, which rewrites the user's
    // pairing — a credential operation, and `connect` does not do those. It
    // earned its place when connect wrote the key into `.env`; nothing is
    // written now, so `capy rotate` owns the near-expiry decision.
    expect(stops.some((s) => s.id === 'refresh')).toBe(false);
  });

  test('the precheck stop is on the rail even though it is never a question', () => {
    // A failed precheck exits before anything can be asked, so it arrives as a
    // wall rather than a step — but the route really did run through it.
    const stops = connectPlan({ ...BASE, standing: 'var' });
    const cli = stops.find((s) => s.id === 'cli')!;
    expect(cli.state).toBe('done');
    expect(cli.label).toBe('Stripe CLI');
    expect(cli.answer).toBe('found');
  });

  test('a connector with no local dependency has no CLI stop at all', () => {
    const stops = connectPlan({ provider: 'acme', branch: 'main', push: true });
    expect(stops.some((s) => s.id === 'cli')).toBe(false);
    // …and one that never signs in has no sign-in stop either, rather than one
    // claiming a pairing happened.
    expect(stops.some((s) => s.id === 'auth')).toBe(false);
  });

  test('only the stop being asked is current', () => {
    const stops = connectPlan({ ...BASE, standing: 'mode', varName: 'STRIPE_SECRET_KEY' });
    expect(stops.filter((s) => s.state === 'current').map((s) => s.id)).toEqual(['mode']);
  });

  test('a flag-answered stop is done and names the flag, never skipped', () => {
    const stops = connectPlan({
      ...BASE,
      standing: 'mode',
      varName: 'STRIPE_SECRET_KEY',
      varFromFlag: true,
      account: 'acct_1234',
      accountFromFlag: true,
      push: false,
      pushFromFlag: true,
    });
    const byId = Object.fromEntries(stops.map((s) => [s.id, s]));
    expect(byId.var.state).toBe('done');
    expect(byId.var.answer).toBe('STRIPE_SECRET_KEY');
    expect(byId.var.flag).toBe('--var');
    expect(byId.account.flag).toBe('--account');
    expect(byId.push.flag).toBe('--no-push');
    expect(byId.push.answer).toBe('local only');
  });

  test('test mode names no flag, because --test does not exist', () => {
    // Naming one would be the rail telling the reader to retype an argument
    // the command would reject.
    const asked = connectPlan({ ...BASE, standing: null, mode: 'test' });
    expect(asked.find((s) => s.id === 'mode')!.flag).toBeUndefined();
    const flagged = connectPlan({ ...BASE, standing: null, mode: 'live', modeFromFlag: true });
    expect(flagged.find((s) => s.id === 'mode')!.flag).toBe('--live');
  });

  test('a stop the run cannot reach is skipped rather than dropped', () => {
    const stops = connectPlan({
      ...BASE,
      standing: 'account',
      alreadySignedIn: true,
    });
    const byId = Object.fromEntries(stops.map((s) => [s.id, s]));
    expect(byId.auth.state).toBe('skipped');
    expect(byId.auth.answer).toBe('already paired');
    // Still six stops: a skipped station is a fact about the route, and an
    // already-paired run really did travel past the sign-in.
    expect(stops).toHaveLength(6);
  });

  test('the one hand-off is marked manual, so its track draws dotted', () => {
    // Sign-in is the only stop left that Capy cannot travel for you: the
    // provider's own browser pairing. `refresh` was the other, and removing it
    // means the route now has exactly one thing it hands back to the user.
    const stops = connectPlan({ ...BASE, standing: 'var' });
    expect(stops.find((s) => s.id === 'auth')!.manual).toBe(true);
    expect(stops.find((s) => s.id === 'account')!.manual).toBeUndefined();
    expect(stops.filter((s) => s.manual)).toHaveLength(1);
  });

  test('push is the terminus and never a question', () => {
    const stops = connectPlan({ ...BASE, standing: 'push' as never });
    const push = stops[stops.length - 1];
    expect(push.id).toBe('push');
    // Even when the run is "standing" there, it is not asked — nothing offers
    // it, `--no-push` settles it, and a rail that made it current would be
    // promising a question that never comes.
    expect(push.state).toBe('upcoming');
    expect(push.detail).toContain('development');
  });

  test('carries no key material', () => {
    const json = JSON.stringify(connectPlan({ ...BASE, standing: null, varName: 'K', mode: 'live', account: 'acct_1' }));
    expect(json).not.toContain('sk_');
    expect(json).not.toContain('rk_');
  });

  test('a finished run says what became of the push, rather than promising it', () => {
    // The result page draws this rail. `upcoming` beside a body reading "The
    // push did not land" is the rail contradicting the page it sits on — and
    // the rail is the half that looks authoritative.
    const failed = connectPlan({ ...BASE, standing: null, varName: 'K', pushOutcome: 'failed' });
    const push = failed[failed.length - 1];
    expect(push.state).toBe('current');
    expect(push.blank).toBe(true);
    expect(push.detail).toBe('did not reach Capy (branch: development)');
    expect(push.answer).toBeUndefined();

    const landed = connectPlan({ ...BASE, standing: null, varName: 'K', pushOutcome: 'landed' });
    const done = landed[landed.length - 1];
    expect(done.state).toBe('done');
    expect(done.answer).toBe('pushed to development');

    // A run that ended before the push ever ran leaves the stop where it was.
    const notReached = connectPlan({ ...BASE, standing: null, varName: 'K', pushOutcome: 'not-reached' });
    expect(notReached[notReached.length - 1].state).toBe('upcoming');
  });
});

describe('pushOutcomeFor', () => {
  test('maps every ending, off the outcome enum rather than its prose', () => {
    expect(pushOutcomeFor('pushed')).toBe('landed');
    expect(pushOutcomeFor('push-failed')).toBe('failed');
    // Three endings that never attempted a push: `--no-push`, a local write
    // that failed, and a live gate that was declined.
    expect(pushOutcomeFor('local-only')).toBe('not-reached');
    expect(pushOutcomeFor('write-failed')).toBe('not-reached');
    expect(pushOutcomeFor('cancelled')).toBe('not-reached');
  });
});

describe('rotationPlan', () => {
  const BASE = { branch: 'development', providers: ['stripe'], authProviders: ['stripe'] };

  test('draws the two stops the terminal left implicit', () => {
    // `renderRotationPlan` started at Auth, so the variable and the integration
    // the user had just answered were missing from the picture of what they
    // were agreeing to.
    const stops = rotationPlan({ ...BASE, standing: 'plan', varName: 'STRIPE_KEY', needsIntegration: false });
    expect(stops.map((s) => s.id)).toEqual(['variable', 'integration', 'auth', 'rotate', 'push', 'deploy']);
  });

  test('the CLI Auth wording is carried verbatim', () => {
    const stops = rotationPlan({ ...BASE, standing: 'plan' });
    expect(stops.find((s) => s.id === 'auth')!.detail).toBe(
      'authenticate with Stripe (requires manual user auth)',
    );
    expect(stops.find((s) => s.id === 'auth')!.manual).toBe(true);
  });

  test('a provider that needs no hand-off draws no Auth stop', () => {
    const stops = rotationPlan({ branch: 'main', providers: ['acme'], authProviders: [], standing: 'plan' });
    expect(stops.some((s) => s.id === 'auth')).toBe(false);
  });

  test('--all settles the variable stop and says which flag did it', () => {
    const stops = rotationPlan({ ...BASE, all: true, targetCount: 3, standing: 'plan' });
    const variable = stops.find((s) => s.id === 'variable')!;
    expect(variable.state).toBe('done');
    expect(variable.answer).toBe('all 3');
    expect(variable.flag).toBe('--all');
    expect(stops.find((s) => s.id === 'rotate')!.detail).toBe(
      'fetch fresh keys for 3 credentials from Stripe',
    );
  });

  test('an already-managed credential never visits the integration stop', () => {
    const managed = rotationPlan({ ...BASE, varName: 'K', needsIntegration: false, standing: 'plan' });
    expect(managed.find((s) => s.id === 'integration')!.state).toBe('skipped');
    const promote = rotationPlan({ ...BASE, varName: 'K', needsIntegration: true, standing: 'integration' });
    expect(promote.find((s) => s.id === 'integration')!.state).toBe('current');
  });

  test('--no-push strikes through the two stops it will not travel', () => {
    // It still rotates: the old key dies at the provider either way. What it
    // skips is the sharing, and the terminal skips the whole diagram instead.
    const stops = rotationPlan({ ...BASE, noPush: true, varName: 'K', standing: 'plan' });
    expect(stops.find((s) => s.id === 'push')!.state).toBe('skipped');
    expect(stops.find((s) => s.id === 'deploy')!.state).toBe('skipped');
    expect(stops.find((s) => s.id === 'rotate')!.state).toBe('upcoming');
  });

  test('an unresolved deploy target is a blank, not a missing stop', () => {
    const blank = rotationPlan({ ...BASE, varName: 'K', standing: 'plan' });
    expect(blank.find((s) => s.id === 'deploy')!.blank).toBe(true);
    const resolved = rotationPlan({ ...BASE, varName: 'K', standing: 'plan', deployDetail: 'ship directly to prod' });
    expect(resolved.find((s) => s.id === 'deploy')!.blank).toBeUndefined();
    expect(resolved.find((s) => s.id === 'deploy')!.detail).toBe('ship directly to prod');
  });

  test('names no integration before one is known', () => {
    // `fetch a fresh key from ` with nothing after it is worse than saying so.
    const stops = rotationPlan({ branch: 'main', standing: 'variable' });
    expect(stops.find((s) => s.id === 'rotate')!.detail).toBe(
      'fetch a fresh key from the integration that issued it',
    );
  });
});

describe('cap', () => {
  test('matches the CLI’s own capitalisation of a provider id', () => {
    expect(cap('stripe')).toBe('Stripe');
    expect(cap('')).toBe('');
  });
});
