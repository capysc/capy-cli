/**
 * The `capy deploy` Dokploy setup prompt and the org system variable `_CONNECTOR_DOKPLOY_BASE_URL` (CAP-703).
 *
 * A Dokploy URL typed at the setup prompt is offered to the org through the shared resolver's save path: saved
 * ONLY when the variable is unset and the caller is an org admin, never overwriting, with one short dim line on
 * stderr either way. The stored value is also the prompt's default. The Dokploy API key is never printed.
 *
 * `mock.module('inquirer', ...)` and `mock.module('../../src/system/systemStore', ...)` are process-wide: this
 * file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';
import { CapyError } from '../../src/types/index';

const promptMock = mock(async (..._args: unknown[]) => ({}) as Record<string, unknown>);
mock.module('inquirer', () => ({ default: { prompt: promptMock, Separator: class {} } }));

const API_KEY = 'dokploy-api-key-that-must-never-print';
const set = mock(async (_name: string, _value: string) => undefined);
/** What the variable holds (undefined: unset) and whether the caller may open the store. */
const world = { stored: undefined as string | undefined, admin: true };
const openSystemStore = mock(async (_opts: unknown) => {
  if (!world.admin) throw new CapyError('x', 'SYSTEM_STORE_ADMIN_ONLY');
  return { get: (_name: string) => world.stored ?? null, set };
});
mock.module('../../src/system/systemStore', () => ({
  getDirectionalConnectorSecret: mock(async () => API_KEY),
  openSystemStore,
}));

import { resolveAdapterOptions } from '../../src/commands/deployCommand';
import { getAdapter } from '../../src/deploy/registry';

const adapter = getAdapter('dokploy');
if (!adapter) throw new Error('dokploy adapter not registered');

const URL_ENTERED = 'https://dokploy.example.com';

function answerBareId(baseUrl: string) {
  promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_1' }));
  promptMock.mockImplementationOnce(async () => ({ kind: 'compose', baseUrl }));
}

/** Runs the picker with stderr and stdout captured; returns what was written. */
async function setup(existingOpts: Record<string, string>, orgId: string | null = 'org_1') {
  const errors = mock((..._a: unknown[]) => undefined);
  const logs = mock((..._a: unknown[]) => undefined);
  const errSpy = spyOn(console, 'error').mockImplementation(errors as never);
  const logSpy = spyOn(console, 'log').mockImplementation(logs as never);
  try {
    const options = await resolveAdapterOptions(adapter!, '/tmp', [], {}, existingOpts, orgId ?? undefined);
    const text = (m: typeof errors) => m.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    return { options, stderr: text(errors), stdout: text(logs) };
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
}

afterEach(() => {
  promptMock.mockReset();
  set.mockClear();
  openSystemStore.mockClear();
  world.stored = undefined;
  world.admin = true;
});

describe('capy deploy setup: the Dokploy URL prompt offers the URL to the org (admins only)', () => {
  test('an admin, variable unset: the typed URL is saved, with one short line', async () => {
    answerBareId(URL_ENTERED);
    const { options, stderr } = await setup({});
    expect(options).toEqual({ baseUrl: URL_ENTERED, composeId: 'compose_1' });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('_CONNECTOR_DOKPLOY_BASE_URL', URL_ENTERED);
    expect(stderr.split('\n').filter((l) => l.includes('Saved the Dokploy URL for your org.'))).toHaveLength(1);
  });

  test('an admin, variable already set to something else: never overwritten, no line', async () => {
    world.stored = 'https://stored.example.com';
    answerBareId(URL_ENTERED);
    const { stderr } = await setup({});
    expect(set).not.toHaveBeenCalled();
    expect(stderr).not.toContain('Saved the Dokploy URL');
    expect(stderr).not.toContain('Not saved');
  });

  test('a non-admin: nothing saved, and one short line says why', async () => {
    world.admin = false;
    answerBareId(URL_ENTERED);
    const { options, stderr } = await setup({});
    expect(options).toEqual({ baseUrl: URL_ENTERED, composeId: 'compose_1' });
    expect(set).not.toHaveBeenCalled();
    expect(stderr.split('\n').filter((l) => l.includes('Not saved for the org: only org admins can save the Dokploy URL.'))).toHaveLength(1);
  });

  test('the stored URL is the prompt default, and accepting it saves nothing new', async () => {
    world.stored = URL_ENTERED;
    promptMock.mockImplementationOnce(async () => ({ serviceUrl: 'compose_1' }));
    promptMock.mockImplementationOnce(async (qs: unknown) => {
      expect((qs as ReadonlyArray<{ name: string; default?: unknown }>).find((q) => q.name === 'baseUrl')?.default).toBe(URL_ENTERED);
      return { kind: 'compose', baseUrl: URL_ENTERED };
    });
    const { stderr } = await setup({});
    expect(set).not.toHaveBeenCalled();
    expect(stderr).toBe('');
  });

  test('a URL the target already had is not "entered": nothing is saved', async () => {
    answerBareId('https://old.example.com');
    await setup({ baseUrl: 'https://old.example.com', composeId: 'compose_1' });
    expect(set).not.toHaveBeenCalled();
  });

  test('without an org there is nothing to save to', async () => {
    answerBareId(URL_ENTERED);
    await setup({}, null);
    expect(openSystemStore).not.toHaveBeenCalled();
  });

  test('the API key is never printed', async () => {
    answerBareId(URL_ENTERED);
    const { stderr, stdout } = await setup({});
    expect(stderr + stdout).not.toContain(API_KEY);
  });
});
