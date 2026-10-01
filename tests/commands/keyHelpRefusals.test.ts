/**
 * Every ask for, and refusal for lack of, a Vercel token or a Dokploy API key
 * says where to get one: `link: { label, url }` + `remedy` on the JSON
 * refusal (the `Blocked` field names), and the URL in the human text on
 * stderr. Additive: the pre-existing fields are asserted still present.
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { createDokployConnector } from '../../src/commands/connectors/dokploy';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { createDokployAdapter } from '../../src/deploy/adapters/dokploy';
import { createVercelAdapter } from '../../src/deploy/adapters/vercel';
import { dokployKeyHelp, formatKeyHelp, keyHelpForName, vercelKeyHelp } from '../../src/deploy/keyHelp';
import type { TargetConfig } from '../../src/deploy/adapter';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { captureConsole, withExitCodeRestored } from '../helpers/testSandbox';

const VERCEL_PAGE = 'https://vercel.com/account/settings/tokens';
const DOKPLOY_BASE = 'https://deploy.example.test';

const ctxWith = (): ResolvedContext =>
  ({
    keep: { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} } as KeepFile,
    branch: 'production',
    orgId: 'org_1',
    localPlaintext: {},
  }) as unknown as ResolvedContext;

const unreachable: VercelFetchLike = async () => {
  throw new Error('no request expected');
};

/** Runs a refusal through the REAL `ConnectCommand` printing, once as JSON and once as human text. */
async function printed(connector: ReturnType<typeof createVercelConnector>, provider: string, opts: ConnectOpts) {
  const json = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false)['executeImport'](connector, provider, ctxWith(), { ...opts, json: true })));
  const human = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false)['executeImport'](connector, provider, ctxWith(), { ...opts, json: false })));
  return { json, human };
}

describe('keyHelp — the four known names', () => {
  test('Vercel: the token page and the --create-token alternative, for both names', () => {
    for (const name of ['_CONNECTOR_VERCEL_TOKEN', '_TARGET_VERCEL_TOKEN']) {
      const help = keyHelpForName(name);
      expect(help?.link.url).toBe(VERCEL_PAGE);
      expect(help?.remedy).toContain(`capy system set ${name}`);
      expect(help?.remedy).toContain('capy connect vercel --create-token');
    }
  });

  test('Dokploy: the page inside the user\'s own Dokploy when the base URL is known (trailing slashes ignored), else the docs', () => {
    expect(dokployKeyHelp('_CONNECTOR_DOKPLOY_API_KEY', `${DOKPLOY_BASE}///`).link.url).toBe(`${DOKPLOY_BASE}/dashboard/settings/profile`);
    expect(keyHelpForName('_TARGET_DOKPLOY_API_KEY')?.link.url).toBe('https://docs.dokploy.com/docs/api');
    expect(keyHelpForName('_TARGET_DOKPLOY_API_KEY', DOKPLOY_BASE)?.link.url).toBe(`${DOKPLOY_BASE}/dashboard/settings/profile`);
  });

  test('any other name has no help', () => {
    expect(keyHelpForName('_CONNECTOR_STRIPE_API_KEY')).toBeNull();
    expect(keyHelpForName('_CONNECTOR_WORKOS_API_KEY')).toBeNull();
  });

  test('the human text carries the URL and the remedy', () => {
    const text = formatKeyHelp(vercelKeyHelp('_CONNECTOR_VERCEL_TOKEN'));
    expect(text).toContain(VERCEL_PAGE);
    expect(text).toContain('capy system set _CONNECTOR_VERCEL_TOKEN');
  });
});

describe('capy connect vercel — key refusals', () => {
  const opts: ConnectOpts = { nonTty: true, project: 'web' };

  test('no token anywhere: VERCEL_TOKEN_MISSING carries link.url + remedy in JSON, and the URL on stderr; old fields intact', async () => {
    const connector = createVercelConnector({ fetch: unreachable, env: {} });
    const { json, human } = await printed(connector, 'vercel', opts);
    expect(json.stdout.length).toBe(1);
    const parsed = JSON.parse(json.stdout[0]);
    expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING, link: { url: VERCEL_PAGE } });
    expect(typeof parsed.message).toBe('string');
    expect(parsed.link.label).toBeTruthy();
    expect(parsed.remedy).toContain('--create-token');
    expect(human.stdout.join('')).toBe('');
    expect(human.stderr.join('\n')).toContain(VERCEL_PAGE);
  });

  test('the store refusing (not an admin / the other direction already has a key) carries it too', async () => {
    for (const code of [ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY, ERROR_CODES.VERCEL_CONNECTOR_KEY_MISSING]) {
      const getConnectorSecret = async () => {
        throw Object.assign(new Error('x'), { code });
      };
      const connector = createVercelConnector({ fetch: unreachable, env: {}, getConnectorSecret });
      const out = await connector.import!(ctxWith(), opts);
      expect(out).toMatchObject({ ok: false, code, link: { url: VERCEL_PAGE } });
      expect((out as { remedy?: string }).remedy).toBeTruthy();
    }
  });

  test('a rejected token (HTTP 401): VERCEL_AUTH_FAILED carries the link', async () => {
    const unauthorized: VercelFetchLike = async () => ({ status: 401, ok: false, text: async () => '{}' });
    const connector = createVercelConnector({ fetch: unauthorized, env: { T: 'x' }, sleep: async () => {} });
    const { json, human } = await printed(connector, 'vercel', { ...opts, tokenEnv: 'T' });
    expect(JSON.parse(json.stdout[0])).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_AUTH_FAILED, link: { url: VERCEL_PAGE } });
    expect(human.stderr.join('\n')).toContain(VERCEL_PAGE);
  });

  test('a refusal that is not about a key adds no link', async () => {
    const down: VercelFetchLike = async () => ({ status: 500, ok: false, text: async () => '{}' });
    const connector = createVercelConnector({ fetch: down, env: { T: 'x' }, sleep: async () => {} });
    const out = await connector.import!(ctxWith(), { nonTty: true, project: 'web', tokenEnv: 'T' });
    expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_API_ERROR });
    expect((out as { link?: unknown }).link).toBeUndefined();
    expect((out as { remedy?: unknown }).remedy).toBeUndefined();
  });
});

describe('capy connect dokploy — key refusals', () => {
  const opts: ConnectOpts = { nonTty: true, baseUrl: DOKPLOY_BASE, application: 'app_1', tokenEnv: 'MISSING_TOKEN' };

  test('missing key with a known base URL: link is that Dokploy\'s API-key page; JSON + stderr; old fields intact', async () => {
    const connector = createDokployConnector({ fetch: unreachable as never, env: {} });
    const { json, human } = await printed(connector as never, 'dokploy', opts);
    const parsed = JSON.parse(json.stdout[0]);
    expect(parsed).toMatchObject({ ok: false, code: 'DOKPLOY_TOKEN_MISSING', link: { url: `${DOKPLOY_BASE}/dashboard/settings/profile` } });
    expect(typeof parsed.message).toBe('string');
    expect(parsed.remedy).toContain('capy system set _CONNECTOR_DOKPLOY_API_KEY');
    expect(human.stderr.join('\n')).toContain(`${DOKPLOY_BASE}/dashboard/settings/profile`);
  });

  test('a rejected key (401): DOKPLOY_AUTH_FAILED carries the same link', async () => {
    const unauthorized = (async () => ({ status: 401, ok: false, text: async () => '{}', json: async () => ({}) })) as never;
    const connector = createDokployConnector({ fetch: unauthorized, env: { TOK: 'x' } });
    const out = await connector.import!(ctxWith(), { ...opts, tokenEnv: 'TOK' });
    expect(out).toMatchObject({ ok: false, code: 'DOKPLOY_AUTH_FAILED', link: { url: `${DOKPLOY_BASE}/dashboard/settings/profile` } });
  });

  test('--discover with a missing key carries the link too', async () => {
    const connector = createDokployConnector({ fetch: unreachable as never, env: {} });
    const out = await connector.discover!(
      { orgId: 'o', userId: 'u', authService: {}, serviceClient: {} } as never,
      { nonTty: true, baseUrl: DOKPLOY_BASE, tokenEnv: 'MISSING_TOKEN', discover: true },
    );
    expect(out).toMatchObject({ ok: false, code: 'DOKPLOY_TOKEN_MISSING', link: { url: `${DOKPLOY_BASE}/dashboard/settings/profile` } });
  });
});

describe('capy deploy — the preflight refusal for a missing or rejected key carries the link', () => {
  const dokployTarget: TargetConfig = {
    name: 'dk',
    kind: 'dokploy',
    branch: 'production',
    vars: ['A'],
    mode: 'ci',
    options: { baseUrl: DOKPLOY_BASE, applicationId: 'app_1' },
  };

  test('Dokploy, no key anywhere', async () => {
    const adapter = createDokployAdapter({ env: {}, fetch: unreachable as never });
    const r = await adapter.preflight(dokployTarget, { cwd: '/nonexistent-cwd' });
    expect(r).toMatchObject({ ok: false, link: { url: `${DOKPLOY_BASE}/dashboard/settings/profile` } });
    expect(r.remedy).toContain('capy system set _TARGET_DOKPLOY_API_KEY');
    expect(r.reason).toBeTruthy();
    expect(r.hint).toBeTruthy();
  });

  test('Dokploy, key rejected by Dokploy', async () => {
    const unauthorized = (async () => ({ status: 401, ok: false, text: async () => '{}', json: async () => ({}) })) as never;
    const adapter = createDokployAdapter({ env: { DOKPLOY_API_KEY: 'x' }, fetch: unauthorized });
    const r = await adapter.preflight({ ...dokployTarget, options: { ...dokployTarget.options, tokenEnv: 'DOKPLOY_API_KEY' } }, { cwd: '/nonexistent-cwd' });
    expect(r).toMatchObject({ ok: false, link: { url: `${DOKPLOY_BASE}/dashboard/settings/profile` } });
  });

  const vercelTarget: TargetConfig = {
    name: 'vc',
    kind: 'vercel',
    branch: 'production',
    vars: ['A'],
    mode: 'ci',
    options: { projectDir: 'web', projectId: 'prj_1', vercelEnv: 'production' },
  };

  test('Vercel API mode, no token anywhere', async () => {
    const adapter = createVercelAdapter({ env: {}, fetch: unreachable as never, getTargetSecret: async () => null });
    const r = await adapter.preflight(vercelTarget, { cwd: '/nonexistent-cwd' });
    expect(r).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING, link: { url: VERCEL_PAGE } });
    expect(r.remedy).toContain('capy system set _TARGET_VERCEL_TOKEN');
    expect(r.remedy).toContain('capy connect vercel --create-token');
  });

  test('Vercel API mode, token rejected (401)', async () => {
    const unauthorized: VercelFetchLike = async () => ({ status: 401, ok: false, text: async () => '{}' });
    const adapter = createVercelAdapter({ env: {}, fetch: unauthorized as never, getTargetSecret: async () => 'x', sleep: mock(async () => {}) });
    const r = await adapter.preflight(vercelTarget, { cwd: '/nonexistent-cwd' });
    expect(r).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_REJECTED, link: { url: VERCEL_PAGE } });
  });
});
