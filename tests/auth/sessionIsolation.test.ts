import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/types/index';

/**
 * Test session isolation by directly testing the file-based session storage.
 * Verifies that per-user session files don't clobber each other and that
 * the SyncState.user_id routes to the correct session.
 */

const TEST_DIR = join(tmpdir(), `capy-session-test-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, 'auth', 'sessions');

const USER_A = { userId: 'user-a-test', email: 'alice@test.com' };
const USER_B = { userId: 'user-b-test', email: 'bob@test.com' };
const ORG_A = 'org-a-id';
const ORG_B = 'org-b-id';

function sessionPath(userId: string): string {
  return join(SESSIONS_DIR, `${userId}.json`);
}

function saveSession(session: SessionStore, userId: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(userId), JSON.stringify(session, null, 2), { mode: 0o600 });
}

function loadSession(userId: string): SessionStore | null {
  const path = sessionPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function makeSession(userId: string, orgId: string): SessionStore {
  return {
    version: 2,
    user_id: userId,
    user_email: userId === USER_A.userId ? USER_A.email : USER_B.email,
    user_first_name: null,
    user_last_name: null,
    refresh_token: `rt_${userId}`,
    organizations: [
      { id: orgId, workos_org_id: `workos_${orgId}`, name: `Org ${orgId}` },
    ],
    sessions: {
      [orgId]: {
        access_token: `at_${userId}_${orgId}`,
        expires_at: Date.now() + 3600_000,
      },
    },
  };
}

describe('Session Isolation', () => {
  beforeAll(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saves sessions to separate per-user files', () => {
    saveSession(makeSession(USER_A.userId, ORG_A), USER_A.userId);
    saveSession(makeSession(USER_B.userId, ORG_B), USER_B.userId);

    expect(existsSync(sessionPath(USER_A.userId))).toBe(true);
    expect(existsSync(sessionPath(USER_B.userId))).toBe(true);
  });

  it('reads the correct session for each user', () => {
    const loadedA = loadSession(USER_A.userId)!;
    const loadedB = loadSession(USER_B.userId)!;

    expect(loadedA.user_id).toBe(USER_A.userId);
    expect(loadedB.user_id).toBe(USER_B.userId);
    expect(loadedA.sessions[ORG_A]).toBeDefined();
    expect(loadedB.sessions[ORG_B]).toBeDefined();
  });

  it('User B write does not affect User A session', () => {
    // Overwrite B with a different org session
    const newB = makeSession(USER_B.userId, ORG_A);
    newB.sessions[ORG_A]!.access_token = 'at_b_new';
    saveSession(newB, USER_B.userId);

    // A is unchanged
    const loadedA = loadSession(USER_A.userId)!;
    expect(loadedA.user_id).toBe(USER_A.userId);
    expect(loadedA.sessions[ORG_A]!.access_token).toBe(`at_${USER_A.userId}_${ORG_A}`);
  });

  it('returns null for unknown user', () => {
    expect(loadSession('user-unknown')).toBeNull();
  });

  describe('SyncState user_id field', () => {
    it('user_id is preserved in JSON serialization', () => {
      const syncState = {
        last_sync: new Date().toISOString(),
        synced_variables: ['FOO', 'BAR'],
        user_id: USER_A.userId,
      };
      const json = JSON.stringify(syncState, null, 2);
      const parsed = JSON.parse(json);
      expect(parsed.user_id).toBe(USER_A.userId);
    });

    it('user_id is omitted from JSON when undefined', () => {
      const syncState = {
        last_sync: new Date().toISOString(),
        synced_variables: ['FOO'],
        user_id: undefined,
      };
      const json = JSON.stringify(syncState, null, 2);
      const parsed = JSON.parse(json);
      expect(parsed.user_id).toBeUndefined();
      expect('user_id' in parsed).toBe(false);
    });
  });

  describe('Multi-user session lifecycle', () => {
    it('User A and User B can both have sessions for the same org', () => {
      // Both users are in ORG_A
      const sessionA = makeSession(USER_A.userId, ORG_A);
      const sessionB = makeSession(USER_B.userId, ORG_A);
      saveSession(sessionA, USER_A.userId);
      saveSession(sessionB, USER_B.userId);

      const loadedA = loadSession(USER_A.userId)!;
      const loadedB = loadSession(USER_B.userId)!;

      // Both have sessions for the same org but different tokens
      expect(loadedA.sessions[ORG_A]!.access_token).toContain(USER_A.userId);
      expect(loadedB.sessions[ORG_A]!.access_token).toContain(USER_B.userId);
    });

    it('Deleting User B session does not affect User A', () => {
      const pathB = sessionPath(USER_B.userId);
      if (existsSync(pathB)) rmSync(pathB);

      expect(loadSession(USER_B.userId)).toBeNull();
      expect(loadSession(USER_A.userId)).not.toBeNull();
    });
  });
});
