import { describe, test, expect } from 'bun:test';
import { buildRotatePickerChoices } from '../../src/commands/rotateCommand';
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
