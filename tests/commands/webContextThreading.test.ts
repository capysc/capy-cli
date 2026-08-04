/**
 * `--web` has to reach the HELPERS too, not just the command handler.
 *
 * `webFlagWiring.test.ts` guards the first hop: the action handler reads `web`
 * off `optsWithGlobals()`. That hop was green for `capy rotate` the whole time
 * the bug below was live, because the handler does read the flag — and then
 * calls a helper without it.
 *
 * `ensureDeployTarget(cwd, web)` branches on its second argument twice:
 * `pickTargetInBrowser` when several targets are saved, and `runPicker(…, web)`
 * when none is, which serves the adapter → branch → settings → variables →
 * delivery → name route through `setUpDeployTargetInBrowser`. The parameter
 * defaults to `{}`. So `ensureDeployTarget(process.cwd())` type-checks, runs,
 * skips every browser branch, and stops on an inquirer `Where are you
 * deploying?` — in a flow whose entire reason for existing is that nobody is
 * reading the terminal.
 *
 * Nothing failed. `deployWebFlow.test.ts` covers the web path thoroughly, but
 * it calls `ensureDeployTarget(ROOT, { web: true })` directly, so it proves the
 * destination works while saying nothing about whether anyone drives there.
 * That is the shape of this whole class of bug: a built, tested, unreachable
 * screen. The gap is in the wiring, and the wiring is what this file reads.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');

/**
 * Helpers that take a web context and silently no-op without one, mapped to the
 * command sources that must hand them one. Add a row when a helper grows a
 * `WebContext` parameter with a default — the default is the hazard.
 */
const THREADED: Array<{ helper: string; callers: string[] }> = [
  { helper: 'ensureDeployTarget', callers: ['src/commands/rotateCommand.ts'] },
];

/**
 * Does every call to `helper` pass a second argument?
 *
 * Deliberately counts arguments rather than looking for the word `web`: the
 * caller may pass a variable, an object literal, or a ternary, and a check that
 * only recognised one spelling would go quietly green on the others. What makes
 * the call wrong is that there is nothing in the second position at all.
 */
function everyCallPassesContext(source: string, helper: string): boolean {
  // `await helper(` … matching to the closing paren of the call, shallowly:
  // these call sites take `process.cwd()` first, so one level of nesting has to
  // survive. Anything deeper is not a shape this codebase writes.
  const re = new RegExp(`\\b${helper}\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)`, 'g');
  const calls = [...source.matchAll(re)];
  if (calls.length === 0) return false;
  return calls.every((m) => {
    // Split on top-level commas only — `process.cwd()` has none, but a future
    // first argument might.
    let depth = 0;
    for (const ch of m[1]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) return true;
    }
    return false;
  });
}

describe('--web reaches the helpers that serve the screens', () => {
  for (const { helper, callers } of THREADED) {
    for (const caller of callers) {
      test(`${caller} passes a web context to ${helper}()`, () => {
        const source = readFileSync(join(CLI_ROOT, caller), 'utf8');
        expect(
          everyCallPassesContext(source, helper),
          `${caller} calls \`${helper}()\` with no web context. The parameter ` +
            `defaults to \`{}\`, so every browser branch inside is skipped and the ` +
            `run stops on a TTY prompt instead of serving a screen. Pass ` +
            `\`web ? { web: true } : {}\`.`,
        ).toBe(true);
      });
    }
  }

  test('the deploy-target gate admits --web, not just a TTY', () => {
    const source = readFileSync(join(CLI_ROOT, 'src/commands/rotateCommand.ts'), 'utf8');
    // `--web` exists because the caller is an agent, which is exactly the case
    // with no TTY. Gating the resolve on `isTTY` alone sent the intended caller
    // down the branch that resolves nothing and ships to no target.
    const gatedOnTtyAlone = /else if \(\s*isTTY\s*\)\s*\{[\s\S]{0,600}?ensureDeployTarget/.test(
      source,
    );
    expect(
      gatedOnTtyAlone,
      'rotate resolves its deploy target behind `else if (isTTY)`, so a `--web` ' +
        'run without a TTY skips resolution entirely. The gate needs `web || isTTY`.',
    ).toBe(false);
  });

  /**
   * The detector, against the line it was written to catch.
   *
   * Both source guards written in this codebase so far shipped with a detector
   * bug that made them report clean on the very code that prompted them — one
   * missed static imports, one missed `serverMsg?.includes(...)`. A guard that
   * cannot fail is worth less than no guard, because it is also a claim.
   */
  test('the detector rejects the pre-fix call and accepts the fixed one', () => {
    expect(everyCallPassesContext('await ensureDeployTarget(process.cwd());', 'ensureDeployTarget')).toBe(false);
    expect(
      everyCallPassesContext(
        'await ensureDeployTarget(process.cwd(), web ? { web: true } : {});',
        'ensureDeployTarget',
      ),
    ).toBe(true);
    // A helper that is never called must not read as "every call is fine".
    expect(everyCallPassesContext('nothing here', 'ensureDeployTarget')).toBe(false);
  });
});
