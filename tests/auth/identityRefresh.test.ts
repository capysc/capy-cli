import { afterEach, describe, expect, it, jest } from 'bun:test';
import { AuthService } from '../../src/auth/authService';
import type { SessionStorageBackend } from '../../src/auth/session/backend';
import {
  currentIdentityAccessToken,
  parseIdentityRefreshResponse,
  prepareIdentityRefresh,
  requestIdentityRefresh,
} from '../../src/auth/identityRefresh';
import type { SessionStore } from '../../src/types/index';

const USER = 'user_identity';
const ORIGIN = 'https://service.example.test';
const jwt = (claims: Readonly<Record<string, unknown>>): string =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const session = (): SessionStore => ({
  version: 2,
  user_id: USER,
  user_email: 'identity@example.test',
  refresh_token: 'refresh-before',
  organizations: [],
  sessions: {},
});
const response = (refreshToken = 'refresh-after') => ({
  access_token: jwt({ sub: USER, exp: Math.floor(Date.now() / 1000) + 600 }),
  refresh_token: refreshToken,
  expires_in: 600,
  user: { id: USER, email: 'identity@example.test', first_name: null, last_name: null },
});
const createdOrganizationResponse = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  workos_org_id: 'org_workos_identity',
  name: 'New Organization',
  access_token: jwt({ sub: USER, org_id: 'org_workos_identity' }),
  refresh_token: 'refresh-created',
  expires_in: 600,
  user: { id: USER, email: 'identity@example.test', first_name: null, last_name: null },
});

const backend = (initial: SessionStore): Readonly<{
  storage: SessionStorageBackend;
  save: ReturnType<typeof jest.fn>;
}> => {
  const save = jest.fn((_value: SessionStore, _userId: string | undefined) => undefined);
  const load = jest.fn(() => (save.mock.calls.at(-1)?.[0] as SessionStore | undefined) ?? initial);
  return {
    save,
    storage: {
      load,
      save,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, operation) => operation(load(), () => undefined),
    },
  };
};

afterEach(() => jest.restoreAllMocks());

describe('identity refresh session coordinator', () => {
  it('strictly parses the four-field service response', () => {
    const valid = response();
    expect(parseIdentityRefreshResponse(valid)).toEqual(valid);
    expect(parseIdentityRefreshResponse({ ...valid, scope: 'user' })).toBeNull();
    expect(parseIdentityRefreshResponse({ ...valid, expires_in: 0 })).toBeNull();
    expect(parseIdentityRefreshResponse({ ...valid, expires_in: '600' })).toBeNull();
    expect(parseIdentityRefreshResponse({ ...valid, expires_in: 600.5 })).toBeNull();
  });

  it('preserves an unselected session and installs only verified replacement authority', () => {
    const now = Date.now();
    const prepared = prepareIdentityRefresh({
      response: response(), previous: session(), currentOrgId: null, expectedUserId: USER, now,
    });
    expect(prepared.currentOrgId).toBeNull();
    expect(prepared.session.organizations).toEqual([]);
    expect(prepared.session.sessions).toEqual({});
    expect(prepared.session.refresh_token).toBe('refresh-after');
    expect(currentIdentityAccessToken(prepared.session, USER, now)).toBe(prepared.accessToken);
  });

  it('rejects a mismatched subject, stale token, and same refresh authority', () => {
    const now = Date.now();
    const cases = [
      { ...response(), access_token: jwt({ sub: 'other', exp: Math.floor(now / 1000) + 600 }) },
      { ...response(), access_token: jwt({ sub: USER, exp: Math.floor(now / 1000) - 1 }) },
      { ...response(), access_token: jwt({ sub: USER, exp: String(Math.floor(now / 1000) + 600) }) },
      { ...response(), access_token: jwt({ sub: USER, exp: Math.floor(now / 1000) + 600, org_id: 7 }) },
      { ...response(), refresh_token: 'refresh-before' },
    ] as const;
    for (const value of cases) {
      expect(() => prepareIdentityRefresh({
        response: value, previous: session(), currentOrgId: null, expectedUserId: USER, now,
      })).toThrow();
    }
  });

  it('preserves an actual provider organization claim without selecting a Capy organization', () => {
    const now = Date.now();
    const accessToken = jwt({ sub: USER, exp: Math.floor(now / 1000) + 600, org_id: 'org_actual' });
    const prepared = prepareIdentityRefresh({
      response: { ...response(), access_token: accessToken },
      previous: session(),
      currentOrgId: null,
      expectedUserId: USER,
      now,
    });
    expect(prepared.currentOrgId).toBeNull();
    expect(prepared.accessToken).toBe(accessToken);
    expect(prepared.session.identity_session?.access_token).toBe(accessToken);
    expect(prepared.auth._orgless_access_token).toBe(accessToken);
    expect(prepared.session.sessions).toEqual({});
  });

  it('posts identity mode once, persists, reads back, and returns a replacement service', async () => {
    const target = backend(session());
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response())));
    const auth = new AuthService(ORIGIN, false, USER, target.storage);
    const renewed = await auth.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      mode: 'identity', refresh_token: 'refresh-before',
    });
    expect(target.save).toHaveBeenCalledTimes(1);
    expect(renewed.authService).not.toBe(auth);
    expect(renewed.authService.getOrganizationId()).toBeNull();
    expect(renewed.auth.user_id).toBe(USER);
  });

  it('adopts a valid identity bearer without another provider request', async () => {
    const now = Date.now();
    const cached = prepareIdentityRefresh({
      response: response(), previous: session(), currentOrgId: null, expectedUserId: USER, now,
    }).session;
    const target = backend(cached);
    const fetcher = jest.spyOn(globalThis, 'fetch');
    const auth = new AuthService(ORIGIN, false, USER, target.storage);
    const renewed = await auth.renewInitRunIdentity({ userId: USER, deadline: now + 30_000 });

    expect(renewed.accessToken).toBe(cached.identity_session?.access_token);
    expect(fetcher).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  it('retains refresh lineage through two rotations and then creates an organization', async () => {
    const firstResponse = response('refresh-first');
    const secondResponse = response('refresh-second');
    const organizationResponse = createdOrganizationResponse();
    const fetcher = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(firstResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(organizationResponse), { status: 201 }));
    const target = backend(session());
    const initial = new AuthService(ORIGIN, false, USER, target.storage);
    const first = await initial.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    const afterFirst = target.storage.load(USER);
    if (!afterFirst?.identity_session) throw new Error('FIRST_IDENTITY_ROTATION_NOT_PERSISTED');
    target.storage.save({
      ...afterFirst,
      identity_session: { ...afterFirst.identity_session, expires_at: Date.now() - 1 },
    }, USER);
    const second = await first.authService.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second.accessToken).toBe(secondResponse.access_token);
    const adopted = await first.authService.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    expect(adopted.accessToken).toBe(secondResponse.access_token);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const installed = await second.authService.createInitRunOrganization(' New Organization ', {
      userId: USER,
      deadline: Date.now() + 30_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toBe(`${ORIGIN}/auth/create-org`);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      name: 'New Organization',
      refresh_token: 'refresh-second',
    });
    expect(installed.organization).toEqual({
      id: organizationResponse.id,
      workos_org_id: organizationResponse.workos_org_id,
      name: organizationResponse.name,
    });
    expect(installed.authService.getOrganizationId()).toBe(organizationResponse.id);
  });

  it('lets the original service rotate twice and create with its preserved root lineage', async () => {
    const firstResponse = response('refresh-first');
    const secondResponse = response('refresh-second');
    const organizationResponse = createdOrganizationResponse();
    const fetcher = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(firstResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(organizationResponse), { status: 201 }));
    const target = backend(session());
    const original = new AuthService(ORIGIN, false, USER, target.storage);
    await original.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    const afterFirst = target.storage.load(USER);
    if (!afterFirst?.identity_session) throw new Error('FIRST_IDENTITY_ROTATION_NOT_PERSISTED');
    target.storage.save({
      ...afterFirst,
      identity_session: { ...afterFirst.identity_session, expires_at: Date.now() - 1 },
    }, USER);
    const second = await original.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    expect(second.accessToken).toBe(secondResponse.access_token);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const installed = await original.createInitRunOrganization('New Organization', {
      userId: USER,
      deadline: Date.now() + 30_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toBe(`${ORIGIN}/auth/create-org`);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      name: 'New Organization',
      refresh_token: 'refresh-second',
    });
    expect(installed.organization.id).toBe(organizationResponse.id);
    expect(installed.authService.getOrganizationId()).toBe(organizationResponse.id);
  });

  it('rejects an unrelated login root after two rotations before another provider request', async () => {
    const firstResponse = response('refresh-first');
    const secondResponse = response('refresh-second');
    const fetcher = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(firstResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondResponse)));
    const target = backend(session());
    const initial = new AuthService(ORIGIN, false, USER, target.storage);
    const first = await initial.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    const afterFirst = target.storage.load(USER);
    if (!afterFirst?.identity_session) throw new Error('FIRST_IDENTITY_ROTATION_NOT_PERSISTED');
    target.storage.save({
      ...afterFirst,
      identity_session: { ...afterFirst.identity_session, expires_at: Date.now() - 1 },
    }, USER);
    const second = await first.authService.renewInitRunIdentity({ userId: USER, deadline: Date.now() + 30_000 });
    expect(second.accessToken).toBe(secondResponse.access_token);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const unrelatedAccessToken = jwt({ sub: USER, exp: Math.floor(Date.now() / 1000) + 600 });
    target.storage.save({
      ...session(),
      refresh_token: 'refresh-unrelated',
      identity_session: {
        access_token: unrelatedAccessToken,
        expires_at: Date.now() + 600_000,
        root_authority_sha256: 'f'.repeat(64),
      },
    }, USER);
    await expect(second.authService.renewInitRunIdentity({
      userId: USER,
      deadline: Date.now() + 30_000,
    })).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('identity refresh provider request boundary', () => {
  it('uses one exact identity request and accepts its strict response', async () => {
    const expected = response();
    const fetcher = jest.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(expected))));
    const refreshed = await requestIdentityRefresh({
      serviceOrigin: ORIGIN,
      refreshToken: 'refresh-before',
      deadline: Date.now() + 1_000,
      fetch: fetcher,
    });
    expect(refreshed).toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${ORIGIN}/auth/refresh`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'identity', refresh_token: 'refresh-before' }),
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects non-finite deadlines before making a provider request', async () => {
    const fetcher = jest.fn(() => Promise.resolve(new Response(JSON.stringify(response()))));
    const deadlines = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const;
    for (const deadline of deadlines) {
      await expect(requestIdentityRefresh({
        serviceOrigin: ORIGIN,
        refreshToken: 'refresh-before',
        deadline,
        fetch: fetcher,
      })).rejects.toMatchObject({ code: 'INIT_RUN_EXPIRED' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts and returns when an injected fetch ignores its clipped run deadline', async () => {
    const observed = Promise.withResolvers<RequestInit>();
    const fetcher = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      observed.resolve(init ?? {});
      return new Promise<Response>(() => undefined);
    });
    const startedAt = Date.now();
    const refresh = requestIdentityRefresh({
      serviceOrigin: ORIGIN,
      refreshToken: 'refresh-before',
      deadline: startedAt + 30,
      fetch: fetcher,
    });
    const init = await observed.promise;
    await expect(refresh).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect((init.signal as AbortSignal).aborted).toBeTrue();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the one deadline through a hung body and caps reader cancellation', async () => {
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    const fetcher = jest.fn(() => Promise.resolve(new Response(body)));
    const startedAt = Date.now();
    await expect(requestIdentityRefresh({
      serviceOrigin: ORIGIN,
      refreshToken: 'refresh-before',
      deadline: startedAt + 40,
      fetch: fetcher,
    })).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a response that arrives after the deadline without accepting late success', async () => {
    const pending = Promise.withResolvers<Response>();
    const cancel = jest.fn(() => Promise.resolve());
    const fetcher = jest.fn(() => pending.promise);
    const refresh = requestIdentityRefresh({
      serviceOrigin: ORIGIN,
      refreshToken: 'refresh-before',
      deadline: Date.now() + 30,
      fetch: fetcher,
    });
    await expect(refresh).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized body and never retries the provider request', async () => {
    const cancel = jest.fn(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(256 * 1024 + 1)),
      cancel,
    });
    const fetcher = jest.fn(() => Promise.resolve(new Response(body)));
    await expect(requestIdentityRefresh({
      serviceOrigin: ORIGIN,
      refreshToken: 'refresh-before',
      deadline: Date.now() + 1_000,
      fetch: fetcher,
    })).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
