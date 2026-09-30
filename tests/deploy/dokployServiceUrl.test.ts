/**
 * CAP-657 URL input follow-up: `parseDokployServiceUrl` (the pure function
 * behind `capy deploy`'s "one question" Dokploy setup picker) and its two
 * small siblings — `looksLikeUrl` (routes a bare id away from parsing at
 * all) and the live-verification helpers `verifyDokployService` /
 * `resolveDokployEnvironmentLabel`.
 *
 * Route shapes are confirmed against Dokploy's own source
 * (github.com/Dokploy/dokploy):
 *  - v0.30.0 (current): `apps/dokploy/pages/dashboard/project/[projectId]/
 *    environment/[environmentId]/services/{compose,application}/[id].tsx`
 *  - v0.20.0 (and earlier, before Dokploy's "environments" feature):
 *    `apps/dokploy/pages/dashboard/project/[projectId]/services/{compose,
 *    application}/[id].tsx` — identical shape minus the `environment/<id>`
 *    segment.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseDokployServiceUrl,
  looksLikeUrl,
  verifyDokployService,
  resolveDokployEnvironmentLabel,
} from '../../src/deploy/adapters/dokploy';
import { DokployApiError, DokployClient, DokployProjectSummary } from '../../src/deploy/dokployApi';
import { ERROR_CODES } from '../../src/types/index';

describe('parseDokployServiceUrl (CAP-657)', () => {
  describe('current shape (v0.30.0): project/environment/services/<kind>/<id>', () => {
    test('compose, https, no trailing slash', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/compose/compose_abc',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'compose', id: 'compose_abc' });
    });

    test('application, https', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/application/app_abc',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'application', id: 'app_abc' });
    });

    test('trailing slash', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/compose/compose_abc/',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'compose', id: 'compose_abc' });
    });

    test('query string (Dokploy tab state) is ignored', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/compose/compose_abc?tab=environment',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'compose', id: 'compose_abc' });
    });

    test('hash fragment is ignored', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/compose/compose_abc#logs',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'compose', id: 'compose_abc' });
    });

    test('query AND trailing slash together', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/environment/env1/services/application/app_abc/?tab=advanced',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'application', id: 'app_abc' });
    });

    test('custom port', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com:8443/dashboard/project/proj1/environment/env1/services/compose/compose_abc',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com:8443', kind: 'compose', id: 'compose_abc' });
    });

    test('http is accepted only for loopback', () => {
      const r = parseDokployServiceUrl(
        'http://localhost:3000/dashboard/project/proj1/environment/env1/services/compose/compose_abc',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'http://localhost:3000', kind: 'compose', id: 'compose_abc' });
    });

    test('subpath deployment: a reverse-proxy prefix before /dashboard is kept in baseUrl', () => {
      const r = parseDokployServiceUrl(
        'https://ops.example.com/tools/dokploy/dashboard/project/proj1/environment/env1/services/compose/compose_abc',
      );
      expect(r).toEqual({
        ok: true,
        baseUrl: 'https://ops.example.com/tools/dokploy',
        kind: 'compose',
        id: 'compose_abc',
      });
    });
  });

  describe('older shape (v0.20.0 and earlier): no environment segment', () => {
    test('compose', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/services/compose/compose_abc',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'compose', id: 'compose_abc' });
    });

    test('application, trailing slash + query', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/proj1/services/application/app_abc/?tab=general',
      );
      expect(r).toEqual({ ok: true, baseUrl: 'https://dokploy.example.com', kind: 'application', id: 'app_abc' });
    });
  });

  describe('invalid URLs → coded error (DOKPLOY_URL_INVALID), never guessed at', () => {
    test('not a URL at all', () => {
      const r = parseDokployServiceUrl('not a url');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('empty string', () => {
      const r = parseDokployServiceUrl('   ');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('wrong scheme (ftp)', () => {
      const r = parseDokployServiceUrl('ftp://dokploy.example.com/dashboard/project/p/services/compose/c');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('http on a non-loopback host', () => {
      const r = parseDokployServiceUrl(
        'http://dokploy.example.com/dashboard/project/p/environment/e/services/compose/c',
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('a URL that is not a Dokploy service page at all', () => {
      const r = parseDokployServiceUrl('https://dokploy.example.com/dashboard/settings/profile');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('an unrecognized service kind segment (e.g. a database page)', () => {
      const r = parseDokployServiceUrl(
        'https://dokploy.example.com/dashboard/project/p/environment/e/services/postgres/pg1',
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });

    test('missing id entirely', () => {
      const r = parseDokployServiceUrl('https://dokploy.example.com/dashboard/project/p/services/compose/');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe(ERROR_CODES.DOKPLOY_URL_INVALID);
    });
  });
});

describe('looksLikeUrl (CAP-657) — routes a bare id away from parsing', () => {
  test('a bare Dokploy-style id is not a URL', () => {
    expect(looksLikeUrl('compose_abc123')).toBe(false);
  });

  test('an https URL is a URL', () => {
    expect(looksLikeUrl('https://dokploy.example.com/dashboard/project/p')).toBe(true);
  });

  test('an http URL is a URL (scheme check happens later, in parseDokployServiceUrl)', () => {
    expect(looksLikeUrl('http://dokploy.example.com')).toBe(true);
  });

  test('whitespace around a URL is trimmed before the check', () => {
    expect(looksLikeUrl('   https://dokploy.example.com  ')).toBe(true);
  });

  test('a scheme-less host:port is NOT treated as a URL', () => {
    expect(looksLikeUrl('dokploy.example.com:8080')).toBe(false);
  });
});

// ── Live verification helpers (fake DokployClient, no real network) ────────

function fakeClient(overrides: Partial<DokployClient> = {}): DokployClient {
  const notImplemented = (name: string) => async () => {
    throw new Error(`fakeClient.${name} not implemented for this test`);
  };
  return {
    getApplication: notImplemented('getApplication'),
    saveEnvironment: notImplemented('saveEnvironment'),
    deploy: notImplemented('deploy'),
    listDeployments: notImplemented('listDeployments'),
    readLogs: notImplemented('readLogs'),
    getCompose: notImplemented('getCompose'),
    listProjects: notImplemented('listProjects'),
    saveComposeEnvironment: notImplemented('saveComposeEnvironment'),
    redeployCompose: notImplemented('redeployCompose'),
    listComposeDeployments: notImplemented('listComposeDeployments'),
    getDokployVersion: notImplemented('getDokployVersion'),
    ...overrides,
  } as DokployClient;
}

describe('verifyDokployService (CAP-657) — the picker\'s "show a name to confirm" call', () => {
  test('compose: returns name/appName/environmentId from compose.one', async () => {
    const client = fakeClient({
      getCompose: async (id) => {
        expect(id).toBe('compose_1');
        return {
          composeId: 'compose_1',
          name: 'my-compose',
          appName: 'app-name',
          env: null,
          createEnvFile: true,
          environmentId: 'env_1',
        };
      },
    });
    const r = await verifyDokployService(client, 'compose', 'compose_1');
    expect(r).toEqual({ ok: true, value: { name: 'my-compose', appName: 'app-name', environmentId: 'env_1' } });
  });

  test('application: returns name/appName/environmentId from application.one', async () => {
    const client = fakeClient({
      getApplication: async (id) => {
        expect(id).toBe('app_1');
        return {
          applicationId: 'app_1',
          name: 'my-app',
          appName: 'app-name',
          env: null,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: true,
          environmentId: 'env_2',
        };
      },
    });
    const r = await verifyDokployService(client, 'application', 'app_1');
    expect(r).toEqual({ ok: true, value: { name: 'my-app', appName: 'app-name', environmentId: 'env_2' } });
  });

  test('404 (not_found) surfaces the underlying DokployApiError, never thrown', async () => {
    const notFound = new DokployApiError('not_found', 404, 'compose.one returned HTTP 404');
    const client = fakeClient({
      getCompose: async () => {
        throw notFound;
      },
    });
    const r = await verifyDokployService(client, 'compose', 'ghost');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('not_found');
    expect(!r.ok && r.error).toBe(notFound);
  });

  test('a non-DokployApiError still throws (never silently swallowed)', async () => {
    const client = fakeClient({
      getCompose: async () => {
        throw new Error('boom');
      },
    });
    await expect(verifyDokployService(client, 'compose', 'x')).rejects.toThrow('boom');
  });
});

describe('resolveDokployEnvironmentLabel (CAP-657) — best-effort, never blocks', () => {
  const projects: DokployProjectSummary[] = [
    {
      projectId: 'proj_1',
      name: 'Acme',
      environments: [
        { environmentId: 'env_1', name: 'production', applications: [], composes: [] },
        { environmentId: 'env_2', name: 'staging', applications: [], composes: [] },
      ],
    },
  ];

  test('resolves "<project> · <environment>" when the environment is found', async () => {
    const client = fakeClient({ listProjects: async () => projects });
    const label = await resolveDokployEnvironmentLabel(client, 'env_2');
    expect(label).toBe('Acme · staging');
  });

  test('undefined environmentId short-circuits without calling listProjects', async () => {
    const client = fakeClient({
      listProjects: async () => {
        throw new Error('should never be called');
      },
    });
    const label = await resolveDokployEnvironmentLabel(client, undefined);
    expect(label).toBeUndefined();
  });

  test('an unknown environmentId resolves to undefined, not a throw', async () => {
    const client = fakeClient({ listProjects: async () => projects });
    const label = await resolveDokployEnvironmentLabel(client, 'env_does_not_exist');
    expect(label).toBeUndefined();
  });

  test('listProjects failing resolves to undefined rather than blocking the picker', async () => {
    const client = fakeClient({
      listProjects: async () => {
        throw new Error('rate limited');
      },
    });
    const label = await resolveDokployEnvironmentLabel(client, 'env_1');
    expect(label).toBeUndefined();
  });
});
