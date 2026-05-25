import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import * as os from 'os';
import { join } from 'path';

// Pin HOME and CWD to per-suite tmpdirs BEFORE the modules under test resolve
// paths via os.homedir(). Note: os.homedir() does NOT read process.env.HOME
// dynamically — it caches at process start — so setting process.env.HOME is
// not enough. We mock the os module to override homedir() with our test
// path. mock.module() is process-wide; this file is in ISOLATED_FILES in
// run-tests.sh, so the override doesn't leak into other suites.
const TEST_HOME = mkdtempSync(join(os.tmpdir(), 'capy-cleanup-test-'));
const TEST_CWD = mkdtempSync(join(os.tmpdir(), 'capy-cleanup-cwd-'));
mock.module('os', () => ({
  ...os,
  homedir: () => TEST_HOME,
}));
const ORIGINAL_CWD = process.cwd();
process.chdir(TEST_CWD);

const ORG_ID = 'org-internal-uuid-1234';
const USER_ID = 'user_01ABC';
const OTHER_USER_ID = 'user_01OTHER';

let cleanupOrgData: (orgId: string, userId?: string) => void;

beforeAll(async () => {
  // Dynamic import after the os.homedir() mock so globalConfig resolves
  // paths against our test home, not the user's real ~/.capy.
  ({ cleanupOrgData } = await import('../../src/cleanup/orgCleanup'));
});

interface Fixture {
  keyPath: string;
  userDir: string;
  orgDir: string;
  siblingKeyPath: string;
  cachePath: string;
  keepPath: string;
}

function fixtureSetup(): Fixture {
  const orgDir = join(TEST_HOME, '.capy', 'orgs', ORG_ID);
  const userDir = join(orgDir, 'users', USER_ID);
  mkdirSync(userDir, { recursive: true });
  const keyPath = join(userDir, 'key.enc');
  writeFileSync(keyPath, JSON.stringify({
    version: '1.0', org_id: ORG_ID, encrypted_master_key: 'fake-blob',
  }));
  // Sibling user's key.enc — verifies multi-user isolation: a kick of one
  // user must not affect another in the same org.
  const siblingDir = join(orgDir, 'users', OTHER_USER_ID);
  mkdirSync(siblingDir, { recursive: true });
  const siblingKeyPath = join(siblingDir, 'key.enc');
  writeFileSync(siblingKeyPath, JSON.stringify({
    version: '1.0', org_id: ORG_ID, encrypted_master_key: 'sibling-blob',
  }));
  // Project key cache — derived artifact, recomputable on next sync.
  const cacheDir = join(orgDir, 'projects', 'proj-1');
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'key.cache');
  writeFileSync(cachePath, 'deadbeef');

  const keepPath = join(TEST_CWD, 'keep.lock');
  writeFileSync(keepPath, JSON.stringify({ org_id: ORG_ID, project_id: 'proj-1', variables: {} }));

  return { keyPath, userDir, orgDir, siblingKeyPath, cachePath, keepPath };
}

describe('cleanupOrgData — destructive on confirmed kick, preserves siblings', () => {
  beforeEach(() => {
    rmSync(join(TEST_HOME, '.capy'), { recursive: true, force: true });
    const keep = join(TEST_CWD, 'keep.lock');
    if (existsSync(keep)) rmSync(keep);
  });

  afterEach(() => {
    rmSync(join(TEST_HOME, '.capy'), { recursive: true, force: true });
    const keep = join(TEST_CWD, 'keep.lock');
    if (existsSync(keep)) rmSync(keep);
  });

  // ── Destructive side: this user's per-org state goes ──────────────────

  test('DELETES the kicked user\'s wrapped master key', () => {
    const { keyPath } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(keyPath)).toBe(false);
  });

  test('DELETES the kicked user\'s per-org user dir', () => {
    const { userDir } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(userDir)).toBe(false);
  });

  test('DELETES the project key cache under this org (derived artifact)', () => {
    const { cachePath } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(cachePath)).toBe(false);
  });

  test('removes keep.lock when present', () => {
    const { keepPath } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(keepPath)).toBe(false);
  });

  // ── Preservation side: siblings stay intact ───────────────────────────

  test('PRESERVES a sibling user\'s key.enc in the same org', () => {
    const { siblingKeyPath } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(siblingKeyPath)).toBe(true);
  });

  test('PRESERVES the org dir when a sibling user still has membership state', () => {
    const { orgDir } = fixtureSetup();
    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(orgDir)).toBe(true);
  });

  test('CLEANS UP the empty org dir when no sibling users remain', () => {
    // Same as fixtureSetup but without the sibling user — kicked user is
    // the only one on this machine. The org dir should go too.
    const orgDir = join(TEST_HOME, '.capy', 'orgs', ORG_ID);
    const userDir = join(orgDir, 'users', USER_ID);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'key.enc'), 'fake');

    cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(orgDir)).toBe(false);
  });

  // ── Defensive: callable with no userId, no keep.lock, etc. ────────────

  test('is a no-op when keep.lock is absent (does not throw)', () => {
    fixtureSetup();
    rmSync(join(TEST_CWD, 'keep.lock'));
    expect(() => cleanupOrgData(ORG_ID, USER_ID)).not.toThrow();
  });

  test('does not touch user dirs when userId is undefined (safety net)', () => {
    // The gate at the call site ALWAYS passes a userId on confirmed kicks,
    // but cleanupOrgData should fail closed if a caller forgets.
    const { keyPath, siblingKeyPath } = fixtureSetup();
    cleanupOrgData(ORG_ID, undefined);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(siblingKeyPath)).toBe(true);
  });
});

afterAll(() => {
  // Restore process state so other tests in the same bun run aren't affected.
  process.chdir(ORIGINAL_CWD);
  rmSync(TEST_HOME, { recursive: true, force: true });
  rmSync(TEST_CWD, { recursive: true, force: true });
});
