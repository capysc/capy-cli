/**
 * CAP-409 — `buildSessionStoreFromAnswer` (pure) + `installPairedSession`
 * (writes through the CLI's one session-file writer, then resolves the
 * active org). HOME is pinned to a throwaway tmpdir BEFORE any module
 * resolves paths — never touches the real ~/.capy.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-install-paired-session-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

let interactive = false;
mock.module('../../../src/ui/interactive', () => ({
  isInteractive: () => interactive,
  EXIT_NEEDS_INPUT: 3,
}));

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import { buildSessionStoreFromAnswer, installPairedSession } from '../../../src/auth/pairing/installPairedSession';
import type { PairMachineAnswerSession } from '../../../src/auth/pairing/pairContract';
import { getAuthSessionPath } from '../../../src/config/globalConfig';

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  rmSync(join(tempHome, '.capy'), { recursive: true, force: true });
  interactive = false;
  globalThis.fetch = realFetch;
});

describe('buildSessionStoreFromAnswer', () => {
  test('maps user/org/refresh_token, defaults first/last name to null', () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_1', email: 'u@example.com' },
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', name: 'Org One' }],
    };
    const store = buildSessionStoreFromAnswer(answer);
    expect(store).toEqual({
      version: 2,
      user_id: 'user_1',
      user_email: 'u@example.com',
      user_first_name: null,
      user_last_name: null,
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', workos_org_id: 'org_1', name: 'Org One' }],
      sessions: {},
    });
  });

  test('preserves workos_org_id when the payload supplies it, and first/last name', () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_1', email: 'u@example.com', first_name: 'A', last_name: 'B' },
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wos_1' }],
    };
    const store = buildSessionStoreFromAnswer(answer);
    expect(store.user_first_name).toBe('A');
    expect(store.user_last_name).toBe('B');
    expect(store.organizations[0].workos_org_id).toBe('wos_1');
  });

  test('carries through an optional sessions map verbatim', () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_1', email: 'u@example.com' },
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', name: 'Org One' }],
      sessions: { org_1: { access_token: 'at_1', expires_at: 12345 } },
    };
    const store = buildSessionStoreFromAnswer(answer);
    expect(store.sessions).toEqual({ org_1: { access_token: 'at_1', expires_at: 12345 } });
  });
});

describe('installPairedSession — writes through the one session-file writer', () => {
  test('zero orgs: session is written, no active org, no network call', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_zero', email: 'zero@example.com' },
      refresh_token: 'rt_zero',
      organizations: [],
    };
    globalThis.fetch = (async () => {
      throw new Error('installPairedSession must not touch the network for a zero-org payload');
    }) as typeof fetch;

    const result = await installPairedSession(answer);
    expect(result).toEqual({ orgId: null, orgTokenReady: false });

    const path = getAuthSessionPath('user_zero');
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.user_id).toBe('user_zero');
    expect(onDisk.organizations).toEqual([]);
  });

  test('exactly one org, payload already carries a valid token: auto-selected, no network call', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_one', email: 'one@example.com' },
      refresh_token: 'rt_one',
      organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wos_1' }],
      sessions: { org_1: { access_token: fakeJwt({ org_id: 'wos_1' }), expires_at: Date.now() + 3_600_000 } },
    };
    globalThis.fetch = (async () => {
      throw new Error('installPairedSession must not refresh when the payload already has a valid cached token');
    }) as typeof fetch;

    const result = await installPairedSession(answer, { apiUrl: 'https://api.test.invalid' });
    expect(result).toEqual({ orgId: 'org_1', orgName: 'Org One', orgTokenReady: true });
  });

  test('exactly one org, no token in payload: falls through to the real silent-refresh path', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_refresh', email: 'refresh@example.com' },
      refresh_token: 'rt_needs_refresh',
      organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wos_1' }],
    };
    const calls: string[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      calls.push(String(url));
      const body = {
        access_token: fakeJwt({ org_id: 'wos_1' }),
        refresh_token: 'rt_rotated',
        expires_in: 3600,
        user: { id: 'user_refresh', email: 'refresh@example.com', first_name: null, last_name: null },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await installPairedSession(answer, { apiUrl: 'https://api.test.invalid' });
    expect(result.orgId).toBe('org_1');
    expect(result.orgTokenReady).toBe(true);
    expect(calls.some((u) => u.includes('/auth/refresh'))).toBe(true);
  });

  test('many orgs, non-interactive: no active org, no prompt, no network', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_many', email: 'many@example.com' },
      refresh_token: 'rt_many',
      organizations: [
        { id: 'org_1', name: 'Org One' },
        { id: 'org_2', name: 'Org Two' },
      ],
    };
    interactive = false;
    globalThis.fetch = (async () => {
      throw new Error('must not touch the network when no org was selected');
    }) as typeof fetch;

    const result = await installPairedSession(answer);
    expect(result).toEqual({ orgId: null, orgTokenReady: false });
  });

  test('many orgs, an injected selector chooses one: that org is installed', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_pick', email: 'pick@example.com' },
      refresh_token: 'rt_pick',
      organizations: [
        { id: 'org_1', name: 'Org One', workos_org_id: 'wos_1' },
        { id: 'org_2', name: 'Org Two', workos_org_id: 'wos_2' },
      ],
      sessions: { org_2: { access_token: fakeJwt({ org_id: 'wos_2' }), expires_at: Date.now() + 3_600_000 } },
    };
    const selectCalls: unknown[] = [];
    globalThis.fetch = (async () => {
      throw new Error('must not touch the network — org_2 already has a valid cached token');
    }) as typeof fetch;

    const result = await installPairedSession(answer, {
      selectOrg: async (orgs) => {
        selectCalls.push(orgs);
        return 'org_2';
      },
    });
    expect(result).toEqual({ orgId: 'org_2', orgName: 'Org Two', orgTokenReady: true });
    expect(selectCalls.length).toBe(1);
  });

  test('the session file is written even when the org-token refresh subsequently fails', async () => {
    const answer: PairMachineAnswerSession = {
      user: { id: 'user_refresh_fail', email: 'fail@example.com' },
      refresh_token: 'rt_bad',
      organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wos_1' }],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })) as typeof fetch;

    const result = await installPairedSession(answer, { apiUrl: 'https://api.test.invalid' });
    expect(result.orgId).toBe('org_1');
    expect(result.orgTokenReady).toBe(false);

    const path = getAuthSessionPath('user_refresh_fail');
    expect(existsSync(path)).toBe(true);
  });
});
