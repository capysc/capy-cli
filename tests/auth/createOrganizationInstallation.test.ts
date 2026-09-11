/** ISOLATED (mock.module): durable organization authority installation. */
import { afterAll, beforeEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from '../../src/types/index';
import type { SessionStorageBackend } from '../../src/auth/session/backend';
import type { InitRunCreatedOrganizationResponse } from '../../src/auth/initRunOrganizationInstaller';

const PRIVATE_ROOT = mkdtempSync(join(tmpdir(), 'capy-create-org-install-'));
const SERVICE_ORIGIN = 'https://service.example.test';
const USER_ID = 'user_create_org';
const VALID_UNTIL = Date.now() + 60_000;
const ORG_A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workos_org_id: 'workos_org_a', name: 'Organization A' } as const;
const ORG_B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workos_org_id: 'workos_org_b', name: 'Organization B' } as const;

const sessionPath = (userId = USER_ID): string => join(PRIVATE_ROOT, 'auth', 'sessions', `${userId}.json`);
const fencePath = (userId = USER_ID): string => `${sessionPath(userId)}.refresh-in-flight`;
const stored = (userId = USER_ID): SessionStore | null => existsSync(sessionPath(userId))
  ? JSON.parse(readFileSync(sessionPath(userId), 'utf8')) as SessionStore
  : null;

mock.module('../../src/config/globalConfig', () => ({
  getGlobalCapyDir: () => PRIVATE_ROOT,
  getAuthSessionPath: sessionPath,
  readAuthSession: stored,
  consumeForceLoginMarker: () => false,
  isForceLoginMarkerPending: () => false,
}));
mock.module('../../src/config/profileConfig', () => ({
  resolveActiveUrl: () => SERVICE_ORIGIN,
  isLocalOnly: () => false,
}));

const { AuthService } = await import('../../src/auth/authService');
const { FileSessionStorageBackend } = await import('../../src/auth/session/fileBackend');
const { CapyError, ERROR_CODES } = await import('../../src/types/index');

const jwt = (claims: Readonly<Record<string, unknown>>): string =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const session = (refreshToken: string, userId = USER_ID): SessionStore => ({
  version: 2,
  user_id: userId,
  user_email: `${userId}@example.test`,
  user_first_name: null,
  user_last_name: null,
  refresh_token: refreshToken,
  organizations: [ORG_A],
  sessions: {
    [ORG_A.id]: {
      access_token: jwt({ sub: userId, org_id: ORG_A.workos_org_id }),
      expires_at: VALID_UNTIL,
    },
  },
});
const response = (
  userId = USER_ID,
  overrides: Partial<InitRunCreatedOrganizationResponse> = {},
): InitRunCreatedOrganizationResponse => ({
  id: ORG_B.id,
  workos_org_id: ORG_B.workos_org_id,
  name: ORG_B.name,
  access_token: jwt({ sub: userId, org_id: ORG_B.workos_org_id }),
  refresh_token: 'refresh-r1',
  expires_in: 600,
  user: { id: userId, email: `${userId}@example.test`, first_name: null, last_name: null },
  ...overrides,
});
const fetchSpy = spyOn(globalThis, 'fetch');
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(
  () => null,
  (error: unknown) => error,
);
const seed = (backend: InstanceType<typeof FileSessionStorageBackend>, initial = session('refresh-r0')): void =>
  backend.save(initial, initial.user_id);

beforeEach(() => {
  rmSync(PRIVATE_ROOT, { recursive: true, force: true });
  fetchSpy.mockReset();
});

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(PRIVATE_ROOT, { recursive: true, force: true });
  mock.restore();
});

describe('organization creation authority installation', () => {
  test('installs rotated authority and the appended organization for a new process', async () => {
    const backend = new FileSessionStorageBackend();
    const originalSession = session('refresh-r0');
    seed(backend, originalSession);
    fetchSpy.mockResolvedValue(Response.json(response(), { status: 201 }));
    const original = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend, ORG_A.id);

    const installed = await original.createOrganization(ORG_B.name, originalSession.refresh_token, USER_ID);
    const readback = new FileSessionStorageBackend().load(USER_ID);
    const replacement = new AuthService(SERVICE_ORIGIN, false, USER_ID, new FileSessionStorageBackend(), ORG_B.id);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      name: ORG_B.name,
      refresh_token: originalSession.refresh_token,
    });
    expect(readback).toEqual({
      ...originalSession,
      refresh_token: 'refresh-r1',
      organizations: [ORG_A, ORG_B],
      sessions: {
        ...originalSession.sessions,
        [ORG_B.id]: {
          access_token: response().access_token,
          expires_at: readback?.sessions[ORG_B.id]?.expires_at,
        },
      },
    });
    expect(installed.organization).toEqual(ORG_B);
    expect(installed.auth).toMatchObject({ success: true, user_id: USER_ID, organization_id: ORG_B.id });
    expect(installed.authService.getOrganizationId()).toBe(ORG_B.id);
    expect(replacement.getOrganizationId()).toBe(ORG_B.id);
    expect(original.getOrganizationId()).toBe(ORG_A.id);
    expect(existsSync(fencePath())).toBeFalse();
  });

  test('keeps the ordinary stale-writer refusal', () => {
    const backend = new FileSessionStorageBackend();
    seed(backend);
    expect(() => backend.save(session('refresh-r2'), USER_ID)).toThrow('AUTH_REFRESH_AUTHORITY_CHANGED');
    expect(stored()).toEqual(session('refresh-r0'));
  });

  test('installs the first organization from a persisted zero-organization session', async () => {
    const backend = new FileSessionStorageBackend();
    const zeroOrganization = { ...session('refresh-zero'), organizations: [], sessions: {} } as const;
    seed(backend, zeroOrganization);
    fetchSpy.mockResolvedValue(Response.json(response(undefined, { refresh_token: 'refresh-zero-r1' }), { status: 201 }));
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend);

    const installed = await auth.createOrganization(ORG_B.name, 'refresh-zero', USER_ID);

    expect(installed.organization).toEqual(ORG_B);
    expect(installed.authService.getOrganizationId()).toBe(ORG_B.id);
    expect(new FileSessionStorageBackend().load(USER_ID)?.organizations).toEqual([ORG_B]);
    expect(existsSync(fencePath())).toBeFalse();
  });

  test('preserves configured non-loopback HTTP and HTTPS path-prefix service bases', async () => {
    type BaseOutcome = Readonly<{ userId: string; requestedUrl: string }>;
    const bases = ['http://mabels-mac-mini.tailcbfb49.ts.net:3001', 'https://byoc.example.test/capy/api/'] as const;
    const outcomes = await bases.reduce(async (prior, base, index): Promise<readonly BaseOutcome[]> => {
      const previous = await prior;
      const userId = `user_service_base_${index}`;
      const refreshToken = `refresh-${userId}`;
      const backend = new FileSessionStorageBackend();
      seed(backend, session(refreshToken, userId));
      fetchSpy.mockResolvedValueOnce(Response.json(response(userId, { refresh_token: `rotated-${userId}` }), { status: 201 }));
      const auth = new AuthService(base, false, userId, backend, ORG_A.id);
      await auth.createOrganization(ORG_B.name, refreshToken, userId);
      return [...previous, {
        userId,
        requestedUrl: String(fetchSpy.mock.calls.at(-1)?.[0]),
      }];
    }, Promise.resolve([] as readonly BaseOutcome[]));

    expect(outcomes).toEqual([
      { userId: 'user_service_base_0', requestedUrl: 'http://mabels-mac-mini.tailcbfb49.ts.net:3001/auth/create-org' },
      { userId: 'user_service_base_1', requestedUrl: 'https://byoc.example.test/capy/api/auth/create-org' },
    ]);
  });

  test('rejects ambiguous configured service bases before rotating or requesting', async () => {
    const bases = [
      'https://user@service.example.test',
      'https://service.example.test?target=other',
      'https://service.example.test#other',
      'file:///private/service',
    ] as const;
    const failures = await bases.reduce(async (prior, base, index): Promise<readonly unknown[]> => {
      const previous = await prior;
      const userId = `user_invalid_base_${index}`;
      const refreshToken = `refresh-${userId}`;
      const backend = new FileSessionStorageBackend();
      seed(backend, session(refreshToken, userId));
      const auth = new AuthService(base, false, userId, backend, ORG_A.id);
      const failure = await errorOf(auth.createOrganization(ORG_B.name, refreshToken, userId));
      return [...previous, failure];
    }, Promise.resolve([] as readonly unknown[]));

    expect(failures.map((failure) => (failure as CapyError).code)).toEqual([
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bases.every((_base, index) => !existsSync(fencePath(`user_invalid_base_${index}`)))).toBeTrue();
  });

  test('uses one total deadline across fetch and body without accepting a late body', async () => {
    jest.useFakeTimers();
    try {
      const backend = new FileSessionStorageBackend();
      seed(backend);
      const fetchStarted = Promise.withResolvers<RequestInit>();
      const bodyStarted = Promise.withResolvers<void>();
      const lateBody = Promise.withResolvers<string>();
      fetchSpy.mockImplementation((_url, init) => {
        fetchStarted.resolve(init ?? {});
        return new Promise<Response>((resolve) => setTimeout(() => resolve({
          ok: true,
          status: 201,
          text: () => {
            bodyStarted.resolve();
            return lateBody.promise;
          },
        } as Response), 10_000));
      });
      const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend, ORG_A.id);
      const creation = auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID);
      const init = await fetchStarted.promise;

      jest.advanceTimersByTime(10_000);
      await bodyStarted.promise;
      jest.advanceTimersByTime(5_000);
      const failure = await errorOf(creation);
      lateBody.resolve(JSON.stringify(response()));
      await Promise.resolve();

      expect(failure).toBeInstanceOf(CapyError);
      expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
      expect((init.signal as AbortSignal).aborted).toBeTrue();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(stored()).toEqual(session('refresh-r0'));
      expect(existsSync(fencePath())).toBeTrue();
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects stale caller authority before the provider request', async () => {
    const backend = new FileSessionStorageBackend();
    seed(backend);
    const stale = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend, ORG_A.id);
    expect(backend.saveIfRefreshAuthorityMatches(session('refresh-r2'), USER_ID, null)).toBeFalse();
    expect(backend.saveIfRefreshAuthorityMatches(session('refresh-r2'), USER_ID,
      (await import('../../src/auth/initRunSessionInstaller')).refreshTokenAuthorityDigest(session('refresh-r0')))).toBeTrue();

    const failure = await errorOf(stale.createOrganization(ORG_B.name, 'refresh-r2', USER_ID));
    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(fencePath())).toBeFalse();
  });

  test('rejects missing persisted authority before the provider request', async () => {
    const backend = new FileSessionStorageBackend();
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend);
    const failure = await errorOf(auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID));
    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects token, name, subject, and expiry mismatches under a retained fence', async () => {
    type MismatchOutcome = Readonly<{ userId: string; failure: unknown; initial: SessionStore }>;
    const variants = [
      (userId: string) => response(userId, { refresh_token: `refresh-${userId}-r0` }),
      (userId: string) => response(userId, { name: 'Different Organization' }),
      (userId: string) => response(userId, { access_token: jwt({ sub: 'user_other', org_id: ORG_B.workos_org_id }) }),
      (userId: string) => response(userId, { expires_in: 0 }),
    ] as const;
    const outcomes = await variants.reduce(async (prior, variant, index): Promise<readonly MismatchOutcome[]> => {
      const previous = await prior;
      const userId = `user_mismatch_${index}`;
      const refreshToken = `refresh-${userId}-r0`;
      const backend = new FileSessionStorageBackend();
      const initial = session(refreshToken, userId);
      seed(backend, initial);
      const auth = new AuthService(SERVICE_ORIGIN, false, userId, backend, ORG_A.id);
      fetchSpy.mockResolvedValueOnce(Response.json(variant(userId), { status: 201 }));
      const failure = await errorOf(auth.createOrganization(ORG_B.name, refreshToken, userId));
      return [...previous, { userId, failure, initial }];
    }, Promise.resolve([] as readonly MismatchOutcome[]));

    expect(outcomes.map(({ failure }) => (failure as CapyError).code)).toEqual([
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
      'INIT_DELIVERY_INDETERMINATE',
    ]);
    expect(outcomes.every(({ userId, initial }) => JSON.stringify(stored(userId)) === JSON.stringify(initial))).toBeTrue();
    expect(outcomes.every(({ userId }) => existsSync(fencePath(userId)))).toBeTrue();
  });

  test('clears only the exact pre-refresh name conflict fence', async () => {
    const backend = new FileSessionStorageBackend();
    seed(backend);
    fetchSpy.mockResolvedValue(Response.json({
      code: 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH',
      error: 'reserved',
    }, { status: 409 }));
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend, ORG_A.id);
    const failure = await errorOf(auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID));

    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('AUTH_ORG_NAME_TAKEN_PRE_REFRESH');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual(session('refresh-r0'));
    expect(existsSync(fencePath())).toBeFalse();
  });

  test('retains the fence for generic conflicts and quota presentation', async () => {
    type FailureOutcome = Readonly<{ userId: string; failure: unknown }>;
    const cases = [
      { userId: 'user_generic_conflict', status: 409, body: { error: 'conflict' }, code: 'INIT_DELIVERY_INDETERMINATE' },
      { userId: 'user_quota', status: 402, body: { code: ERROR_CODES.QUOTA_EXCEEDED, error: 'Account limit', kind: 'organization', limit: 1 }, code: ERROR_CODES.QUOTA_EXCEEDED },
    ] as const;
    const failures = await cases.reduce(async (prior, { userId, status, body }): Promise<readonly FailureOutcome[]> => {
      const previous = await prior;
      const refreshToken = `refresh-${userId}`;
      const backend = new FileSessionStorageBackend();
      seed(backend, session(refreshToken, userId));
      fetchSpy.mockResolvedValueOnce(Response.json(body, { status }));
      const auth = new AuthService(SERVICE_ORIGIN, false, userId, backend, ORG_A.id);
      const failure = await errorOf(auth.createOrganization(ORG_B.name, refreshToken, userId));
      return [...previous, { userId, failure }];
    }, Promise.resolve([] as readonly FailureOutcome[]));

    expect(failures.map(({ failure }) => (failure as CapyError).code)).toEqual(cases.map(({ code }) => code));
    expect(failures.every(({ userId }) => existsSync(fencePath(userId)))).toBeTrue();
  });

  test('keeps unknown transport outcomes fenced without retrying', async () => {
    const backend = new FileSessionStorageBackend();
    seed(backend);
    fetchSpy.mockRejectedValue(new Error('private transport failure'));
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, backend, ORG_A.id);
    const failure = await errorOf(auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID));

    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(fencePath())).toBeTrue();
    expect(stored()).toEqual(session('refresh-r0'));
  });

  test('projects save and readback refusal to a fixed indeterminate result', async () => {
    const real = new FileSessionStorageBackend();
    seed(real);
    const refusing = {
      load: (userId: string | undefined) => real.load(userId),
      save: (_session: SessionStore, _userId: string | undefined): void => { throw new Error('private write failure'); },
      clear: (userId: string | undefined) => real.clear(userId),
      discover: () => real.discover(),
      withRefreshLock: <T>(userId: string | undefined, run: Parameters<SessionStorageBackend['withRefreshLock']>[1]) =>
        real.withRefreshLock(userId, run as (fresh: SessionStore | null, beginRotation: () => void) => Promise<T>),
    } satisfies SessionStorageBackend;
    fetchSpy.mockResolvedValue(Response.json(response(), { status: 201 }));
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, refusing, ORG_A.id);
    const failure = await errorOf(auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID));

    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(existsSync(fencePath())).toBeTrue();
    expect(stored()).toEqual(session('refresh-r0'));
  });

  test('rejects expiry-only readback drift without reverting the installed authority', async () => {
    const real = new FileSessionStorageBackend();
    seed(real);
    const load = mock((userId: string | undefined) => {
      const current = real.load(userId);
      const selected = current?.sessions[ORG_B.id];
      return load.mock.calls.length === 1 || !current || !selected
        ? current
        : {
          ...current,
          sessions: {
            ...current.sessions,
            [ORG_B.id]: { ...selected, expires_at: selected.expires_at + 1 },
          },
        };
    });
    const unreadable = {
      load,
      save: (next: SessionStore, userId: string | undefined) => real.save(next, userId),
      clear: (userId: string | undefined) => real.clear(userId),
      discover: () => real.discover(),
      withRefreshLock: <T>(userId: string | undefined, run: Parameters<SessionStorageBackend['withRefreshLock']>[1]) =>
        real.withRefreshLock(userId, run as (fresh: SessionStore | null, beginRotation: () => void) => Promise<T>),
    } satisfies SessionStorageBackend;
    fetchSpy.mockResolvedValue(Response.json(response(), { status: 201 }));
    const auth = new AuthService(SERVICE_ORIGIN, false, USER_ID, unreadable, ORG_A.id);

    const failure = await errorOf(auth.createOrganization(ORG_B.name, 'refresh-r0', USER_ID));

    expect(failure).toBeInstanceOf(CapyError);
    expect((failure as CapyError).code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(stored()?.refresh_token).toBe('refresh-r1');
    expect(stored()?.organizations).toEqual([ORG_A, ORG_B]);
    expect(existsSync(fencePath())).toBeFalse();
  });
});
