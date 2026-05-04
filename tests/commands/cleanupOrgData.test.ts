import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Pin HOME and CWD to per-suite tmpdirs BEFORE the modules under test capture
// homedir() at module load. We set the env vars then dynamically import.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'capy-cleanup-test-'));
const TEST_CWD = mkdtempSync(join(tmpdir(), 'capy-cleanup-cwd-'));
process.env.HOME = TEST_HOME;
const ORIGINAL_CWD = process.cwd();
process.chdir(TEST_CWD);

const ORG_ID = 'org-internal-uuid-1234';
const USER_ID = 'user_01ABC';

let CapyCommand: any;

beforeAll(async () => {
  // Dynamic import after HOME mutation so globalConfig.GLOBAL_CAPY_DIR
  // resolves to our test home, not the user's real ~/.capy.
  ({ CapyCommand } = await import('../../src/commands/capyCommand'));
});

function fixtureSetup(): { keyPath: string; orgDir: string; keepPath: string } {
  const orgDir = join(TEST_HOME, '.capy', 'orgs', ORG_ID);
  const userDir = join(orgDir, 'users', USER_ID);
  mkdirSync(userDir, { recursive: true });
  const keyPath = join(userDir, 'key.enc');
  writeFileSync(keyPath, JSON.stringify({
    version: '1.0', org_id: ORG_ID, encrypted_master_key: 'fake-blob',
  }));
  // Sibling user's key.enc — verifies multi-user isolation: a kick of one
  // user must not affect another in the same org.
  const sibling = join(orgDir, 'users', 'user_01OTHER');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'key.enc'), JSON.stringify({
    version: '1.0', org_id: ORG_ID, encrypted_master_key: 'sibling-blob',
  }));
  // Project key cache — the OLD recursive cleanup nuked this and everything
  // else under the org dir.
  const cacheDir = join(orgDir, 'projects', 'proj-1');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'key.cache'), 'deadbeef');

  const keepPath = join(TEST_CWD, 'keep.lock');
  writeFileSync(keepPath, JSON.stringify({ org_id: ORG_ID, project_id: 'proj-1', variables: {} }));

  return { keyPath, orgDir, keepPath };
}

describe('cleanupOrgData (post-fix safety)', () => {
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

  test('does NOT delete the wrapped master key', () => {
    const { keyPath } = fixtureSetup();
    const cmd = new CapyCommand({});
    (cmd as any).cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(keyPath)).toBe(true);
  });

  test('does NOT delete the org dir', () => {
    const { orgDir } = fixtureSetup();
    const cmd = new CapyCommand({});
    (cmd as any).cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(orgDir)).toBe(true);
  });

  test("does NOT delete a sibling user's key.enc in the same org", () => {
    fixtureSetup();
    const sibling = join(TEST_HOME, '.capy', 'orgs', ORG_ID, 'users', 'user_01OTHER', 'key.enc');
    const cmd = new CapyCommand({});
    (cmd as any).cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(sibling)).toBe(true);
  });

  test('removes keep.lock when present', () => {
    const { keepPath } = fixtureSetup();
    const cmd = new CapyCommand({});
    (cmd as any).cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(keepPath)).toBe(false);
  });

  test('is a no-op when keep.lock is absent (does not throw)', () => {
    fixtureSetup();
    rmSync(join(TEST_CWD, 'keep.lock'));
    const cmd = new CapyCommand({});
    expect(() => (cmd as any).cleanupOrgData(ORG_ID, USER_ID)).not.toThrow();
  });

  test('does NOT delete project key cache (pre-fix recursively wiped it)', () => {
    fixtureSetup();
    const cachePath = join(TEST_HOME, '.capy', 'orgs', ORG_ID, 'projects', 'proj-1', 'key.cache');
    const cmd = new CapyCommand({});
    (cmd as any).cleanupOrgData(ORG_ID, USER_ID);
    expect(existsSync(cachePath)).toBe(true);
  });
});

afterAll(() => {
  // Restore process state so other tests in the same bun run aren't affected.
  process.chdir(ORIGINAL_CWD);
  rmSync(TEST_HOME, { recursive: true, force: true });
  rmSync(TEST_CWD, { recursive: true, force: true });
});
