/**
 * `capy system set <NAME>` prints where to get the key before the hidden
 * prompt, for the four known key names — and nothing new for any other name.
 * The help goes to stderr, so `--json` stdout stays one pure JSON object.
 *
 * Command layer only: the store and `inquirer` are mocked (`mock.module`), so
 * this file runs on its own (see ISOLATED_FILES in tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { captureConsole, withTTY } from '../helpers/testSandbox';

const setStore = mock(async (_name: string, _value: string) => {});

mock.module('../../src/system/systemStore', () => ({
  assertValidConnectorName: () => {},
  openSystemStore: async () => ({ orgId: 'org_x', userId: 'u', listNames: () => [], get: () => null, set: setStore, remove: async () => {} }),
}));

const typed = mock(async (_questions: unknown) => ({ value: 'typed-fake-value' }));
mock.module('inquirer', () => ({ default: { prompt: typed, createPromptModule: () => typed } }));

afterAll(() => mock.restore());

const run = async (name: string, json: boolean) => {
  const { systemSetCommand } = await import('../../src/commands/systemCommand');
  return withTTY(() => captureConsole(() => systemSetCommand(name, { json })));
};

const URLS: ReadonlyArray<[string, string]> = [
  ['_CONNECTOR_VERCEL_TOKEN', 'https://vercel.com/account/settings/tokens'],
  ['_TARGET_VERCEL_TOKEN', 'https://vercel.com/account/settings/tokens'],
  ['_CONNECTOR_DOKPLOY_API_KEY', 'https://docs.dokploy.com/docs/api'],
  ['_TARGET_DOKPLOY_API_KEY', 'https://docs.dokploy.com/docs/api'],
];

describe('capy system set — key help before the hidden prompt', () => {
  for (const [name, url] of URLS) {
    test(`${name}: the link is on stderr; the saved value is what was typed; the value is never echoed`, async () => {
      const out = await run(name, false);
      expect(out.stderr.join('\n')).toContain(url);
      expect(out.stderr.join('\n')).toContain(`capy system set ${name}`);
      expect(setStore.mock.calls.at(-1)).toEqual([name, 'typed-fake-value']);
      expect([...out.stdout, ...out.stderr].join('\n')).not.toContain('typed-fake-value');
    });
  }

  test('--json: stdout is exactly one JSON object; the link is on stderr only', async () => {
    const out = await run('_CONNECTOR_VERCEL_TOKEN', true);
    expect(out.stdout.length).toBe(1);
    expect(JSON.parse(out.stdout[0])).toEqual({ ok: true, name: '_CONNECTOR_VERCEL_TOKEN' });
    expect(out.stderr.join('\n')).toContain('https://vercel.com/account/settings/tokens');
  });

  test('any other name: nothing new is printed', async () => {
    const out = await run('_CONNECTOR_STRIPE_API_KEY', false);
    expect(out.stderr).toEqual([]);
    expect(out.stdout).toEqual(['Saved _CONNECTOR_STRIPE_API_KEY.']);
  });
});
