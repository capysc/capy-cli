/**
 * `capy` and `capy-dev` must register the SAME commands.
 *
 * They are one CLI pointed at two backends, and the divergence is silent in
 * both directions. `deploy targets` and `deploy targets-remove` existed on
 * `src/index.ts` and had never been added to `src/index-dev.ts`, so
 * `capy-dev deploy targets` resolved `targets` as a TARGET NAME and failed with
 * `No target named "targets"`. Nothing was red: the commands work, their
 * handlers are shared, and every test that covers them runs against the
 * production entrypoint.
 *
 * It surfaced through an MCP tool — `capy_deploy` with `action:"list-targets"`
 * shells `capy deploy targets`, which works in production and breaks under the
 * dev binary, which is the only one the sandbox flow ever runs. The contract
 * test for it was GREEN, because the fake capy in that suite had been taught to
 * accept the command the tool sends. A fake that agrees with your assumption
 * tests the assumption, not the CLI.
 *
 * SOURCE, not `--help`. Diffing the built binaries' help output is a stronger
 * check — it catches a registration that throws at startup — but it needs
 * `dist/`, which makes it a post-build step and moves it out of the suite that
 * runs on every change. This reads the two entrypoints directly, costs
 * milliseconds, and would have caught the bug above the moment it was written.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');

/**
 * Every command an entrypoint registers, as `"name"` or `"parent name"`.
 *
 * The owner of a `.command()` call is the nearest preceding non-blank,
 * non-comment line — `program` for a top-level command, or the variable a
 * sub-command group was assigned to (`deploy`, `profileCmd`). Nesting matters:
 * `deploy targets` and a hypothetical top-level `targets` are different
 * commands and must not compare equal.
 */
function registeredCommands(file: string): Set<string> {
  return commandsIn(readFileSync(join(CLI_ROOT, file), 'utf8'));
}

/** The same parse, over source TEXT — so the detector can be tested on itself. */
function commandsIn(source: string): Set<string> {
  const src = source.split('\n');
  const out = new Set<string>();
  src.forEach((line, i) => {
    const m = line.match(/\.command\('([a-z-]+)/);
    if (!m) return;
    let j = i - 1;
    while (j >= 0 && (!src[j].trim() || src[j].trim().startsWith('//') || src[j].trim().startsWith('*'))) j--;
    const owner = (src[j] ?? '').trim().replace(/[^a-zA-Z]/g, '');
    const group = /^program$|^programcommand/.test(owner)
      ? ''
      : owner === 'deploy'
        ? 'deploy '
        : owner.toLowerCase().includes('profile')
          ? 'profile '
          : `${owner} `;
    out.add(group + m[1]);
  });
  return out;
}

/**
 * The differences that are DELIBERATE.
 *
 * Every entry is a claim that this command has no business on the other
 * binary. Anything not listed here is drift, and the test says so by name —
 * adding to this list should feel like a decision, because it is one.
 */
const PROD_ONLY = new Set([
  // Commander's built-in, declared explicitly on the production program only.
  'help',
  // Local-only vault lock. Dev runs against a dev service, never a local vault.
  'lock',
]);

const DEV_ONLY = new Set([
  // Mock-auth decrypt path. Its whole purpose is bypassing real auth, which is
  // exactly what must never ship in the production binary.
  'auth-decrypt',
  // Screen workbench for developing the browser UI against fixtures.
  'ui-preview',
]);

describe('capy and capy-dev register the same commands', () => {
  const prod = registeredCommands('src/index.ts');
  const dev = registeredCommands('src/index-dev.ts');
  const missingFromDev = [...prod].filter((c) => !dev.has(c) && !PROD_ONLY.has(c)).sort();
  const missingFromProd = [...dev].filter((c) => !prod.has(c) && !DEV_ONLY.has(c)).sort();

  test('every production command exists on capy-dev', () => {
    expect(
      missingFromDev,
      `On \`capy\` but not \`capy-dev\`: ${missingFromDev.join(', ')}. A command missing from the dev ` +
        'entrypoint fails at RUNTIME with a confusing message rather than "unknown command" — a missing ' +
        'sub-command gets swallowed as a positional argument. Register it in src/index-dev.ts, or add it ' +
        'to PROD_ONLY with the reason it cannot exist in dev.',
    ).toEqual([]);
  });

  test('every capy-dev command exists on capy', () => {
    expect(
      missingFromProd,
      `On \`capy-dev\` but not \`capy\`: ${missingFromProd.join(', ')}. Either it is a dev-only escape ` +
        'hatch — add it to DEV_ONLY and say why it must never ship — or production is missing a command ' +
        'people have been using in dev.',
    ).toEqual([]);
  });

  test('the two binaries share a substantial surface, so a parse failure cannot pass silently', () => {
    // If the regex ever stops matching, both sets go empty and both assertions
    // above pass vacuously. This is the guard on the guard.
    const shared = [...prod].filter((c) => dev.has(c));
    expect(shared.length).toBeGreaterThan(25);
    expect(shared).toContain('deploy targets');
    expect(shared).toContain('rotate');
  });

  test('the detector catches the exact gap this file exists for', () => {
    // Not a synthetic string — the REAL production source with the two
    // `deploy targets` registrations cut out, which is precisely the state
    // src/index-dev.ts was in. A guard that cannot reproduce its own bug is a
    // claim rather than a check, and this codebase has shipped two of those.
    const prodSource = readFileSync(join(CLI_ROOT, 'src/index.ts'), 'utf8');
    const withoutTargets = prodSource
      .replace(/deploy\n  \.command\('targets'\)[\s\S]*?\n  \}\);\n/, '')
      .replace(/deploy\n  \.command\('targets-remove <name>'\)[\s\S]*?\n  \}\);\n/, '');
    const crippled = commandsIn(withoutTargets);
    expect(crippled.has('deploy targets')).toBe(false);
    expect(crippled.has('deploy targets-remove')).toBe(false);
    // …and everything else still parses, so the removal is what was detected
    // rather than the parse falling over.
    expect(crippled.has('deploy revoke')).toBe(true);
    expect(crippled.size).toBe(commandsIn(prodSource).size - 2);
  });

  test('the detector distinguishes a nested command from a top-level one', () => {
    // `deploy targets` must not compare equal to a top-level `targets`, or the
    // exact bug this file exists for would read as present on both sides.
    expect(prod.has('deploy targets')).toBe(true);
    expect(prod.has('targets')).toBe(false);
  });
});
