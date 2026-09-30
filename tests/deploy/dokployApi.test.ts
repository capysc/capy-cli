import { describe, test, expect } from 'bun:test';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  createDokployClient,
  listImportableEntries,
  mergeManagedBlock,
  resolveDokployToken,
  splitManagedBlock,
  stripManagedBlock,
} from '../../src/deploy/dokployApi';

const PAIR = { secretsBlob: 'QkxPQg==', projectKey: 'ab'.repeat(32) };
const PAIR2 = { secretsBlob: 'TkVXQkxPQg==', projectKey: 'cd'.repeat(32) };

/** `splitManagedBlock` + `mergeManagedBlock` in one step — the production flow. */
function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

function splitOk(env: string | null) {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem: ' + split.code);
  return split;
}

/** The 4 lines of a Capy block, joined with `eol`, no trailing terminator — matches mergeManagedBlock's own construction. */
function blockText(pair: { secretsBlob: string; projectKey: string }, eol: '\n' | '\r\n' = '\n'): string {
  return [MANAGED_BEGIN, `${RUNTIME_PAIR[0]}=${pair.secretsBlob}`, `${RUNTIME_PAIR[1]}=${pair.projectKey}`, MANAGED_END].join(eol);
}

// ── Byte-exactness: split/merge/strip must round-trip every byte outside the
// block, in every position (start/middle/end) and every line-ending style. ──
describe('dokployApi — managed block byte-exactness', () => {
  const withContentAfter = `A=1\n${blockText(PAIR)}\nB=2\n# tail\n`;
  const withContentAfterCRLF = `A=1\r\n${blockText(PAIR, '\r\n')}\r\nB=2\r\n# tail\r\n`;

  test('replace: content AFTER the block (LF) survives byte-for-byte', () => {
    const merged = mergedEnv(withContentAfter, PAIR2);
    expect(merged).toBe(`A=1\n${blockText(PAIR2)}\nB=2\n# tail\n`);
    // The literal bug this guards: END and the next line must never fuse.
    expect(merged).not.toContain('endB=2');
    expect(merged).toContain(`${MANAGED_END}\nB=2`);
  });

  test('replace: content AFTER the block (CRLF) survives byte-for-byte', () => {
    const merged = mergedEnv(withContentAfterCRLF, PAIR2);
    expect(merged).toBe(`A=1\r\n${blockText(PAIR2, '\r\n')}\r\nB=2\r\n# tail\r\n`);
    expect(merged).toContain(`${MANAGED_END}\r\nB=2`);
  });

  test('replace keeps `before`/`after` byte-identical — only the block’s own 4 lines move', () => {
    const split = splitOk(withContentAfter);
    expect(split.before).toBe('A=1\n');
    expect(split.after).toBe('\nB=2\n# tail\n');
    const merged = mergeManagedBlock(split, PAIR2);
    const resplit = splitOk(merged);
    expect(resplit.before).toBe(split.before);
    expect(resplit.after).toBe(split.after);
  });

  test('block at the very START (nothing before it)', () => {
    const env = `${blockText(PAIR)}\nB=2\n`;
    const merged = mergedEnv(env, PAIR2);
    expect(merged).toBe(`${blockText(PAIR2)}\nB=2\n`);
  });

  test('block at the very END, WITH a trailing newline', () => {
    const env = `A=1\n${blockText(PAIR)}\n`;
    const merged = mergedEnv(env, PAIR2);
    expect(merged).toBe(`A=1\n${blockText(PAIR2)}\n`);
  });

  test('block at the very END, with NO trailing newline', () => {
    const env = `A=1\n${blockText(PAIR)}`;
    const merged = mergedEnv(env, PAIR2);
    expect(merged).toBe(`A=1\n${blockText(PAIR2)}`);
  });

  test('strip undoes a real (first-time) merge exactly, for every block position — strip(merge(x)) === x', () => {
    const cases: Array<{ name: string; before: string }> = [
      { name: 'no prior block, content in the middle', before: 'A=1\nB=2\n# tail\n' },
      { name: 'no prior block, empty file', before: '' },
      { name: 'no prior block, single line no trailing newline', before: 'A=1' },
      { name: 'no prior block, CRLF', before: 'A=1\r\nB=2\r\n' },
    ];
    for (const { before } of cases) {
      const split = splitOk(before);
      const merged = mergeManagedBlock(split, PAIR);
      const roundTripped = stripManagedBlock(splitOk(merged));
      expect(roundTripped).toBe(before);
    }
  });

  test('strip a block that already has real content after it (e.g. a dashboard edit made after Capy wrote) leaves exactly one separator', () => {
    // Block sits between "A=1" and "B=2", exactly as if the 4 Capy lines were
    // deleted outright — never two newlines, never zero.
    const stripped = stripManagedBlock(splitOk(withContentAfter));
    expect(stripped).toBe('A=1\nB=2\n# tail\n');
  });

  test('strip a block at the end, with real content after it, CRLF', () => {
    const stripped = stripManagedBlock(splitOk(withContentAfterCRLF));
    expect(stripped).toBe('A=1\r\nB=2\r\n# tail\r\n');
  });

  test('multiple replaces in a row never drift the surrounding bytes', () => {
    const once = mergedEnv(withContentAfter, PAIR);
    const twice = mergedEnv(once, PAIR2);
    const split = splitOk(twice);
    expect(split.before).toBe('A=1\n');
    expect(split.after).toBe('\nB=2\n# tail\n');
    expect(stripManagedBlock(splitOk(twice))).toBe('A=1\nB=2\n# tail\n');
  });
});

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

  // ── CAP-679 follow-up: DOKPLOY_VALUE_QUOTED. dotenv already strips ONE
  // layer of surrounding quotes (see the "one matching pair of double quotes
  // is stripped" test above) — a value that STILL looks quote-wrapped after
  // that means the raw line was double-quoted, and is flagged, never stripped
  // further. ──
  test('a double-quoted value (single quotes outside, double quotes surviving inside) is flagged DOKPLOY_VALUE_QUOTED, never stripped', () => {
    const env = `Q='"real value"'`;
    expect(listImportableEntries(env)).toEqual([
      { name: 'Q', value: '"real value"', warning: 'DOKPLOY_VALUE_QUOTED' },
    ]);
  });

  test('the reverse double-quoting (double outside, single surviving inside) is flagged the same way', () => {
    const env = `Q="'real value'"`;
    expect(listImportableEntries(env)).toEqual([
      { name: 'Q', value: "'real value'", warning: 'DOKPLOY_VALUE_QUOTED' },
    ]);
  });

  test('a normally single-quoted value (only one layer) is NOT flagged — dotenv already stripped it clean', () => {
    const env = 'DATABASE_URL="postgres://u:p@h/db"';
    expect(listImportableEntries(env)).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://u:p@h/db' },
    ]);
  });

  test('quoting takes priority over the dollar warning when both would apply', () => {
    const env = `H='"$2b$12$abc"'`;
    const entries = listImportableEntries(env);
    expect(entries).toEqual([{ name: 'H', value: '"$2b$12$abc"', warning: 'DOKPLOY_VALUE_QUOTED' }]);
  });

  test('a reference value is never ALSO flagged as quoted', () => {
    const env = `REF='"${'${{project.X}}'}"'`;
    const entries = listImportableEntries(env);
    // The reference check (`${{`) runs first — this is still a reference,
    // not a quoted value, even though its parsed form also looks wrapped.
    expect(entries[0].skip).toBe('DOKPLOY_REFERENCE_VALUE');
    expect(entries[0].warning).toBeUndefined();
  });
});

// ── Validator finding (key exposure, CAP-657 URL input follow-up): a
// redirect must never carry the `x-api-key` header cross-origin. ──────────
describe('createDokployClient — redirect guard', () => {
  test('every request is sent with redirect: "error" (never follows a 30x)', async () => {
    const seenInits: Array<{ redirect?: string }> = [];
    const fetchImpl = async (
      _url: string,
      init: { method: string; headers: Record<string, string>; body?: string; redirect?: string },
    ) => {
      seenInits.push({ redirect: init.redirect });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ applicationId: 'app_1', env: null, createEnvFile: true }),
      };
    };
    const client = createDokployClient('https://dokploy.example.com', 'tok', fetchImpl);
    await client.getApplication('app_1');
    expect(seenInits.length).toBe(1);
    expect(seenInits[0].redirect).toBe('error');
  });

  test('a redirect (fetch rejecting under redirect: "error") surfaces as an "unreachable" DokployApiError, not an unhandled throw', async () => {
    const fetchImpl = async () => {
      // What a real `fetch` does for a 30x under `redirect: 'error'`: reject.
      throw new TypeError('Failed to fetch: redirect');
    };
    const client = createDokployClient('https://dokploy.example.com', 'tok', fetchImpl);
    await expect(client.getApplication('app_1')).rejects.toMatchObject({ code: 'unreachable' });
  });
});
