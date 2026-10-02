/**
 * `capy system set <NAME>` shows where to get the key, for the four known key
 * names — and nothing new for any other name.
 *
 *   - With a terminal: before the hidden prompt, ending "Then paste it here."
 *     (Vercel) — stderr, so `--json` stdout stays one pure JSON object.
 *   - Without one: part of the `SYSTEM_STORE_NEEDS_TTY` refusal — `link` +
 *     `remedy` in the JSON, the instructions on stderr in human mode.
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

const VERCEL_PAGE = 'https://vercel.com/account/settings/tokens';
const VERCEL_SENTENCE = `Create a token at ${VERCEL_PAGE}. Set Scope to the team that owns the project.`;

const run = async (name: string, json: boolean) => {
  const { systemSetCommand } = await import('../../src/commands/systemCommand');
  return withTTY(() => captureConsole(() => systemSetCommand(name, { json })));
};

/** `systemSetCommand` ends a refusal with `process.exit`; turn that into a throw so the output can be read. */
const refused = async (name: string, json: boolean) => {
  const { systemSetCommand } = await import('../../src/commands/systemCommand');
  const exit = mock((code?: number) => {
    throw new Error(`exit:${code}`);
  });
  const original = process.exit;
  Object.defineProperty(process, 'exit', { value: exit, configurable: true });
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const out = await captureConsole(() => systemSetCommand(name, { json }).catch((err: Error) => err.message));
    return { ...out, exitCodes: exit.mock.calls.map((c) => c[0]) };
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
    Object.defineProperty(process, 'exit', { value: original, configurable: true });
  }
};

describe('capy system set — key help before the hidden prompt', () => {
  for (const name of ['_CONNECTOR_VERCEL_TOKEN', '_TARGET_VERCEL_TOKEN']) {
    test(`${name}: the approved sentence and "Then paste it here." are on stderr; the typed value is saved and never echoed`, async () => {
      const out = await run(name, false);
      const stderr = out.stderr.join('\n');
      expect(stderr).toContain(VERCEL_SENTENCE);
      expect(stderr).toContain('Then paste it here.');
      expect(stderr).not.toContain('capy system set');
      expect(setStore.mock.calls.at(-1)).toEqual([name, 'typed-fake-value']);
      expect([...out.stdout, ...out.stderr].join('\n')).not.toContain('typed-fake-value');
    });
  }

  for (const name of ['_CONNECTOR_DOKPLOY_API_KEY', '_TARGET_DOKPLOY_API_KEY']) {
    test(`${name}: the Dokploy docs link is on stderr (no base URL is known here)`, async () => {
      const out = await run(name, false);
      expect(out.stderr.join('\n')).toContain('https://docs.dokploy.com/docs/api');
      expect(setStore.mock.calls.at(-1)).toEqual([name, 'typed-fake-value']);
    });
  }

  test('--json: stdout is exactly one JSON object; the help is on stderr only', async () => {
    const out = await run('_CONNECTOR_VERCEL_TOKEN', true);
    expect(out.stdout.length).toBe(1);
    expect(JSON.parse(out.stdout[0])).toEqual({ ok: true, name: '_CONNECTOR_VERCEL_TOKEN' });
    expect(out.stderr.join('\n')).toContain(VERCEL_PAGE);
  });

  test('any other name: nothing new is printed', async () => {
    const out = await run('_CONNECTOR_STRIPE_API_KEY', false);
    expect(out.stderr).toEqual([]);
    expect(out.stdout).toEqual(['Saved _CONNECTOR_STRIPE_API_KEY.']);
  });
});

describe('capy system set — no terminal: the refusal carries the instructions', () => {
  test('--json: SYSTEM_STORE_NEEDS_TTY with link + remedy (the same two sentences as one string); stdout is one JSON object', async () => {
    const out = await refused('_TARGET_VERCEL_TOKEN', true);
    expect(out.stdout.length).toBe(1);
    const parsed = JSON.parse(out.stdout[0]);
    expect(parsed).toMatchObject({ ok: false, code: 'SYSTEM_STORE_NEEDS_TTY', link: { url: VERCEL_PAGE } });
    expect(parsed.link.label).toBeTruthy();
    expect(parsed.remedy).toBe(`${VERCEL_SENTENCE} Then save it: capy system set _TARGET_VERCEL_TOKEN`);
    expect(out.exitCodes).toEqual([3]);
  });

  test('human: the instructions are on stderr, nothing on stdout', async () => {
    const out = await refused('_CONNECTOR_VERCEL_TOKEN', false);
    expect(out.stdout).toEqual([]);
    expect(out.stderr.join('\n')).toContain(VERCEL_SENTENCE);
    expect(out.stderr.join('\n')).toContain('Then save it: capy system set _CONNECTOR_VERCEL_TOKEN');
  });

  test('another name: the refusal is what it always was, with no link', async () => {
    const out = await refused('_CONNECTOR_STRIPE_API_KEY', true);
    const parsed = JSON.parse(out.stdout[0]);
    expect(parsed.link).toBeUndefined();
    expect(parsed.remedy).toBeUndefined();
  });
});
