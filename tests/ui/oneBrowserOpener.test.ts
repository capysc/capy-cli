/**
 * `open` is imported in exactly one file.
 *
 * WHY THIS EXISTS, and it is not a style rule. The popup-vs-tab decision was
 * consolidated into `openScreen` on the strength of a grep that found four
 * call sites. There were seven. Three of them — `endingPage`, `syncScreens`,
 * `memberScreens` — import `open` dynamically inside a function, so a search
 * for import statements at the top of a file misses them completely, and every
 * ending page, both sync reports and the invite result went on opening as
 * ordinary tabs while the commit message said they did not.
 *
 * Nothing failed. Nothing could have: a browser opening the right URL in the
 * wrong kind of window is invisible to every test that checks what the page
 * says. The only thing that catches it is counting the importers, which is
 * what this does.
 *
 * A source-level assertion, because the property IS about the source: "there
 * is one place where this decision is made" cannot be observed at runtime from
 * inside the process that made it.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../src');

/** The one file allowed to reach for the `open` package. */
const OPENER = 'ui/openScreen.ts';

/**
 * Both shapes an import of the `open` PACKAGE can take, and both are needed.
 *
 * `import open from 'open'` — how `oauthServer` had it.
 * `await import('open')` — how the three that hid had it.
 *
 * The quotes are anchored so `'./openScreen'` and `'opener'` are not hits.
 */
const IMPORTS_OPEN = /(?:from|import\s*\(|require\s*\()\s*['"]open['"]/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('one place decides how a browser window opens', () => {
  test('only openScreen.ts imports the `open` package', () => {
    const importers = tsFiles(SRC)
      .filter((file) => IMPORTS_OPEN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(
      importers,
      `Every browser window in the CLI opens through \`openScreen\`, which is what ` +
        `decides between a chromeless dialog and a full window with an address bar. ` +
        `A file that imports \`open\` directly has quietly opted out of that decision ` +
        `and will serve its page as a plain tab. Call \`openScreen(url, {kind})\` instead.`,
    ).toEqual([OPENER]);
  });

  test('the detector sees both import shapes, and is not fooled by a lookalike', () => {
    // The first version of this file only matched the dynamic form, so it
    // passed while `oauthServer` held a static `import open from 'open'`. A
    // guard whose detector is wrong is worse than no guard: it reports clean.
    for (const shape of [
      `import open from 'open';`,
      `const open = (await import('open')).default;`,
      `const open = require('open');`,
      `import openDefault from "open";`,
    ]) {
      expect(IMPORTS_OPEN.test(shape), shape).toBe(true);
    }
    for (const innocent of [
      `import { openScreen } from './openScreen';`,
      `import { openSync } from 'node:fs';`,
      `// the printed URL is what you open`,
      `import opener from 'opener';`,
    ]) {
      expect(IMPORTS_OPEN.test(innocent), innocent).toBe(false);
    }
  });
});
