/**
 * `resolveDokployApiKey` (CAP-664) — the shared resolver in front of every
 * Dokploy token lookup: the deploy adapter's preflight/deploy/onRemove, and
 * `capy connect dokploy`'s import. Pure unit tests, `getConnectorSecret`
 * injected — no auth, no network, no filesystem.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  DOKPLOY_CONNECTOR_SECRET_NAME,
  DokploySystemStoreCallOptions,
  describeDokployTokenProblem,
  resolveDokployApiKey,
} from '../../src/deploy/dokployApi';

const TOKEN = 'dk_test_token';

describe('resolveDokployApiKey', () => {
  test('a system-store entry is used when there is no explicit tokenEnv', async () => {
    const getConnectorSecret = mock(async () => TOKEN);
    const r = await resolveDokployApiKey({ env: {}, interactive: false, deps: { getConnectorSecret } });
    expect(r).toEqual({ ok: true, value: TOKEN, source: 'system' });
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
  });

  test('the store is asked for the exact connector secret name, with orgId/interactive/devMode passed through', async () => {
    const getConnectorSecret = mock(async (name: string, opts: DokploySystemStoreCallOptions) => {
      expect(name).toBe(DOKPLOY_CONNECTOR_SECRET_NAME);
      expect(opts).toEqual({ orgId: 'org_1', interactive: true, devMode: true, apiUrl: undefined });
      return TOKEN;
    });
    const r = await resolveDokployApiKey({
      env: {},
      interactive: true,
      orgId: 'org_1',
      devMode: true,
      deps: { getConnectorSecret },
    });
    expect(r.ok).toBe(true);
  });

  test('missing everywhere + non-interactive + no env: DOKPLOY_TOKEN_MISSING', async () => {
    const getConnectorSecret = mock(async () => null);
    const r = await resolveDokployApiKey({ env: {}, interactive: false, deps: { getConnectorSecret } });
    expect(r).toEqual({ ok: false, code: 'DOKPLOY_TOKEN_MISSING' });
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
  });

  test('no deps at all: resolves with zero network calls, same as a missing store', async () => {
    const r = await resolveDokployApiKey({ env: {}, interactive: false });
    expect(r).toEqual({ ok: false, code: 'DOKPLOY_TOKEN_MISSING' });
  });

  test('an explicit tokenEnv that IS set wins outright — the store is never called', async () => {
    const getConnectorSecret = mock(async () => TOKEN);
    const r = await resolveDokployApiKey({
      tokenEnv: 'MY_TOKEN',
      env: { MY_TOKEN: 'from-env' },
      interactive: false,
      deps: { getConnectorSecret },
    });
    expect(r).toEqual({ ok: true, value: 'from-env', source: 'env' });
    expect(getConnectorSecret).not.toHaveBeenCalled();
  });

  test('an explicit tokenEnv that is UNSET falls through to the store', async () => {
    const getConnectorSecret = mock(async () => TOKEN);
    const r = await resolveDokployApiKey({
      tokenEnv: 'MY_TOKEN',
      env: {},
      interactive: false,
      deps: { getConnectorSecret },
    });
    expect(r).toEqual({ ok: true, value: TOKEN, source: 'system' });
  });

  test('the default DOKPLOY_API_KEY still works as a fallback when the store has nothing', async () => {
    const getConnectorSecret = mock(async () => null);
    const r = await resolveDokployApiKey({
      env: { DOKPLOY_API_KEY: 'legacy-value' },
      interactive: false,
      deps: { getConnectorSecret },
    });
    expect(r).toEqual({ ok: true, value: 'legacy-value', source: 'env' });
  });

  test('a non-admin store refusal with no env fallback: refused with the STORE\'s own code', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const r = await resolveDokployApiKey({ env: {}, interactive: true, deps: { getConnectorSecret } });
    expect(r).toEqual({ ok: false, code: 'SYSTEM_STORE_ADMIN_ONLY' });
  });

  test('a non-admin store refusal still falls back to the default env var when it is set', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const r = await resolveDokployApiKey({
      env: { DOKPLOY_API_KEY: 'legacy-value' },
      interactive: true,
      deps: { getConnectorSecret },
    });
    expect(r).toEqual({ ok: true, value: 'legacy-value', source: 'env' });
  });

  test('any other store error (not admin-only) also falls through, then refuses with ITS code', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'AUTH_FAILED' };
    });
    const r = await resolveDokployApiKey({ env: {}, interactive: false, deps: { getConnectorSecret } });
    expect(r).toEqual({ ok: false, code: 'AUTH_FAILED' });
  });

  test('a thrown value with no .code still gets a stable (never a message-derived) code', async () => {
    const getConnectorSecret = mock(async () => {
      throw new Error('some prose the caller must never parse');
    });
    const r = await resolveDokployApiKey({ env: {}, interactive: false, deps: { getConnectorSecret } });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('DOKPLOY_STORE_ERROR');
  });

  test('a value the store returns is used verbatim, and only it — nothing derived or padded', async () => {
    const getConnectorSecret = mock(async () => '  not-trimmed-by-us  ');
    const r = await resolveDokployApiKey({ env: {}, interactive: false, deps: { getConnectorSecret } });
    expect(r).toEqual({ ok: true, value: '  not-trimmed-by-us  ', source: 'system' });
  });

  test('an empty string from the store counts as missing, not a value', async () => {
    const getConnectorSecret = mock(async () => '');
    const r = await resolveDokployApiKey({
      env: { DOKPLOY_API_KEY: 'fallback' },
      interactive: false,
      deps: { getConnectorSecret },
    });
    expect(r).toEqual({ ok: true, value: 'fallback', source: 'env' });
  });
});

describe('describeDokployTokenProblem', () => {
  test('DOKPLOY_TOKEN_MISSING keeps the exact pre-system-store wording', () => {
    const { reason } = describeDokployTokenProblem('DOKPLOY_TOKEN_MISSING', 'DOKPLOY_API_KEY');
    expect(reason).toBe('$DOKPLOY_API_KEY is not set');
  });

  test('SYSTEM_STORE_ADMIN_ONLY names both avenues, never a value', () => {
    const { reason, hint } = describeDokployTokenProblem('SYSTEM_STORE_ADMIN_ONLY', 'DOKPLOY_API_KEY');
    expect(reason).toContain('admin');
    expect(reason).toContain(DOKPLOY_CONNECTOR_SECRET_NAME);
    expect(hint).toContain('capy system set');
  });

  test('an unrecognized code still produces a printable reason + hint, with the code itself visible', () => {
    const { reason, hint } = describeDokployTokenProblem('SOME_OTHER_CODE', 'DOKPLOY_API_KEY');
    expect(reason).toContain('SOME_OTHER_CODE');
    expect(hint).toContain('capy system set');
  });
});
