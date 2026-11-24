/**
 * A request sent in the last moments of an access token's life gets a 401 from the service while our local clock
 * still calls the token fresh. The CLI must then obtain a token DIFFERENT from the rejected one before its single
 * retry: adopt the one another process already stored, or refresh now (once, however many requests were refused).
 *
 * Real `AuthService` + real `ServiceClient` over a real session file in a temp directory; only `fetch` (the
 * service) is replaced. Assertions are about properties: which token each request carried, how many refreshes ran,
 * what the session file holds afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative } from 'path';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const WORKOS_ORG_ID = 'workos-org-1';
const API_URL = 'http://localhost:3999';

const tempRoot = mkdtempSync(join(tmpdir(), 'capy-refresh-401-'));
const capyDir = join(tempRoot, '.capy');
const sessionFile = join(capyDir, 'auth', 'sessions', `${USER_ID}.json`);
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
const savedTtlOverride = process.env.CAPY_TOKEN_TTL_SECONDS;

beforeAll(() => {
  // `getGlobalCapyDir()` is `join(homedir(), CAPY_GLOBAL_DIR_NAME)`; a relative name steers it into the temp dir.
  process.env.CAPY_GLOBAL_DIR_NAME = relative(homedir(), capyDir);
  delete process.env.CAPY_TOKEN_TTL_SECONDS;
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
  if (savedTtlOverride === undefined) delete process.env.CAPY_TOKEN_TTL_SECONDS;
  else process.env.CAPY_TOKEN_TTL_SECONDS = savedTtlOverride;
});

afterEach(() => {
  mock.restore();
});

/** An unsigned JWT scoped to the test org. `label` makes each token distinct. */
function jwt(label: string, expSecondsFromNow = 600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: USER_ID,
    org_id: WORKOS_ORG_ID,
    jti: label,
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })).toString('base64url');
  return `${header}.${payload}.sig-${label}`;
}

const REJECTED = jwt('rejected');
const OTHER_PROCESS = jwt('stored-by-another-process');
const FRESH = jwt('fresh');

function writeStoredSession(accessToken: string, refreshToken: string): void {
  mkdirSync(join(capyDir, 'auth', 'sessions'), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({
    version: 2,
    user_id: USER_ID,
    user_email: 'test@example.com',
    refresh_token: refreshToken,
    organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: 'Test Org' }],
    sessions: { [ORG_ID]: { access_token: accessToken, expires_at: Date.now() + 600_000 } },
  }));
}

function storedOrgSession(): { access_token: string; expires_at: number } {
  return JSON.parse(readFileSync(sessionFile, 'utf-8')).sessions[ORG_ID];
}

function storedRefreshToken(): string {
  return JSON.parse(readFileSync(sessionFile, 'utf-8')).refresh_token;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const refreshAnswersFresh = (): Response => json(200, { access_token: FRESH, refresh_token: 'rt-2', expires_in: 600 });
const refreshRefused = (): Response => json(401, { error: 'invalid_grant' });

interface FakeService {
  /** Access tokens the service accepts; any other bearer gets a 401. */
  readonly accepts: readonly string[];
  readonly onRefresh?: () => Response;
  readonly serviceDelayMs?: number;
  readonly refreshDelayMs?: number;
  /** What a 401 says. The CLI must not care. */
  readonly rejection?: () => Response;
  /** Status for an accepted bearer (default 200). */
  readonly acceptedStatus?: number;
}

const isRefreshCall = (url: unknown): boolean => String(url).endsWith('/auth/refresh');

function installFakeService(service: FakeService) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: RequestInit) => {
    if (isRefreshCall(input)) {
      await sleep(service.refreshDelayMs ?? 0);
      return (service.onRefresh ?? refreshAnswersFresh)();
    }
    await sleep(service.serviceDelayMs ?? 0);
    const bearer = new Headers(init?.headers).get('authorization');
    const accepted = service.accepts.some(token => bearer === `Bearer ${token}`);
    if (accepted) return json(service.acceptedStatus ?? 200, { projects: [] });
    return (service.rejection ?? (() => json(401, { error: 'Token expired' })))();
  }) as unknown as typeof fetch);
}

type FetchSpy = ReturnType<typeof installFakeService>;

/** The Authorization header of every service request, in order. */
function bearersSent(spy: FetchSpy): Array<string | null> {
  return spy.mock.calls
    .filter(([url]) => !isRefreshCall(url))
    .map(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get('authorization'));
}

/** The body of every refresh call, in order. */
function refreshBodies(spy: FetchSpy): Array<{ refresh_token: string; organization_id: string }> {
  return spy.mock.calls
    .filter(([url]) => isRefreshCall(url))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

const bearer = (token: string): string => `Bearer ${token}`;

async function signedInClient(): Promise<ServiceClient> {
  const auth = new AuthService(API_URL, false, USER_ID);
  const result = await auth.authenticateSilent(ORG_ID);
  expect(result.success).toBe(true);
  const client = new ServiceClient(API_URL);
  client.setTokenProvider((rejected, refusal) => auth.getValidToken(rejected, refusal));
  return client;
}

async function failureOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(() => undefined, (error: unknown) => error);
}

describe('a 401 for a token our clock still calls fresh', () => {
  test('retries once with a DIFFERENT token, after exactly one refresh', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH] });
    const client = await signedInClient();

    await expect(client.listProjects()).resolves.toEqual([]);

    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(FRESH)]);
    expect(refreshBodies(spy)).toEqual([{ refresh_token: 'rt-1', organization_id: ORG_ID }]);
    expect(storedOrgSession().access_token).toBe(FRESH);
    expect(storedRefreshToken()).toBe('rt-2');
  });

  test('another process already refreshed: its stored token is adopted, no refresh call is made', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [OTHER_PROCESS] });
    const client = await signedInClient();
    // The other process stores its refresh after we loaded our copy.
    writeStoredSession(OTHER_PROCESS, 'rt-other');

    await expect(client.listProjects()).resolves.toEqual([]);

    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(OTHER_PROCESS)]);
    expect(refreshBodies(spy)).toEqual([]);
  });

  test('a stored copy that is still the rejected token is not adopted: it refreshes instead', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH] });
    const client = await signedInClient();

    await client.listProjects();

    expect(refreshBodies(spy)).toHaveLength(1);
    expect(bearersSent(spy)).not.toEqual([bearer(REJECTED), bearer(REJECTED)]);
  });

  test('what the 401 says is irrelevant: only its status decides', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH], rejection: () => new Response('not json at all', { status: 401 }) });
    const client = await signedInClient();

    await expect(client.listProjects()).resolves.toEqual([]);

    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(FRESH)]);
    expect(refreshBodies(spy)).toHaveLength(1);
  });

  test('N requests refused at once share ONE refresh; every retry carries the new token and succeeds', async () => {
    const requests = 6;
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH], serviceDelayMs: 5, refreshDelayMs: 30 });
    const client = await signedInClient();

    const results = await Promise.all(Array.from({ length: requests }, () => client.listProjects()));

    expect(results).toEqual(Array.from({ length: requests }, () => []));
    expect(refreshBodies(spy)).toHaveLength(1);
    expect(bearersSent(spy)).toEqual([
      ...Array.from({ length: requests }, () => bearer(REJECTED)),
      ...Array.from({ length: requests }, () => bearer(FRESH)),
    ]);
  });

  test('requests refused a few ms apart, some after the refresh finished, still cause one refresh', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH], serviceDelayMs: 20, refreshDelayMs: 20 });
    const client = await signedInClient();

    const staggered = [0, 4, 8, 45].map(async (startAfterMs) => {
      await sleep(startAfterMs);
      return client.listProjects();
    });
    await expect(Promise.all(staggered)).resolves.toEqual([[], [], [], []]);

    expect(refreshBodies(spy)).toHaveLength(1);
    expect(bearersSent(spy).filter(sent => sent === bearer(FRESH))).toHaveLength(4);
  });

  test('the refresh fails: AUTH_FAILED as before, and the rejected token is never sent a second time', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [FRESH], onRefresh: refreshRefused });
    const client = await signedInClient();

    const error = await failureOf(client.listProjects());

    expect(error).toBeInstanceOf(CapyError);
    expect((error as CapyError).code).toBe(ERROR_CODES.AUTH_FAILED);
    expect((error as CapyError).details).toEqual({ status: 401, detail: 'Token expired' });
    expect((error as CapyError).message).toBe('Authentication failed: Token expired');
    expect(bearersSent(spy)).toEqual([bearer(REJECTED)]);
    expect(refreshBodies(spy)).toHaveLength(1);
  });

  test('the refresh fails but another process stored a token meanwhile: that token is used', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({
      accepts: [OTHER_PROCESS],
      onRefresh: () => {
        // The other process spent the refresh token first and stored its result.
        writeStoredSession(OTHER_PROCESS, 'rt-other');
        return refreshRefused();
      },
    });
    const client = await signedInClient();

    await expect(client.listProjects()).resolves.toEqual([]);

    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(OTHER_PROCESS)]);
    expect(refreshBodies(spy)).toHaveLength(1);
  });

  test('a 401 on the retry fails: no third attempt, no second refresh', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [] });
    const client = await signedInClient();

    const error = await failureOf(client.listProjects());

    expect((error as CapyError).code).toBe(ERROR_CODES.AUTH_FAILED);
    expect((error as CapyError).details).toEqual({ status: 401, detail: 'Token expired' });
    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(FRESH)]);
    expect(refreshBodies(spy)).toHaveLength(1);
  });
});

describe('everything else is unchanged', () => {
  test('a 200 never refreshes', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [REJECTED] });
    const client = await signedInClient();

    await client.listProjects();

    expect(bearersSent(spy)).toEqual([bearer(REJECTED)]);
    expect(refreshBodies(spy)).toEqual([]);
  });

  test('a 403 never refreshes and is not retried', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({
      accepts: [],
      rejection: () => json(403, { error: 'You do not have permission to perform this action.' }),
    });
    const client = await signedInClient();

    const error = await failureOf(client.listProjects());

    expect((error as CapyError).code).not.toBe(ERROR_CODES.AUTH_FAILED);
    expect(bearersSent(spy)).toEqual([bearer(REJECTED)]);
    expect(refreshBodies(spy)).toEqual([]);
  });

  test('a token whose local expiry has passed still refreshes before the request, as before', async () => {
    mkdirSync(join(capyDir, 'auth', 'sessions'), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({
      version: 2,
      user_id: USER_ID,
      refresh_token: 'rt-1',
      organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: 'Test Org' }],
      sessions: { [ORG_ID]: { access_token: REJECTED, expires_at: Date.now() - 1000 } },
    }));
    const spy = installFakeService({ accepts: [FRESH] });
    const auth = new AuthService(API_URL, false, USER_ID);
    // authenticateSilent itself refreshes an expired token; the provider is then asked for the (fresh) token.
    await auth.authenticateSilent(ORG_ID);
    const client = new ServiceClient(API_URL);
    client.setTokenProvider((rejected, refusal) => auth.getValidToken(rejected, refusal));

    await client.listProjects();

    expect(bearersSent(spy)).toEqual([bearer(FRESH)]);
    expect(refreshBodies(spy)).toHaveLength(1);
  });
});

describe('the local expiry of a refreshed token', () => {
  test('is never later than the JWT\'s own exp', async () => {
    const shortLived = jwt('short-lived', 60);
    writeStoredSession(REJECTED, 'rt-1');
    installFakeService({
      accepts: [shortLived],
      onRefresh: () => json(200, { access_token: shortLived, refresh_token: 'rt-2', expires_in: 600 }),
    });
    const client = await signedInClient();

    await client.listProjects();

    const jwtExpiryMs = JSON.parse(Buffer.from(shortLived.split('.')[1], 'base64url').toString()).exp * 1000;
    const { expires_at } = storedOrgSession();
    expect(expires_at).toBeLessThanOrEqual(jwtExpiryMs);
    expect(expires_at).toBeGreaterThan(Date.now());
  });

  test('CAPY_TOKEN_TTL_SECONDS still sets it, exactly as before', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    installFakeService({ accepts: [FRESH] });
    const client = await signedInClient();
    process.env.CAPY_TOKEN_TTL_SECONDS = '5';
    const before = Date.now();
    try {
      await client.listProjects();
    } finally {
      delete process.env.CAPY_TOKEN_TTL_SECONDS;
    }

    const { expires_at } = storedOrgSession();
    expect(expires_at).toBeGreaterThanOrEqual(before + 5000);
    expect(expires_at).toBeLessThanOrEqual(Date.now() + 5000);
  });
});

describe('a session the service did not hand out (SESSION_NOT_RECOGNIZED)', () => {
  const notRecognized = (): Response =>
    json(401, { error: 'This session was not issued by Capy. Sign in again.', code: 'SESSION_NOT_RECOGNIZED' });

  test('a refused request removes the saved session and says to sign in again, with no refresh and no retry', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    // The refresh would succeed here (a service mid-deploy): the route's answer alone decides.
    const spy = installFakeService({ accepts: [], rejection: notRecognized });
    const client = await signedInClient();

    const error = await failureOf(client.listProjects());

    expect(error).toBeInstanceOf(CapyError);
    expect((error as CapyError).code).toBe(ERROR_CODES.AUTH_FAILED);
    expect((error as CapyError).details?.code).toBe('SESSION_NOT_RECOGNIZED');
    expect((error as CapyError).details?.next_command).toBe('capy pair');
    expect((error as CapyError).message).toContain('sign in again');
    expect(bearersSent(spy)).toEqual([bearer(REJECTED)]);
    expect(refreshBodies(spy)).toHaveLength(0);
    expect(existsSync(sessionFile)).toBe(false);
  });

  test('another process signed in again meanwhile: its session is used once and its file is kept', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [OTHER_PROCESS], rejection: notRecognized });
    const client = await signedInClient();
    writeStoredSession(OTHER_PROCESS, 'rt-other');

    await expect(client.listProjects()).resolves.toEqual([]);

    expect(bearersSent(spy)).toEqual([bearer(REJECTED), bearer(OTHER_PROCESS)]);
    expect(refreshBodies(spy)).toHaveLength(0);
    expect(storedRefreshToken()).toBe('rt-other');
  });

  test('a refused refresh does not delete a session another process stored since', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const stale = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    stale.sessions[ORG_ID].expires_at = Date.now() - 1000;
    writeFileSync(sessionFile, JSON.stringify(stale));
    const auth = new AuthService(API_URL, false, USER_ID);
    // The new session is for the same user, with no cached token for this org yet.
    writeFileSync(sessionFile, JSON.stringify({ ...stale, refresh_token: 'rt-other', sessions: {} }));
    installFakeService({ accepts: [], onRefresh: notRecognized });

    const result = await auth.authenticateSilent(ORG_ID);

    expect(result.success).toBe(false);
    expect(existsSync(sessionFile)).toBe(true);
    expect(storedRefreshToken()).toBe('rt-other');
  });

  test('a second silent auth in the same run still says why there is no session', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const stale = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    stale.sessions[ORG_ID].expires_at = Date.now() - 1000;
    writeFileSync(sessionFile, JSON.stringify(stale));
    installFakeService({ accepts: [], onRefresh: notRecognized });
    const auth = new AuthService(API_URL, false, USER_ID);

    await auth.authenticateSilent(ORG_ID);
    const second = await auth.authenticateSilent();

    expect(second.success).toBe(false);
    expect(second.error_code).toBe('session_ended');
    expect(second.error).toContain('sign in again');
  });

  test('the next command finds no session instead of sending the refused token again', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const spy = installFakeService({ accepts: [], rejection: notRecognized, onRefresh: notRecognized });
    const client = await signedInClient();
    await failureOf(client.listProjects());
    const callsAfterFirstCommand = spy.mock.calls.length;

    const next = await new AuthService(API_URL, false, USER_ID).authenticateSilent(ORG_ID);

    expect(next.success).toBe(false);
    expect(next.error_code).toBe('no_session');
    expect(spy.mock.calls.length).toBe(callsAfterFirstCommand);
  });

  test('an expired token whose refresh is refused this way: silent auth says to sign in again and removes the session', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    const stored = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    stored.sessions[ORG_ID].expires_at = Date.now() - 1000;
    writeFileSync(sessionFile, JSON.stringify(stored));
    installFakeService({ accepts: [], onRefresh: notRecognized });

    const result = await new AuthService(API_URL, false, USER_ID).authenticateSilent(ORG_ID);

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('session_ended');
    expect(result.error).toContain('sign in again');
    expect(existsSync(sessionFile)).toBe(false);
  });

  test('an ordinary refused refresh (no code) still keeps the session file', async () => {
    writeStoredSession(REJECTED, 'rt-1');
    installFakeService({ accepts: [], onRefresh: refreshRefused });
    const client = await signedInClient();

    await failureOf(client.listProjects());

    expect(existsSync(sessionFile)).toBe(true);
  });
});
