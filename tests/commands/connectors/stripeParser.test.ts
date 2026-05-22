import { describe, test, expect } from 'bun:test';
import {
  parseStripeConfig,
  validateRestrictedKey,
  looksStripey,
  rankStripeVars,
  validateVarName,
} from '../../../src/commands/connectors/stripe';

describe('parseStripeConfig', () => {
  test('parses single-quoted values (Stripe CLI native format)', () => {
    const raw = `
color = ''
project-name = 'default'

[default]
account_id = 'acct_1Abc'
device_name = 'vince-mbp'
test_mode_api_key = 'sk_test_long_value_here'
test_mode_key_expires_at = '2026-08-06'
display_name = 'vincentchan.vc'
`;
    const sections = parseStripeConfig(raw);
    expect(sections).toHaveLength(1);
    const s = sections[0];
    expect(s.test_mode_api_key).toBe('sk_test_long_value_here');
    expect(s.account_id).toBe('acct_1Abc');
    expect(s.display_name).toBe('vincentchan.vc');
    // ISO date should be converted to unix seconds.
    expect(typeof s.test_mode_key_expires_at).toBe('number');
    expect(s.test_mode_key_expires_at).toBe(Math.floor(Date.parse('2026-08-06') / 1000));
  });

  test('parses a default-section config', () => {
    const raw = `
[default]
device_name = "vince-mbp"
test_mode_api_key = "rk_test_abc123"
test_mode_publishable_key = "pk_test_xyz"
test_mode_key_expires_at = 1717000000
live_mode_api_key = "rk_live_def456"
live_mode_key_expires_at = 1718000000
account_id = "acct_1Abc"
display_name = "Acme Inc"
`;
    const sections = parseStripeConfig(raw);
    expect(sections).toHaveLength(1);
    const s = sections[0];
    expect(s.name).toBe('default');
    expect(s.test_mode_api_key).toBe('rk_test_abc123');
    expect(s.live_mode_api_key).toBe('rk_live_def456');
    expect(s.test_mode_key_expires_at).toBe(1717000000);
    expect(s.account_id).toBe('acct_1Abc');
    expect(s.display_name).toBe('Acme Inc');
  });

  test('parses multiple [project-name] sections', () => {
    const raw = `
[default]
test_mode_api_key = "rk_test_default"
account_id = "acct_default"

[rocket-rides]
test_mode_api_key = "rk_test_rocket"
account_id = "acct_rocket"
display_name = "Rocket Rides"
`;
    const sections = parseStripeConfig(raw);
    expect(sections.map((s) => s.name).sort()).toEqual(['default', 'rocket-rides']);
    const rocket = sections.find((s) => s.name === 'rocket-rides')!;
    expect(rocket.account_id).toBe('acct_rocket');
  });

  test('skips comments and blank lines', () => {
    const raw = `
# top-level comment
[default]
# inline comment
test_mode_api_key = "rk_test_x"

account_id = "acct_x"
`;
    const sections = parseStripeConfig(raw);
    expect(sections).toHaveLength(1);
    expect(sections[0].test_mode_api_key).toBe('rk_test_x');
  });

  test('filters out sections with no key material', () => {
    const raw = `
[empty]
device_name = "no-keys"

[full]
test_mode_api_key = "rk_test_full"
account_id = "acct_full"
`;
    const sections = parseStripeConfig(raw);
    expect(sections.map((s) => s.name)).toEqual(['full']);
  });

  test('returns no sections for empty input', () => {
    expect(parseStripeConfig('')).toEqual([]);
  });

  test('strips one layer of outer quotes from section headers', () => {
    // TOML requires quoting section names with spaces. Stripe CLI writes
    // them as `["Project Name"]`; we want to recover "Project Name" so the
    // `--project-name=` we hand to `stripe login` is the canonical form.
    const raw = `
["Acornpack Prod"]
account_id = "acct_1"
test_mode_api_key = "rk_test_one"

['single-quoted']
account_id = "acct_2"
test_mode_api_key = "rk_test_two"

[unquoted-plain]
account_id = "acct_3"
test_mode_api_key = "rk_test_three"
`;
    const sections = parseStripeConfig(raw);
    const names = sections.map((s) => s.name).sort();
    expect(names).toEqual(['Acornpack Prod', 'single-quoted', 'unquoted-plain']);
  });

  test('does not strip mismatched outer quotes (preserves intent)', () => {
    // If a header is genuinely asymmetric, leave it alone — better to fail
    // loudly than silently lose a character.
    const raw = `
["mismatch']
account_id = "acct_x"
test_mode_api_key = "rk_test_x"
`;
    const sections = parseStripeConfig(raw);
    expect(sections[0].name).toBe('"mismatch\'');
  });

  test('handles trailing comments after values', () => {
    const raw = `
[default]
test_mode_api_key = "rk_test_x"  # this is a key
test_mode_key_expires_at = 1717000000  # unix seconds
`;
    const sections = parseStripeConfig(raw);
    expect(sections[0].test_mode_api_key).toBe('rk_test_x');
    expect(sections[0].test_mode_key_expires_at).toBe(1717000000);
  });
});

describe('validateRestrictedKey', () => {
  test('accepts well-formed restricted and secret keys', () => {
    expect(validateRestrictedKey('rk_test_abcdefgh')).toBe(true);
    expect(validateRestrictedKey('rk_live_abcdefgh')).toBe(true);
    expect(validateRestrictedKey('sk_test_abcdefgh')).toBe(true);
    expect(validateRestrictedKey('sk_live_abcdefgh')).toBe(true);
  });

  test('rejects empty', () => {
    expect(validateRestrictedKey('')).toBe('Key cannot be empty');
    expect(validateRestrictedKey('   ')).toBe('Key cannot be empty');
  });

  test('rejects unknown prefixes', () => {
    expect(typeof validateRestrictedKey('whsec_abcdefgh')).toBe('string');
    expect(typeof validateRestrictedKey('pk_test_abcdefgh')).toBe('string');
    expect(typeof validateRestrictedKey('garbage')).toBe('string');
  });

  test('rejects keys that are too short', () => {
    expect(typeof validateRestrictedKey('rk_test_a')).toBe('string');
  });
});

describe('looksStripey', () => {
  test('matches names containing STRIPE (case-insensitive)', () => {
    expect(looksStripey('STRIPE_SECRET_KEY')).toBe(true);
    expect(looksStripey('STRIPE_PUBLISHABLE_KEY')).toBe(true);
    expect(looksStripey('stripe_secret')).toBe(true);
    expect(looksStripey('MY_STRIPE_THING')).toBe(true);
  });

  test('matches names containing RESTRICTED_KEY', () => {
    expect(looksStripey('RESTRICTED_KEY')).toBe(true);
    expect(looksStripey('MY_RESTRICTED_KEY')).toBe(true);
    expect(looksStripey('restricted_key')).toBe(true);
  });

  test('does not match unrelated names', () => {
    expect(looksStripey('DATABASE_URL')).toBe(false);
    expect(looksStripey('REDIS_URL')).toBe(false);
    expect(looksStripey('OPENAI_API_KEY')).toBe(false);
    expect(looksStripey('SECRET_KEY')).toBe(false);
  });

  test('does not match on value prefixes (we removed value matching)', () => {
    // The name "SOME_KEY" looks like nothing — even if its value were
    // 'sk_test_xyz' we don't peek inside.
    expect(looksStripey('SOME_KEY')).toBe(false);
    expect(looksStripey('SK_TEST_KEY')).toBe(false);
  });
});

describe('rankStripeVars', () => {
  test('partitions matches first, others second, preserving input order', () => {
    const { matches, others } = rankStripeVars([
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'REDIS_URL',
      'STRIPE_PUBLISHABLE_KEY',
      'OPENAI_API_KEY',
    ]);
    expect(matches).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY']);
    expect(others).toEqual(['DATABASE_URL', 'REDIS_URL', 'OPENAI_API_KEY']);
  });

  test('handles all-matches input', () => {
    const { matches, others } = rankStripeVars(['STRIPE_A', 'STRIPE_B']);
    expect(matches).toEqual(['STRIPE_A', 'STRIPE_B']);
    expect(others).toEqual([]);
  });

  test('handles no-matches input', () => {
    const { matches, others } = rankStripeVars(['DATABASE_URL', 'REDIS_URL']);
    expect(matches).toEqual([]);
    expect(others).toEqual(['DATABASE_URL', 'REDIS_URL']);
  });

  test('handles empty input', () => {
    const { matches, others } = rankStripeVars([]);
    expect(matches).toEqual([]);
    expect(others).toEqual([]);
  });
});

describe('validateVarName', () => {
  test('accepts well-formed UPPER_SNAKE_CASE names', () => {
    expect(validateVarName('STRIPE_SECRET_KEY')).toBe(true);
    expect(validateVarName('A')).toBe(true);
    expect(validateVarName('_LEADING_UNDERSCORE')).toBe(true);
    expect(validateVarName('NAME_WITH_123')).toBe(true);
  });

  test('rejects empty or whitespace-only', () => {
    expect(validateVarName('')).toBe('Variable name cannot be empty');
    expect(validateVarName('   ')).toBe('Variable name cannot be empty');
  });

  test('rejects lowercase or invalid characters', () => {
    expect(typeof validateVarName('stripe_secret_key')).toBe('string');
    expect(typeof validateVarName('My-Var')).toBe('string');
    expect(typeof validateVarName('1LEADING_DIGIT')).toBe('string');
    expect(typeof validateVarName('HAS SPACE')).toBe('string');
  });

  test('trims whitespace before validating', () => {
    expect(validateVarName('  STRIPE_SECRET_KEY  ')).toBe(true);
  });
});
