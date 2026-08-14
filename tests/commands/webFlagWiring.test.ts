/**
 * `--web` has to actually reach the command.
 *
 * It is declared ONCE, on the root program, so Commander binds it to the
 * global scope: a subcommand reading `options.web` gets `undefined` forever.
 * Every action handler has to read `command.optsWithGlobals().web` instead.
 *
 * The failure mode is SILENCE, which is why this file exists. `capy connect
 * --web` parses cleanly, is accepted, and then hands an agent a TTY prompt it
 * cannot answer — no error, no warning, nothing to grep for. Every reviewer of
 * the conversion work found it independently, each time by reading rather than
 * by anything failing.
 *
 * A source-level assertion rather than a behavioural one, deliberately: running
 * each command for real needs a session, a project and in some cases a
 * provider. What can be checked cheaply on every commit is that the wiring is
 * present at all, which is precisely what was missing.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');

/**
 * BOTH entrypoints, and the second one is why this file grew.
 *
 * `index-dev.ts` is what `capy-dev` runs, which is what every local run against
 * a dev service uses — including the MCP, whose README points `CAPY_BIN` at it
 * with `CAPY_API_URL=http://localhost:3001`. It had FIVE `optsWithGlobals`
 * calls to `index.ts`'s twenty, so `capy-dev rotate --web` parsed the flag,
 * accepted it, and prompted a TTY nobody was watching. This file checked only
 * `index.ts` and reported green throughout.
 *
 * A mirror that is only half-checked is worse than an unchecked one: the
 * checked half sets the expectation that both work.
 */
const ENTRYPOINTS = ['src/index.ts', 'src/index-dev.ts'] as const;
const SOURCE: Record<string, string> = Object.fromEntries(
  ENTRYPOINTS.map((f) => [f, readFileSync(join(CLI_ROOT, f), 'utf8')]),
);

/** The source of one `.command('name')` registration, up to its closing `});`. */
function commandBlock(entry: string, name: string): string {
  const re = new RegExp(`\\.command\\('${name}[^\\n]*\\n(?:.*?\\n)*?  \\}\\);\\n`);
  const m = SOURCE[entry].match(re);
  if (!m) throw new Error(`no registration for \`${name}\` in ${entry}`);
  return m[0];
}

/**
 * Which commands need the flag — DERIVED, never listed.
 *
 * The first version of this file carried a hand-written array of eleven
 * command names. It passed while `capy edit`, `capy decrypt` and `capy deploy`
 * sat unwired, because they were not in the array — a test whose coverage is a
 * list has exactly the blind spot it was written to close, and a reviewer
 * found the gap rather than the test doing it.
 *
 * So the list comes from the source: a command needs the flag when the command
 * class it constructs declares a `web` option. That cannot drift, and a newly
 * converted command is covered the moment it accepts one.
 */
function commandsNeedingWeb(entry: string): string[] {
  const need: string[] = [];
  for (const m of SOURCE[entry].matchAll(/\.command\('([a-z-]+)/g)) {
    const name = m[1];
    let block: string;
    try {
      block = commandBlock(entry, name);
    } catch {
      continue;
    }
    // The implementation is always a dynamic import inside the handler.
    const imp = block.match(/import\('\.\/commands\/([A-Za-z]+)'\)/);
    if (!imp) continue;
    const file = join(CLI_ROOT, `src/commands/${imp[1]}.ts`);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Two signals, because one was not enough and the gap was on the command
    // this matters most for. Declaring `web?: boolean` catches most; `rotate`
    // and `connect` take their options as `RotateOpts`/`ConnectOpts`, declared
    // over in `connectors/registry.ts`, so the declaration is not in the file
    // the registration imports — and both were invisible here while
    // `capy-dev rotate --web` silently prompted a TTY.
    //
    // READING `opts.web` is the signal that cannot hide: wherever the type
    // lives, a command that can serve a screen has to consult the flag.
    if (/\bweb\??:\s*boolean/.test(src) || /\bopts\.web\b/.test(src)) need.push(name);
  }
  return [...new Set(need)];
}

/**
 * Does this handler take `web` FROM the merged globals?
 *
 * Not "does it mention `optsWithGlobals`" — that is what this file used to ask,
 * and it is how `capy-dev connect stripe --web` shipped broken while this test
 * was green. That handler calls `optsWithGlobals()` for a different reason
 * entirely: the root program also declares `-f/--force`, so `--force` has to be
 * read from the merge. `web` was simply never taken off the result, and a
 * substring check for the call cannot tell the two apart.
 *
 * Both spellings in use are accepted: read straight through
 * (`command.optsWithGlobals().web`), or via the local alias the handlers that
 * also need `force` keep (`const merged = …; merged.web`).
 */
function readsWebFromGlobals(block: string): boolean {
  if (/optsWithGlobals\(\)\s*\.\s*web\b/.test(block)) return true;
  for (const m of block.matchAll(/const\s+(\w+)\s*=\s*[^;\n]*optsWithGlobals[^;]*;/g)) {
    if (new RegExp(`\\b${m[1]}\\s*\\.\\s*web\\b`).test(block)) return true;
  }
  return false;
}

/** One row per (entrypoint, command) so a failure names both. */
const CASES: Array<[string, string]> = ENTRYPOINTS.flatMap((entry) =>
  commandsNeedingWeb(entry).map((name) => [entry, name] as [string, string]),
);

describe('--web reaches the commands that can serve a screen', () => {
  test.each(CASES)('%s: %s threads the inherited flag', (entry, name) => {
    const block = commandBlock(entry, name);
    expect(
      readsWebFromGlobals(block),
      `\`${name} --web\` parses in ${entry} but the handler never reads \`web\` off ` +
        `the inherited globals, so the flag is silently dropped and the command ` +
        `prompts a TTY nobody is watching. Read \`command.optsWithGlobals().web\`.`,
    ).toBe(true);
  });

  test.each(ENTRYPOINTS)('%s declares the flag once, at the root', (entry) => {
    // A subcommand redeclaring `--web` binds it locally, which makes
    // `optsWithGlobals()` the wrong call for that one command — an
    // inconsistency invisible until someone runs exactly that flow.
    // `index-dev.ts` carried a second declaration on `add` for exactly as long
    // as nothing checked it.
    const declarations = SOURCE[entry].match(/\.option\('--web'/g) ?? [];
    expect(declarations, `${entry} should declare --web once`).toHaveLength(1);
  });

  test.each(CASES)('%s: %s does not read it off the local options', (entry, name) => {
    // `options.web` inside a subcommand is always undefined. It is an easy line
    // to write, it looks right, and it does nothing.
    const block = commandBlock(entry, name);
    expect(
      /\bweb:\s*options\.web\b/.test(block),
      `${entry}: \`${name}\` reads options.web, which a subcommand never receives.`,
    ).toBe(false);
  });

  test('the dev entrypoint covers what the production one does', () => {
    // The mirror-drift guard. `index-dev.ts` is not a subset by design — it is
    // meant to be the same CLI against a dev service — so a command that can
    // serve a screen in one and not the other is drift, not a decision.
    const prod = new Set(commandsNeedingWeb('src/index.ts'));
    const dev = new Set(commandsNeedingWeb('src/index-dev.ts'));
    const missing = [...prod].filter((c) => !dev.has(c) && SOURCE['src/index-dev.ts'].includes(`.command('${c}`));
    expect(
      missing,
      `these commands are registered in index-dev.ts and can serve a screen, but ` +
        `the dev entrypoint was not counted as needing the flag: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
