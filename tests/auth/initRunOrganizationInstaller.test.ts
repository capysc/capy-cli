import { afterEach, describe, expect, it, jest } from 'bun:test';
import { AuthService, type SessionStorageBackend } from '../../src/auth/authService';
import {
  INIT_RUN_ORGANIZATION_INDETERMINATE,
  INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH,
  parseInitRunCreatedOrganizationResponse,
  prepareInitRunCreatedOrganizationInstallation,
  type InitRunCreatedOrganizationResponse,
} from '../../src/auth/initRunOrganizationInstaller';
import type { SessionStore } from '../../src/types/index';

const SERVICE_ORIGIN = 'https://service.example.test';
const USER_ID = 'user_expected';
const NOW = 1_799_000_000_000;

const jwt = (claims: Readonly<Record<string, unknown>>): string =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;

const initialSession = (): SessionStore => ({
  version: 2,
  user_id: USER_ID,
  user_email: 'fixture@example.com',
  user_first_name: null,
  user_last_name: null,
  refresh_token: 'rt_before',
  organizations: [],
  sessions: {},
});

const response = (overrides: Partial<InitRunCreatedOrganizationResponse> = {}): InitRunCreatedOrganizationResponse => ({
  id: '11111111-1111-4111-8111-111111111111',
  workos_org_id: 'org_workos_new',
  name: 'New Organization',
  access_token: jwt({ sub: USER_ID, org_id: 'org_workos_new' }),
  refresh_token: 'rt_after',
  expires_in: 600,
  user: { id: USER_ID, email: 'fixture@example.com', first_name: null, last_name: null },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const storage = (initial: SessionStore = initialSession()): Readonly<{
  backend: SessionStorageBackend;
  load: ReturnType<typeof jest.fn>;
  save: ReturnType<typeof jest.fn>;
}> => {
  const save = jest.fn((_session: SessionStore, _userId: string | undefined) => undefined);
  const load = jest.fn((_userId: string | undefined): SessionStore =>
    (save.mock.calls[save.mock.calls.length - 1]?.[0] as SessionStore | undefined) ?? initial);
  return {
    load,
    save,
    backend: {
      load,
      save,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, operation) => operation(initial, () => undefined),
    },
  };
};

afterEach(() => jest.restoreAllMocks());

describe('hosted init-run organization installation', () => {
  it('strictly parses the service response and rejects additive or malformed fields', () => {
    const valid = response();
    expect(parseInitRunCreatedOrganizationResponse(valid)).toEqual(valid);
    expect(parseInitRunCreatedOrganizationResponse({ ...valid, extra: true })).toBeNull();
    expect(parseInitRunCreatedOrganizationResponse({ ...valid, expires_in: 0 })).toBeNull();
    expect(parseInitRunCreatedOrganizationResponse({ ...valid, user: { ...valid.user, extra: true } })).toBeNull();
  });

  it('prepares one selected organization only for the exact subject, provider org and unexpired token', () => {
    const prepared = prepareInitRunCreatedOrganizationInstallation({
      response: response(),
      expectedUserId: USER_ID,
      requestedName: ' New Organization ',
      previousSession: initialSession(),
      expiresAt: NOW + 600_000,
      now: NOW,
    });

    expect(prepared.organization).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      workos_org_id: 'org_workos_new',
      name: 'New Organization',
    });
    expect(prepared.session).toMatchObject({
      user_id: USER_ID,
      refresh_token: 'rt_after',
      organizations: [prepared.organization],
      sessions: {
        [prepared.organization.id]: {
          access_token: response().access_token,
          expires_at: NOW + 600_000,
        },
      },
    });
    expect(prepared.auth).toMatchObject({
      success: true,
      user_id: USER_ID,
      organization_id: prepared.organization.id,
      organizations: [prepared.organization],
    });

    const mismatches = [
      response({ user: { ...response().user, id: 'user_other' } }),
      response({ access_token: jwt({ sub: USER_ID, org_id: 'org_other' }) }),
      response({ name: 'Other Name' }),
    ] as const;
    for (const mismatched of mismatches) {
      const error = (() => {
        try {
          prepareInitRunCreatedOrganizationInstallation({
            response: mismatched,
            expectedUserId: USER_ID,
            requestedName: 'New Organization',
            previousSession: initialSession(),
            expiresAt: NOW + 600_000,
            now: NOW,
          });
          return null;
        } catch (cause) {
          return cause;
        }
      })() as Readonly<{ code?: string }> | null;
      expect(error?.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    }
  });

  it('refuses an existing organization identity and an expired prepared token', () => {
    const created = response();
    const duplicate = { ...initialSession(), organizations: [{
      id: 'org_existing', workos_org_id: 'workos_existing', name: created.name,
    }] };
    const duplicateError = (() => {
      try {
        prepareInitRunCreatedOrganizationInstallation({
          response: created, expectedUserId: USER_ID, requestedName: created.name,
          previousSession: duplicate, expiresAt: NOW + 1, now: NOW,
        });
        return null;
      } catch (cause) { return cause; }
    })() as Readonly<{ code?: string }> | null;
    const expiredError = (() => {
      try {
        prepareInitRunCreatedOrganizationInstallation({
          response: created, expectedUserId: USER_ID, requestedName: created.name,
          previousSession: initialSession(), expiresAt: NOW, now: NOW,
        });
        return null;
      } catch (cause) { return cause; }
    })() as Readonly<{ code?: string }> | null;

    expect(duplicateError?.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(expiredError?.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
  });

  it('posts once with the captured stored refresh authority and returns a read-back replacement', async () => {
    const target = storage();
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const authService = new AuthService(SERVICE_ORIGIN, false, USER_ID, target.backend);

    const installed = await authService.createInitRunOrganization(' New Organization ', {
      userId: USER_ID,
      deadline: Date.now() + 60_000,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${SERVICE_ORIGIN}/auth/create-org`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      name: 'New Organization',
      refresh_token: 'rt_before',
    });
    expect(target.save).toHaveBeenCalledTimes(1);
    expect(installed.organization.id).toBe(response().id);
    expect(installed.auth.organization_id).toBe(response().id);
    expect(installed.authService).not.toBe(authService);
    expect(installed.authService.getToken()).toMatchObject({
      user_id: USER_ID,
      organization_id: response().id,
      access_token: response().access_token,
    });
  });

  it('refuses an untrusted service origin or non-zero-org authority before sending the refresh token', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const untrustedTarget = storage();
    const untrusted = new AuthService('http://service.example.test', false, USER_ID, untrustedTarget.backend);
    const originError = await untrusted.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(originError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(fetcher).not.toHaveBeenCalled();
    expect(untrustedTarget.save).not.toHaveBeenCalled();

    const existing = {
      ...initialSession(),
      organizations: [{ id: 'org_existing', workos_org_id: 'workos_existing', name: 'Existing' }],
    };
    const existingTarget = storage(existing);
    const existingService = new AuthService(SERVICE_ORIGIN, false, USER_ID, existingTarget.backend);
    const authorityError = await existingService.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(authorityError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(fetcher).not.toHaveBeenCalled();
    expect(existingTarget.save).not.toHaveBeenCalled();
  });

  it('allows retry only for the closed pre-refresh name reservation code', async () => {
    const target = storage();
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      code: INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH,
      error: 'fixture text is not an authority',
    }, 409));
    const authService = new AuthService(SERVICE_ORIGIN, false, USER_ID, target.backend);

    const error = await authService.createInitRunOrganization('Reserved', {
      userId: USER_ID,
      deadline: Date.now() + 60_000,
    }).catch((cause) => cause);

    expect(error.code).toBe(INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(target.save).not.toHaveBeenCalled();
  });

  it('fails closed without replay for provider conflicts, lost responses and invalid success bodies', async () => {
    const cases = [
      () => Promise.resolve(jsonResponse({ error: 'provider conflict after refresh' }, 409)),
      () => Promise.reject(new TypeError('response lost')),
      () => Promise.resolve(jsonResponse({ id: 'partial' }, 201)),
    ] as const;
    for (const outcome of cases) {
      const target = storage();
      const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(outcome as typeof fetch);
      const authService = new AuthService(SERVICE_ORIGIN, false, USER_ID, target.backend);
      const error = await authService.createInitRunOrganization('New Organization', {
        userId: USER_ID,
        deadline: Date.now() + 60_000,
      }).catch((cause) => cause);

      expect(error.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(target.save).not.toHaveBeenCalled();
      fetcher.mockRestore();
    }
  });

  it('bounds a stalled request and never starts a second request', async () => {
    const target = storage();
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch);
    const authService = new AuthService(SERVICE_ORIGIN, false, USER_ID, target.backend);
    const error = await authService.createInitRunOrganization('New Organization', {
      userId: USER_ID,
      deadline: Date.now() + 10,
    }).catch((cause) => cause);

    expect(error.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(target.save).not.toHaveBeenCalled();
  });

  it('refuses storage drift, write failure and replacement read-back failure after one response', async () => {
    const original = initialSession();
    const changed = { ...original, refresh_token: 'rt_changed' };
    const driftSave = jest.fn();
    const driftBackend: SessionStorageBackend = {
      load: jest.fn()
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(changed),
      save: driftSave,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, operation) => operation(original, () => undefined),
    };
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const driftService = new AuthService(SERVICE_ORIGIN, false, USER_ID, driftBackend);
    const driftError = await driftService.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(driftError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    // The operation is serialized around the fresh session supplied by the
    // backend; a later replacement-read mismatch is indeterminate after the
    // single persistence attempt.
    expect(driftSave).toHaveBeenCalledTimes(1);

    fetcher.mockRestore();
    const writeTarget = storage();
    writeTarget.save.mockImplementation(() => { throw new Error('write failed'); });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const writeService = new AuthService(SERVICE_ORIGIN, false, USER_ID, writeTarget.backend);
    const writeError = await writeService.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(writeError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(writeTarget.save).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
    const readbackSave = jest.fn();
    const readbackBackend: SessionStorageBackend = {
      load: jest.fn()
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(null),
      save: readbackSave,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, operation) => operation(original, () => undefined),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const readbackService = new AuthService(SERVICE_ORIGIN, false, USER_ID, readbackBackend);
    const readbackError = await readbackService.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(readbackError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(readbackSave).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
    const throwingReadbackSave = jest.fn();
    const throwingReadbackBackend: SessionStorageBackend = {
      load: jest.fn()
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(original)
        .mockImplementation(() => { throw new Error('read-back failed'); }),
      save: throwingReadbackSave,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, operation) => operation(original, () => undefined),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response(), 201));
    const throwingReadbackService = new AuthService(SERVICE_ORIGIN, false, USER_ID, throwingReadbackBackend);
    const throwingReadbackError = await throwingReadbackService.createInitRunOrganization('New Organization', {
      userId: USER_ID, deadline: Date.now() + 60_000,
    }).catch((cause) => cause);
    expect(throwingReadbackError.code).toBe(INIT_RUN_ORGANIZATION_INDETERMINATE);
    expect(throwingReadbackSave).toHaveBeenCalledTimes(1);
  });
});
