/**
 * The rotation route, as a pure function.
 *
 * The diagram `renderRotationPlan` prints is claimed to be the array
 * `rotationPlan` returns, and a claim nobody pins is a claim that drifts.
 * Everything asserted here is a claim about a run — which stops it has, which
 * it will never reach, and what settled the ones it is not going to ask about.
 */
import { describe, test, expect } from 'bun:test';
import { rotationPlan, cap } from '../../src/commands/connectors/plans';

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
