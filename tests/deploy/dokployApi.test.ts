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

/**
 * The value for each importable name is exactly `dotenv.parse`'s own output
 * (CAP-657 live bug, 2026-09-27: a quoted `DATABASE_URL="postgres://…"` was
 * stored WITH its surrounding quotes) — not a byte-for-byte copy of the raw
 * Dokploy line. Every vector here is one Vince's research pinned down
 * against Dokploy's own first parsing step (dotenv@16.4.5); this repo's
 * installed `dotenv` (16.6.1 at the time of writing) is asserted to produce
 * the SAME output for each, so a future dotenv bump that changes this
 * behavior fails a test here rather than silently reaching a person's `.env`.
 */
describe('dokployApi — listImportableEntries — dotenv.parse-accurate values', () => {
  test('one matching pair of double quotes is stripped', () => {
    const env = 'DATABASE_URL="postgres://u:p@h:5432/db?sslmode=require"';
    expect(listImportableEntries(env)).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://u:p@h:5432/db?sslmode=require' },
    ]);
  });

  test('a $$-escaped bcrypt hash in double quotes is unescaped by dotenv, and flagged for its literal $', () => {
    const env = 'H="$$2b$$12$$abc"';
    expect(listImportableEntries(env)).toEqual([{ name: 'H', value: '$$2b$$12$$abc', warning: 'DOKPLOY_VALUE_HAS_DOLLAR' }]);
  });

  test('the same hash in single quotes, unescaped, is flagged the same way', () => {
    const env = "H='$2b$12$abc'";
    expect(listImportableEntries(env)).toEqual([{ name: 'H', value: '$2b$12$abc', warning: 'DOKPLOY_VALUE_HAS_DOLLAR' }]);
  });

  test('a duplicate name: the LAST value wins, and it is offered only once', () => {
    const env = 'DUP=first\nDUP=second';
    expect(listImportableEntries(env)).toEqual([{ name: 'DUP', value: 'second' }]);
  });

  test('inside double quotes, only \\n is decoded — \\t is left literal', () => {
    const env = 'E="a\\nb\\tc"';
    expect(listImportableEntries(env)).toEqual([{ name: 'E', value: 'a\nb\\tc' }]);
  });

  test('an unquoted value is cut at the first #', () => {
    const env = 'A=abc#def';
    expect(listImportableEntries(env)).toEqual([{ name: 'A', value: 'abc' }]);
  });

  test('a quoted value keeps an internal #, and a trailing # comment after the closing quote is dropped', () => {
    const env = 'A="abc#def" # c';
    expect(listImportableEntries(env)).toEqual([{ name: 'A', value: 'abc#def' }]);
  });

  test('padding inside quotes is kept', () => {
    const env = 'T="  padded  "';
    expect(listImportableEntries(env)).toEqual([{ name: 'T', value: '  padded  ' }]);
  });

  test('a leading "export " is dropped', () => {
    const env = 'export X=yes';
    expect(listImportableEntries(env)).toEqual([{ name: 'X', value: 'yes' }]);
  });

  test('CRLF-terminated lines parse the same as LF', () => {
    const env = 'A=1\r\nB=2\r\n';
    expect(listImportableEntries(env)).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
  });

  test('a backtick-quoted value is unwrapped like single/double quotes', () => {
    const env = 'B=`tick`';
    expect(listImportableEntries(env)).toEqual([{ name: 'B', value: 'tick' }]);
  });

  test('a line with no "=" is dropped entirely', () => {
    const env = 'NOEQ\nOK=1';
    expect(listImportableEntries(env)).toEqual([{ name: 'OK', value: '1' }]);
  });

  test('a Dokploy reference value is detected on the PARSED value, still skipped', () => {
    const env = 'REF=${{project.X}}';
    expect(listImportableEntries(env)).toEqual([{ name: 'REF', value: '${{project.X}}', skip: 'DOKPLOY_REFERENCE_VALUE' }]);
  });

  test('a $ that is part of a reference value is not ALSO reported as the dollar warning', () => {
    const env = 'REF=${{project.X}}';
    const entries = listImportableEntries(env);
    expect(entries).toEqual([{ name: 'REF', value: '${{project.X}}', skip: 'DOKPLOY_REFERENCE_VALUE' }]);
    expect(entries[0].warning).toBeUndefined();
  });
});
