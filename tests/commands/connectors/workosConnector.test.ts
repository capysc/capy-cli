import { describe, test, expect } from 'bun:test';
import {
  findKeyByValue,
  findPreviousRotatedKey,
  isCapyRotatedName,
  resolveApplicationId,
  rotationKeyName,
  isCredentials,
  parseCredentialBlob,
  looksLikeWorkOSClientId,
  looksLikeWorkOSApiKey,
  findClientIdCandidates,
  findApiKeyCandidates,
  WorkOSGraphQLError,
  workosConnector,
  type WorkOSKey,
} from '../../../src/commands/connectors/workos';

const CLIENT_ID = 'client_01JD4FCFQ5M1XGAV5E4CG8BT8A';
const OTHER_CLIENT_ID = 'client_01KVHX0J4F64B9GXAQFWQZZCPF';
const WOS_KEY = 'sk_test_a2V5XzAxTTFDODg2Tko4NDFYMlkwSlJO';

const key = (over: Partial<WorkOSKey> = {}): WorkOSKey => ({
  id: 'key_1',
  name: 'Secret Key',
  createdAt: '2026-08-01T00:00:00.000Z',
  displayValue: 'sk_test_aaa',
  applicationId: 'app_1',
  expiredAt: null,
  ...over,
});

describe('findKeyByValue', () => {
  test('matches the key holding the value currently in .env', () => {
    const keys = [key({ id: 'key_1', displayValue: 'sk_test_aaa' }), key({ id: 'key_2', displayValue: 'sk_test_bbb' })];
    expect(findKeyByValue(keys, 'sk_test_bbb')?.id).toBe('key_2');
  });

  test('misses rather than guessing when the value is not listed', () => {
    // A production key's plaintext is never returned, so this is the normal
    // case for production — callers must treat undefined as "unknown", not
    // as "the first one".
    const keys = [key({ displayValue: null })];
    expect(findKeyByValue(keys, 'sk_live_secret')).toBeUndefined();
  });

  test('does not match on a null displayValue when the value is empty', () => {
    const keys = [key({ displayValue: null })];
    expect(findKeyByValue(keys, '')).toBeUndefined();
  });
});

describe('resolveApplicationId', () => {
  test('prefers the outgoing key application so the new key lands beside it', () => {
    const keys = [key({ applicationId: 'app_1' }), key({ id: 'key_2', applicationId: 'app_2' })];
    const outgoing = key({ id: 'key_2', applicationId: 'app_2' });
    expect(resolveApplicationId(keys, outgoing)).toBe('app_2');
  });

  test('falls back to the sole application when the outgoing key is unknown', () => {
    const keys = [key({ id: 'key_1', applicationId: 'app_1' }), key({ id: 'key_2', applicationId: 'app_1' })];
    expect(resolveApplicationId(keys, undefined)).toBe('app_1');
  });

  test('refuses to choose between two applications', () => {
    // Guessing here mints a key on an application nothing is using while the
    // live one keeps working — a rotation that reports success and changes
    // nothing.
    const keys = [key({ id: 'key_1', applicationId: 'app_1' }), key({ id: 'key_2', applicationId: 'app_2' })];
    expect(resolveApplicationId(keys, undefined)).toBeUndefined();
  });

  test('returns undefined when no key carries an application', () => {
    expect(resolveApplicationId([key({ applicationId: null })], undefined)).toBeUndefined();
  });

  test('ignores a null application on the outgoing key and falls through', () => {
    const keys = [key({ id: 'key_1', applicationId: 'app_1' })];
    expect(resolveApplicationId(keys, key({ applicationId: null }))).toBe('app_1');
  });
});

describe('findPreviousRotatedKey', () => {
  const rotated = (id: string, date: string, over: Partial<WorkOSKey> = {}) =>
    key({ id, name: `capy-rotated-${date}`, createdAt: `${date}T12:00:00.000Z`, ...over });

  test('finds the newest Capy-minted key when the value match missed', () => {
    // The production case: displayValue never matches, so this is the only
    // route to expiring anything at all.
    const keys = [rotated('key_old', '2026-08-01'), rotated('key_new', '2026-08-30')];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')?.id).toBe('key_new');
  });

  test('never returns the key just created', () => {
    // Without the exclusion this expires the replacement it is handing over to.
    const keys = [rotated('key_created', '2026-08-31'), rotated('key_old', '2026-08-01')];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')?.id).toBe('key_old');
  });

  test('ignores keys the connector did not mint', () => {
    const keys = [key({ id: 'key_manual', name: 'Secret Key', createdAt: '2026-08-30T00:00:00Z' })];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')).toBeUndefined();
  });

  test('ignores keys already scheduled to expire', () => {
    const keys = [rotated('key_done', '2026-08-30', { expiredAt: '2026-09-01T00:00:00Z' })];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')).toBeUndefined();
  });

  test('stays within the target application', () => {
    const keys = [rotated('key_other', '2026-08-30', { applicationId: 'app_2' })];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')).toBeUndefined();
    expect(findPreviousRotatedKey(keys, 'key_created', null)?.id).toBe('key_other');
  });

  test('falls back to the name date when createdAt is absent', () => {
    const keys = [
      rotated('key_old', '2026-08-01', { createdAt: null }),
      rotated('key_new', '2026-08-30', { createdAt: null }),
    ];
    expect(findPreviousRotatedKey(keys, 'key_created', 'app_1')?.id).toBe('key_new');
  });

  test('returns undefined on a first rotation, when Capy has minted nothing', () => {
    expect(findPreviousRotatedKey([], 'key_created', 'app_1')).toBeUndefined();
  });
});

describe('isCapyRotatedName', () => {
  test('matches only the exact minted shape', () => {
    expect(isCapyRotatedName('capy-rotated-2026-08-31')).toBe(true);
    expect(isCapyRotatedName('capy-rotated-soon')).toBe(false);
    expect(isCapyRotatedName('my-capy-rotated-2026-08-31')).toBe(false);
    expect(isCapyRotatedName('Secret Key')).toBe(false);
    expect(isCapyRotatedName(null)).toBe(false);
  });

  test('agrees with the name rotationKeyName actually produces', () => {
    // These two must not drift: the writer and the reader of that name are
    // the only contract linking one rotation to the next.
    expect(isCapyRotatedName(rotationKeyName())).toBe(true);
  });
});

describe('rotationKeyName', () => {
  test('is dated so the dashboard shows when a rotation happened', () => {
    expect(rotationKeyName()).toMatch(/^capy-rotated-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isCredentials', () => {
  test('accepts a stored blob with the fields the connector needs', () => {
    expect(isCredentials({ accessToken: 'tok', expiresAt: 1 })).toBe(true);
  });

  test('rejects a partial write so it reads as logged-out, not as a crash', () => {
    expect(isCredentials({ accessToken: 'tok' })).toBe(false);
    expect(isCredentials({ expiresAt: 1 })).toBe(false);
    expect(isCredentials(null)).toBe(false);
    expect(isCredentials('nope')).toBe(false);
  });

  test('rejects a numeric accessToken rather than coercing it', () => {
    expect(isCredentials({ accessToken: 123, expiresAt: 1 })).toBe(false);
  });
});

describe('WorkOSGraphQLError', () => {
  test('carries the machine-readable code, not just the prose', () => {
    // The whole point: callers branch on `code`. If this ever collapses to a
    // message-only error, every consumer silently starts string-matching.
    const err = new WorkOSGraphQLError('Forbidden resource', 'FORBIDDEN', 403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
    expect(err instanceof Error).toBe(true);
  });

  test('tolerates a server error that carried no code', () => {
    const err = new WorkOSGraphQLError('boom', undefined, undefined);
    expect(err.code).toBeUndefined();
  });
});

describe('looksLikeWorkOSClientId', () => {
  test('accepts a real client id', () => {
    expect(looksLikeWorkOSClientId(CLIENT_ID)).toBe(true);
    expect(looksLikeWorkOSClientId(`  ${CLIENT_ID}  `)).toBe(true);
  });

  test('rejects near-misses that would resolve to the wrong environment', () => {
    expect(looksLikeWorkOSClientId('client_tooshort')).toBe(false);
    expect(looksLikeWorkOSClientId('org_01JD4FCFQ5M1XGAV5E4CG8BT8A')).toBe(false);
    expect(looksLikeWorkOSClientId('')).toBe(false);
    expect(looksLikeWorkOSClientId('changeme')).toBe(false);
  });
});

describe('looksLikeWorkOSApiKey', () => {
  test('accepts sk_test_ and sk_live_', () => {
    expect(looksLikeWorkOSApiKey(WOS_KEY)).toBe(true);
    expect(looksLikeWorkOSApiKey('sk_live_abc123')).toBe(true);
  });

  test('rejects non-keys', () => {
    expect(looksLikeWorkOSApiKey('pk_test_abc')).toBe(false);
    expect(looksLikeWorkOSApiKey('sk_test_')).toBe(false);
    expect(looksLikeWorkOSApiKey('')).toBe(false);
  });
});

describe('findClientIdCandidates', () => {
  test('finds a client id under a non-standard name', () => {
    // The whole point of matching on value: not everyone names it
    // WORKOS_CLIENT_ID.
    const found = findClientIdCandidates({ NEXT_PUBLIC_AUTH_CLIENT_ID: CLIENT_ID, PORT: '3000' });
    expect(found.map((c) => c.name)).toEqual(['NEXT_PUBLIC_AUTH_CLIENT_ID']);
    expect(found[0].value).toBe(CLIENT_ID);
  });

  test('does not accept a right-looking name holding a placeholder', () => {
    // Name says yes, value says no. The value wins, because rotating against
    // a placeholder resolves to no environment at all.
    expect(findClientIdCandidates({ WORKOS_CLIENT_ID: 'changeme' })).toHaveLength(0);
  });

  test('sorts name-agreeing candidates first', () => {
    const found = findClientIdCandidates({
      AAA_CLIENT: OTHER_CLIENT_ID,
      WORKOS_CLIENT_ID: CLIENT_ID,
    });
    expect(found[0].name).toBe('WORKOS_CLIENT_ID');
    expect(found[0].byName).toBe(true);
    expect(found).toHaveLength(2);
  });

  test('returns both when two client ids are present, so the caller can ask', () => {
    const found = findClientIdCandidates({ STAGING_CLIENT: CLIENT_ID, PROD_CLIENT: OTHER_CLIENT_ID });
    expect(found).toHaveLength(2);
  });
});

describe('findApiKeyCandidates', () => {
  test('finds a WorkOS key under a non-standard name', () => {
    const found = findApiKeyCandidates({ WORKOS_SECRET: WOS_KEY, PORT: '3000' });
    expect(found.map((c) => c.name)).toEqual(['WORKOS_SECRET']);
  });

  test('a Stripe key collides on shape and is disambiguated by name', () => {
    // Stripe secret keys share the sk_test_ prefix exactly. Both are
    // candidates; only the WorkOS-named one is name-agreeing, which is what
    // stops a WorkOS rotation pointing at the Stripe variable.
    const found = findApiKeyCandidates({
      STRIPE_SECRET_KEY: 'sk_test_stripe_value_here',
      WORKOS_API_KEY: WOS_KEY,
    });
    expect(found).toHaveLength(2);
    expect(found[0].name).toBe('WORKOS_API_KEY');
    expect(found[0].byName).toBe(true);
    expect(found[1].byName).toBe(false);
  });

  test('two unnamed sk_ values stay ambiguous rather than silently resolving', () => {
    const found = findApiKeyCandidates({ A_KEY: 'sk_test_aaa', B_KEY: 'sk_live_bbb' });
    expect(found.every((c) => !c.byName)).toBe(true);
    expect(found).toHaveLength(2);
  });

  test('finds nothing when no value has the prefix', () => {
    expect(findApiKeyCandidates({ WORKOS_API_KEY: 'not-a-key' })).toHaveLength(0);
  });
});

describe('parseCredentialBlob', () => {
  const creds = { accessToken: 'tok', expiresAt: 123, refreshToken: 'r' };

  test('reads the base64 blob the macOS keychain actually stores', () => {
    // The regression this exists for: `security -w` returns base64 of the
    // JSON, not the JSON. Parsing directly threw, the throw was swallowed as
    // "no credentials", and a successful `workos auth login` was followed by
    // "could not read a usable WorkOS session".
    const b64 = Buffer.from(JSON.stringify(creds)).toString('base64');
    expect(parseCredentialBlob(b64)).toEqual(creds);
  });

  test('still reads plain JSON, as the file store holds it', () => {
    expect(parseCredentialBlob(JSON.stringify(creds))).toEqual(creds);
  });

  test('returns undefined for a blob that is neither', () => {
    expect(parseCredentialBlob('not-a-thing')).toBeUndefined();
    expect(parseCredentialBlob('')).toBeUndefined();
  });
});

describe('workosConnector module shape', () => {
  test('declares the tool it reads credentials from', () => {
    expect(workosConnector.name).toBe('workos');
    expect(workosConnector.requiresTool).toBe('workos');
    expect(workosConnector.toolMissing?.code).toBe('PROVIDER_CLI_MISSING');
  });

  test('does not claim an interactive auth step', () => {
    // `requiresAuth` puts an "Auth" stop in the rotate plan promising a manual
    // hand-off. WorkOS rotation is unattended, so claiming one would describe
    // a pause that never comes.
    expect(workosConnector.requiresAuth).toBeUndefined();
  });
});
