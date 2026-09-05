import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { lock } from 'proper-lockfile';

// Only the home directory and HTTP boundary are faked. Persistence and locks
// are real: mocking proper-lockfile previously hid the ESYNC regression.
const temporaryHome = mkdtempSync(join(os.tmpdir(), 'capy-refresh-test-'));
mock.module('os', () => ({ ...os, homedir: () => temporaryHome }));
const oauthConstructor = mock(() => { throw new Error('Unexpected interactive sign-in'); });
mock.module('../../src/auth/oauthServer', () => ({ OAuthServer: oauthConstructor }));
const fetchMock = spyOn(globalThis, 'fetch');

const { AuthService } = await import('../../src/auth/authService');
const { getAuthSessionPath, saveAuthSession, readAuthSession } = await import('../../src/config/globalConfig');
import type { SessionStore } from '../../src/types';

function jwt(orgId: string): string {
  return `header.${Buffer.from(JSON.stringify({ org_id: `workos-${orgId}` })).toString('base64url')}.signature`;
}

function session(orgIds: readonly string[] = ['org-a']): SessionStore {
  return {
    version: 2,
    user_id: randomUUID(),
    refresh_token: 'original-refresh',
    organizations: orgIds.map(id => ({ id, workos_org_id: `workos-${id}`, name: id })),
    sessions: Object.fromEntries(orgIds.map(id => [id, {
      access_token: jwt(id), expires_at: Date.now() - 60_000,
    }])),
  };
}

function success(orgId = 'org-a', refreshToken = 'rotated-refresh'): Response {
  return Response.json({ access_token: jwt(orgId), refresh_token: refreshToken, expires_in: 3600 });
}

beforeEach(() => {
  fetchMock.mockReset();
  oauthConstructor.mockClear();
});

afterAll(() => {
  mock.restore();
  rmSync(temporaryHome, { recursive: true, force: true });
});

describe('refresh with real session files and locks', () => {
  test('concurrent instances refresh once and reuse the persisted rotated token', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const clients = [new AuthService('https://api.test', false, original.user_id),
      new AuthService('https://api.test', false, original.user_id)];
    fetchMock.mockImplementation(async () => {
      await delay(40);
      return success();
    });

    const results = await Promise.all(clients.map(client => client.authenticateSilent('org-a')));
    expect(results.every(result => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clients.map(client => client.getToken()?.refresh_token)).toEqual(['rotated-refresh', 'rotated-refresh']);
    expect((readAuthSession(original.user_id) as SessionStore).refresh_token).toBe('rotated-refresh');
    expect(statSync(getAuthSessionPath(original.user_id)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${getAuthSessionPath(original.user_id)}.lock`)).toBe(false);
  });

  test('concurrent org refreshes use the latest token and preserve both org sessions', async () => {
    const original = session(['org-a', 'org-b']);
    saveAuthSession(original, original.user_id);
    const clients = ['org-a', 'org-b'].map(orgId => ({
      orgId, client: new AuthService('https://api.test', false, original.user_id),
    }));
    fetchMock.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      await delay(40);
      return success(body.organization_id, `${body.refresh_token}-next`);
    });

    const results = await Promise.all(clients.map(({ orgId, client }) => client.authenticateSilent(orgId)));
    expect(results.every(result => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options!.body as string).refresh_token))
      .toEqual(['original-refresh', 'original-refresh-next']);
    const saved = readAuthSession(original.user_id) as SessionStore;
    expect(saved.refresh_token).toBe('original-refresh-next-next');
    expect(Object.values(saved.sessions).every(value => value.expires_at > Date.now())).toBe(true);
  });

  test('an idle instance rereads a token rotated by another process', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    saveAuthSession({ ...original, refresh_token: 'newer-on-disk' }, original.user_id);
    fetchMock.mockResolvedValueOnce(success());

    expect((await client.authenticateSilent('org-a')).success).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).refresh_token).toBe('newer-on-disk');
  });

  test('first refresh can lock a session file that does not exist yet', async () => {
    const userId = randomUUID();
    const client = new AuthService('https://api.test', false, userId);
    fetchMock.mockResolvedValueOnce(Response.json({
      access_token: jwt('org-a'), refresh_token: 'rotated-refresh', expires_in: 3600,
      organization: { id: 'org-a', workos_org_id: 'workos-org-a', name: 'A' },
    }));
    expect((await client.refreshWithCredentials('new-login', 'org-a', userId)).success).toBe(true);
    expect((readAuthSession(userId) as SessionStore).refresh_token).toBe('rotated-refresh');
  });

  test('explicit new-login credentials take precedence over an old saved login', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    fetchMock.mockResolvedValueOnce(success());
    expect((await client.refreshWithCredentials('new-login', 'org-a')).success).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).refresh_token).toBe('new-login');
  });

  test('lock contention never falls through to an unlocked refresh or sign-in', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const release = await lock(getAuthSessionPath(original.user_id), { realpath: false });
    try {
      const client = new AuthService('https://api.test', false, original.user_id);
      expect((await client.authenticate('org-a')).success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(oauthConstructor).not.toHaveBeenCalled();
      expect(readAuthSession(original.user_id)).toEqual(original);
    } finally {
      await release();
    }
  }, 10_000);

  test.each([429, 500, 503])('HTTP %i preserves the session and allows retry without OAuth', async status => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Temporary failure' }, { status }));
    expect((await client.authenticate('org-a')).error_code).toBe('server_error');
    expect(readAuthSession(original.user_id)).toEqual(original);
    expect(oauthConstructor).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(success());
    expect((await client.authenticate('org-a')).success).toBe(true);
    expect(client.getLastRefreshFailure()).toBeNull();
  });

  test('network errors preserve the session and do not launch OAuth', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
    expect((await client.authenticate('org-a')).error_code).toBe('network');
    expect(readAuthSession(original.user_id)).toEqual(original);
    expect(oauthConstructor).not.toHaveBeenCalled();
    expect(existsSync(`${getAuthSessionPath(original.user_id)}.lock`)).toBe(false);
  });

  test('an incomplete refresh response cannot overwrite the saved refresh token', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: jwt('org-a'), expires_in: 3600 }));
    expect((await client.authenticate('org-a')).error_code).toBe('server_error');
    expect(readAuthSession(original.user_id)).toEqual(original);
    expect(oauthConstructor).not.toHaveBeenCalled();
  });

  test('a malformed saved session is not bypassed using a stale in-memory token', async () => {
    const original = session();
    saveAuthSession(original, original.user_id);
    const client = new AuthService('https://api.test', false, original.user_id);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(getAuthSessionPath(original.user_id), '{');
    expect((await client.authenticate('org-a')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(oauthConstructor).not.toHaveBeenCalled();
  });
});
