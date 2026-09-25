import { describe, test, expect } from 'bun:test';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  listImportableEntries,
  mergeManagedBlock,
  resolveDokployToken,
  splitManagedBlock,
} from '../../src/deploy/dokployApi';

const PAIR = { secretsBlob: 'QkxPQg==', projectKey: 'ab'.repeat(32) };

/** `splitManagedBlock` + `mergeManagedBlock` in one step — the production flow. */
function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

describe('dokployApi — token resolution', () => {
  test('reads the token from the configured variable name', () => {
    expect(resolveDokployToken('MY_TOKEN', { MY_TOKEN: 'dk_abc' })).toBe('dk_abc');
  });

  test('is null when unset or empty', () => {
    expect(resolveDokployToken('MY_TOKEN', {})).toBeNull();
    expect(resolveDokployToken('MY_TOKEN', { MY_TOKEN: '' })).toBeNull();
  });
});

describe('dokployApi — listImportableEntries', () => {
  test('lists names + values outside the Capy block', () => {
    const env = 'DATABASE_URL=postgres://x\n# comment\nPORT=3000';
    expect(listImportableEntries(env)).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://x' },
      { name: 'PORT', value: '3000' },
    ]);
  });

  test('excludes both runtime pairs — never offered as an "importable" project var', () => {
    const env = [
      `${RUNTIME_PAIR[0]}=x`,
      `${RUNTIME_PAIR[1]}=y`,
      `${OLD_RUNTIME_PAIR[0]}=x`,
      `${OLD_RUNTIME_PAIR[1]}=y`,
      'REAL_VAR=z',
    ].join('\n');
    expect(listImportableEntries(env)).toEqual([{ name: 'REAL_VAR', value: 'z' }]);
  });

  test('excludes names inside the Capy block itself', () => {
    const env = mergedEnv('OUTSIDE=1', PAIR);
    expect(listImportableEntries(env)).toEqual([{ name: 'OUTSIDE', value: '1' }]);
  });

  test('a CRLF-terminated line is still read, and its name carries no \\r', () => {
    const env = 'DATABASE_URL=postgres://x\r\nPORT=3000\r\n';
    const entries = listImportableEntries(env);
    expect(entries).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://x' },
      { name: 'PORT', value: '3000' },
    ]);
    expect(entries.some((e) => e.name.includes('\r') || e.value.includes('\r'))).toBe(false);
  });

  test('flags a Dokploy reference value rather than importing it as a literal string', () => {
    const env = 'STATIC=1\nREF=${{project.SOME_VAR}}';
    expect(listImportableEntries(env)).toEqual([
      { name: 'STATIC', value: '1' },
      { name: 'REF', value: '${{project.SOME_VAR}}', skip: 'DOKPLOY_REFERENCE_VALUE' },
    ]);
  });

  test('a malformed block (edited/duplicated markers) offers nothing rather than guessing', () => {
    expect(listImportableEntries(`${MANAGED_BEGIN}\nA=1`)).toEqual([]);
    expect(listImportableEntries(`${MANAGED_END}\n${MANAGED_BEGIN}`)).toEqual([]);
  });

  test('an empty env has nothing to import', () => {
    expect(listImportableEntries(null)).toEqual([]);
    expect(listImportableEntries('')).toEqual([]);
  });
});
