/**
 * `capy deploy`'s Dokploy setup picker.
 *
 * CAP-657 URL input follow-up REPLACED the shape this file used to prove:
 * three separate questions (baseUrl, kind, composeId/applicationId) are now
 * ONE question — the service's Dokploy dashboard URL — parsed
 * (`parseDokployServiceUrl`) and verified live (`compose.one`/
 * `application.one`) before being saved, with the old three-question shape
 * still reachable as a fallback when the answer is a bare id rather than a
 * URL. Every test below that drove the OLD three-question mock sequence was
 * rewritten to drive the new one-question-plus-fallback flow instead — the
 * underlying fact each test proves (byte-for-byte `tokenEnv` survival,
 * exactly one of composeId/applicationId, kind defaulting on re-edit) is
 * unchanged; only the inquirer call sequence that produces it is different.
 *
 * CAP-664's original point — a NEW Dokploy target is no longer asked for
 * `tokenEnv` at all; an EXISTING target's saved `tokenEnv` survives an
 * edit — still holds and is still proved here.
 *
 * Drives `resolveAdapterOptions` directly rather than the whole multi-prompt
 * `runPicker` flow, same reasoning as before: its return value becomes
 * `target.options` verbatim and is then written to `.capy/deploy.json`
 * verbatim.
 *
 * `mock.module('inquirer', ...)` and `mock.module('../../src/system/
 * systemStore', ...)` are both process-wide: this file runs isolated
 * (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';

const promptMock = mock(async () => ({ serviceUrl: 'app_1' }));
mock.module('inquirer', () => ({
  default: { prompt: promptMock, Separator: class {} },
}));

/**
 * Default: no key anywhere (system store empty, no `DOKPLOY_API_KEY` env
 * var) — every test that gives a FULL URL and does not care about
 * verification relies on this to make `resolveDokployApiKeyForPicker` fail
 * closed and skip straight to "saving as entered", with no extra prompt.
 * Tests that DO want a successful verification override this per-test with
 * `mock.module` again (process-wide, last one wins — same pattern
 * `deployDokploySystemStoreToken.test.ts` uses).
 */
mock.module('../../src/system/systemStore', () => ({
  getDirectionalConnectorSecret: mock(async () => null),
}));

import { resolveAdapterOptions, settingsDefaults } from '../../src/commands/deployCommand';
import { getAdapter } from '../../src/deploy/registry';

afterEach(() => {
  promptMock.mockClear();
  delete process.env.DOKPLOY_API_KEY;
});

describe('capy deploy picker — dokploy URL input (CAP-657) + tokenEnv (CAP-664)', () => {
  const adapter = getAdapter('dokploy');
  if (!adapter) throw new Error('dokploy adapter not registered');

  describe('bare id (no scheme://): falls back to the pre-CAP-657 kind + baseUrl questions', () => {
    test('a NEW target: one URL/id question, then kind + baseUrl — no tokenEnv key at all', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_1' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'application', baseUrl: 'https://dokploy.example.com' }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_1' });
      expect(Object.prototype.hasOwnProperty.call(options, 'tokenEnv')).toBe(false);
      expect(promptMock.mock.calls.length).toBe(2);
    });

    test('picking Compose returns composeId, never applicationId', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_1' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'compose', baseUrl: 'https://dokploy.example.com' }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_1' });
      expect(Object.prototype.hasOwnProperty.call(options, 'applicationId')).toBe(false);
    });

    test("an EXISTING target's tokenEnv survives an edit, byte for byte", async () => {
      const existingOpts = {
        baseUrl: 'https://old.example.com',
        applicationId: 'app_old',
        tokenEnv: 'MY_OLD_TOKEN_VAR',
      };
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_1' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'application', baseUrl: 'https://dokploy.example.com' }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, existingOpts);
      expect(options).toEqual({
        baseUrl: 'https://dokploy.example.com',
        applicationId: 'app_1',
        tokenEnv: 'MY_OLD_TOKEN_VAR',
      });
    });

    test('the tokenEnv question itself is never asked', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_1' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'application', baseUrl: 'https://x' }));
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { tokenEnv: 'WHATEVER' });
      const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{ name: string }>;
      expect(lastCallQuestions.map((q) => q.name)).not.toContain('tokenEnv');
    });

    test('the URL/id question prefills the existing id — not a reconstructed full URL (projectId is never saved)', async () => {
      promptMock.mockImplementationOnce(async (qs: ReadonlyArray<{ name: string; default?: unknown }>) => {
        expect(qs[0].name).toBe('serviceUrl');
        expect(qs[0].default).toBe('compose_old');
        return { serviceUrl: 'compose_old' };
      });
      promptMock.mockImplementationOnce(async () => ({ kind: 'compose', baseUrl: 'https://x' }));
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { baseUrl: 'https://old', composeId: 'compose_old' });
    });

    test('re-editing a Compose target defaults the fallback kind question to Compose', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_old' }));
      promptMock.mockImplementationOnce(async (qs: ReadonlyArray<{ name: string; default?: unknown }>) => {
        expect(qs.find((q) => q.name === 'kind')?.default).toBe('compose');
        return { kind: 'compose', baseUrl: 'https://x' };
      });
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { baseUrl: 'https://x', composeId: 'compose_old' });
    });

    test('re-editing an Application target defaults the fallback kind question to Application', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_old' }));
      promptMock.mockImplementationOnce(async (qs: ReadonlyArray<{ name: string; default?: unknown }>) => {
        expect(qs.find((q) => q.name === 'kind')?.default).toBe('application');
        return { kind: 'application', baseUrl: 'https://x' };
      });
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { baseUrl: 'https://x', applicationId: 'app_old' });
    });

    test('switching kind on re-edit drops the OTHER id — an Application target re-edited to Compose loses applicationId', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_new' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'compose', baseUrl: 'https://dokploy.example.com' }));
      const options = await resolveAdapterOptions(
        adapter,
        '/tmp',
        [],
        {},
        { baseUrl: 'https://old', applicationId: 'app_old' },
      );
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_new' });
      expect(Object.prototype.hasOwnProperty.call(options, 'applicationId')).toBe(false);
    });

    test('switching kind the other way (Compose → Application) loses composeId', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_new' }));
      promptMock.mockImplementationOnce(async () => ({ kind: 'application', baseUrl: 'https://dokploy.example.com' }));
      const options = await resolveAdapterOptions(
        adapter,
        '/tmp',
        [],
        {},
        { baseUrl: 'https://old', composeId: 'compose_old' },
      );
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_new' });
      expect(Object.prototype.hasOwnProperty.call(options, 'composeId')).toBe(false);
    });
  });

  describe('a full dashboard URL: parsed + (best-effort) verified', () => {
    test('no Dokploy key available yet → saved as entered, no confirm prompt asked', async () => {
      promptMock.mockImplementationOnce(async () => ({
        serviceUrl:
          'https://dokploy.example.com/dashboard/project/p1/environment/e1/services/compose/compose_verified',
      }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_verified' });
      // Only the URL question — no verification, so no confirm prompt.
      expect(promptMock.mock.calls.length).toBe(1);
    });

    test('a bad path claiming to be a URL is refused (DOKPLOY_URL_INVALID) and RE-ASKED — never silently treated as an id', async () => {
      promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'https://dokploy.example.com/not/a/service/page' }));
      promptMock.mockImplementationOnce(async () => ({
        serviceUrl: 'https://dokploy.example.com/dashboard/project/p1/services/application/app_ok',
      }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_ok' });
      expect(promptMock.mock.calls.length).toBe(2);
    });

    describe('with a resolvable key: verification actually runs', () => {
      afterEach(() => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => null),
        }));
      });

      test('verified name → confirmed → saved composeId', async () => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => 'fake-dokploy-key'),
        }));
        const fetchMock = mock(async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('compose.one')) {
            return {
              status: 200,
              ok: true,
              text: async () =>
                JSON.stringify({
                  composeId: 'compose_verified',
                  name: 'billing-worker',
                  env: null,
                  createEnvFile: true,
                  environmentId: 'env_1',
                }),
            };
          }
          if (u.pathname.endsWith('project.all')) {
            return { status: 200, ok: true, text: async () => JSON.stringify([]) };
          }
          throw new Error(`unscripted request: ${url}`);
        });
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
        try {
          promptMock.mockImplementationOnce(async () => ({
            serviceUrl:
              'https://dokploy.example.com/dashboard/project/p1/environment/e1/services/compose/compose_verified',
          }));
          promptMock.mockImplementationOnce(async (qs: ReadonlyArray<{ name: string; message: string }>) => {
            expect(qs[0].name).toBe('confirmed');
            expect(qs[0].message).toContain('billing-worker');
            return { confirmed: true };
          });
          const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
          expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_verified' });
        } finally {
          fetchSpy.mockRestore();
        }
      });

      test('declining the confirmation loops back to the URL question', async () => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => 'fake-dokploy-key'),
        }));
        const fetchMock = mock(async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('compose.one')) {
            return {
              status: 200,
              ok: true,
              text: async () =>
                JSON.stringify({ composeId: 'compose_1', name: 'wrong-one', env: null, createEnvFile: true }),
            };
          }
          throw new Error(`unscripted request: ${url}`);
        });
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
        try {
          promptMock.mockImplementationOnce(async () => ({
            serviceUrl: 'https://dokploy.example.com/dashboard/project/p1/services/compose/compose_1',
          }));
          promptMock.mockImplementationOnce(async () => ({ confirmed: false }));
          // Declined — loop back to the URL/id question; answer with a bare id this time.
          promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_2' }));
          promptMock.mockImplementationOnce(async () => ({ kind: 'compose', baseUrl: 'https://dokploy.example.com' }));
          const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
          expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_2' });
          expect(promptMock.mock.calls.length).toBe(4);
        } finally {
          fetchSpy.mockRestore();
        }
      });

      test('a 404 is refused (DOKPLOY_SERVICE_NOT_FOUND) and RE-ASKED, never saved unverified', async () => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => 'fake-dokploy-key'),
        }));
        const fetchMock = mock(async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('application.one')) {
            return { status: 404, ok: false, text: async () => 'not found' };
          }
          throw new Error(`unscripted request: ${url}`);
        });
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
        try {
          promptMock.mockImplementationOnce(async () => ({
            serviceUrl: 'https://dokploy.example.com/dashboard/project/p1/services/application/ghost_id',
          }));
          // Re-asked after the 404 — this time a bare id (skips verification).
          promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'app_real' }));
          promptMock.mockImplementationOnce(async () => ({ kind: 'application', baseUrl: 'https://dokploy.example.com' }));
          const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
          expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_real' });
          expect(promptMock.mock.calls.length).toBe(3);
        } finally {
          fetchSpy.mockRestore();
        }
      });

      test('a non-404 API problem (e.g. unauthorized) is best-effort — saved as entered, not a hard refusal', async () => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => 'wrong-key'),
        }));
        const fetchMock = mock(async () => ({ status: 401, ok: false, text: async () => 'unauthorized' }));
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
        try {
          promptMock.mockImplementationOnce(async () => ({
            serviceUrl: 'https://dokploy.example.com/dashboard/project/p1/services/compose/compose_x',
          }));
          const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
          expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_x' });
          expect(promptMock.mock.calls.length).toBe(1);
        } finally {
          fetchSpy.mockRestore();
        }
      });

      test('tokenEnv still survives a Compose re-edit, byte for byte, through the verified path', async () => {
        mock.module('../../src/system/systemStore', () => ({
          getDirectionalConnectorSecret: mock(async () => 'fake-dokploy-key'),
        }));
        const fetchMock = mock(async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('compose.one')) {
            return {
              status: 200,
              ok: true,
              text: async () =>
                JSON.stringify({ composeId: 'compose_new', name: 'svc', env: null, createEnvFile: true }),
            };
          }
          throw new Error(`unscripted request: ${url}`);
        });
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
        try {
          promptMock.mockImplementationOnce(async () => ({
            serviceUrl: 'https://dokploy.example.com/dashboard/project/p1/services/compose/compose_new',
          }));
          promptMock.mockImplementationOnce(async () => ({ confirmed: true }));
          const options = await resolveAdapterOptions(
            adapter,
            '/tmp',
            [],
            {},
            { composeId: 'compose_old', tokenEnv: 'MY_TOKEN' },
          );
          expect(options).toEqual({
            baseUrl: 'https://dokploy.example.com',
            composeId: 'compose_new',
            tokenEnv: 'MY_TOKEN',
          });
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });
  });

  // ── validator fix-first: settingsDefaults (the WEB surface's copy of the
  // terminal picker's own defaults) is UNCHANGED by CAP-657 — Dokploy setup
  // stays terminal-only (TERMINAL_ONLY_SETUP), so this function never drives
  // the URL question at all; it must still include composeId/kind so a
  // re-edit never disagrees between the two surfaces about what a Compose
  // target starts from. ──
  describe('settingsDefaults — dokploy (web surface parity, unchanged by CAP-657)', () => {
    test('a brand-new target defaults kind to compose, with both ids blank', () => {
      expect(settingsDefaults('dokploy', '/tmp', {}, {})).toEqual({
        baseUrl: '',
        applicationId: '',
        composeId: '',
        kind: 'compose',
      });
    });

    test('an existing Compose target defaults kind to compose and carries composeId', () => {
      expect(settingsDefaults('dokploy', '/tmp', { baseUrl: 'https://x', composeId: 'compose_old' }, {})).toEqual({
        baseUrl: 'https://x',
        applicationId: '',
        composeId: 'compose_old',
        kind: 'compose',
      });
    });

    test('an existing Application target defaults kind to application and carries applicationId', () => {
      expect(settingsDefaults('dokploy', '/tmp', { baseUrl: 'https://x', applicationId: 'app_old' }, {})).toEqual({
        baseUrl: 'https://x',
        applicationId: 'app_old',
        composeId: '',
        kind: 'application',
      });
    });

    test('tokenEnv is carried through only when an existing target already has one', () => {
      expect(settingsDefaults('dokploy', '/tmp', { applicationId: 'app_old', tokenEnv: 'MY_TOKEN' }, {})).toEqual({
        baseUrl: '',
        applicationId: 'app_old',
        composeId: '',
        kind: 'application',
        tokenEnv: 'MY_TOKEN',
      });
    });
  });
});
