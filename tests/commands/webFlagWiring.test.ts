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

const INDEX = readFileSync(join(resolve(import.meta.dir, '../..'), 'src/index.ts'), 'utf8');

/** The source of one `.command('name')` registration, up to its closing `});`. */
function commandBlock(name: string): string {
  const re = new RegExp(`\\.command\\('${name}[^\\n]*\\n(?:.*?\\n)*?  \\}\\);\\n`);
  const m = INDEX.match(re);
  if (!m) throw new Error(`no registration found for \`capy ${name}\``);
  return m[0];
}

/**
 * Commands whose flow has a compiled screen behind it.
 *
 * `run` is absent on purpose — it wraps a child process and has no question to
 * ask, so it is the one command with no browser path by design.
 */
const WEB_CAPABLE = [
  'connect',
  'rotate',
  'org',
  'byoc',
  'invite',
  'kick',
  'recover',
  'end-recover',
  'transport',
  'checkout',
  'status',
];

describe('--web reaches the commands that can serve a screen', () => {
  test.each(WEB_CAPABLE)('capy %s threads the inherited flag', (name) => {
    const block = commandBlock(name);
    expect(
      block.includes('optsWithGlobals'),
      `\`capy ${name} --web\` parses but the handler never reads the inherited ` +
        `global, so the flag is silently dropped and the command prompts a TTY ` +
        `nobody is watching. Read \`command.optsWithGlobals().web\`.`,
    ).toBe(true);
  });

  test('the flag is declared once, at the root, and not shadowed per command', () => {
    // A subcommand redeclaring `--web` would bind it locally and make
    // `optsWithGlobals()` the wrong call for that one command — the kind of
    // inconsistency that is invisible until someone runs exactly that flow.
    const declarations = INDEX.match(/\.option\('--web'/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  test('reading it off the local options is not how any handler does it', () => {
    // `options.web` inside a subcommand is always undefined. It is an easy line
    // to write, it looks right, and it does nothing.
    for (const name of WEB_CAPABLE) {
      const block = commandBlock(name);
      expect(
        /\bweb:\s*options\.web\b/.test(block),
        `\`capy ${name}\` reads options.web, which a subcommand never receives.`,
      ).toBe(false);
    }
  });
});
