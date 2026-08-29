import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// Guard rail: pin HOME to a throwaway tmpdir so if any file path ever leaked
// into this suite it could not touch the real ~/.capy. The suite itself runs
// entirely against an in-memory backend — no file I/O is expected.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-session-lifecycle-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import { AuthService } from '../../src/auth/authService';
import { SessionLifecycle } from '../../src/auth/session/lifecycle';
import { SessionStorageBackend, DiscoveredSession } from '../../src/auth/session/backend';
import { SessionStore } from '../../src/types/index';

const API = 'https://api.test.invalid';

/**
 * The Phase-2 shape: a lock-free backend holding the session in memory,
 * injected through the AuthService constructor. `withRefreshLock` simply
 * hands `fn` its current stored session — that is the documented lock-free
 * contract, and it is what lets the adopt-don't-race dance keep working
 * when another actor (not another OS process) refreshed the stored copy.
 */
class MemorySessionStorageBackend implements SessionStorageBackend {
  store = new Map<string, SessionStore>();
  saveCount = 0;

  private key(userId: string | undefined): string {
    return userId ?? '__unscoped__';
  }

  load(userId: string | undefined): SessionStore | null {
    const found = this.store.get(this.key(userId));
    return found ? structuredClone(found) : null;
  }

  save(session: SessionStore, userId: string | undefined): void {
    this.saveCount++;
    this.store.set(this.key(userId), structuredClone(session));
  }

  clear(userId: string | undefined): void {
    this.store.delete(this.key(userId));
  }

  discover(): DiscoveredSession | null {
    for (const [key, session] of this.store) {
      if (key === session.user_id) {
        return { userId: key, session: structuredClone(session) };
      }
    }
    return null;
  }

  async withRefreshLock<T>(
    userId: string | undefined,
    fn: (fresh: SessionStore | null) => Promise<T>,
  ): Promise<T> {
    return fn(this.load(userId));
  }
}

function fakeJwt(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', ...claims })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function makeSession(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    version: 2,
    user_id: 'user-1',
    user_email: 'user-1@test.com',
    refresh_token: 'rt-original',
    organizations: [{ id: 'org-1', workos_org_id: 'workos-org-1', name: 'Org One' }],
    sessions: {
      'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() + 3600_000 },
    },
    ...overrides,
  };
}

interface FetchCall { url: string; body: any; }

/** Install a fetch stub that answers /auth/refresh and records calls. */
function stubFetch(responses: Array<{ status: number; body: any }>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift() ?? { status: 500, body: { error: 'no stubbed response left' } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

describe('SessionLifecycle with an injected backend', () => {
  let backend: MemorySessionStorageBackend;

  beforeEach(() => {
    backend = new MemorySessionStorageBackend();
    delete process.env.CAPY_TOKEN_TTL_SECONDS;
  });

  describe('constructor injection through AuthService', () => {
    test('AuthService runs entirely against the injected backend', async () => {
      backend.save(makeSession(), 'user-1');
      backend.saveCount = 0;

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent('org-1');

      expect(result.success).toBe(true);
      expect(result._auth_method).toBe('cached');
      expect(service.getToken()?.organization_id).toBe('org-1');
    });

    test('discovery works without a userId hint', async () => {
      backend.save(makeSession(), 'user-1');

      const service = new AuthService(API, false, undefined, backend);
      const result = await service.authenticateSilent();

      expect(result.success).toBe(true);
      expect(result.user_id).toBe('user-1');
    });

    test('clearSession clears the backend, not the filesystem', async () => {
      backend.save(makeSession(), 'user-1');
      const service = new AuthService(API, false, 'user-1', backend);
      await service.authenticateSilent('org-1');

      service.clearSession();

      expect(service.getToken()).toBeNull();
      expect(backend.load('user-1')).toBeNull();
    });
  });

  describe('refresh through the backend', () => {
    test('expired token refreshes over HTTP and persists the rotated refresh token', async () => {
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      backend.save(expired, 'user-1');

      const calls = stubFetch([{
        status: 200,
        body: { access_token: fakeJwt({ org_id: 'workos-org-1' }), refresh_token: 'rt-rotated', expires_in: 3600 },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      const refreshed = await lifecycle.refreshForOrg('org-1');

      expect(refreshed).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API}/auth/refresh`);
      expect(calls[0].body.refresh_token).toBe('rt-original');
      // Rotation persisted through the backend, not just held in memory.
      expect(backend.load('user-1')?.refresh_token).toBe('rt-rotated');
    });

    test('adopts a fresher session from the backend instead of burning the refresh token', async () => {
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.session = structuredClone(expired);

      // Meanwhile the stored copy was refreshed by someone else.
      const fresher = makeSession({
        refresh_token: 'rt-theirs',
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() + 3600_000 } },
      });
      backend.save(fresher, 'user-1');

      const calls = stubFetch([]);
      const refreshed = await lifecycle.refreshForOrg('org-1');

      expect(refreshed).toBe(true);
      expect(calls).toHaveLength(0); // no network — adopted, not re-refreshed
      expect(lifecycle.session?.refresh_token).toBe('rt-theirs');
      expect(lifecycle.currentOrgId).toBe('org-1');
    });

    test('getValidToken refreshes an expired token before returning it', async () => {
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      backend.save(expired, 'user-1');
      stubFetch([{
        status: 200,
        body: { access_token: fakeJwt({ org_id: 'workos-org-1' }), refresh_token: 'rt-rotated', expires_in: 3600 },
      }]);

      const service = new AuthService(API, false, 'user-1', backend);
      await service.authenticateSilent('org-1');
      const token = await service.getValidToken();

      expect(token).not.toBeNull();
      expect(token!.expires_at).toBeGreaterThan(Date.now());
    });

    test('CAPY_TOKEN_TTL_SECONDS still clamps expires_at through the extracted path', async () => {
      process.env.CAPY_TOKEN_TTL_SECONDS = '5';
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      backend.save(expired, 'user-1');
      stubFetch([{
        status: 200,
        body: { access_token: fakeJwt({ org_id: 'workos-org-1' }), refresh_token: 'rt-rotated', expires_in: 3600 },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      await lifecycle.refreshForOrg('org-1');

      const expiresAt = lifecycle.session!.sessions['org-1'].expires_at;
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5_000);
    });
  });

  describe('typed failure signals', () => {
    test('a 401 refresh yields reason session_ended and error_code session_ended — no message parsing', async () => {
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      backend.save(expired, 'user-1');
      stubFetch([{ status: 401, body: { error: 'Session has already ended.' } }]);

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent('org-1');

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('session_ended');
      expect(service.getLastRefreshFailure()?.reason).toBe('session_ended');
      expect(service.getLastRefreshFailure()?.status).toBe(401);
    });

    test('a transport failure yields reason network', async () => {
      const expired = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-1' }), expires_at: Date.now() - 1000 } },
      });
      backend.save(expired, 'user-1');
      globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent('org-1');

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('network');
      expect(service.getLastRefreshFailure()?.reason).toBe('network');
    });
  });

  describe('org validation still gates cached tokens', () => {
    test('a cached token scoped to the wrong org is refused and refreshed', async () => {
      // A backend may also choose to skip adoption entirely by handing fn
      // null (the other documented lock-free option). Used here so the
      // wrong-org token provably goes through the HTTP refresh — with the
      // echoing backend the lifecycle would adopt the stored copy instead
      // (its adopt branch keys on expiry, not org validity).
      class NoAdoptBackend extends MemorySessionStorageBackend {
        override async withRefreshLock<T>(
          _userId: string | undefined,
          fn: (fresh: SessionStore | null) => Promise<T>,
        ): Promise<T> {
          return fn(null);
        }
      }
      const noAdopt = new NoAdoptBackend();
      const stale = makeSession({
        sessions: { 'org-1': { access_token: fakeJwt({ org_id: 'workos-org-WRONG' }), expires_at: Date.now() + 3600_000 } },
      });
      noAdopt.save(stale, 'user-1');
      const calls = stubFetch([{
        status: 200,
        body: { access_token: fakeJwt({ org_id: 'workos-org-1' }), refresh_token: 'rt-rotated', expires_in: 3600 },
      }]);

      const service = new AuthService(API, false, 'user-1', noAdopt);
      const result = await service.authenticateSilent('org-1');

      expect(result.success).toBe(true);
      expect(result._auth_method).toBe('refreshed');
      expect(calls).toHaveLength(1);
      expect(service.getToken()?.organization_id).toBe('org-1');
    });
  });

  describe('CAP-451 §7.1.1 — the org-less silent path', () => {
    function makeOrglessSession(overrides: Partial<SessionStore> = {}): SessionStore {
      return {
        version: 2,
        user_id: 'user-1',
        user_email: 'user-1@test.com',
        refresh_token: 'rt-original',
        organizations: [],
        sessions: {},
        ...overrides,
      };
    }

    test('refreshes with NO organization_id and returns refreshed_orgless', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      const calls = stubFetch([{
        status: 200,
        body: { access_token: 'orgless-access-token', refresh_token: 'rt-rotated', scope: 'user' },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      const method = await lifecycle.acquireSilent();

      expect(method).toBe('refreshed_orgless');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API}/auth/refresh`);
      expect(calls[0].body).toEqual({ refresh_token: 'rt-original' });
      // No organization_id key at all — org-scoped refreshForOrg always sends one.
      expect('organization_id' in calls[0].body).toBe(false);
    });

    test('the org-less bearer is held in memory only — never written to the session store', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      stubFetch([{
        status: 200,
        body: { access_token: 'orgless-access-token', refresh_token: 'rt-rotated', scope: 'user' },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      await lifecycle.acquireSilent();

      expect(lifecycle.orglessAccessToken).toBe('orgless-access-token');
      const persisted = backend.load('user-1');
      expect(persisted?.sessions).toEqual({});
      expect(JSON.stringify(persisted)).not.toContain('orgless-access-token');
    });

    test('the rotated refresh token is persisted exactly as the org path does', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      stubFetch([{
        status: 200,
        body: { access_token: 'orgless-access-token', refresh_token: 'rt-rotated', scope: 'user' },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      await lifecycle.acquireSilent();

      expect(backend.load('user-1')?.refresh_token).toBe('rt-rotated');
    });

    test('AuthService.authenticateSilent() surfaces the bearer as _orgless_access_token', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      stubFetch([{
        status: 200,
        body: { access_token: 'orgless-access-token', refresh_token: 'rt-rotated', scope: 'user' },
      }]);

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent();

      expect(result.success).toBe(true);
      expect(result._orgless_access_token).toBe('orgless-access-token');
      // Still a "refreshed" method from the caller's point of view — no new
      // slot on the public _auth_method union for this branch.
      expect(result._auth_method).toBe('refreshed');
      expect(result.organization_id).toBe('');
    });

    test('400 ORG_ID_REQUIRED (the user gained an org meanwhile) returns null — as today, no orgless token', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      stubFetch([{ status: 400, body: { error: 'organization_id is required', code: 'ORG_ID_REQUIRED' } }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      const method = await lifecycle.acquireSilent();

      expect(method).toBeNull();
      expect(lifecycle.orglessAccessToken).toBeNull();
      // Not classified as a refresh failure — describeSilentAuthFailure falls
      // through to its default (no_session), not a spurious server_error.
      expect(lifecycle.lastRefreshFailure).toBeNull();
    });

    test('AuthService.authenticateSilent() reports no_session for the ORG_ID_REQUIRED case, not a message-parsed guess', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      stubFetch([{ status: 400, body: { error: 'organization_id is required', code: 'ORG_ID_REQUIRED' } }]);

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent();

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('no_session');
    });

    test('a genuine network failure on the org-less refresh IS classified — describeSilentAuthFailure reports it', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;

      const service = new AuthService(API, false, 'user-1', backend);
      const result = await service.authenticateSilent();

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('network');
    });

    test('never fires when an explicit organizationId is passed, even with zero known orgs', async () => {
      backend.save(makeOrglessSession(), 'user-1');
      // The org-SCOPED endpoint (refreshForOrg) is hit instead — its request
      // body always carries organization_id, proving the org-less branch's
      // `!organizationId` guard held.
      const calls = stubFetch([{
        status: 200,
        body: { access_token: fakeJwt({ org_id: 'workos-org-1' }), refresh_token: 'rt-rotated', expires_in: 3600 },
      }]);

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      await lifecycle.acquireSilent('org-1');

      expect(calls).toHaveLength(1);
      expect(calls[0].body.organization_id).toBe('org-1');
    });

    test('never fires when the session already has organizations — the existing first-known-org branch runs instead', async () => {
      backend.save(makeSession(), 'user-1'); // has one org, one live session
      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();

      const method = await lifecycle.acquireSilent();

      expect(method).toBe('cached');
      expect(lifecycle.orglessAccessToken).toBeNull();
    });

    test('adopts a fresher session with an org that appeared meanwhile, instead of burning the refresh token', async () => {
      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.session = makeOrglessSession();

      // Meanwhile, elsewhere, the user gained an org.
      const fresher = makeSession({ refresh_token: 'rt-theirs' });
      backend.save(fresher, 'user-1');

      const calls = stubFetch([]);
      const refreshed = await lifecycle.refreshOrgless();

      expect(refreshed).toBe(false);
      expect(calls).toHaveLength(0); // no network — adopted the fresher copy instead
      expect(lifecycle.session?.organizations.length).toBe(1);
    });
  });

  describe('rotation-clobber guard — the single-use refresh token only moves FORWARD', () => {
    test('a non-rotating save preserves a newer rotation another instance persisted', () => {
      const backend = new MemorySessionStorageBackend();
      backend.save(makeSession({ refresh_token: 'rt-1' }), 'user-1');

      const stale = new SessionLifecycle(backend, API, 'user-1');
      stale.load(); // baseline rt-1

      const rotator = new SessionLifecycle(backend, API, 'user-1');
      rotator.load();
      rotator.session!.refresh_token = 'rt-2'; // rotated (as refreshForOrg does)
      rotator.save();
      expect(backend.load('user-1')?.refresh_token).toBe('rt-2');

      // The stale instance updates something unrelated and saves — before the
      // guard this wrote rt-1 back over rt-2, and the next process died on
      // invalid_grant (observed live, twice, in the mint ceremony worker).
      stale.session!.sessions['org-1'] = { access_token: 'at-new', expires_at: Date.now() + 60_000 };
      stale.save();

      expect(backend.load('user-1')?.refresh_token).toBe('rt-2');
      // ...but its non-token payload DID land.
      expect(backend.load('user-1')?.sessions['org-1']?.access_token).toBe('at-new');
    });

    test('after a preserving save, the instance can still rotate forward later', () => {
      const backend = new MemorySessionStorageBackend();
      backend.save(makeSession({ refresh_token: 'rt-1' }), 'user-1');

      const stale = new SessionLifecycle(backend, API, 'user-1');
      stale.load();

      const rotator = new SessionLifecycle(backend, API, 'user-1');
      rotator.load();
      rotator.session!.refresh_token = 'rt-2';
      rotator.save();

      stale.save(); // preserving save: adopts rt-2 as its own baseline
      expect(backend.load('user-1')?.refresh_token).toBe('rt-2');

      // A genuine rotation by the formerly-stale instance still advances.
      stale.session!.refresh_token = 'rt-3';
      stale.save();
      expect(backend.load('user-1')?.refresh_token).toBe('rt-3');
    });

    test('a rotating save wins even when the disk still holds the older token', () => {
      const backend = new MemorySessionStorageBackend();
      backend.save(makeSession({ refresh_token: 'rt-1' }), 'user-1');

      const lifecycle = new SessionLifecycle(backend, API, 'user-1');
      lifecycle.load();
      lifecycle.session!.refresh_token = 'rt-2';
      lifecycle.save();

      expect(backend.load('user-1')?.refresh_token).toBe('rt-2');
    });
  });
});
