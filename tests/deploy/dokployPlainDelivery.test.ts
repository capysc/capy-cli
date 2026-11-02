/**
 * CAP-682: Dokploy plaintext delivery — the pure primitives in
 * `dokployApi.ts`'s "Plaintext delivery" section.
 *
 *   - `formatDotenvValue`: a property test proving `dotenv.parse(render(x))
 *     === x` for a large adversarial value set (never a fixed example list
 *     alone — see `feedback_assert_the_property_not_the_shape`: this asserts
 *     the ACTUAL round-trip property via the real `dotenv` package, not a
 *     hand-derived shape).
 *   - `syncCommentedLines`: comment/uncomment byte-exactness, including
 *     multi-line quoted values and a name appearing twice.
 *   - `mergeManagedValuesBlock` / `removeManagedValuesBlock`: the whole-env
 *     round trip (original → deploy → remove === original), LF/CRLF, block
 *     already present, block at the end, and migration from an OLD
 *     blob-style Capy block.
 *   - `mismatchedDeliveredValues`: the read-back verification.
 *
 * Every value used here is a fake, obviously-non-secret test string.
 */
import { describe, test, expect } from 'bun:test';
import { parse as parseDotenv } from 'dotenv';
import {
  CAPY_OFF_MARKER,
  MANAGED_BEGIN,
  MANAGED_END,
  describeDokployPlainMergeProblem,
  formatDotenvValue,
  mergeManagedValuesBlock,
  mismatchedDeliveredValues,
  removeManagedValuesBlock,
  renderManagedValueLines,
  syncCommentedLines,
} from '../../src/deploy/dokployApi';

// ── formatDotenvValue: property test ───────────────────────────────────────

/** A deliberately adversarial set of values — every quote character, alone and combined, real and literal newlines, `#`, `$`, `=`, backslashes, whitespace, empty, unicode, and very long. */
const ADVERSARIAL_VALUES: readonly string[] = [
  '',
  ' ',
  '   leading and trailing whitespace   ',
  'plain-value-no-special-chars',
  "it's got an apostrophe",
  'has a "double quote"',
  'has a `backtick`',
  `mixes ' and "`,
  "mixes ' and `",
  'mixes " and `',
  // Value that itself looks like a quoted string, unquoted-safe test.
  "'already looks quoted'",
  '"already looks double-quoted"',
  '`already looks backtick-quoted`',
  // Real newlines.
  'line one\nline two',
  'line one\r\nline two',
  'line one\nline two\nline three',
  // Literal (non-real) escape-looking sequences — the double-quote decode trap.
  'a literal backslash-n: \\n not a real newline',
  'a literal backslash-r: \\r not a real newline',
  'both a real \n newline and a literal \\n sequence',
  // `#`, `$`, `=` — meaningful to dotenv/shells, must never be special here.
  'has a # hash mid-value',
  '# starts with a hash',
  'has a $DOLLAR and ${BRACES}',
  'has an = sign in it',
  'KEY=VALUE-shaped-content',
  // Backslashes generally.
  'a single backslash: \\',
  'a trailing backslash\\',
  'many\\\\backslashes\\\\here',
  // Whitespace-only and tabs.
  '\t\ttabbed\t\t',
  '\n',
  '   ',
  // Looks like the managed-block markers or the capy:off marker.
  MANAGED_BEGIN,
  MANAGED_END,
  CAPY_OFF_MARKER + 'FOO=bar',
  // JSON-shaped secrets (the realistic worst case: escaped newlines AND quotes).
  '{"a":"b","c":"line1\\nline2"}',
  '{"nested":{"x":1},"y":["a","b"]}',
  // Unicode.
  '日本語のテスト値',
  '🔒🔑 emoji secret 🔐',
  'café naïve résumé',
  // Long value.
  'x'.repeat(2000),
  // All three quote types but no newline and no literal escape sequence —
  // still representable (double-quote branch).
  "has ' and " + '`' + ' but no double quote',
  // Literal ${{ — refused outright (Dokploy resolves this itself); covered
  // by dedicated tests below, listed here too for round-trip-loop symmetry.
  '${{project.OTHER_VAR}}',
];

describe('formatDotenvValue — property: dotenv.parse(render(x)) === x', () => {
  test('every representable adversarial value round-trips exactly through dotenv.parse, individually', () => {
    for (const value of ADVERSARIAL_VALUES) {
      const rendered = formatDotenvValue(value);
      if (!rendered.ok) continue; // covered by the refusal test below
      const line = `V=${rendered.rendered}`;
      const parsed = parseDotenv(line);
      expect(parsed.V).toBe(value);
    }
  });

  test('a whole block of REPRESENTABLE adversarial values round-trips together — no cross-entry interference', () => {
    // `renderManagedValueLines` is all-or-nothing (a single unrepresentable
    // value refuses the WHOLE block — see its own test below) — so this
    // proves the "many entries in one block" property on exactly the subset
    // `formatDotenvValue` itself accepts.
    const entries = ADVERSARIAL_VALUES.filter((v) => formatDotenvValue(v).ok).map((value, i) => ({ name: `VAR_${i}`, value }));
    expect(entries.length).toBeGreaterThan(20);
    const rendered = renderManagedValueLines(entries);
    if (!rendered.ok) throw new Error('unexpected: every entry here was pre-filtered to be representable');
    const text = rendered.lines.join('\n');
    const parsed = parseDotenv(text);
    for (const { name, value } of entries) {
      expect(parsed[name]).toBe(value);
    }
  });

  test('a value made only of plain characters is emitted bare, unquoted', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['180', '180'],
      ['https://x.y/z', 'https://x.y/z'],
      ['a=b', 'a=b'],
      ['user@host:5432,other+1_2-3./x', 'user@host:5432,other+1_2-3./x'],
    ];
    for (const [value, expected] of cases) {
      const r = formatDotenvValue(value);
      expect(r).toEqual({ ok: true, rendered: expected });
      expect(parseDotenv(`V=${expected}`).V).toBe(value);
    }
  });

  test('a value that needs protection is still quoted: #, leading space, $, quote characters, empty', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['a#b', "'a#b'"],
      [' lead', "' lead'"],
      ['trail ', "'trail '"],
      ['$HOME', "'$HOME'"],
      ["'x'", '`\'x\'`'],
      ['"x"', `'"x"'`],
      ['a b', "'a b'"],
      ['a\\b', "'a\\b'"],
      ['a\nb', "'a\nb'"],
      ['', "''"],
    ];
    for (const [value, expected] of cases) {
      const r = formatDotenvValue(value);
      expect(r).toEqual({ ok: true, rendered: expected });
      expect(parseDotenv(`V=${r.ok ? r.rendered : ''}`).V).toBe(value);
    }
  });

  test('property: any rendered output that does not start with a quote character matches the safe charset', () => {
    const SAFE = /^[A-Za-z0-9_\-./:@,+=]+$/;
    const values = [...ADVERSARIAL_VALUES, ...fuzzCases(0xbeef, 2000), '180', 'https://x.y/z', 'a=b', 'a#b', ' lead', '$HOME'];
    const rendered = values.flatMap((v) => {
      const r = formatDotenvValue(v);
      return r.ok ? [r.rendered] : [];
    });
    const bare = rendered.filter((r) => !["'", '`', '"'].includes(r[0] ?? ''));
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.filter((r) => !SAFE.test(r))).toEqual([]);
  });

  test('a value using all three quote characters, with a double-quote AND a literal backslash-n, refuses rather than writing lossy', () => {
    const value = "has ' and " + '\u0060' + ' and " and a literal \\n sequence';
    const r = formatDotenvValue(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOKPLOY_VALUE_UNREPRESENTABLE');
  });

  test('a value using all three quote characters, with only a literal backslash-r, refuses', () => {
    const value = "' and " + '\u0060' + ' and " together, plus a literal \\r sequence';
    const r = formatDotenvValue(value);
    expect(r.ok).toBe(false);
  });

  // Regression: `formatDotenvValue` originally only guarded the double-quote
  // branch against a literal \n (backslash + n), missing that `dotenv`
  // ALSO decodes a literal \r (backslash + r) inside a double-quoted
  // value. A value with ' and backtick but deliberately NO " is the one
  // case that actually exercises the double-quote branch -- the sibling
  // test above (which also has a literal ") would refuse either way and so
  // passes vacuously regardless of whether the \r guard exists at all.
  test('single + backtick quotes, no double quote, but a literal backslash-r: refuses rather than corrupting the value into a real CR', () => {
    const value = "has ' and " + '\u0060' + ' but no double quote, plus a literal \\r sequence';
    const r = formatDotenvValue(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOKPLOY_VALUE_UNREPRESENTABLE');
  });

  test('single + backtick quotes, no double quote, but a literal backslash-n: refuses (the backslash-n sibling of the case above)', () => {
    const value = "has ' and " + '\u0060' + ' but no double quote, plus a literal \\n sequence';
    const r = formatDotenvValue(value);
    expect(r.ok).toBe(false);
  });

  test('a value with single AND backtick quotes but NO double quote uses the double-quote fallback', () => {
    const value = "has ' and " + '\u0060' + ' but no double quote at all';
    const r = formatDotenvValue(value);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rendered.startsWith('"')).toBe(true);
      const parsed = parseDotenv(`V=${r.rendered}`);
      expect(parsed.V).toBe(value);
    }
  });

  test('a value containing a carriage return (bare \\r or as part of \\r\\n) always refuses, regardless of quoting', () => {
    // dotenv normalizes EVERY \r\n (and a bare \r) to \n on the whole input
    // BEFORE any quote-aware parsing -- so no quote style can preserve a real
    // carriage return byte-exact. This is a refusal, not a quoting problem.
    for (const value of ['line one\r\nline two', 'bare\rcarriage-return', "has ' and a \r too"]) {
      const r = formatDotenvValue(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('DOKPLOY_VALUE_UNREPRESENTABLE');
    }
  });

  test('a value containing a literal ${{ refuses with DOKPLOY_VALUE_HAS_REFERENCE, regardless of quoting or how simple the rest of the value is', () => {
    for (const value of [
      '${{project.OTHER_VAR}}',
      'prefix-${{environment.DB}}-suffix',
      "has a ' quote and ${{project.X}} too",
      '${{',
    ]) {
      const r = formatDotenvValue(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('DOKPLOY_VALUE_HAS_REFERENCE');
    }
  });

  test('a single closing brace or a single $ alone is NOT a reference — only the literal ${{ triggers the refusal', () => {
    for (const value of ['just a } brace', 'a $ sign alone', '{{not-a-reference}}', '${notEither}']) {
      const r = formatDotenvValue(value);
      expect(r.ok).toBe(true);
    }
  });

  test('renderManagedValueLines refuses the WHOLE block, naming every offending variable, when any value is unrepresentable', () => {
    const bad = "has ' and " + '\u0060' + ' and " and a literal \\n';
    const entries = [
      { name: 'OK_ONE', value: 'fine' },
      { name: 'BAD_ONE', value: bad },
      { name: 'BAD_TWO', value: bad },
    ];
    const r = renderManagedValueLines(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.map((p) => p.name)).toEqual(['BAD_ONE', 'BAD_TWO']);
      expect(r.problems.every((p) => p.code === 'DOKPLOY_VALUE_UNREPRESENTABLE')).toBe(true);
    }
  });
});

// ── syncCommentedLines: comment/uncomment byte-exactness ───────────────────

describe('syncCommentedLines — comment/uncomment', () => {
  test('comments exactly the active line for a delivered name, leaves everything else untouched', () => {
    const text = 'FOO=1\nBAR=2\n# a comment\n\nBAZ=3\n';
    const commented = syncCommentedLines(text, new Set(['BAR']));
    expect(commented).toBe(`FOO=1\n${CAPY_OFF_MARKER}BAR=2\n# a comment\n\nBAZ=3\n`);
  });

  test('is idempotent — commenting an already-commented line does not double the marker', () => {
    const once = syncCommentedLines('BAR=2\n', new Set(['BAR']));
    const twice = syncCommentedLines(once, new Set(['BAR']));
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(CAPY_OFF_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0).toBe(1);
  });

  test('un-comments exactly the marked line for a name no longer delivered, restoring it byte-exact', () => {
    const commented = `FOO=1\n${CAPY_OFF_MARKER}BAR=2\n`;
    const restored = syncCommentedLines(commented, new Set());
    expect(restored).toBe('FOO=1\nBAR=2\n');
  });

  test('a real comment line and a blank line are NEVER touched, whether marked names exist or not', () => {
    const text = '# real comment\n\nFOO=1\n';
    expect(syncCommentedLines(text, new Set(['FOO']))).toBe(`# real comment\n\n${CAPY_OFF_MARKER}FOO=1\n`);
    expect(syncCommentedLines(text, new Set())).toBe(text);
  });

  test('an undelivered name that happens to already carry the marker (hand-edited) is left marked — never guessed at as "should be active"', () => {
    // Only a caller that includes the name in `deliveredNames` un-marks it;
    // absence is not itself a signal to touch a line at all here.
    const text = `${CAPY_OFF_MARKER}FOO=1\n`;
    expect(syncCommentedLines(text, new Set())).toBe('FOO=1\n');
    expect(syncCommentedLines(text, new Set(['FOO']))).toBe(text);
  });

  test('a name appearing twice outside the block gets BOTH occurrences commented', () => {
    const text = 'STRIPE_KEY=first\nOTHER=x\nSTRIPE_KEY=second\n';
    const commented = syncCommentedLines(text, new Set(['STRIPE_KEY']));
    expect(commented).toBe(`${CAPY_OFF_MARKER}STRIPE_KEY=first\nOTHER=x\n${CAPY_OFF_MARKER}STRIPE_KEY=second\n`);
    // Un-commenting restores both.
    expect(syncCommentedLines(commented, new Set())).toBe(text);
  });

  test('a multi-line double-quoted value gets EVERY physical line commented, not just the first', () => {
    const text = ['CERT="-----BEGIN CERT-----', 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A', '-----END CERT-----"', 'PORT=3000'].join('\n');
    const commented = syncCommentedLines(text, new Set(['CERT']));
    const lines = commented.split('\n');
    expect(lines[0]).toBe(`${CAPY_OFF_MARKER}CERT="-----BEGIN CERT-----`);
    expect(lines[1]).toBe(`${CAPY_OFF_MARKER}MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A`);
    expect(lines[2]).toBe(`${CAPY_OFF_MARKER}-----END CERT-----"`);
    expect(lines[3]).toBe('PORT=3000'); // untouched — not delivered, not part of CERT's span
    // Round trip back to the exact original.
    expect(syncCommentedLines(commented, new Set())).toBe(text);
  });

  test('a multi-line value for a name NOT delivered is left completely untouched', () => {
    const text = ['CERT="-----BEGIN CERT-----', 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A', '-----END CERT-----"'].join('\n');
    expect(syncCommentedLines(text, new Set(['UNRELATED']))).toBe(text);
  });

  test('a Dokploy ${{project.X}}/${{environment.X}} reference for an undelivered name stays active', () => {
    const text = 'API_URL=${{project.API_URL}}\nDB=${{environment.DB}}\n';
    expect(syncCommentedLines(text, new Set(['STRIPE_KEY']))).toBe(text);
  });

  test('CRLF lines are commented/uncommented with their own line ending preserved', () => {
    const text = 'FOO=1\r\nBAR=2\r\n';
    const commented = syncCommentedLines(text, new Set(['BAR']));
    expect(commented).toBe(`FOO=1\r\n${CAPY_OFF_MARKER}BAR=2\r\n`);
    expect(syncCommentedLines(commented, new Set())).toBe(text);
  });
});

// ── mergeManagedValuesBlock / removeManagedValuesBlock: whole-env round trip ─

function mergeOk(env: string | null, values: ReadonlyArray<{ name: string; value: string }>): string {
  const r = mergeManagedValuesBlock(env, values);
  if (!r.ok) throw new Error('unexpected merge problem in test');
  return r.env;
}

function removeOk(env: string | null): string {
  const r = removeManagedValuesBlock(env);
  if (!r.ok) throw new Error('unexpected remove problem in test');
  return r.env;
}

describe('mergeManagedValuesBlock / removeManagedValuesBlock — round trip', () => {
  const V = [
    { name: 'DATABASE_URL', value: 'postgres://example-not-real/db' },
    { name: 'STRIPE_KEY', value: 'sk_test_not_real_789' },
  ];

  test('first write: appends the block, writes plain KEY=value lines dotenv reads back exactly', () => {
    const merged = mergeOk('NODE_ENV=production\nPORT=3000', V);
    expect(merged.split('\n').filter((l) => l === MANAGED_BEGIN)).toHaveLength(1);
    const parsed = parseDotenv(merged);
    expect(parsed.DATABASE_URL).toBe(V[0].value);
    expect(parsed.STRIPE_KEY).toBe(V[1].value);
    expect(parsed.NODE_ENV).toBe('production');
  });

  test('original → deploy → remove === original, LF, no pre-existing shadow', () => {
    const original = 'NODE_ENV=production\n# note\nPORT=3000\n';
    expect(removeOk(mergeOk(original, V))).toBe(original);
  });

  test('original → deploy → remove === original, CRLF', () => {
    const original = 'NODE_ENV=production\r\nPORT=3000\r\n';
    expect(removeOk(mergeOk(original, V))).toBe(original);
  });

  test('original → deploy → remove === original, with a shadowed active line for a delivered name', () => {
    const original = 'STRIPE_KEY=stale\nNODE_ENV=production\n';
    const merged = mergeOk(original, V);
    expect(merged).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=stale`);
    expect(removeOk(merged)).toBe(original);
  });

  test('original → deploy → remove === original, with the SAME name appearing twice outside', () => {
    const original = 'STRIPE_KEY=first\nOTHER=x\nSTRIPE_KEY=second\n';
    const merged = mergeOk(original, V);
    expect(removeOk(merged)).toBe(original);
  });

  test('original → deploy → remove === original, block already present (redeploy), values changed', () => {
    const original = 'NODE_ENV=production\n';
    const firstDeploy = mergeOk(original, V);
    const secondDeploy = mergeOk(firstDeploy, [{ name: 'DATABASE_URL', value: 'a-new-value' }, { name: 'STRIPE_KEY', value: 'sk_test_new_999' }]);
    expect(secondDeploy.split('\n').filter((l) => l === MANAGED_BEGIN)).toHaveLength(1);
    expect(removeOk(secondDeploy)).toBe(original);
  });

  test('block at the very end of the file, nothing after it — round trips', () => {
    const original = 'A=1\nB=2';
    expect(removeOk(mergeOk(original, V))).toBe(original);
  });

  test('a multi-line quoted value outside the block, for an undelivered name, survives the whole round trip untouched', () => {
    const original = ['CERT="-----BEGIN-----', 'abc123', '-----END-----"', 'NODE_ENV=production'].join('\n') + '\n';
    const merged = mergeOk(original, V);
    expect(merged).toContain('CERT="-----BEGIN-----\nabc123\n-----END-----"');
    expect(removeOk(merged)).toBe(original);
  });

  test('redeploy adjusts commented lines as the delivered set changes: a dropped name is un-commented, a newly-delivered one is commented', () => {
    const original = 'STRIPE_KEY=stale\nDATABASE_URL=stale-too\nNODE_ENV=production\n';
    // First deploy delivers only DATABASE_URL.
    const first = mergeOk(original, [{ name: 'DATABASE_URL', value: 'v1' }]);
    expect(first).toContain(`${CAPY_OFF_MARKER}DATABASE_URL=stale-too`);
    expect(first).toContain('STRIPE_KEY=stale\n'); // untouched — not yet delivered
    // Second deploy switches to delivering only STRIPE_KEY.
    const second = mergeOk(first, [{ name: 'STRIPE_KEY', value: 'v2' }]);
    expect(second).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=stale`);
    expect(second).toContain('DATABASE_URL=stale-too\n'); // un-commented — no longer delivered
    expect(second).not.toContain(`${CAPY_OFF_MARKER}DATABASE_URL`);
  });

  test('migration: an env holding an OLD blob-style Capy block is replaced cleanly by the new plain-value block', () => {
    const oldBlobEnv = [
      'NODE_ENV=production',
      MANAGED_BEGIN,
      '_SECRETS_BLOB=old-blob-not-real',
      '_PROJECT_KEY=' + 'ab'.repeat(32),
      MANAGED_END,
    ].join('\n');
    const merged = mergeOk(oldBlobEnv, V);
    expect(merged).not.toContain('_SECRETS_BLOB');
    expect(merged).not.toContain('old-blob-not-real');
    expect(merged.split('\n').filter((l) => l === MANAGED_BEGIN)).toHaveLength(1);
    const parsed = parseDotenv(merged);
    expect(parsed.DATABASE_URL).toBe(V[0].value);
    expect(parsed.STRIPE_KEY).toBe(V[1].value);
  });

  test('migration: targets-remove (removeManagedValuesBlock) fully removes the OLD blob block too', () => {
    const oldBlobEnv = [
      'NODE_ENV=production',
      MANAGED_BEGIN,
      '_SECRETS_BLOB=old-blob-not-real',
      '_PROJECT_KEY=' + 'cd'.repeat(32),
      MANAGED_END,
    ].join('\n');
    expect(removeOk(oldBlobEnv)).toBe('NODE_ENV=production');
  });

  test('an unrepresentable value refuses the write and reports which name — never a lossy partial write', () => {
    const bad = "' and " + '\u0060' + ' and " and a literal \\n';
    const r = mergeManagedValuesBlock('NODE_ENV=production', [{ name: 'BAD_VAR', value: bad }]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.problem.code !== 'malformed_block') {
      expect(r.problem.problems.map((p) => p.name)).toEqual(['BAD_VAR']);
    }
  });

  test('a malformed (edited/duplicated) block refuses cleanly, same as the pair-based mergeManagedBlock', () => {
    const r = mergeManagedValuesBlock(`${MANAGED_BEGIN}\nA=1`, V);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.code).toBe('malformed_block');
  });

  test('a value containing a literal ${{ is refused before any write — never resolved by Dokploy on Capy’s behalf', () => {
    const r = mergeManagedValuesBlock('NODE_ENV=production', [
      { name: 'DATABASE_URL', value: 'postgres://real' },
      { name: 'SNEAKY', value: '${{project.OTHER}}' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.problem.code !== 'malformed_block') {
      expect(r.problem.problems).toEqual([{ name: 'SNEAKY', code: 'DOKPLOY_VALUE_HAS_REFERENCE' }]);
    }
  });
});

// ── describeDokployPlainMergeProblem: mixed-problem grouping ───────────────

describe('describeDokployPlainMergeProblem', () => {
  test('groups a mix of DOKPLOY_VALUE_HAS_REFERENCE and DOKPLOY_VALUE_UNREPRESENTABLE, naming every variable, under the DOKPLOY_VALUE_INVALID umbrella code', () => {
    const bad = "' and " + '`' + ' and " and a literal \\n';
    const r = mergeManagedValuesBlock('NODE_ENV=production', [
      { name: 'REF_VAR', value: '${{project.OTHER}}' },
      { name: 'BAD_VAR', value: bad },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const described = describeDokployPlainMergeProblem(r.problem);
    expect(described.reason).toContain('REF_VAR');
    expect(described.reason).toContain('BAD_VAR');
    expect(described.hint).toContain('REF_VAR');
    expect(described.hint).toContain('BAD_VAR');
    // Mixed problem set — neither specific code alone would correctly
    // describe every variable, so the umbrella code is reported instead of
    // omitting one (Rule 5: always a real, stable code).
    expect(described.code).toBe('DOKPLOY_VALUE_INVALID');
  });

  test('grammar: singular vs. plural "contains"/"contain" for the reference-value reason', () => {
    const oneRef = mergeManagedValuesBlock('NODE_ENV=production', [{ name: 'REF_VAR', value: '${{project.OTHER}}' }]);
    if (oneRef.ok) throw new Error('expected a refusal');
    expect(describeDokployPlainMergeProblem(oneRef.problem).reason).toContain('REF_VAR contains a literal');

    const twoRefs = mergeManagedValuesBlock('NODE_ENV=production', [
      { name: 'REF_ONE', value: '${{project.A}}' },
      { name: 'REF_TWO', value: '${{project.B}}' },
    ]);
    if (twoRefs.ok) throw new Error('expected a refusal');
    expect(describeDokployPlainMergeProblem(twoRefs.problem).reason).toContain('REF_ONE, REF_TWO contain a literal');
  });

  test('a single-reason refusal DOES carry the matching code', () => {
    const r1 = mergeManagedValuesBlock('NODE_ENV=production', [{ name: 'REF_VAR', value: '${{project.OTHER}}' }]);
    if (r1.ok) throw new Error('expected a refusal');
    expect(describeDokployPlainMergeProblem(r1.problem).code).toBe('DOKPLOY_VALUE_HAS_REFERENCE');

    const bad = "' and " + '`' + ' and " and a literal \\n';
    const r2 = mergeManagedValuesBlock('NODE_ENV=production', [{ name: 'BAD_VAR', value: bad }]);
    if (r2.ok) throw new Error('expected a refusal');
    expect(describeDokployPlainMergeProblem(r2.problem).code).toBe('DOKPLOY_VALUE_UNREPRESENTABLE');
  });
});

// ── Seeded fuzz test: never lossy, over a large random sample ──────────────
//
// A deterministic PRNG (mulberry32, fixed seed) generates several thousand
// random strings from an alphabet chosen to hit every corner formatDotenvValue
// cares about: all three quote characters, backslash, the letters n/r (for
// literal backslash-n/backslash-r sequences), a real newline, space, #, $,
// { and } (for ${{ references), =, a plain letter, and a tab. Every one of
// them must EITHER round-trip exactly through dotenv.parse OR be refused —
// never written lossy. Deterministic: a failure here always reproduces.
//
// Written functionally throughout (Rule 1: no `let`, no mutation) — one
// pure step function threaded via `reduce`, never a closure over a
// reassigned seed variable.

/** One mulberry32 step: `state` in, `{value, next}` out — no mutation, the state itself is the only thing threaded forward. */
function mulberry32Step(state: number): { value: number; next: number } {
  const s = (state + 0x6d2b79f5) | 0;
  const t1 = Math.imul(s ^ (s >>> 15), 1 | s);
  const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
  const value = ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  return { value, next: s };
}

/**
 * `count` pseudo-random floats in [0, 1), deterministic from `seed`. mulberry32's
 * state only ever advances by the constant 0x6d2b79f5, so the state before draw
 * `k` is `(seed + k * 0x6d2b79f5) | 0` and every draw can be computed from its
 * index directly: the same sequence as threading the state step by step, in
 * linear time and with no accumulator. (`k * 0x6d2b79f5` stays well inside
 * 2^53 for any count used here, so `| 0` wraps it exactly.)
 */
function randomSequence(seed: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_, k) => mulberry32Step((seed + k * 0x6d2b79f5) | 0).value);
}

const FUZZ_ALPHABET = ["'", '"', '`', '\\', 'n', 'r', '\n', ' ', '#', '$', '{', '}', '=', 'a', '\t'] as const;
/** Random draws consumed per fuzz value: 1 to pick a length, the rest as candidate characters (unused tail draws are simply sliced off). */
const FUZZ_MAX_LEN = 24;
const FUZZ_STRIDE = FUZZ_MAX_LEN + 1;

/** One fuzz value from its own fixed-size slice of the shared draw sequence — pure, no shared mutable index. */
function fuzzValueFromDraws(draws: readonly number[]): string {
  const len = Math.floor(draws[0] * FUZZ_MAX_LEN);
  return draws
    .slice(1, 1 + len)
    .map((d) => FUZZ_ALPHABET[Math.floor(d * FUZZ_ALPHABET.length)])
    .join('');
}

/** `count` deterministic fuzz values from one seed — each consumes its own fixed-stride slice of one flat draw sequence. */
function fuzzCases(seed: number, count: number): readonly string[] {
  const draws = randomSequence(seed, count * FUZZ_STRIDE);
  return Array.from({ length: count }, (_, i) => fuzzValueFromDraws(draws.slice(i * FUZZ_STRIDE, (i + 1) * FUZZ_STRIDE)));
}

type FuzzOutcome = { kind: 'refused' } | { kind: 'roundtrip'; exact: boolean };

describe('formatDotenvValue — seeded fuzz: never lossy', () => {
  test('3000 deterministic random values each either round-trip exactly or are refused', () => {
    const cases = fuzzCases(0xc0ffee, 3000);
    const outcomes: readonly FuzzOutcome[] = cases.map((value) => {
      const rendered = formatDotenvValue(value);
      if (!rendered.ok) return { kind: 'refused' };
      const parsed = parseDotenv(`V=${rendered.rendered}`);
      return { kind: 'roundtrip', exact: parsed.V === value };
    });
    const lossy = outcomes.filter((o) => o.kind === 'roundtrip' && !o.exact);
    expect(lossy).toEqual([]);
    // Sanity: the alphabet is adversarial enough that BOTH outcomes actually
    // happen — a fuzz test that only ever hits one branch isn't testing much.
    expect(outcomes.some((o) => o.kind === 'roundtrip' && o.exact)).toBe(true);
    expect(outcomes.some((o) => o.kind === 'refused')).toBe(true);
  });
});

// ── mismatchedDeliveredValues: the read-back check ──────────────────────────

describe('mismatchedDeliveredValues', () => {
  test('empty when every delivered value reads back exactly', () => {
    const V = [{ name: 'A', value: 'one' }, { name: 'B', value: 'two' }];
    const env = mergeOk('NODE_ENV=production', V);
    expect(mismatchedDeliveredValues(env, V)).toEqual([]);
  });

  test('names the variable(s) whose stored value does not match, never the value itself', () => {
    const env = mergeOk('NODE_ENV=production', [{ name: 'A', value: 'correct' }]);
    const mismatched = mismatchedDeliveredValues(env, [{ name: 'A', value: 'wrong' }]);
    expect(mismatched).toEqual(['A']);
  });

  test('a name absent from the stored env entirely is also reported as mismatched', () => {
    const env = 'NODE_ENV=production';
    expect(mismatchedDeliveredValues(env, [{ name: 'MISSING', value: 'x' }])).toEqual(['MISSING']);
  });
});
