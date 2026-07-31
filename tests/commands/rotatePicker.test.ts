import { describe, test, expect } from 'bun:test';
import {
  buildRotateCandidates,
  buildRotatePickerChoices,
  rotationPlanLines,
  travelledStops,
} from '../../src/commands/rotateCommand';
import { rotationPlan } from '../../src/commands/connectors/plans';
import { KeepFile } from '../../src/types/index';

function keepWith(entries: Record<string, Array<{ branch: string; connector?: any }>>): KeepFile {
  const variables: KeepFile['variables'] = {};
  for (const [name, es] of Object.entries(entries)) {
    variables[name] = es.map((e) => ({
      resource_id: `r-${name}`,
      branch: e.branch,
      value_hash: `h-${name}`,
      ...(e.connector ? { connector: e.connector } : {}),
    }));
  }
  return { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables };
}

const stripeConnector = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_test',
  created_at: 1700000000,
  fingerprint: 'rk_…tst',
};

describe('buildRotatePickerChoices', () => {
  test('annotates unmanaged vars with "(unmanaged)" and managed with provider info', () => {
    const keep = keepWith({
      STRIPE_SECRET_KEY: [{ branch: 'main', connector: stripeConnector }],
      DATABASE_URL: [{ branch: 'main' }],
    });

    const choices = buildRotatePickerChoices(
      ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      keep,
      'main',
    );

    expect(choices).toHaveLength(2);

    const db = choices.find((c) => c.value === 'DATABASE_URL')!;
    expect(db.managed).toBe(false);
    // ANSI escapes can vary; assert on the substring that matters.
    expect(db.name).toContain('DATABASE_URL');
    expect(db.name).toContain('(unmanaged)');

    const stripe = choices.find((c) => c.value === 'STRIPE_SECRET_KEY')!;
    expect(stripe.managed).toBe(true);
    expect(stripe.name).toContain('STRIPE_SECRET_KEY');
    expect(stripe.name).toContain('stripe');
    expect(stripe.name).toContain('rk_…tst');
  });

  test('preserves input order (caller controls sort)', () => {
    const keep = keepWith({
      A: [{ branch: 'main' }],
      B: [{ branch: 'main' }],
      C: [{ branch: 'main' }],
    });
    const choices = buildRotatePickerChoices(['B', 'A', 'C'], keep, 'main');
    expect(choices.map((c) => c.value)).toEqual(['B', 'A', 'C']);
  });

  test('treats a connector tagged on another branch as unmanaged here', () => {
    const keep = keepWith({
      STRIPE_SECRET_KEY: [{ branch: 'feature', connector: stripeConnector }],
    });
    const choices = buildRotatePickerChoices(['STRIPE_SECRET_KEY'], keep, 'main');
    expect(choices[0].managed).toBe(false);
    expect(choices[0].name).toContain('(unmanaged)');
  });

  test('renders expiry hint for managed vars with expires_at', () => {
    const future = Math.floor(Date.now() / 1000) + 30 * 86400; // ~30 days
    const keep = keepWith({
      STRIPE_SECRET_KEY: [{
        branch: 'main',
        connector: { ...stripeConnector, expires_at: future },
      }],
    });
    const choices = buildRotatePickerChoices(['STRIPE_SECRET_KEY'], keep, 'main');
    expect(choices[0].name).toMatch(/expires in \d+d/);
  });

  test('renders "expired" for past expires_at', () => {
    const past = Math.floor(Date.now() / 1000) - 5 * 86400;
    const keep = keepWith({
      STRIPE_SECRET_KEY: [{
        branch: 'main',
        connector: { ...stripeConnector, expires_at: past },
      }],
    });
    const choices = buildRotatePickerChoices(['STRIPE_SECRET_KEY'], keep, 'main');
    expect(choices[0].name).toMatch(/expired \d+d ago/);
  });

  test('returns empty list for empty input', () => {
    const keep = keepWith({});
    expect(buildRotatePickerChoices([], keep, 'main')).toEqual([]);
  });
});

describe('buildRotateCandidates', () => {
  test('carries the same facts as the terminal rows, structured', () => {
    // Same keep.lock lookup, which is why it lives beside the terminal
    // builder: two lookups is two answers to "is this managed?".
    const future = Math.floor(Date.now() / 1000) + 30 * 86400;
    const keep = keepWith({
      STRIPE_SECRET_KEY: [
        { branch: 'main', connector: { ...stripeConnector, expires_at: future, mode: 'live' } },
      ],
      DATABASE_URL: [{ branch: 'main' }],
    });
    const rows = buildRotateCandidates(['DATABASE_URL', 'STRIPE_SECRET_KEY'], keep, 'main');

    expect(rows[0]).toEqual({ name: 'DATABASE_URL', managed: false });

    const stripe = rows[1];
    expect(stripe.managed).toBe(true);
    expect(stripe.provider).toBe('stripe');
    expect(stripe.fingerprint).toBe('rk_…tst');
    expect(stripe.mode).toBe('live');
    expect(stripe.accountId).toBe('acct_test');
    // Issued through the provider's CLI, so rotating invalidates every
    // teammate's copy.
    expect(stripe.issuedByCapy).toBe(true);
    // A number, not `expires in 30d` glued into a sentence.
    expect(stripe.expiresInDays).toBe(29);
  });

  test('carries no ANSI, unlike the strings the terminal picker builds', () => {
    const keep = keepWith({ A: [{ branch: 'main' }] });
    expect(JSON.stringify(buildRotateCandidates(['A'], keep, 'main'))).not.toContain('\x1b');
  });
});

describe('rotationPlanLines', () => {
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  test('draws every stop the plan declares, including the answered ones', () => {
    // The diagram used to start at Auth, so the variable and the integration
    // the user had just answered were missing from the picture of what they
    // were agreeing to.
    const lines = rotationPlanLines(
      rotationPlan({
        branch: 'development',
        varName: 'STRIPE_SECRET_KEY',
        needsIntegration: false,
        providers: ['stripe'],
        authProviders: ['stripe'],
        standing: 'plan',
      }),
    ).map(strip);
    const text = lines.join('\n');
    expect(text).toContain('Rotation plan');
    for (const label of ['Variable', 'Integration', 'Auth', 'Rotate', 'Push', 'Deploy']) {
      expect(text).toContain(label);
    }
    // An answered stop carries its answer beside it.
    expect(text).toContain('· STRIPE_SECRET_KEY');
  });

  test('a stop this run never visits is drawn, dimmed, rather than dropped', () => {
    const text = rotationPlanLines(
      rotationPlan({
        branch: 'development',
        varName: 'K',
        needsIntegration: false,
        providers: ['stripe'],
        authProviders: [],
        standing: 'plan',
      }),
    )
      .map(strip)
      .join('\n');
    // `·` is the never-visited node; `◌` stays reserved for a blank the plan
    // still needs an answer for.
    expect(text).toMatch(/·\s+Integration/);
    expect(text).toMatch(/◌\s+Deploy/);
  });

  test('the track leaving a manual stop is dotted', () => {
    const text = rotationPlanLines(
      rotationPlan({
        branch: 'development',
        all: true,
        targetCount: 2,
        providers: ['stripe'],
        authProviders: ['stripe'],
        standing: 'plan',
      }),
    )
      .map(strip)
      .join('\n');
    expect(text).toContain('┊');
    expect(text).toContain('│');
    // `--all` settled the variable stop, and the rail names the flag.
    expect(text).toContain('(--all)');
  });
});

describe('travelledStops', () => {
  const PLAN = rotationPlan({
    branch: 'development',
    varName: 'STRIPE_SECRET_KEY',
    needsIntegration: false,
    providers: ['stripe'],
    authProviders: ['stripe'],
    deployDetail: 'ship directly to prod',
    standing: 'plan',
  });
  const at = (stops: Array<{ id: string; state: string }>, id: string) =>
    stops.find((s) => s.id === id)!;

  test('a rollout that failed puts the rail on the stop the run died at', () => {
    // The page this screen exists for. The plan handed over untouched drew
    // Rotate, Push and Deploy as stops still ahead of a run that had been
    // through all three.
    const stops = travelledStops(PLAN, [
      { id: 'rotate', label: 'Rotate', state: 'ok', detail: '1/1' },
      { id: 'push', label: 'Push', state: 'ok', detail: 'development' },
      { id: 'deploy', label: 'Deploy', state: 'fail', detail: 'prod' },
    ]);
    expect(at(stops, 'rotate').state).toBe('done');
    expect(at(stops, 'push').state).toBe('done');
    expect(at(stops, 'deploy').state).toBe('current');
    expect(at(stops, 'deploy').blank).toBe(true);
    // The pairing is inside the Rotate step, and it produced a key.
    expect(at(stops, 'auth').state).toBe('done');
    expect(at(stops, 'auth').answer).toBe('paired');
    // A question settled before the run began is left exactly as declared.
    expect(at(stops, 'variable')).toEqual(at(PLAN as never, 'variable') as never);
  });

  test('a deploy queued behind a failed rotation is upcoming, not skipped', () => {
    // `pending` and `skip` are different facts: one never ran and might still
    // have worked; the other was never going to.
    const stops = travelledStops(PLAN, [
      { id: 'rotate', label: 'Rotate', state: 'fail', detail: '0/1' },
      { id: 'push', label: 'Push', state: 'pending', detail: 'development' },
      { id: 'deploy', label: 'Deploy', state: 'pending', detail: 'prod' },
    ]);
    expect(at(stops, 'rotate').state).toBe('current');
    expect(at(stops, 'push').state).toBe('upcoming');
    expect(at(stops, 'deploy').state).toBe('upcoming');
    // Nothing rotated, so nothing proves the pairing happened.
    expect(at(stops, 'auth').state).not.toBe('done');
  });

  test('--no-push strikes through the stops it skipped', () => {
    const stops = travelledStops(PLAN, [
      { id: 'rotate', label: 'Rotate', state: 'ok', detail: '1/1' },
      { id: 'push', label: 'Push', state: 'skip', detail: 'skipped by --no-push' },
      { id: 'deploy', label: 'Deploy', state: 'skip', detail: 'nothing was pushed' },
    ]);
    expect(at(stops, 'push').state).toBe('skipped');
    expect(at(stops, 'deploy').state).toBe('skipped');
  });
});
