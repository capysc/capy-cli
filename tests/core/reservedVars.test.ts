import { describe, test, expect } from 'bun:test';
import {
  isReservedRuntimeVar,
  stripReservedRuntimeVars,
  RESERVED_VAR_PREFIX,
  LEGACY_RESERVED_VARS,
} from '../../src/core/reservedVars';

describe('isReservedRuntimeVar', () => {
  test('reserves the two legacy names', () => {
    expect(isReservedRuntimeVar('SECRETS_BLOB')).toBe(true);
    expect(isReservedRuntimeVar('PROJECT_KEY')).toBe(true);
  });

  test('reserves anything under the _CAPY_ prefix, including names not invented yet', () => {
    expect(isReservedRuntimeVar('_CAPY_SECRETS_BLOB')).toBe(true);
    expect(isReservedRuntimeVar('_CAPY_DEPLOY_KEY')).toBe(true);
    expect(isReservedRuntimeVar('_CAPY_A_FUTURE_RUNTIME_VAR')).toBe(true);
  });

  test('does NOT reserve bare DEPLOY_KEY', () => {
    // Deliberate (CAP-424): a generic word is a plausible application variable
    // — tests/sync/spliceKeepBranch.test.ts uses this exact name as one — and
    // the real credential is _CAPY_DEPLOY_KEY, covered by the prefix.
    expect(isReservedRuntimeVar('DEPLOY_KEY')).toBe(false);
  });

  test('does not reserve ordinary application variables', () => {
    for (const name of ['DATABASE_URL', 'API_KEY', 'CAPY_API_URL', 'CAPY_HOME', 'SECRETS', 'KEY']) {
      expect(isReservedRuntimeVar(name)).toBe(false);
    }
  });

  test('matches on the prefix, not a substring', () => {
    // A variable that merely contains the prefix is someone else's.
    expect(isReservedRuntimeVar('MY_CAPY_THING')).toBe(false);
    expect(isReservedRuntimeVar('PREFIX_CAPY_X')).toBe(false);
  });

  test('is exact for the legacy names, not a prefix match', () => {
    expect(isReservedRuntimeVar('SECRETS_BLOB_BACKUP')).toBe(false);
    expect(isReservedRuntimeVar('MY_PROJECT_KEY')).toBe(false);
  });

  test('the exported constants are what the predicate actually uses', () => {
    // Guards against the constants drifting into decoration while the
    // predicate hardcodes its own copies.
    expect(isReservedRuntimeVar(`${RESERVED_VAR_PREFIX}ANYTHING`)).toBe(true);
    for (const legacy of LEGACY_RESERVED_VARS) {
      expect(isReservedRuntimeVar(legacy)).toBe(true);
    }
  });
});

describe('stripReservedRuntimeVars', () => {
  test('removes reserved names and keeps everything else byte-identical', () => {
    const out = stripReservedRuntimeVars({
      SECRETS_BLOB: 'blob',
      PROJECT_KEY: 'pk',
      _CAPY_DEPLOY_KEY: 'dt',
      DATABASE_URL: 'postgres://h/d',
      DEPLOY_KEY: 'mine',
    });

    expect(out).toEqual({ DATABASE_URL: 'postgres://h/d', DEPLOY_KEY: 'mine' });
  });

  test('preserves explicit undefined values for non-reserved names', () => {
    // process.env entries can be undefined in the typed record; dropping them
    // silently would change spawn semantics for callers that rely on the key
    // existing.
    const out = stripReservedRuntimeVars({ MAYBE: undefined, SECRETS_BLOB: 'blob' });
    expect(Object.keys(out)).toEqual(['MAYBE']);
    expect(out.MAYBE).toBeUndefined();
  });

  test('does not mutate its input', () => {
    const input = { SECRETS_BLOB: 'blob', KEEP: 'me' };
    stripReservedRuntimeVars(input);
    expect(input.SECRETS_BLOB).toBe('blob');
  });

  test('is a no-op on an environment with nothing reserved', () => {
    const input = { A: '1', B: '2' };
    expect(stripReservedRuntimeVars(input)).toEqual(input);
  });
});
