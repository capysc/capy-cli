/**
 * `capy connect vercel --create-token` through the connector and
 * `ConnectCommand`: with a stub `vercel` program on PATH and an in-memory
 * stand-in for the org system store.
 *
 * The property throughout: the token the stub hands back is saved to the store
 * under `_CONNECTOR_VERCEL_TOKEN`, is what the following import authenticates
 * with, and appears on NO output surface (stdout, stderr, JSON) and in NO
 * recorded argv. No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { createVercelConnector, type CreateTokenStore } from '../../src/commands/connectors/vercel';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import { providers, type ConnectOpts } from '../../src/commands/connectors/registry';
import type { DiscoveryContext } from '../../src/commands/connectors/dokployDiscovery';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData } from '../helpers/fakeVercel';
import { FAKE_BEARER, createdJson, teamsJson, withStubVercel } from '../helpers/stubVercelCli';
import { captureConsole, withExitCodeRestored, withIsolatedGlobalDir, withTTY, withTempDir } from '../helpers/testSandbox';

const FILES = { 'teams.json': teamsJson([{ id: 'team_acme', slug: 'acme' }]), 'create.json': createdJson() } as const;

const DATA: FakeVercelData = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: [{ id: 'env_1', key: 'PLAIN_PROD', type: 'plain', target: ['production'], listValue: 'plain-prod-SENT-1a2b' }] },
  custom: { prj_web: [] },
};

function storeStub(existing: readonly string[] = []) {
  const set = mock(async (_name: string, _value: string) => {});
  const store: CreateTokenStore = { listNames: () => existing.map((name) => ({ name })), set };
  const openStore = mock(async (_orgId: string, _o: { devMode?: boolean }) => store);
  return { set, openStore };
}

function build(stubEnv: Record<string, string>, extra: Partial<Parameters<typeof createVercelConnector>[0]> = {}, data: FakeVercelData = DATA) {
  const store = storeStub();
  const fetchMock = mock(fakeVercelFetch(data));
  const connector = createVercelConnector({
    fetch: fetchMock as unknown as VercelFetchLike,
    env: stubEnv,
    sleep: async () => {},
    openStore: store.openStore,
    ...extra,
  });
  return { connector, fetchMock, ...store };
}

const ctxWith = (): ResolvedContext =>
  ({
    keep: { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} } as KeepFile,
    branch: 'production',
    orgId: 'org_1',
    localPlaintext: {},
  }) as unknown as ResolvedContext;

const discoveryCtx = (): DiscoveryContext =>
  ({
    orgId: 'org_v',
    userId: 'user_v',
    authService: {},
    serviceClient: { listBranches: async () => [], listProjects: async () => [] },
  }) as unknown as DiscoveryContext;

const BASE: ConnectOpts = { nonTty: true, createToken: true };
const orgId = async () => 'org_1';

const noBearer = (surfaces: readonly string[]) => expect(surfaces.join('\n')).not.toContain(FAKE_BEARER);

describe('--create-token on its own (no --project, no --discover)', () => {
  test('creates and saves the token, reports name/id/team, imports nothing, makes no Vercel REST call', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector, set, openStore, fetchMock } = build(stub.env);
      const out = await connector.createToken!(BASE, orgId);
      expect(out).toMatchObject({ ok: true, tokenCreated: { name: 'capy-acme-import', id: 'tok_new_1', team: { id: 'team_acme', slug: 'acme' }, secretName: '_CONNECTOR_VERCEL_TOKEN' } });
      expect(set.mock.calls).toEqual([['_CONNECTOR_VERCEL_TOKEN', FAKE_BEARER]]);
      expect(openStore.mock.calls[0][0]).toBe('org_1');
      expect(fetchMock.mock.calls.length).toBe(0);
      expect(stub.rawLog()).not.toContain(FAKE_BEARER);
      expect(JSON.stringify(out)).not.toContain(FAKE_BEARER);
    });
  });

  test('--json through ConnectCommand: stdout is ONE JSON object with tokenCreated; the value is nowhere; non-interactive never signs out', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector } = build(stub.env);
      const run = await captureConsole(() => new ConnectCommand(false)['executeCreateToken'](connector, 'vercel', { ...BASE, json: true }, orgId));
      expect(run.stdout.length).toBe(1);
      expect(JSON.parse(run.stdout[0])).toMatchObject({
        ok: true,
        provider: 'vercel',
        tokenCreated: { name: 'capy-acme-import', id: 'tok_new_1', team: { slug: 'acme' }, cliSignOut: 'not_offered', next: 'vercel logout' },
      });
      noBearer([...run.stdout, ...run.stderr]);
      expect(stub.calls().some((c) => c[0] === 'logout')).toBe(false);
    });
  });

  test('`capy connect vercel --create-token` (the whole command) creates, reports and STOPS: no keep.lock needed, no import, no Vercel REST call', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector, fetchMock } = build(stub.env);
      // the real command resolves the org by logging in; the test names it
      const wired = { ...connector, createToken: (o: ConnectOpts) => connector.createToken!(o, orgId) };
      const loader = spyOn(providers, 'vercel').mockImplementation(async () => wired);
      try {
        const run = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false).execute('vercel', { createToken: true, nonTty: true, json: true })));
        expect(run.result).toEqual({ linked: false });
        expect(JSON.parse(run.stdout[0])).toMatchObject({ ok: true, provider: 'vercel', tokenCreated: { id: 'tok_new_1' } });
        expect(fetchMock.mock.calls.length).toBe(0);
      } finally {
        loader.mockRestore();
      }
    });
  });

  test('human output names the token and the logout next step, never the value', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector } = build(stub.env);
      const run = await captureConsole(() => new ConnectCommand(false)['executeCreateToken'](connector, 'vercel', BASE, orgId));
      const text = run.stdout.join('\n');
      expect(text).toContain('capy-acme-import');
      expect(text).toContain('tok_new_1');
      expect(text).toContain('vercel logout');
      noBearer([...run.stdout, ...run.stderr]);
    });
  });

  test('replacing an existing entry is reported', async () => {
    await withStubVercel(FILES, async (stub) => {
      const store = storeStub(['_CONNECTOR_VERCEL_TOKEN']);
      const { connector } = build(stub.env, { openStore: store.openStore });
      const out = await connector.createToken!(BASE, orgId);
      expect(out.ok && out.tokenCreated.replacedExisting).toBe(true);
    });
  });

  test('--token-expires-days reaches the CLI as expiresAt; an invalid value is refused before anything runs', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector } = build(stub.env, { cli: { now: () => 5_000 } });
      await connector.createToken!({ ...BASE, tokenExpiresDays: '3' }, orgId);
      expect(stub.calls().find((c) => c[1] === '/v3/user/tokens')).toContain(`expiresAt=${5_000 + 3 * 86_400_000}`);
    });
    await withStubVercel(FILES, async (stub) => {
      const { connector, openStore } = build(stub.env);
      const out = await connector.createToken!({ ...BASE, tokenExpiresDays: 'soon' }, orgId);
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_EXPIRY_INVALID });
      expect(stub.calls().length).toBe(0);
      expect(openStore.mock.calls.length).toBe(0);
    });
  });
});

describe('--create-token refusals', () => {
  test('--dry-run: VERCEL_CREATE_TOKEN_DRY_RUN from createToken, import and discover; nothing ran, nothing opened, nothing saved', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector, openStore, set, fetchMock } = build(stub.env);
      const dry = { ...BASE, dryRun: true };
      const a = await connector.createToken!(dry, orgId);
      const b = await connector.import!(ctxWith(), { ...dry, project: 'web' });
      const c = await connector.discover!(discoveryCtx(), dry);
      for (const out of [a, b, c]) expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_CREATE_TOKEN_DRY_RUN });
      expect(stub.calls().length).toBe(0);
      expect(openStore.mock.calls.length).toBe(0);
      expect(set.mock.calls.length).toBe(0);
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  test('binary missing: VERCEL_CLI_MISSING (with link + remedy in JSON); the store is not asked to save anything', async () => {
    const { connector, set } = build({ PATH: '/nonexistent-dir-for-test' });
    const run = await withExitCodeRestored(() =>
      captureConsole(() => new ConnectCommand(false)['executeCreateToken'](connector, 'vercel', { ...BASE, json: true }, orgId)),
    );
    expect(run.stdout.length).toBe(1);
    expect(JSON.parse(run.stdout[0])).toMatchObject({ ok: false, code: 'VERCEL_CLI_MISSING', link: { url: 'https://vercel.com/docs/cli' } });
    expect(JSON.parse(run.stdout[0]).remedy).toBeTruthy();
    expect(set.mock.calls.length).toBe(0);
  });

  test('not signed in: VERCEL_CLI_NOT_SIGNED_IN, human text on stderr only', async () => {
    await withStubVercel({ ...FILES, 'whoami.exit': '1' }, async (stub) => {
      const { connector } = build(stub.env);
      const run = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false)['executeCreateToken'](connector, 'vercel', BASE, orgId)));
      expect(run.stdout.join('')).toBe('');
      expect(run.stderr.join('\n')).toContain('vercel login');
    });
  });

  test('a caller who cannot open the store (not an admin) is refused with the store\'s code BEFORE any token is created', async () => {
    await withStubVercel(FILES, async (stub) => {
      const openStore = mock(async () => {
        throw Object.assign(new Error('x'), { code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
      });
      const { connector } = build(stub.env, { openStore });
      const out = await connector.createToken!(BASE, orgId);
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
      expect(stub.calls().some((c) => c[1] === '/v3/user/tokens')).toBe(false);
    });
  });

  test('a store save that fails deletes the new token and refuses with the store\'s code', async () => {
    await withStubVercel(FILES, async (stub) => {
      const store: CreateTokenStore = {
        listNames: () => [],
        set: async () => {
          throw Object.assign(new Error('x'), { code: ERROR_CODES.SERVICE_ERROR });
        },
      };
      const { connector } = build(stub.env, { openStore: async () => store });
      const out = await connector.createToken!(BASE, orgId);
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.SERVICE_ERROR });
      expect(stub.calls().filter((c) => c[0] === 'tokens')).toEqual([['tokens', 'rm', 'tok_new_1']]);
    });
  });
});

describe('--create-token with --project continues into the import', () => {
  test('the import authenticates with the created token; tokenCreated is in the JSON; the value is nowhere', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withIsolatedGlobalDir(() =>
        withExitCodeRestored(() =>
          withTempDir('capy-vercel-ct', async (dir) => {
            const { connector, fetchMock, set } = build(stub.env);
            const ctx = {
              ...ctxWith(),
              pm: { readSyncState: () => null },
              fileManager: new (await import('../../src/files/fileManager')).FileManager(dir),
              serviceClient: {},
              projectId: 'p',
              userId: 'u',
              projectKey: 'ct-project-key-0123456789',
            } as unknown as ResolvedContext;
            const run = await captureConsole(() =>
              new ConnectCommand(false)['executeImport'](connector, 'vercel', ctx, { ...BASE, project: 'web', environment: 'production', json: true, noPush: true }),
            );
            expect(run.stdout.length).toBe(1);
            const parsed = JSON.parse(run.stdout[0]);
            expect(parsed).toMatchObject({ ok: true, imported: ['PLAIN_PROD'], tokenCreated: { id: 'tok_new_1', team: { slug: 'acme' } } });
            expect(set.mock.calls).toEqual([['_CONNECTOR_VERCEL_TOKEN', FAKE_BEARER]]);
            // the import used the created token, and only ever read
            const calls = callsOf(fetchMock);
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.every((c) => c.authorization === `Bearer ${FAKE_BEARER}` && c.method === 'GET')).toBe(true);
            expect(calls.some((c) => c.url.includes(FAKE_BEARER))).toBe(false);
            noBearer([...run.stdout, ...run.stderr, stub.rawLog()]);
          }),
        ),
      );
    });
  });

  test('a later refusal still reports the token that was made', async () => {
    await withStubVercel(FILES, async (stub) => {
      const { connector } = build(stub.env);
      const run = await withExitCodeRestored(() =>
        captureConsole(() => new ConnectCommand(false)['executeImport'](connector, 'vercel', ctxWith(), { ...BASE, project: 'no-such-project', json: true })),
      );
      const parsed = JSON.parse(run.stdout[0]);
      expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_PROJECT_NOT_FOUND, tokenCreated: { id: 'tok_new_1' } });
      noBearer(run.stdout);
    });
  });

  test('--discover: the token is created, then discovery runs with it', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withTempDir('capy-vercel-ct-disc', async (root) => {
        const { connector, fetchMock } = build(stub.env, { cwd: root }, { ...DATA, projects: { team_acme: [] } });
        const out = await connector.discover!(discoveryCtx(), { ...BASE, discover: true, yes: true });
        expect(out).toMatchObject({ ok: true, tokenCreated: { id: 'tok_new_1' } });
        expect(callsOf(fetchMock).every((c) => c.authorization === `Bearer ${FAKE_BEARER}`)).toBe(true);
      });
    });
  });
});

describe('interactive: a missing token offers the Vercel CLI route next to the hidden prompt', () => {
  /** The store's own hidden-prompt path, reduced to what the connector sees: it calls `onMissing` first, then (if that gave nothing) would prompt. */
  const storeThatCalls = (saved: { value?: string }) =>
    mock(async (_name: string, o: { onMissing?: (save: (v: string) => Promise<void>) => Promise<string | null> }) => {
      const made = await o.onMissing?.(async () => {});
      return made ?? saved.value ?? null;
    });

  test('"create": the CLI makes the token, it is saved through the store\'s own save, and the import proceeds with it', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withTTY(() =>
        withExitCodeRestored(async () => {
          const saves = mock(async (_v: string) => {});
          const getConnectorSecret = mock(async (_n: string, o: { onMissing?: (save: (v: string) => Promise<void>) => Promise<string | null> }) => o.onMissing?.(saves) ?? null);
          const confirm = mock(async (_m: string, d: boolean) => d);
          const { connector, fetchMock } = build({ ...stub.env }, { getConnectorSecret, askCreateMethod: async () => 'create', confirm, selectVars: async (c) => c });
          const run = await captureConsole(() => connector.import!(ctxWith(), { project: 'web', environment: 'production', nonTty: false, noPush: true }));
          expect(run.result.ok).toBe(true);
          expect(saves.mock.calls).toEqual([[FAKE_BEARER]]);
          expect(callsOf(fetchMock).every((c) => c.authorization === `Bearer ${FAKE_BEARER}`)).toBe(true);
          noBearer([...run.stdout, ...run.stderr, stub.rawLog()]);
          // the question "sign the Vercel CLI out now?" defaults to yes
          expect(confirm.mock.calls[0][1]).toBe(true);
          expect(stub.calls().some((c) => c[0] === 'logout')).toBe(true);
        }),
      );
    });
  });

  test('answering no to "sign out?" leaves the CLI signed in', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withTTY(() =>
        withExitCodeRestored(async () => {
          const getConnectorSecret = mock(async (_n: string, o: { onMissing?: (save: (v: string) => Promise<void>) => Promise<string | null> }) => o.onMissing?.(async () => {}) ?? null);
          const confirm = mock(async () => false);
          const { connector } = build({ ...stub.env }, { getConnectorSecret, askCreateMethod: async () => 'create', confirm, selectVars: async (c) => c });
          await captureConsole(() => connector.import!(ctxWith(), { project: 'web', environment: 'production', nonTty: false, noPush: true }));
          expect(stub.calls().some((c) => c[0] === 'logout')).toBe(false);
        }),
      );
    });
  });

  test('"paste": the CLI is never run and the hidden prompt path carries on', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withTTY(() =>
        withExitCodeRestored(async () => {
          const saved: { value?: string } = { value: undefined };
          const getConnectorSecret = storeThatCalls(saved);
          const { connector } = build({ ...stub.env }, { getConnectorSecret, askCreateMethod: async () => 'paste' });
          const run = await captureConsole(() => connector.import!(ctxWith(), { project: 'web', environment: 'production', nonTty: false, noPush: true }));
          expect(run.result).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING });
          expect(stub.calls().length).toBe(0);
        }),
      );
    });
  });

  test('no `vercel` binary: the choice is not offered at all (the hook is not even passed)', async () => {
    await withTTY(() =>
      withExitCodeRestored(async () => {
        const getConnectorSecret = mock(async (_n: string, o: { onMissing?: unknown }) => {
          expect(o.onMissing).toBeUndefined();
          return null;
        });
        const askCreateMethod = mock(async () => 'create' as const);
        const { connector } = build({ PATH: '/nonexistent-dir-for-test' }, { getConnectorSecret, askCreateMethod });
        await captureConsole(() => connector.import!(ctxWith(), { project: 'web', nonTty: false }));
        expect(askCreateMethod.mock.calls.length).toBe(0);
      }),
    );
  });

  test('a run that cannot prompt (--json) never offers it', async () => {
    await withStubVercel(FILES, async (stub) => {
      await withTTY(() =>
        withExitCodeRestored(async () => {
          const getConnectorSecret = mock(async (_n: string, o: { onMissing?: unknown }) => {
            expect(o.onMissing).toBeUndefined();
            return null;
          });
          const { connector } = build({ ...stub.env }, { getConnectorSecret });
          await captureConsole(() => connector.import!(ctxWith(), { project: 'web', nonTty: false, json: true }));
          expect(stub.calls().length).toBe(0);
        }),
      );
    });
  });
});
