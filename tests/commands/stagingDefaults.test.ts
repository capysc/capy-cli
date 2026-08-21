import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dir, '../../bin/capy-staging');
const SOURCE = readFileSync(BIN, 'utf8');

const STAGING_API = 'https://staging-api.capy.sc';
const STAGING_KEEP = 'https://staging-keep.capy.sc';
const EXPECTED_STATE_DIR = join(homedir(), '.capy-staging');

/**
 * `capy-staging doctor --json` under a hostile environment.
 *
 * doctor is read-only and local, so this never touches the network. The env is
 * built fresh per call rather than mutated, and PATH/HOME are carried through
 * so the child resolves node the same way the parent did.
 */
const doctorUnder = (hostile: Record<string, string>) => {
  const result = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...hostile,
      // Never let a test's flow auto-commit into this repo.
      CAPY_NO_AUTOCOMMIT: '1',
    },
  });

  if (result.status !== 0) {
    throw new Error(`capy-staging doctor exited ${result.status}: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
};

test('capy-staging pins both origins and its isolated state dir', () => {
  const report = doctorUnder({});

  expect(report.origins.api).toBe(STAGING_API);
  expect(report.origins.keep).toBe(STAGING_KEEP);
  expect(report.stateDir).toBe(EXPECTED_STATE_DIR);
});

test('CAPY_API_URL and CAPY_KEEP_ORIGIN cannot repoint capy-staging at prod', () => {
  const report = doctorUnder({
    CAPY_API_URL: 'https://api.capy.sc',
    CAPY_KEEP_ORIGIN: 'https://keep.capy.sc',
  });

  expect(report.origins.api).toBe(STAGING_API);
  expect(report.origins.keep).toBe(STAGING_KEEP);
});

test('the two origins cannot be split apart', () => {
  // The drift that 06a22cb fixed: a staging-backed CLI on the prod keep origin
  // mints a device key under the wrong WebAuthn RP ID, leaving a door row
  // nothing can satisfy. Setting either alone must move neither.
  const apiOnly = doctorUnder({ CAPY_API_URL: 'https://api.capy.sc' });
  expect(apiOnly.origins.api).toBe(STAGING_API);
  expect(apiOnly.origins.keep).toBe(STAGING_KEEP);

  const keepOnly = doctorUnder({ CAPY_KEEP_ORIGIN: 'https://keep.capy.sc' });
  expect(keepOnly.origins.api).toBe(STAGING_API);
  expect(keepOnly.origins.keep).toBe(STAGING_KEEP);
});

test('CAPY_GLOBAL_DIR_NAME cannot point capy-staging at prod state', () => {
  // ~/.capy holds recovery-equivalent wrapped keys; staging must never read or
  // write it, whatever the caller exports.
  const report = doctorUnder({ CAPY_GLOBAL_DIR_NAME: '.capy' });

  expect(report.stateDir).toBe(EXPECTED_STATE_DIR);
});

test('CAPY_PROFILE cannot repoint capy-staging', () => {
  const report = doctorUnder({ CAPY_PROFILE: 'prod' });

  expect(report.origins.api).toBe(STAGING_API);
  expect(report.origins.keep).toBe(STAGING_KEEP);
});

test('capy-staging assigns unconditionally — no when-unset guards', () => {
  // The regression this whole file exists to catch: reintroducing
  // `if (!process.env.X)` turns the pin back into an overridable default.
  expect(SOURCE).not.toContain('if (!process.env');
  expect(SOURCE).toContain(`CAPY_API_URL: '${STAGING_API}'`);
  expect(SOURCE).toContain(`CAPY_KEEP_ORIGIN: '${STAGING_KEEP}'`);
});

test('capy-staging bakes in the four portability rollout flags', () => {
  // Without these the staging entrypoint cannot exercise the onboarding flow,
  // which is the reason it exists.
  const flags = ['CAPY_FLOW_ONBOARD', 'CAPY_DEVICE_KEYS', 'CAPY_KEEP_SCREENS', 'CAPY_KEEP_LOGIN_BRIDGE'];

  for (const flag of flags) {
    expect(SOURCE).toContain(`${flag}: '1'`);
  }
});

test('capy-staging runs the production codepath, not the mock-auth dev build', () => {
  expect(SOURCE).toContain("require('../dist/index.js')");
  // Not a bare 'index-dev' search: the file's own header explains why it does
  // NOT use index-dev.js, so only the require target is meaningful here.
  expect(SOURCE).not.toContain("require('../dist/index-dev.js')");
});

// ---------------------------------------------------------------------------
// The pin lives in the resolvers, not in the shim's env assignments.
// ---------------------------------------------------------------------------

/**
 * A bare entrypoint that sets NO environment at all — the filename is the only
 * signal. If the pin still holds through this, it is `isStagingEntrypoint()`'s
 * early return doing the work and not bin/capy-staging's env writes.
 */
const bareEntrypoint = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'capy-pin-'));
  const file = join(dir, name);
  const dist = resolve(import.meta.dir, '../../dist/index.js');

  writeFileSync(file, `#!/usr/bin/env node\nrequire(${JSON.stringify(dist)});\n`);
  return file;
};

const doctorFrom = (entrypoint: string, hostile: Record<string, string>) => {
  const result = spawnSync(process.execPath, [entrypoint, 'doctor', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...hostile, CAPY_NO_AUTOCOMMIT: '1' },
  });

  if (result.status !== 0) {
    throw new Error(`doctor exited ${result.status}: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
};

test('the pin holds with no env assignments — the resolver, not the shim', () => {
  const report = doctorFrom(bareEntrypoint('capy-staging'), {
    CAPY_API_URL: 'https://api.capy.sc',
    CAPY_KEEP_ORIGIN: 'https://keep.capy.sc',
    CAPY_GLOBAL_DIR_NAME: '.capy',
  });

  expect(report.origins.api).toBe(STAGING_API);
  expect(report.origins.keep).toBe(STAGING_KEEP);
  expect(report.stateDir).toBe(EXPECTED_STATE_DIR);
});

test('the pin does NOT leak into the production entrypoint', () => {
  // The same bytes under a different name must resolve normally. Without this,
  // the early return could silently pin prod too.
  const report = doctorFrom(bareEntrypoint('capy'), { CAPY_API_URL: 'https://api.capy.sc' });

  expect(report.origins.api).toBe('https://api.capy.sc');
  expect(report.stateDir).not.toBe(EXPECTED_STATE_DIR);
});
