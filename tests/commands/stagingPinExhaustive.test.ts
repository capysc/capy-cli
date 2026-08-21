import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dir, '../../bin/capy-staging');
const SRC = resolve(import.meta.dir, '../../src');

const STAGING_API = 'https://staging-api.capy.sc';
const STAGING_KEEP = 'https://staging-keep.capy.sc';
const HOSTILE = 'https://api.capy.sc';

/**
 * Not a knob: a prefix, a marker, or an injected blob, none of which the
 * caller sets to steer origin resolution. Everything else in src is fair game.
 */
const NOT_AN_INPUT = new Set(['CAPY_DATA__', 'CAPY_EVENT_V1', 'CAPY_LOGO_SVG']);

/**
 * Every CAPY_* name src actually mentions, discovered at run time.
 *
 * Deriving the list instead of hardcoding it is the entire point: a new env
 * var added to the CLI is covered by this test the day it lands, with nobody
 * having to remember to extend a fixture. That is what turns "the vectors we
 * thought of" into "the vectors that exist".
 */
const discoverEnvNames = () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => !entry.endsWith('generated.ts'));

  const names = files.flatMap((entry) =>
    (readFileSync(join(SRC, entry), 'utf8').match(/CAPY_[A-Z0-9_]+/g) ?? []),
  );

  return [...new Set(names)].filter((name) => !NOT_AN_INPUT.has(name)).sort();
};

const doctorUnder = (name: string) =>
  spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, [name]: HOSTILE, CAPY_NO_AUTOCOMMIT: '1' },
  });

test('no CAPY_* env var can move capy-staging off its pinned target', () => {
  const names = discoverEnvNames();

  // A guard on the discovery itself: if the scan silently returns nothing,
  // every assertion below would vacuously pass.
  expect(names.length).toBeGreaterThan(15);
  expect(names).toContain('CAPY_API_URL');
  expect(names).toContain('CAPY_KEEP_ORIGIN');

  const moved = names.flatMap((name) => {
    const result = doctorUnder(name);

    // A refusal is an acceptable outcome — fail-closed is not a repoint. Only
    // "ran fine, pointed somewhere else" is the bug this test exists for.
    if (result.status !== 0) return [];

    const report = JSON.parse(result.stdout);
    const held =
      report.origins.api === STAGING_API &&
      report.origins.keep === STAGING_KEEP &&
      report.stateDir.endsWith('.capy-staging');

    if (held) return [];

    return [`${name} -> api=${report.origins.api} keep=${report.origins.keep} state=${report.stateDir}`];
  });

  expect(moved).toEqual([]);
}, 120_000);
