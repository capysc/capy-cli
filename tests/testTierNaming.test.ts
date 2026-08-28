/**
 * The filename has to tell the truth about what the test needs to run.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * This package carried NINE files named `*.e2e.test.ts`, all of which ran on
 * every commit inside `run-tests.sh`, and none of which touched a live system:
 * they spawn the real built CLI against fake services. Good tests, wrong label.
 *
 * The cost was not cosmetic. "the E2E tests pass" and "the E2E tests ran" meant
 * different things depending on who said them — the genuinely live suite lives
 * in the monorepo (`bun run tests/e2e/e2e.ts`) and is run separately. A green
 * `run-tests.sh` could therefore be offered, honestly and wrongly, as evidence
 * that an end-to-end path had been exercised against staging.
 *
 * THE TAXONOMY THIS ENFORCES
 * ---------------------------------------------------------------------------
 *   *.test.ts          unit — no process spawned
 *   *.int.test.ts      integration — real code paths, real spawned CLI, but
 *                      every boundary faked. Runs on every commit.
 *   *.browser.test.ts  as above, and additionally drives a real headless
 *                      browser over CDP. Skips itself when no cached
 *                      chrome-headless-shell is present.
 *   *.e2e.*            RESERVED for tests that require live systems. There are
 *                      none in this package; they belong in the monorepo.
 *
 * `.browser.` is separate from `.int.` on purpose: those tests need a binary
 * that is not in this repo and not in `bun install`, so a run that silently
 * skipped them would otherwise be indistinguishable from one that passed them.
 *
 * WHY A TEST RATHER THAN A LINE IN THE SHELL SCRIPT
 * ---------------------------------------------------------------------------
 * The rename fixes today. This is what stops it drifting back: `run-tests.sh`
 * guards the scripted path, but anyone can type `bun test`, and CI can grow a
 * second entrypoint. The rule travels with the test suite instead.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TESTS_ROOT = resolve(import.meta.dir);

/** Every file under tests/, recursively. */
function allFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) return [];
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

describe('test tier naming', () => {
  test('no `.e2e.` file runs in the default suite — that suffix means live systems', () => {
    const offenders = allFiles(TESTS_ROOT)
      .filter((f) => /\.e2e\./.test(f))
      .map((f) => f.slice(TESTS_ROOT.length + 1));

    expect(
      offenders,
      `These files claim the \`.e2e.\` tier but run on every commit:\n` +
        offenders.map((o) => `  ${o}`).join('\n') +
        `\n\n\`.e2e.\` is reserved for tests that require LIVE systems — staging, a real ` +
        `service, a real provider. A test that spawns the real CLI against a fake ` +
        `boundary is \`.int.\`; one that also drives a real browser is \`.browser.\`. ` +
        `Live end-to-end tests belong in the monorepo (\`bun run tests/e2e/e2e.ts\`), ` +
        `not here. Rename the file, or move it to where its tier is actually run.`,
    ).toEqual([]);
  });

  test('CONTROL: this scan can see files at all', () => {
    // An empty offenders list is the passing state above, which is exactly the
    // result a broken scan produces. If this directory walk ever returns
    // nothing, the assertion above is vacuous and this catches it.
    const files = allFiles(TESTS_ROOT);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('.int.test.ts'))).toBe(true);
  });
});
