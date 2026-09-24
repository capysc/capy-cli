import { mock, describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

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
import { AuthService } from '../../src/auth/authService';
import { SessionLifecycle } from '../../src/auth/session/lifecycle';
import { lockSync } from 'proper-lockfile';
import { SessionStore } from '../../src/types/index';

const CAPY_DIR = join(tempHome, '.capy');
const SESSIONS_DIR = join(CAPY_DIR, 'auth', 'sessions');
const LEGACY_PATH = join(CAPY_DIR, 'auth', 'session.json');
const backend = new FileSessionStorageBackend();

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

const authorityDigest = (refreshToken: string): string =>
  createHash('sha256').update(refreshToken).digest('hex');
const fakeJwt = (value: Readonly<Record<string, unknown>>): string =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(value)).toString('base64url')}.fixture`;

/**
 * The on-disk contract of the extracted file backend. sessionIsolation.test.ts
 * pins the same shape from the outside; this suite pins it at the backend
 * seam so a future backend change cannot silently drift from what deployed
 * CLIs have on disk.
 */
describe('FileSessionStorageBackend', () => {
  beforeEach(() => {
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

    test('refuses an ordinary stale writer after the refresh authority changed', () => {
      const original = makeSession('user-a');
      const current = { ...original, refresh_token: 'rt_current' };
      expect(backend.saveIfRefreshAuthorityMatches(
        current,
        'user-a',
        authorityDigest(original.refresh_token),
      )).toBe(false);
      backend.save(original, 'user-a');
      expect(() => backend.save(current, 'user-a')).toThrow('AUTH_REFRESH_AUTHORITY_CHANGED');
      expect(backend.load('user-a')).toEqual(original);
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

    test('retires only the exact deleted-user refresh authority', () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');

      expect(backend.retireDeletedUserIfRefreshAuthorityMatches('user-a', authorityDigest('rt_other'))).toBe(false);
      expect(backend.load('user-a')).toEqual(stored);
      expect(backend.retireDeletedUserIfRefreshAuthorityMatches('user-a', authorityDigest(stored.refresh_token))).toBe(true);
      expect(backend.load('user-a')).toBeNull();
    });

    test('explicit logout clears an uncertain fence before a fresh login', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await expect(backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
        beginRotation();
        throw new Error('provider outcome lost');
      })).rejects.toThrow('provider outcome lost');
      expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');

      backend.clear('user-a');
      const replacement = { ...makeSession('user-a'), refresh_token: 'rt_fresh_login' };
      backend.save(replacement, 'user-a');
      expect(backend.load('user-a')).toEqual(replacement);
    });

    test('returns subject proof only when a fenced session still owns the recorded authority', async () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      await expect(backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
        beginRotation();
        throw new Error('provider outcome lost');
      })).rejects.toThrow('provider outcome lost');

      expect(backend.getFencedIdentityProof('user-a')).toEqual({
        userId: 'user-a',
        refreshAuthoritySha256: authorityDigest(stored.refresh_token),
        fenceId: expect.any(String),
        priorAccessToken: 'at_user-a_org-1',
      });
      expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });

    test('does not retire a session when the durable fence changed after identity proof', async () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      await expect(backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
        beginRotation();
        throw new Error('provider outcome lost');
      })).rejects.toThrow('provider outcome lost');
      const proof = backend.getFencedIdentityProof('user-a');
      const fencePath = join(SESSIONS_DIR, 'user-a.json.refresh-in-flight');
      const changedFence = { ...JSON.parse(readFileSync(fencePath, 'utf-8')), id: '00000000-0000-4000-8000-000000000001' };
      writeFileSync(fencePath, JSON.stringify(changedFence), { mode: 0o600 });

      expect(backend.retireFencedDeletedUserIfMatches(
        'user-a', authorityDigest(stored.refresh_token), proof!.fenceId,
      )).toBe(false);
      expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
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
    test('hands fn the fresh stored authority under a reliable lock', async () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      const seen = await backend.withRefreshLock('user-a', async fresh => fresh);
      expect(seen).toEqual(stored);
    });

    test('fails closed when no persisted authority can be locked', async () => {
      await expect(backend.withRefreshLock('user-a', async fresh => fresh)).rejects.toThrow();
    });

    test('returns fn\'s result', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      const result = await backend.withRefreshLock('user-a', async () => 'refreshed');
      expect(result).toBe('refreshed');
    });

    test('propagates fn\'s errors (the lifecycle classifies them)', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await expect(
        backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
          beginRotation();
          throw new Error('refresh exploded');
        }),
      ).rejects.toThrow('refresh exploded');
      expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      expect(() => backend.save(makeSession('user-a'), 'user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });

    test('persists a rotated authority and clears the fence only after readback', async () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      const rotated = { ...stored, refresh_token: 'rt_rotated' };
      const result = await backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
        beginRotation();
        backend.save(rotated, 'user-a');
        return 'rotated';
      });
      expect(result).toBe('rotated');
      expect(backend.load('user-a')?.refresh_token).toBe('rt_rotated');
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json.refresh-in-flight'))).toBe(false);
    });

    test('leaves no lock artifacts behind', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await backend.withRefreshLock('user-a', async () => undefined);
      // A completed non-rotating adoption releases both lock and fence.
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json.lock'))).toBe(false);
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json.refresh-in-flight'))).toBe(false);
    });

    test('refuses a dangling refresh-fence symlink instead of treating it as absent', () => {
      backend.save(makeSession('user-a'), 'user-a');
      const fence = join(SESSIONS_DIR, 'user-a.json.refresh-in-flight');
      symlinkSync(join(SESSIONS_DIR, 'missing-fence-target'), fence);
      expect(() => backend.load('user-a')).toThrow();
      expect(() => backend.save(makeSession('user-a'), 'user-a')).toThrow();
    });

    test('binds cached-authority refusal to constructor and switched user scopes', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      backend.save(makeSession('user-b'), 'user-b');
      await expect(backend.withRefreshLock('user-b', async (_fresh, beginRotation) => {
        beginRotation();
        throw new Error('provider outcome lost');
      })).rejects.toThrow('provider outcome lost');

      const fencedAtConstruction = new AuthService('https://service.example.test', false, 'user-b', backend);
      expect(() => fencedAtConstruction.getToken()).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');

      const switched = new AuthService('https://service.example.test', false, 'user-a', backend);
      switched.setSessionUserId('user-b');
      expect(() => switched.getToken()).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });
  });

  describe('compare-and-save', () => {
    test('refuses a stale hosted install without overwriting the rotated authority', () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      const staleDigest = authorityDigest('rt_stale');
      const replacement = { ...stored, refresh_token: 'rt_replacement' };
      expect(backend.saveIfRefreshAuthorityMatches(replacement, 'user-a', staleDigest)).toBe(false);
      expect(backend.load('user-a')?.refresh_token).toBe(stored.refresh_token);
    });

    test('serializes the first install and refuses a second null-baseline writer', () => {
      const first = makeSession('user-a');
      const second = { ...first, refresh_token: 'rt_second' };
      expect(backend.saveIfRefreshAuthorityMatches(first, 'user-a', null)).toBe(true);
      expect(backend.saveIfRefreshAuthorityMatches(second, 'user-a', null)).toBe(false);
      expect(backend.load('user-a')).toEqual(first);
    });

    test('checks explicit provider-authenticated replacement and refuses swallowed or missing saves', async () => {
      const original = makeSession('user-a');
      const replacement = { ...original, refresh_token: 'rt_verified_login' };
      backend.save(original, 'user-a');
      const installed = await backend.withVerifiedAuthInstallation(
        'user-a',
        authorityDigest(original.refresh_token),
        async () => {
          backend.save(replacement, 'user-a');
          return 'installed';
        },
      );
      expect(installed).toBe('installed');
      expect(backend.load('user-a')).toEqual(replacement);

      await expect(backend.withVerifiedAuthInstallation(
        'user-a',
        authorityDigest(original.refresh_token),
        async () => {
          try { backend.save({ ...replacement, refresh_token: 'rt_stale_login' }, 'user-a'); } catch { /* legacy save swallows */ }
          return 'must-not-escape';
        },
      )).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      await expect(backend.withVerifiedAuthInstallation(
        'user-a',
        authorityDigest(replacement.refresh_token),
        async () => 'missing-save',
      )).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      expect(backend.load('user-a')).toEqual(replacement);
    });

    test('persists an explicit sign-in replacement and detects drift despite the legacy swallowed save', async () => {
      const original = makeSession('user-a');
      backend.save(original, 'user-a');
      const auth = new AuthService('https://service.example.test', false, 'user-a', backend);
      const verified = auth as unknown as Readonly<{
        captureExplicitAuthInstallationBaseline: () => Readonly<{
          userId: string | null;
          refreshAuthoritySha256: string | null;
        }>;
        processVerifiedExchangeResponse: (
          token: Readonly<{ access_token: string; refresh_token: string; expires_in: number }>,
          user: Readonly<{ id: string; email: string; first_name: null; last_name: null }>,
          organizations: readonly [],
          baseline: Readonly<{ userId: string | null; refreshAuthoritySha256: string | null }>,
        ) => Promise<Readonly<{ success: boolean }>>;
      }>;
      const user = { id: 'user-a', email: 'user-a@test.com', first_name: null, last_name: null } as const;
      const baseline = verified.captureExplicitAuthInstallationBaseline();
      const first = await verified.processVerifiedExchangeResponse({
        access_token: fakeJwt({ sub: 'user-a' }), refresh_token: 'rt_verified_login', expires_in: 600,
      }, user, [], baseline);
      expect(first.success).toBeTrue();
      expect(backend.load('user-a')?.refresh_token).toBe('rt_verified_login');

      await expect(verified.processVerifiedExchangeResponse({
        access_token: fakeJwt({ sub: 'user-a' }), refresh_token: 'rt_stale_login', expires_in: 600,
      }, user, [], baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      expect(backend.load('user-a')?.refresh_token).toBe('rt_verified_login');
    });

    test('freezes a new explicit-login baseline after clear on the same AuthService', async () => {
      const original = makeSession('user-a');
      backend.save(original, 'user-a');
      const auth = new AuthService('https://service.example.test', false, 'user-a', backend);
      const verified = auth as unknown as Readonly<{
        captureExplicitAuthInstallationBaseline: () => Readonly<{
          userId: string | null;
          refreshAuthoritySha256: string | null;
        }>;
        processVerifiedExchangeResponse: (
          token: Readonly<{ access_token: string; refresh_token: string; expires_in: number }>,
          user: Readonly<{ id: string; email: string; first_name: null; last_name: null }>,
          organizations: readonly [],
          baseline: Readonly<{ userId: string | null; refreshAuthoritySha256: string | null }>,
        ) => Promise<Readonly<{ success: boolean }>>;
      }>;
      auth.clearToken();
      const baseline = verified.captureExplicitAuthInstallationBaseline();
      const result = await verified.processVerifiedExchangeResponse({
        access_token: fakeJwt({ sub: 'user-a' }), refresh_token: 'rt_after_clear', expires_in: 600,
      }, { id: 'user-a', email: 'user-a@test.com', first_name: null, last_name: null }, [], baseline);

      expect(baseline).toEqual({ userId: 'user-a', refreshAuthoritySha256: null });
      expect(result.success).toBeTrue();
      expect(backend.load('user-a')?.refresh_token).toBe('rt_after_clear');
    });

    test('does not let an unknown login subject adopt an existing user authority', async () => {
      const existing = makeSession('user-b');
      const auth = new AuthService('https://service.example.test', false, undefined, backend);
      const verified = auth as unknown as Readonly<{
        captureExplicitAuthInstallationBaseline: () => Readonly<{
          userId: string | null;
          refreshAuthoritySha256: string | null;
        }>;
        processVerifiedExchangeResponse: (
          token: Readonly<{ access_token: string; refresh_token: string; expires_in: number }>,
          user: Readonly<{ id: string; email: string; first_name: null; last_name: null }>,
          organizations: readonly [],
          baseline: Readonly<{ userId: string | null; refreshAuthoritySha256: string | null }>,
        ) => Promise<Readonly<{ success: boolean }>>;
      }>;
      const baseline = verified.captureExplicitAuthInstallationBaseline();
      backend.save(existing, 'user-b');

      await expect(verified.processVerifiedExchangeResponse({
        access_token: fakeJwt({ sub: 'user-b' }), refresh_token: 'rt_unrelated_login', expires_in: 600,
      }, { id: 'user-b', email: 'user-b@test.com', first_name: null, last_name: null }, [], baseline))
        .rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      expect(baseline).toEqual({ userId: null, refreshAuthoritySha256: null });
      expect(backend.load('user-b')).toEqual(existing);
    });

    test('refuses explicit auth when a nested scoped refresh leaves authority fenced', async () => {
      const original = makeSession('user-a');
      const signedIn = { ...original, refresh_token: 'rt_verified_login' };
      backend.save(original, 'user-a');
      await expect(backend.withVerifiedAuthInstallation(
        'user-a',
        authorityDigest(original.refresh_token),
        async () => {
          backend.save(signedIn, 'user-a');
          await backend.withRefreshLock('user-a', async (_fresh, beginRotation) => {
            beginRotation();
            throw new Error('nested refresh response lost');
          }).catch(() => undefined);
          return 'must-not-escape';
        },
      )).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      expect(existsSync(join(SESSIONS_DIR, 'user-a.json.refresh-in-flight'))).toBeTrue();
    });
  });

  describe('indeterminate refresh recovery', () => {
    const API = 'https://service.example.test';
    const fencePath = (userId: string): string => join(SESSIONS_DIR, `${userId}.json.refresh-in-flight`);
    const sessionPath = (userId: string): string => join(SESSIONS_DIR, `${userId}.json`);
    const FENCED_SESSION_ENDED = { reason: 'session_ended', detail: 'AUTH_REFRESH_AUTHORITY_INDETERMINATE' };

    /** A killed rotation owner: the fence is written, the matching save never ran. */
    const leaveFence = async (userId: string): Promise<void> => {
      await expect(backend.withRefreshLock(userId, async (_fresh, beginRotation) => {
        beginRotation();
        throw new Error('provider outcome lost');
      })).rejects.toThrow('provider outcome lost');
      expect(existsSync(fencePath(userId))).toBeTrue();
    };

    type Call = Readonly<{ url: string; body: string }>;
    /** Answers every request with `reply`; records what was sent. */
    const withFetch = async (
      reply: () => Response,
      run: (calls: readonly Call[]) => Promise<void>,
    ): Promise<void> => {
      const realFetch = globalThis.fetch;
      const calls: Call[] = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? '') });
        return reply();
      }) as typeof fetch;
      try {
        await run(calls);
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    const json = (status: number, body: unknown) => (): Response => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    const present = json(200, { status: 'present' });

    test('drops a fenced session the service reports present, without sending its refresh token', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');

      await withFetch(present, async (calls) => {
        const auth = new AuthService(API, false, 'user-a', backend);
        const result = await auth.authenticateSilent('org-1');

        expect(result.success).toBeFalse();
        expect(result.error_code).toBe('session_ended');
        expect(auth.getLastRefreshFailure()).toEqual(FENCED_SESSION_ENDED);
        expect(calls.map(({ url }) => url)).toEqual([`${API}/auth/session-status`]);
        expect(calls.some(({ body }) => body.includes('rt_user-a'))).toBeFalse();
      });
      expect(existsSync(sessionPath('user-a'))).toBeFalse();
      expect(existsSync(fencePath('user-a'))).toBeFalse();
      expect(backend.load('user-a')).toBeNull();
    });

    test('authenticate starts sign-in for the same org once the fenced session is dropped', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');
      const authPrototype = AuthService.prototype as unknown as {
        startOAuthFlow: (organizationId?: string) => Promise<unknown>;
      };
      const startOAuthFlow = spyOn(authPrototype, 'startOAuthFlow').mockResolvedValue({ success: false });
      try {
        await withFetch(present, async (calls) => {
          await new AuthService(API, false, 'user-a', backend).authenticate('org-1');
          expect(calls.map(({ url }) => url)).toEqual([`${API}/auth/session-status`]);
        });
        expect(startOAuthFlow).toHaveBeenCalledTimes(1);
        expect(startOAuthFlow).toHaveBeenCalledWith('org-1');
      } finally {
        startOAuthFlow.mockRestore();
      }
    });

    test('an org refresh refused by an existing fence drops only that authority and never calls the provider', async () => {
      backend.save({
        ...makeSession('user-a'),
        sessions: { 'org-1': { access_token: 'at_user-a_org-1', expires_at: Date.now() - 1000 } },
      }, 'user-a');
      const unrelated = makeSession('user-b');
      backend.save(unrelated, 'user-b');
      const lifecycle = new SessionLifecycle(backend, API, 'user-a');
      lifecycle.load();
      await leaveFence('user-a');

      await withFetch(present, async (calls) => {
        expect(await lifecycle.refreshForOrg('org-1')).toBeFalse();
        expect(calls.map(({ url }) => url)).toEqual([`${API}/auth/session-status`]);
        expect(calls.some(({ body }) => body.includes('rt_user-a'))).toBeFalse();
      });
      expect(lifecycle.lastRefreshFailure).toEqual(FENCED_SESSION_ENDED);
      expect(lifecycle.session).toBeNull();
      expect(lifecycle.currentOrgId).toBeNull();
      expect(lifecycle.sessionUserId).toBe('user-a');
      expect(lifecycle.retiredDeletedUserId).toBeNull();
      expect(existsSync(sessionPath('user-a'))).toBeFalse();
      expect(existsSync(fencePath('user-a'))).toBeFalse();
      expect(backend.load('user-b')).toEqual(unrelated);
    });

    test('an org-less refresh refused by an existing fence drops that authority and never calls the provider', async () => {
      backend.save({
        ...makeSession('user-a'),
        organizations: [],
        sessions: {},
        identity_session: { access_token: 'at_identity', expires_at: Date.now() + 60_000, root_authority_sha256: 'a'.repeat(64) },
      }, 'user-a');
      const lifecycle = new SessionLifecycle(backend, API, 'user-a');
      lifecycle.load();
      await leaveFence('user-a');

      await withFetch(present, async (calls) => {
        expect(await lifecycle.refreshOrgless()).toBeFalse();
        expect(calls.map(({ url }) => url)).toEqual([`${API}/auth/session-status`]);
      });
      expect(lifecycle.lastRefreshFailure).toEqual(FENCED_SESSION_ENDED);
      expect(lifecycle.orglessAccessToken).toBeNull();
      expect(existsSync(sessionPath('user-a'))).toBeFalse();
      expect(existsSync(fencePath('user-a'))).toBeFalse();
    });

    test('keeps the fenced session when session status cannot be confirmed', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');
      const fenceBytes = readFileSync(fencePath('user-a'), 'utf-8');

      await withFetch(() => { throw new TypeError('fetch failed'); }, async () => {
        const result = await new AuthService(API, false, 'user-a', backend).authenticateSilent('org-1');
        expect(result.error_code).toBe('server_error');
      });
      await withFetch(json(503, { error: 'unavailable' }), async () => {
        const result = await new AuthService(API, false, 'user-a', backend).authenticateSilent('org-1');
        expect(result.error_code).toBe('server_error');
      });
      expect(readFileSync(fencePath('user-a'), 'utf-8')).toBe(fenceBytes);
      expect(existsSync(sessionPath('user-a'))).toBeTrue();
    });

    test('still retires the fenced authority when the service confirms deletion', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');

      await withFetch(json(200, { status: 'deleted', user_id: 'user-a' }), async () => {
        const auth = new AuthService(API, false, 'user-a', backend);
        expect((await auth.authenticateSilent('org-1')).error_code).toBe('user_deleted');
      });
      expect(existsSync(sessionPath('user-a'))).toBeFalse();
      expect(existsSync(fencePath('user-a'))).toBeFalse();
    });

    test('leaves a fence whose id or authority changed between the check and the clear', async () => {
      const stored = makeSession('user-a');
      backend.save(stored, 'user-a');
      await leaveFence('user-a');
      const proof = backend.getFencedIdentityProof('user-a')!;

      expect(backend.clearIndeterminateFencedSessionIfMatches(
        'user-a', proof.refreshAuthoritySha256, '00000000-0000-4000-8000-000000000001',
      )).toBeFalse();
      expect(backend.clearIndeterminateFencedSessionIfMatches(
        'user-a', authorityDigest('rt_other'), proof.fenceId,
      )).toBeFalse();
      expect(existsSync(sessionPath('user-a'))).toBeTrue();
      expect(existsSync(fencePath('user-a'))).toBeTrue();

      const changedFence = { ...JSON.parse(readFileSync(fencePath('user-a'), 'utf-8')), id: '00000000-0000-4000-8000-000000000002' };
      writeFileSync(fencePath('user-a'), JSON.stringify(changedFence), { mode: 0o600 });
      expect(backend.clearIndeterminateFencedSessionIfMatches(
        'user-a', proof.refreshAuthoritySha256, proof.fenceId,
      )).toBeFalse();
      expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });

    test('a present response for another subject is not permission to clear', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');

      await withFetch(json(200, { status: 'present', user_id: 'user-other' }), async () => {
        const result = await new AuthService(API, false, 'user-a', backend).authenticateSilent('org-1');
        expect(result.error_code).toBe('server_error');
        expect(result.error).toBe('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      });
      expect(existsSync(fencePath('user-a'))).toBeTrue();
    });

    test('a held session lock refuses with its own error and clears nothing', async () => {
      backend.save(makeSession('user-a'), 'user-a');
      await leaveFence('user-a');
      const release = lockSync(sessionPath('user-a'), { realpath: false });
      try {
        expect(() => backend.load('user-a')).toThrow('AUTH_REFRESH_LOCK_UNAVAILABLE');
        await expect(backend.withRefreshLock('user-a', async () => 'unreachable'))
          .rejects.toThrow('AUTH_REFRESH_LOCK_UNAVAILABLE');
        await withFetch(present, async (calls) => {
          const result = await new AuthService(API, false, 'user-a', backend).authenticateSilent('org-1');
          expect(result.error_code).toBe('server_error');
          expect(result.error).toBe('AUTH_REFRESH_LOCK_UNAVAILABLE');
          expect(calls).toEqual([]);
        });
      } finally {
        release();
      }
      expect(existsSync(sessionPath('user-a'))).toBeTrue();
      expect(existsSync(fencePath('user-a'))).toBeTrue();
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
