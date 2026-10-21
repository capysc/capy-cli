/**
 * `capy deploy` after bare `capy` (docs/conflict-resolution.md): the real `deployCommand()` over a real folder, with the
 * REAL gate (`CapyCommand.runSync`) on an in-memory Capy server (tests/helpers/fakeCapyServer.ts) and a scripted Dokploy
 * over `fetch`. Only the network edges are replaced.
 *
 * Vince's case: the folder is pinned to GEMINI_TIMEOUT_SECONDS=120 and its `.env` holds 120, while Capy holds 180 (a
 * teammate saved). Deploying a target that delivers GEMINI:
 *   - the difference is shown by bare `capy` BEFORE anything else: the Dokploy preflight and the confirm screen come after;
 *   - off a terminal (`--yes`): exit 3 with that row (fingerprints only), Dokploy not contacted, nothing delivered or saved;
 *   - `--resolve GEMINI_TIMEOUT_SECONDS=local --conflict <id>`: 120 is committed to Capy, THEN delivered;
 *   - `=remote`: 180 is delivered and the folder takes it.
 * Asserted on what Capy's latest decrypts to and on the body Dokploy was sent.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { FIXED_PROJECT_KEY } from '../helpers/deployServer';
import { fakeCapyServer, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { KeepFile } from '../../src/types/index';

const KEY = FIXED_PROJECT_KEY;
const BRANCH = 'production';
const NAME = 'GEMINI_TIMEOUT_SECONDS';
const APP_ID = 'app_gate';
const TOKEN_ENV = 'DEPLOY_GATE_TEST_TOKEN';

/** One ordered log of what happened, so "before" is an assertion about order. */
const event = mock((_name: string) => undefined);
const events = (): readonly string[] => event.mock.calls.map((c) => String(c[0]));
const serverOf = mock((): ReturnType<typeof fakeCapyServer> | undefined => undefined);
const menu = mock((): { action: string } => ({ action: 'skip' }));

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    setSessionUserId() {}
    async authenticateSilent() {
      return { success: true, user_id: 'user-b', organization_id: 'org', user_email: 'b@example.test', _auth_method: 'cached' };
    }
    getLastRefreshFailure() {
      return null;
    }
    getToken() {
      return { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000 };
    }
    async getValidToken() {
      return 't';
    }
  },
  silentAuthFailureMessage: () => 'no session',
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    getDecryptData(...args: unknown[]) {
      return serverOf()!.getDecryptData(...(args as [string, string]));
    }
    pushSecrets(...args: unknown[]) {
      event('capy.push');
      return serverOf()!.pushSecrets(...(args as Parameters<ReturnType<typeof fakeCapyServer>['pushSecrets']>));
    }
    async getLatestSecrets(_projectId: string, branch: string) {
      const state = serverOf()!.state();
      const hash = SyncEngine.computeKeepHash(state.keep as KeepFile, branch);
      return { env_file: state.blobs[hash] ?? '', keep_hash: hash, keep_file: JSON.stringify(state.keep) };
    }
    async listBranches() {
      return [];
    }
  },
}));
mock.module('../../src/crypto/keyResolver', () => ({ resolveProjectKey: async () => KEY, hasOrgKey: () => true }));
mock.module('../../src/commands/deployTokenCommand', () => ({ mintDeployToken: async () => ({ secretsBlob: 'B', projectKey: 'K', deployId: 'd', secretCount: 1 }) }));
mock.module('inquirer', () => ({
  default: {
    prompt: async () => {
      event('menu');
      return menu();
    },
  },
}));
mock.module('../../src/ui/keypressConfirm', () => ({
  keypressConfirm: async () => {
    event('confirm');
    return 'cancel';
  },
}));

import { deployCommand } from '../../src/commands/deployCommand';
import { mergeManagedValuesBlock } from '../../src/deploy/dokployApi';
import { hashValue } from '../../src/sync/compareSecrets';

const globalDirName = `.capy-test-deploy-gate-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
const ORIGINAL_CWD = process.cwd();
beforeAll(() => {
  process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
});
afterAll(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
});

const made = mock((_: Folder) => undefined);
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  made.mock.calls.forEach(([folder]) => removeFolder(folder));
  made.mockClear();
  serverOf.mockReset();
  event.mockClear();
  menu.mockReset();
  menu.mockImplementation(() => ({ action: 'skip' }));
});

/** The folder (pinned to 120, `.env` 120, a deploy target delivering GEMINI) and Capy (holding 180). */
function world() {
  const server = fakeCapyServer({ initial: seedServer({ projectKey: KEY, values: { [BRANCH]: { [NAME]: '180' } } }) });
  serverOf.mockReturnValue(server);
  const folder = makeFolder({ projectKey: KEY, branch: BRANCH, keep: seedServer({ projectKey: KEY, values: { [BRANCH]: { [NAME]: '120' } } }).keep as KeepFile, env: { [NAME]: '120' }, client: server.client });
  made(folder);
  mkdirSync(join(folder.dir, '.capy'), { recursive: true });
  writeFileSync(join(folder.dir, '.capy', 'branch'), BRANCH);
  writeFileSync(
    join(folder.dir, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'dokploy-ci': {
          name: 'dokploy-ci',
          kind: 'dokploy',
          branch: BRANCH,
          vars: [NAME],
          mode: 'ci',
          gitBaseBranch: 'main',
          options: { baseUrl: 'https://dokploy.example.com', applicationId: APP_ID, tokenEnv: TOKEN_ENV },
        },
      },
    }),
  );
  process.chdir(folder.dir);
  return { server, folder };
}

const RAW_ENV = 'NODE_ENV=production\n';
const merged = (value: string): string => {
  const m = mergeManagedValuesBlock(RAW_ENV, [{ name: NAME, value }]);
  if (!m.ok) throw new Error('fixture');
  return m.env;
};

/** `application.one` reads from `reads`, in order; every call is logged as `dokploy`. */
function dokployFetch(reads: readonly string[]) {
  const it = reads[Symbol.iterator]();
  return mock(async (url: string) => {
    event('dokploy');
    const path = new URL(url).pathname;
    if (path.endsWith('application.saveEnvironment')) return { status: 200, ok: true, text: async () => 'true' };
    if (path.endsWith('application.one')) {
      const next = it.next();
      if (next.done) throw new Error('unscripted extra application.one read');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ applicationId: APP_ID, name: 'demo-app', env: next.value, buildArgs: null, buildSecrets: null, createEnvFile: true, autoDeploy: true, branch: 'main' }),
      };
    }
    throw new Error(`unscripted Dokploy request: ${path}`);
  });
}

async function run(fetchMock: ReturnType<typeof dokployFetch>, options: Parameters<typeof deployCommand>[1], cwd: string, tty: boolean = false) {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  const ttySpy = spyOn(process.stdin, 'isTTY', 'get' as never).mockReturnValue(tty as never);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code}__`);
  }) as never);
  const saved = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = 'dk_test_token';
  try {
    const code = await deployCommand('dokploy-ci', options, cwd).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.startsWith('__exit_')) throw err;
      return Number(m.slice('__exit_'.length, -2));
    });
    return { code, stdout: logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n'), stderr: errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n') };
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = saved;
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
    ttySpy.mockRestore();
    exitSpy.mockRestore();
  }
}

const saves = (f: ReturnType<typeof dokployFetch>) => f.mock.calls.filter((c) => String(c[0]).endsWith('saveEnvironment'));
const row = { name: NAME, project: 'demo', branch: BRANCH, type: 'changed', pinned: hashValue('120'), local: hashValue('120'), remote: hashValue('180') };

describe('Vince\'s case: folder 120, .env 120, Capy 180, deploy a target delivering GEMINI', () => {
  test('at a terminal: bare capy\'s table and menu come BEFORE the Dokploy preflight and the confirm screen', async () => {
    const w = world();
    menu.mockImplementation(() => ({ action: 'retrieve_remote' }));
    const f = dokployFetch([RAW_ENV, RAW_ENV]);
    await run(f, {}, w.folder.dir, true);
    const log = events();
    expect(log[0]).toBe('menu');
    expect(log.indexOf('menu')).toBeLessThan(log.indexOf('dokploy'));
    expect(log.indexOf('menu')).toBeLessThan(log.indexOf('confirm'));
    // The person chose Capy's value at the table: the folder has it by the time the confirm screen is up.
    expect(w.folder.env()[NAME]).toBe('180');
  });

  test('off a terminal (--yes): exit 3 with the row alone on stdout; Dokploy is not contacted; nothing is delivered or saved', async () => {
    const w = world();
    const f = dokployFetch([]);
    const out = await run(f, { yes: true }, w.folder.dir);
    expect(out.code).toBe(3);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(payload).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
    expect(payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(payload.conflicts).toEqual([row]);
    expect(f).not.toHaveBeenCalled();
    expect(`${out.stdout}${out.stderr}`).not.toContain('120');
    expect(`${out.stdout}${out.stderr}`).not.toContain('180');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.folder.env()[NAME]).toBe('120');
  }, 30_000);

  test('--resolve =local: 120 is committed to Capy, THEN delivered to Dokploy', async () => {
    const w = world();
    const first = JSON.parse((await run(dokployFetch([]), { yes: true }, w.folder.dir)).stdout) as { conflict_id: string };
    const f = dokployFetch([RAW_ENV, RAW_ENV, RAW_ENV, merged('120')]);
    const out = await run(f, { yes: true, conflictFlags: { resolve: [`${NAME}=local`], conflict: first.conflict_id } }, w.folder.dir);
    expect(out.code).toBe(0);
    expect(serverValues(w.server.state(), BRANCH, KEY)[NAME]).toBe('120');
    expect(saves(f)).toHaveLength(1);
    expect(JSON.parse(String(saves(f)[0][1].body)).env).toContain(`${NAME}=120`);
    // Capy was written to BEFORE Dokploy: the first push to Capy precedes the first Dokploy request in the shared log.
    expect(events().indexOf('capy.push')).toBeGreaterThanOrEqual(0);
    expect(events().indexOf('capy.push')).toBeLessThan(events().indexOf('dokploy'));
    expect(w.folder.env()[NAME]).toBe('120');
  }, 30_000);

  test('--resolve =remote: 180 is delivered, and the folder takes it', async () => {
    const w = world();
    const first = JSON.parse((await run(dokployFetch([]), { yes: true }, w.folder.dir)).stdout) as { conflict_id: string };
    const f = dokployFetch([RAW_ENV, RAW_ENV, RAW_ENV, merged('180')]);
    const out = await run(f, { yes: true, conflictFlags: { resolve: [`${NAME}=remote`], conflict: first.conflict_id } }, w.folder.dir);
    expect(out.code).toBe(0);
    expect(saves(f)).toHaveLength(1);
    expect(JSON.parse(String(saves(f)[0][1].body)).env).toContain(`${NAME}=180`);
    expect(serverValues(w.server.state(), BRANCH, KEY)[NAME]).toBe('180');
    expect(w.folder.env()[NAME]).toBe('180');
    expect(w.folder.pin(NAME)).toBe(hashValue('180'));
  }, 30_000);

  test('--dry-run reports the same row and id with dry_run, and changes nothing', async () => {
    const w = world();
    const real = JSON.parse((await run(dokployFetch([]), { yes: true }, w.folder.dir)).stdout) as { conflict_id: string };
    const f = dokployFetch([]);
    const out = await run(f, { yes: true, dryRun: true }, w.folder.dir);
    expect(out.code).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: real.conflict_id, conflicts: [row] });
    expect(f).not.toHaveBeenCalled();
    expect(w.folder.env()[NAME]).toBe('120');
  }, 30_000);
});
