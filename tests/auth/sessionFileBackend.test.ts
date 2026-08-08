import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Pin HOME to a per-suite tmpdir BEFORE the modules under test resolve paths
// via os.homedir() — same pattern as logoutCleanup.test.ts. Never touches the
// real ~/.capy.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-session-backend-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import { FileSessionStorageBackend } from '../../src/auth/session/fileBackend';
import { SessionStore } from '../../src/types/index';

const CAPY_DIR = join(tempHome, '.capy');
const SESSIONS_DIR = join(CAPY_DIR, 'auth', 'sessions');
const LEGACY_PATH = join(CAPY_DIR, 'auth', 'session.json');

function makeSession(userId: string, orgId = 'org-1'): SessionStore {
  return {
    version: 2,
    user_id: userId,
    user_email: `${userId}@test.com`,
    refresh_token: `rt_${userId}`,
    organizations: [{ id: orgId, workos_org_id: `workos_${orgId}`, name: `Org ${orgId}` }],
    sessions: {
      [orgId]: { access_token: `at_${userId}_${orgId}`, expires_at: Date.now() + 3600_000 },
    },
  };
}

/**
 * The on-disk contract of the extracted file backend. sessionIsolation.test.ts
 * pins the same shape from the outside; this suite pins it at the backend
 * seam so a future backend change cannot silently drift from what deployed
 * CLIs have on disk.
 */
describe('FileSessionStorageBackend', () => {
  let backend: FileSessionStorageBackend;

  beforeEach(() => {
    backend = new FileSessionStorageBackend();
    rmSync(CAPY_DIR, { recursive: true, force: true });
  });

  describe('save/load', () => {
    test('save writes ~/.capy/auth/sessions/<userId>.json, byte-identical to the historical format', () => {
      const session = makeSession('user-a');
      backend.save(session, 'user-a');

      const path = join(SESSIONS_DIR, 'user-a.json');
      expect(existsSync(path)).toBe(true);
      // Byte-for-byte: pretty-printed JSON, 2-space indent — what
      // globalConfig.saveAuthSession has always written.
      expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify(session, null, 2));
    });

    test('session file is 0600 and auth dirs are 0700', () => {
      backend.save(makeSession('user-a'), 'user-a');

      expect(statSync(join(SESSIONS_DIR, 'user-a.json')).mode & 0o777).toBe(0o600);
      expect(statSync(SESSIONS_DIR).mode & 0o777).toBe(0o700);
    });

    test('save without a userId writes the legacy unscoped auth/session.json', () => {
      backend.save(makeSession('user-a'), undefined);
      expect(existsSync(LEGACY_PATH)).toBe(true);
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json'))).toBe(false);
    });

    test('load round-trips what save wrote', () => {
      const session = makeSession('user-a');
      backend.save(session, 'user-a');
      expect(backend.load('user-a')).toEqual(session);
    });

    test('load returns null when nothing is stored', () => {
      expect(backend.load('user-a')).toBeNull();
    });

    test('load propagates corrupt-data errors (the lifecycle treats a throw as no session)', () => {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(join(SESSIONS_DIR, 'user-a.json'), 'not json', { mode: 0o600 });
      expect(() => backend.load('user-a')).toThrow();
    });
  });

  describe('clear', () => {
    test('removes the stored session', () => {
      backend.save(makeSession('user-a'), 'user-a');
      backend.clear('user-a');
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json'))).toBe(false);
    });

    test('is a no-op when nothing is stored', () => {
      expect(() => backend.clear('user-a')).not.toThrow();
    });
  });

  describe('discover', () => {
    test('finds a session whose filename matches its user_id', () => {
      backend.save(makeSession('user-a'), 'user-a');
      const found = backend.discover();
      expect(found?.userId).toBe('user-a');
      expect(found?.session.user_id).toBe('user-a');
    });

    test('rejects a stale snapshot whose filename disagrees with its user_id', () => {
      // A prior refresh wrote new user data to the old path — not an identity.
      backend.save(makeSession('user-b'), 'user-a');
      expect(backend.discover()).toBeNull();
    });

    test('skips unparseable files and keeps scanning', () => {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(join(SESSIONS_DIR, 'aaa-corrupt.json'), 'not json', { mode: 0o600 });
      backend.save(makeSession('user-b'), 'user-b');
      expect(backend.discover()?.userId).toBe('user-b');
    });

    test('returns null when the sessions directory does not exist', () => {
      expect(backend.discover()).toBeNull();
    });
  });

  describe('withRefreshLock', () => {
    // FOUND BUG, PRESERVED VERBATIM (see fileBackend.ts): the pre-extraction
    // code passed `retries` to proper-lockfile's lockSync, which the sync API
    // rejects — the throw was swallowed, so production has never held the
    // refresh lock and never re-read fresh state. This refactor must not
    // change CLI behavior, so these tests pin what the backend actually does
    // today. The adopt-fresher dance the interface exists for is exercised in
    // sessionLifecycle.test.ts through a backend that can express it.
    test('hands fn null even when a session is stored — the sync lock call always fails', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      const seen = await backend.withRefreshLock('user-a', async fresh => fresh);
      expect(seen).toBeNull();
    });

    test('hands fn null when nothing is stored (proceed-without-lock semantics)', async () => {
      const seen = await backend.withRefreshLock('user-a', async fresh => fresh);
      expect(seen).toBeNull();
    });

    test('returns fn\'s result', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      const result = await backend.withRefreshLock('user-a', async () => 'refreshed');
      expect(result).toBe('refreshed');
    });

    test('propagates fn\'s errors (the lifecycle classifies them)', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await expect(
        backend.withRefreshLock('user-a', async () => { throw new Error('refresh exploded'); }),
      ).rejects.toThrow('refresh exploded');
      // And the backend stays usable afterwards.
      const result = await backend.withRefreshLock('user-a', async () => 'ok');
      expect(result).toBe('ok');
    });

    test('leaves no lock artifacts behind', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await backend.withRefreshLock('user-a', async () => undefined);
      // No <file>.lock directory — the lock never engages today.
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json.lock'))).toBe(false);
    });
  });

  describe('bright line: auth material only', () => {
    test('every path the backend touches lives under ~/.capy/auth/', () => {
      backend.save(makeSession('user-a'), 'user-a');
      backend.save(makeSession('user-b'), undefined);
      backend.discover();
      backend.clear('user-a');

      // Nothing outside auth/ — no orgs/ (key.enc, local.key), no local/,
      // no keep/. The session module must never grow a key-material path.
      const entries = require('fs').readdirSync(CAPY_DIR) as string[];
      expect(entries).toEqual(['auth']);
    });
  });
});
