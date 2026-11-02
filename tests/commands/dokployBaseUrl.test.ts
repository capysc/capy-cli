/**
 * The Dokploy base URL as an org system variable (CAP-703): ONE resolver for every path that needs it.
 *
 * Order: `--base-url`, the system variable `_CONNECTOR_DOKPLOY_BASE_URL`, the Dokploy target saved in the
 * folder's deploy.json, else a structured refusal with `unanswered`. The first `--base-url` is saved by an
 * admin; a non-admin gets a coded notice; a flag that differs from the stored URL wins for the run and never
 * overwrites. Fakes only: the system store is an in-memory object.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapyError } from '../../src/types/index';
import { DOKPLOY_BASE_URL_VAR_NAME, type FetchLike } from '../../src/deploy/dokployApi';
import { normalizeDokployBaseUrl, offerSaveAskedBaseUrl, resolveDokployBaseUrl, type BaseUrlStore } from '../../src/deploy/dokployBaseUrl';
import { withTty } from '../helpers/processState';
import { runDeployDokployDiscover } from '../../src/commands/deployDiscover/command';
import { createDokployConnector } from '../../src/commands/connectors/dokploy';
import { ConnectCommand } from '../../src/commands/connectCommand';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { DiscoveryContext } from '../../src/commands/connectors/dokployDiscovery';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import { ENTRY_SOLO, SENTINEL_CAPY, SENTINEL_DOKPLOY, TOKEN, makeWorld, planFile } from '../helpers/deployDiscoverWorld';

const STORED = 'https://stored.example.com';
const FLAG = 'https://flag.example.com';
const SAVED_TARGET = 'https://saved-target.example.com';

/** An in-memory system store: `initial` is what the variable holds (absent: unset). */
function storeFake(initial?: string) {
  const set = mock(async (_name: string, _value: string) => undefined);
  const store: BaseUrlStore = { get: (name) => (name === DOKPLOY_BASE_URL_VAR_NAME ? (initial ?? null) : null), set };
  const open = mock(async () => store);
  return { store, set, open };
}

const nonAdmin = () => mock(async (): Promise<BaseUrlStore> => { throw new CapyError('x', 'SYSTEM_STORE_ADMIN_ONLY'); });

describe('the variable name follows the system store convention', () => {
  test('_CONNECTOR_<PROVIDER>_<NAME>, next to the API key', () => {
    expect(DOKPLOY_BASE_URL_VAR_NAME).toBe('_CONNECTOR_DOKPLOY_BASE_URL');
    expect(/^_(?:CONNECTOR|TARGET)_[A-Z0-9]+_[A-Z0-9_]+$/.test(DOKPLOY_BASE_URL_VAR_NAME)).toBe(true);
  });
});

describe('the resolver: each step, in order', () => {
  test('1. --base-url wins over the variable and the saved target', async () => {
    const { open } = storeFake(STORED);
    const r = await resolveDokployBaseUrl({ flag: FLAG, openStore: open, savedTargetUrl: () => SAVED_TARGET });
    expect(r).toMatchObject({ ok: true, baseUrl: FLAG, source: 'flag' });
  });

  test('2. the system variable, when there is no flag, wins over the saved target', async () => {
    const { open } = storeFake(STORED);
    const r = await resolveDokployBaseUrl({ openStore: open, savedTargetUrl: () => SAVED_TARGET });
    expect(r).toEqual({ ok: true, baseUrl: STORED, source: 'system', notices: [] });
  });

  test('3. the saved deploy.json target, when the variable is unset', async () => {
    const { open } = storeFake(undefined);
    const r = await resolveDokployBaseUrl({ openStore: open, savedTargetUrl: () => SAVED_TARGET });
    expect(r).toEqual({ ok: true, baseUrl: SAVED_TARGET, source: 'saved_target', notices: [] });
  });

  test('3. ...and when the store cannot be opened (not an admin)', async () => {
    const r = await resolveDokployBaseUrl({ openStore: nonAdmin(), savedTargetUrl: () => SAVED_TARGET });
    expect(r).toMatchObject({ ok: true, baseUrl: SAVED_TARGET, source: 'saved_target' });
  });

  test('4. nothing anywhere: the structured refusal with `unanswered`', async () => {
    const r = await resolveDokployBaseUrl({ openStore: storeFake(undefined).open, savedTargetUrl: () => undefined });
    expect(r).toEqual({
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      error: expect.any(String),
      unanswered: [{ id: 'base_url', flag: '--base-url', hint: expect.any(String) }],
    });
  });

  test('without a store at all (an offline caller) the variable is skipped', async () => {
    const r = await resolveDokployBaseUrl({ flag: FLAG, savedTargetUrl: () => undefined });
    expect(r).toEqual({ ok: true, baseUrl: FLAG, source: 'flag', notices: [] });
  });
});

describe('the resolver: validation and normalisation', () => {
  test('a trailing slash is dropped and spaces trimmed; http is only for localhost', () => {
    expect(normalizeDokployBaseUrl('  https://dokploy.example.com/  ')).toBe('https://dokploy.example.com');
    expect(normalizeDokployBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeDokployBaseUrl('http://dokploy.example.com')).toBeNull();
    expect(normalizeDokployBaseUrl('not a url')).toBeNull();
  });

  test('a bad --base-url is DOKPLOY_URL_INVALID, and nothing is read or saved', async () => {
    const { open, set } = storeFake(undefined);
    const r = await resolveDokployBaseUrl({ flag: 'http://dokploy.example.com', openStore: open, savedTargetUrl: () => undefined });
    expect(r).toMatchObject({ ok: false, code: 'DOKPLOY_URL_INVALID' });
    expect(open).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  test('a bad stored value is DOKPLOY_URL_INVALID too, not silently skipped', async () => {
    const r = await resolveDokployBaseUrl({ openStore: storeFake('ftp://nope').open, savedTargetUrl: () => SAVED_TARGET });
    expect(r).toMatchObject({ ok: false, code: 'DOKPLOY_URL_INVALID' });
  });
});

describe('the resolver: saving the first --base-url', () => {
  test('an admin, variable unset: the NORMALISED URL is saved to the variable, and reported', async () => {
    const { open, set } = storeFake(undefined);
    const r = await resolveDokployBaseUrl({ flag: `${FLAG}/`, openStore: open, savedTargetUrl: () => undefined });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', FLAG);
    expect(r).toEqual({ ok: true, baseUrl: FLAG, source: 'flag', saved: { base_url: true }, notices: [] });
  });

  test('not an admin: nothing saved, and a coded notice carries the reason', async () => {
    const r = await resolveDokployBaseUrl({ flag: FLAG, openStore: nonAdmin(), savedTargetUrl: () => undefined });
    expect(r).toEqual({ ok: true, baseUrl: FLAG, source: 'flag', notices: [{ code: 'BASE_URL_NOT_SAVED', reason: 'SYSTEM_STORE_ADMIN_ONLY' }] });
  });

  test('a save that fails is a notice too, never a failure of the run', async () => {
    const { store } = storeFake(undefined);
    const failing: BaseUrlStore = { ...store, set: async () => { throw new CapyError('x', 'SERVICE_ERROR'); } };
    const r = await resolveDokployBaseUrl({ flag: FLAG, openStore: async () => failing, savedTargetUrl: () => undefined });
    expect(r).toMatchObject({ ok: true, baseUrl: FLAG, notices: [{ code: 'BASE_URL_NOT_SAVED', reason: 'SERVICE_ERROR' }] });
    expect(r).not.toHaveProperty('saved');
  });

  test('the variable already holds a DIFFERENT URL: the flag is used for this run, nothing is overwritten, and a notice says so', async () => {
    const { open, set } = storeFake(STORED);
    const r = await resolveDokployBaseUrl({ flag: FLAG, openStore: open, savedTargetUrl: () => undefined });
    expect(set).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, baseUrl: FLAG, source: 'flag', notices: [{ code: 'BASE_URL_DIFFERS_FROM_STORED', stored: STORED, used: FLAG }] });
  });

  test('the variable already holds the same URL: no notice, no save', async () => {
    const { open, set } = storeFake(`${FLAG}/`);
    const r = await resolveDokployBaseUrl({ flag: FLAG, openStore: open, savedTargetUrl: () => undefined });
    expect(set).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, notices: [] });
  });

  test('a dry run saves nothing (a dry run changes nothing) and says why', async () => {
    const { open, set } = storeFake(undefined);
    const r = await resolveDokployBaseUrl({ flag: FLAG, dryRun: true, openStore: open, savedTargetUrl: () => undefined });
    expect(set).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, notices: [{ code: 'BASE_URL_NOT_SAVED', reason: 'DRY_RUN' }] });
  });
});

describe('capy deploy dokploy --discover uses the resolver', () => {
  test('the stored URL is used with no flag, and is the base_url of the output and of every proposed target', async () => {
    const world = makeWorld({ io: { openBaseUrlStore: storeFake(STORED).open } });
    const result = await runDeployDokployDiscover({}, world.io);
    const body = result.body as any;
    expect(body.base_url).toBe(STORED);
    expect(body.proposals.every((p: any) => p.target.baseUrl === STORED)).toBe(true);
    expect(body).not.toHaveProperty('saved');
  });

  test('the first --base-url as an admin is saved and reported as saved: { base_url: true }', async () => {
    const fake = storeFake(undefined);
    const world = makeWorld({ io: { openBaseUrlStore: fake.open } });
    const body = (await runDeployDokployDiscover({ baseUrl: FLAG }, world.io)).body as any;
    expect(fake.set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', FLAG);
    expect(body.saved).toEqual({ base_url: true });
  });

  test('a non-admin gets BASE_URL_NOT_SAVED in notices, and the run still works', async () => {
    const world = makeWorld({ io: { openBaseUrlStore: nonAdmin() as never } });
    const result = await runDeployDokployDiscover({ baseUrl: FLAG }, world.io);
    const body = result.body as any;
    expect(result.exitCode).toBe(0);
    expect(body.notices).toContainEqual({ code: 'BASE_URL_NOT_SAVED', reason: 'SYSTEM_STORE_ADMIN_ONLY' });
    expect(body).not.toHaveProperty('saved');
  });

  test('a differing --base-url is used, not saved over the stored one, and noticed', async () => {
    const fake = storeFake(STORED);
    const world = makeWorld({ io: { openBaseUrlStore: fake.open } });
    const body = (await runDeployDokployDiscover({ baseUrl: FLAG }, world.io)).body as any;
    expect(body.base_url).toBe(FLAG);
    expect(fake.set).not.toHaveBeenCalled();
    expect(body.notices).toContainEqual({ code: 'BASE_URL_DIFFERS_FROM_STORED', stored: STORED, used: FLAG });
  });

  test('no flag, no variable, no saved target: the structured refusal (exit 3, needs input) with unanswered', async () => {
    const world = makeWorld({ io: { openBaseUrlStore: storeFake(undefined).open } });
    const result = await runDeployDokployDiscover({}, world.io);
    expect(result.exitCode).toBe(3);
    expect(result.body).toEqual({
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      error: expect.any(String),
      unanswered: [{ id: 'base_url', flag: '--base-url', hint: expect.any(String) }],
    });
    expect(world.dokploy.listProjects).not.toHaveBeenCalled();
  });

  test('plan_id covers the RESOLVED URL: a dry run on the flag and a confirm on the stored variable agree', async () => {
    const text = planFile([ENTRY_SOLO]);
    const files = { 'p.json': text };
    const dry = makeWorld({ files, io: { openBaseUrlStore: storeFake(undefined).open } });
    const approved = ((await runDeployDokployDiscover({ baseUrl: STORED, plan: 'p.json', dryRun: true }, dry.io)).body as any).plan_id;
    const confirm = makeWorld({ files, io: { openBaseUrlStore: storeFake(STORED).open } });
    const result = await runDeployDokployDiscover({ plan: 'p.json', confirm: approved }, confirm.io);
    expect((result.body as any).ok).toBe(true);
    expect(confirm.github.createPull).toHaveBeenCalled();
    // And a different resolved URL is a different plan.
    const other = makeWorld({ files, io: { openBaseUrlStore: storeFake('https://another.example.com').open } });
    expect(((await runDeployDokployDiscover({ plan: 'p.json', confirm: approved }, other.io)).body as any).code).toBe('PLAN_CHANGED');
  });
});

describe('capy connect dokploy --discover uses the same resolver', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'capy-baseurl-connect-'));
  const ctx = { orgId: 'org_1', userId: 'user_1', serviceClient: {}, authService: {} } as unknown as DiscoveryContext;

  function recordingFetch() {
    const urls = mock((_url: string) => undefined);
    const fetchImpl: FetchLike = (async (url: string) => {
      urls(url);
      return { status: 200, ok: true, text: async () => '[]' };
    }) as FetchLike;
    return { urls, fetchImpl };
  }

  test('with no flag the stored URL is where Dokploy is read', async () => {
    const { urls, fetchImpl } = recordingFetch();
    const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT, openBaseUrlStore: storeFake(STORED).open as never });
    const outcome = await connector.discover!(ctx, { nonTty: true, dryRun: true, tokenEnv: 'T' } as ConnectOpts);
    expect(outcome.ok).toBe(true);
    expect(String(urls.mock.calls[0][0]).startsWith(`${STORED}/api/`)).toBe(true);
  });

  test('the first --base-url is saved and reported; a differing one is noticed', async () => {
    const { fetchImpl } = recordingFetch();
    const fake = storeFake(undefined);
    const first = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT, openBaseUrlStore: fake.open as never });
    await first.discover!(ctx, { nonTty: true, tokenEnv: 'T', baseUrl: FLAG, yes: false } as ConnectOpts);
    // No --yes: it stops at the confirmation, after the URL was resolved and saved.
    expect(fake.set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', FLAG);
    const differs = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT, openBaseUrlStore: storeFake(STORED).open as never });
    const outcome = await differs.discover!(ctx, { nonTty: true, dryRun: true, tokenEnv: 'T', baseUrl: FLAG } as ConnectOpts);
    expect(outcome.ok && outcome.notices).toContainEqual({ code: 'BASE_URL_DIFFERS_FROM_STORED', stored: STORED, used: FLAG });
  });

  test('nothing anywhere: the same structured refusal, unanswered included', async () => {
    const connector = createDokployConnector({ env: { T: 'x' }, cwd: ROOT, openBaseUrlStore: storeFake(undefined).open as never });
    const outcome = await connector.discover!(ctx, { nonTty: true, tokenEnv: 'T' } as ConnectOpts);
    expect(outcome).toEqual({
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      message: expect.any(String),
      unanswered: [{ id: 'base_url', flag: '--base-url', hint: expect.any(String) }],
    });
  });

  test('the JSON ConnectCommand prints carries saved, notices and unanswered', async () => {
    const { fetchImpl } = recordingFetch();
    const printed = mock((..._a: unknown[]) => undefined);
    const spy = spyOn(console, 'log').mockImplementation(printed as never);
    const saved = process.exitCode;
    try {
      const withSaved = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT, openBaseUrlStore: storeFake(undefined).open as never });
      await (new ConnectCommand(false) as unknown as { executeDiscovery: Function }).executeDiscovery(withSaved, 'dokploy', ctx, {
        json: true, nonTty: true, dryRun: false, tokenEnv: 'T', baseUrl: FLAG,
      } as ConnectOpts);
      const refused = createDokployConnector({ env: { T: 'x' }, cwd: ROOT });
      await (new ConnectCommand(false) as unknown as { executeDiscovery: Function }).executeDiscovery(refused, 'dokploy', ctx, { json: true, nonTty: true, tokenEnv: 'T' } as ConnectOpts);
    } finally {
      spy.mockRestore();
      process.exitCode = saved ?? 0;
    }
    const outputs = printed.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(outputs[0].saved).toEqual({ base_url: true });
    expect(outputs[1]).toMatchObject({ ok: false, code: 'DOKPLOY_SETTINGS_MISSING', unanswered: [{ id: 'base_url', flag: '--base-url' }] });
    rmSync(ROOT, { recursive: true, force: true });
  });
});

describe('the single-service connect import reads the variable too', () => {
  test('--application with no --base-url reads Dokploy at the stored URL', async () => {
    const calls = mock((_url: string) => undefined);
    const fetchImpl: FetchLike = (async (url: string) => {
      calls(url);
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ applicationId: 'app_1', name: 'a', env: 'A=1', buildArgs: null, buildSecrets: null, createEnvFile: true }),
      };
    }) as FetchLike;
    const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: tmpdir(), openBaseUrlStore: storeFake(STORED).open as never });
    const keep = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    const ctx = { keep, branch: 'development', localPlaintext: {}, orgId: 'org_1' } as unknown as ResolvedContext;
    const outcome = await connector.import!(ctx, { nonTty: true, application: 'app_1', tokenEnv: 'T', dryRun: true } as ConnectOpts);
    expect(outcome.ok).toBe(true);
    expect(String(calls.mock.calls[0][0]).startsWith(`${STORED}/api/`)).toBe(true);
  });
});

describe('the API key is never printed; the URL may be', () => {
  test('neither the Dokploy key, nor either value sentinel, is in a discovery or plan output; the URL is', async () => {
    const world = makeWorld({ files: { 'p.json': planFile([ENTRY_SOLO]) }, io: { openBaseUrlStore: storeFake(undefined).open } });
    const discovery = (await runDeployDokployDiscover({ baseUrl: FLAG }, world.io)).body;
    const plan = (await runDeployDokployDiscover({ baseUrl: FLAG, plan: 'p.json', dryRun: true }, world.io)).body;
    const refusal = (await runDeployDokployDiscover({}, makeWorld({ io: { openBaseUrlStore: storeFake(undefined).open } }).io)).body;
    const everything = JSON.stringify([discovery, plan, refusal]) + world.progress.mock.calls.map(([l]) => String(l)).join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(SENTINEL_DOKPLOY);
    expect(everything).not.toContain(SENTINEL_CAPY);
    expect(everything).toContain(FLAG);
  });

  test('a missing key refuses without echoing anything secret', async () => {
    const world = makeWorld({ io: { getConnectorSecret: async () => null, openBaseUrlStore: storeFake(STORED).open } });
    const body = (await runDeployDokployDiscover({}, world.io)).body as any;
    expect(body.code).toBe('DOKPLOY_TOKEN_MISSING');
    expect(body.dashboard).toBe(STORED);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

// ── CAP-703: a prompt collected the URL; non-TTY refusals are structured ─────

describe('a terminal prompt that collects the URL offers it to the org (admins only)', () => {
  const SAVED_LINE = 'Saved the Dokploy URL for your org.';
  const NOT_ADMIN_LINE = 'Not saved for the org: only org admins can save the Dokploy URL.';

  test('the shared save path: an admin with the variable unset saves, and says so', async () => {
    const { open, set } = storeFake(undefined);
    const log = mock((_l: string) => undefined);
    const r = await offerSaveAskedBaseUrl({ baseUrl: FLAG, openStore: open, log });
    expect(r).toEqual({ saved: true });
    expect(set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', FLAG);
    expect(log.mock.calls.map(([l]) => l)).toEqual([SAVED_LINE]);
  });

  test('an admin with the variable already set: never overwritten, silent', async () => {
    const { open, set } = storeFake(STORED);
    const log = mock((_l: string) => undefined);
    expect(await offerSaveAskedBaseUrl({ baseUrl: FLAG, openStore: open, log })).toEqual({ saved: false });
    expect(set).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('a non-admin (decided by the store\'s code): not saved, one line', async () => {
    const log = mock((_l: string) => undefined);
    expect(await offerSaveAskedBaseUrl({ baseUrl: FLAG, openStore: nonAdmin(), log })).toEqual({ saved: false });
    expect(log.mock.calls.map(([l]) => l)).toEqual([NOT_ADMIN_LINE]);
  });

  test('another failure to save (not an admin problem) is silent: it would only be noise at a prompt', async () => {
    const { store } = storeFake(undefined);
    const failing: BaseUrlStore = { ...store, set: async () => { throw new CapyError('x', 'SERVICE_ERROR'); } };
    const log = mock((_l: string) => undefined);
    await offerSaveAskedBaseUrl({ baseUrl: FLAG, openStore: async () => failing, log });
    expect(log).not.toHaveBeenCalled();
  });

  /** Runs one interactive single-service import that asks for its settings; returns what went to stderr and the outcome. */
  async function interactiveImport(openStore: ReturnType<typeof storeFake>['open'] | ReturnType<typeof nonAdmin>, opts: Partial<ConnectOpts> = {}, status = 200) {
    const fetchImpl: FetchLike = (async () => ({
      status,
      ok: status === 200,
      text: async () => JSON.stringify({ applicationId: 'app_1', name: 'a', env: `A=${SENTINEL_DOKPLOY}`, buildArgs: null, buildSecrets: null, createEnvFile: true }),
    })) as FetchLike;
    const connector = createDokployConnector({
      fetch: fetchImpl,
      env: { T: 'x' },
      cwd: tmpdir(),
      openBaseUrlStore: openStore as never,
      askSourceKind: async () => 'application' as const,
      askSettings: async () => ({ baseUrl: FLAG, applicationId: 'app_1' }),
      selectVars: async (c: readonly string[]) => c,
      confirm: async () => true,
    });
    const keep = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    const ctx = { keep, branch: 'development', localPlaintext: {}, orgId: 'org_1' } as unknown as ResolvedContext;
    const errors = mock((..._a: unknown[]) => undefined);
    const errSpy = spyOn(console, 'error').mockImplementation(errors as never);
    try {
      const outcome = await withTty({ stdin: true }, () => connector.import!(ctx, { nonTty: false, tokenEnv: 'T', ...opts } as ConnectOpts));
      return { outcome, stderr: errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
    } finally {
      errSpy.mockRestore();
    }
  }

  test('capy connect dokploy, an admin, variable unset: the URL typed at the prompt is saved once Dokploy has answered', async () => {
    const { open, set } = storeFake(undefined);
    const { outcome, stderr } = await interactiveImport(open);
    expect(outcome.ok).toBe(true);
    expect(set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', FLAG);
    expect(stderr).toContain(SAVED_LINE);
  });

  test('capy connect dokploy, an admin, variable already set: not overwritten, silent', async () => {
    const { open, set } = storeFake(STORED);
    // The stored URL is used for the import, so nothing is asked at all.
    const { outcome, stderr } = await interactiveImport(open);
    expect(outcome.ok).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(stderr).not.toContain(SAVED_LINE);
  });

  test('capy connect dokploy, a non-admin: nothing saved, one line says why', async () => {
    const { outcome, stderr } = await interactiveImport(nonAdmin());
    expect(outcome.ok).toBe(true);
    expect(stderr.split('\n').filter((l) => l.includes(NOT_ADMIN_LINE))).toHaveLength(1);
  });

  test('nothing is saved when Dokploy refused the URL, or under --dry-run', async () => {
    const refused = storeFake(undefined);
    const bad = await interactiveImport(refused.open, {}, 404);
    expect(bad.outcome.ok).toBe(false);
    expect(refused.set).not.toHaveBeenCalled();
    const dry = storeFake(undefined);
    await interactiveImport(dry.open, { dryRun: true });
    expect(dry.set).not.toHaveBeenCalled();
  });

  test('the API key and the Dokploy value are never printed', async () => {
    const { stderr } = await interactiveImport(storeFake(undefined).open);
    expect(stderr).not.toContain(SENTINEL_DOKPLOY);
    expect(stderr).not.toContain(TOKEN);
  });
});

describe('the single-service non-TTY refusal is structured, like every other Dokploy command', () => {
  const keep = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  const ctx = { keep, branch: 'development', localPlaintext: {}, orgId: 'org_1' } as unknown as ResolvedContext;

  test('nothing given: DOKPLOY_SETTINGS_MISSING with the base URL and the service in `unanswered`', async () => {
    const connector = createDokployConnector({ env: { T: 'x' }, cwd: tmpdir() });
    const outcome = await connector.import!(ctx, { nonTty: true, tokenEnv: 'T' } as ConnectOpts);
    expect(outcome).toEqual({
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      message: expect.any(String),
      unanswered: [
        { id: 'base_url', flag: '--base-url', hint: 'your Dokploy dashboard URL, e.g. https://dokploy.example.com' },
        { id: 'service', flag: '--application', alternative: '--compose', hint: expect.any(String) },
      ],
    });
  });

  test('--compose without a URL: only the base URL is unanswered', async () => {
    const connector = createDokployConnector({ env: { T: 'x' }, cwd: tmpdir() });
    const outcome = await connector.import!(ctx, { nonTty: true, tokenEnv: 'T', compose: 'c1' } as ConnectOpts);
    expect(outcome).toMatchObject({ ok: false, code: 'DOKPLOY_SETTINGS_MISSING', unanswered: [{ id: 'base_url', flag: '--base-url' }] });
  });

  async function printed(opts: Partial<ConnectOpts>) {
    const out = mock((..._a: unknown[]) => undefined);
    const err = mock((..._a: unknown[]) => undefined);
    const logSpy = spyOn(console, 'log').mockImplementation(out as never);
    const errSpy = spyOn(console, 'error').mockImplementation(err as never);
    const before = process.exitCode;
    try {
      const connector = createDokployConnector({ env: { T: 'x' }, cwd: tmpdir() });
      await (new ConnectCommand(false) as unknown as { executeImport: Function }).executeImport(connector, 'dokploy', ctx, { nonTty: true, tokenEnv: 'T', ...opts } as ConnectOpts);
      return { exitCode: process.exitCode, out: out.mock.calls.map(([l]) => String(l)), err: err.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = before ?? 0;
    }
  }

  test('--json: the same JSON refusal as the other commands, and exit 3 (needs input)', async () => {
    const r = await printed({ json: true });
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.out[0])).toMatchObject({ ok: false, code: 'DOKPLOY_SETTINGS_MISSING', unanswered: [{ id: 'base_url', flag: '--base-url' }, { id: 'service' }] });
  });

  test('human mode: the error and each hint on stderr, nothing on stdout, exit 3', async () => {
    const r = await printed({});
    expect(r.exitCode).toBe(3);
    expect(r.out).toEqual([]);
    expect(r.err).toContain('--base-url');
    expect(r.err).toContain('https://dokploy.example.com');
  });

  test('another refusal still exits 1', async () => {
    const r = await printed({ json: true, application: 'a', compose: 'c' });
    expect(r.exitCode).toBe(1);
  });
});
