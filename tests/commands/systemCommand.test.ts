import { mock, spyOn, describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';

/**
 * `capy system set|list|rm` — CLI-layer wiring: every refusal coded, `--json`
 * output pure JSON on stdout, hidden-input-only for `set`, confirm-by-default
 * for `rm`. The underlying crypto/round-trip is covered by
 * tests/system/systemStore.test.ts; this file only exercises the command
 * layer, so `../../src/system/systemStore` is mocked.
 */

const setCalls: Array<{ name: string; value: string }> = [];
const removeCalls: string[] = [];
let openError: any = null;
let listReturn: Array<{ name: string; changed_at?: string }> = [];

// Mirrors the real regex — the regex itself is exercised for real in
// tests/system/systemStore.test.ts; this file tests the command layer around it.
const CONNECTOR_NAME_RE = /^_CONNECTOR_[A-Z0-9]+_[A-Z0-9_]+$/;

mock.module('../../src/system/systemStore', () => {
  const { CapyError, ERROR_CODES } = require('../../src/types/index');
  return {
    assertValidConnectorName: (name: string) => {
      if (!CONNECTOR_NAME_RE.test(name)) {
        throw new CapyError(`"${name}" is not a valid connector secret name.`, ERROR_CODES.SYSTEM_STORE_BAD_NAME, { name });
      }
    },
    openSystemStore: async (_opts: any) => {
      if (openError) throw openError;
      return {
        orgId: 'org_x',
        userId: 'user_x',
        listNames: () => listReturn,
        get: () => null,
        set: async (name: string, value: string) => {
          setCalls.push({ name, value });
        },
        remove: async (name: string) => {
          removeCalls.push(name);
        },
      };
    },
  };
});

let promptQueue: any[] = [];
const createPromptModuleCalls: any[] = [];
const fakePrompt = mock(async (_questions: any) => promptQueue.shift() ?? {});
mock.module('inquirer', () => ({
  default: {
    prompt: fakePrompt,
    // `--json` routes the prompt to a module created with `{ output: stderr }`
    // (see systemCommand.ts's `promptModuleFor`) rather than the default
    // `inquirer.prompt`, which always renders to stdout. The fake module
    // returned here is the SAME canned-answer function either way — it never
    // actually writes UI text to a stream — so every prompt-driven test above
    // keeps working; `createPromptModuleCalls` is what proves which path ran.
    createPromptModule: mock((opts: any) => {
      createPromptModuleCalls.push(opts);
      return fakePrompt;
    }),
  },
}));

afterAll(() => mock.restore());

let systemSetCommand: typeof import('../../src/commands/systemCommand').systemSetCommand;
let systemListCommand: typeof import('../../src/commands/systemCommand').systemListCommand;
let systemRmCommand: typeof import('../../src/commands/systemCommand').systemRmCommand;

const importCommands = async () => {
  const mod = await import('../../src/commands/systemCommand');
  systemSetCommand = mod.systemSetCommand;
  systemListCommand = mod.systemListCommand;
  systemRmCommand = mod.systemRmCommand;
};

/** Runs `fn`, capturing stdout/stderr and the exit code — never lets `process.exit` actually exit the test runner. */
async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  let exitCode: number | undefined;
  let stdout = '';
  let stderr = '';
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  });
  const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += args.map(String).join(' ') + '\n';
  });
  try {
    await fn().catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.startsWith('__exit_')) throw err;
    });
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { exitCode, stdout, stderr };
}

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('systemCommand', () => {
  beforeEach(async () => {
    if (!systemSetCommand) await importCommands();
    setCalls.length = 0;
    removeCalls.length = 0;
    openError = null;
    listReturn = [];
    promptQueue = [];
    createPromptModuleCalls.length = 0;
  });
  afterEach(() => setTTY(false));

  describe('systemSetCommand', () => {
    it('refuses a bad name before opening the store, coded, no network/store call', async () => {
      const { exitCode, stdout, stderr } = await capture(() =>
        systemSetCommand('NOT_VALID', { json: true }),
      );
      expect(exitCode).toBe(1);
      expect(setCalls).toEqual([]);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ ok: false, code: 'SYSTEM_STORE_BAD_NAME' });
      expect(stderr).toBe('');
    });

    it('refuses non-interactive with SYSTEM_STORE_NEEDS_TTY, coded, exit 3', async () => {
      setTTY(false);
      const { exitCode, stdout } = await capture(() =>
        systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', { json: true }),
      );
      expect(exitCode).toBe(3);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ ok: false, code: 'SYSTEM_STORE_NEEDS_TTY' });
      expect(setCalls).toEqual([]);
    });

    it('non-interactive human mode: prose to stderr, nothing on stdout', async () => {
      setTTY(false);
      const { stdout, stderr, exitCode } = await capture(() =>
        systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', {}),
      );
      expect(exitCode).toBe(3);
      expect(stdout).toBe('');
      expect(stderr.length).toBeGreaterThan(0);
    });

    it('interactive: prompts once (hidden input), saves the typed value, never echoes it', async () => {
      setTTY(true);
      promptQueue.push({ value: 'super-secret-value' });
      const { stdout, exitCode } = await capture(() =>
        systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', { json: true }),
      );
      expect(exitCode).toBeUndefined();
      expect(setCalls).toEqual([{ name: '_CONNECTOR_DOKPLOY_API_KEY', value: 'super-secret-value' }]);
      expect(stdout.includes('super-secret-value')).toBe(false);
      expect(JSON.parse(stdout)).toEqual({ ok: true, name: '_CONNECTOR_DOKPLOY_API_KEY' });
    });

    it('--json routes the hidden-value prompt to stderr, not the default stdout prompt', async () => {
      setTTY(true);
      promptQueue.push({ value: 'super-secret-value' });
      await capture(() => systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', { json: true }));
      expect(createPromptModuleCalls).toEqual([{ output: process.stderr }]);
    });

    it('without --json, the prompt uses the default stdout-bound module (no createPromptModule)', async () => {
      setTTY(true);
      promptQueue.push({ value: 'super-secret-value' });
      await capture(() => systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', {}));
      expect(createPromptModuleCalls).toEqual([]);
    });

    it('propagates SYSTEM_STORE_ADMIN_ONLY from the store as a coded refusal', async () => {
      setTTY(true);
      promptQueue.push({ value: 'v' });
      const { CapyError, ERROR_CODES } = await import('../../src/types/index');
      openError = new CapyError('nope', ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY);
      const { exitCode, stdout } = await capture(() =>
        systemSetCommand('_CONNECTOR_DOKPLOY_API_KEY', { json: true }),
      );
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'SYSTEM_STORE_ADMIN_ONLY' });
    });
  });

  describe('systemListCommand', () => {
    it('--json prints { ok, names } with changed_at, never values', async () => {
      listReturn = [{ name: '_CONNECTOR_FOO_KEY', changed_at: '2026-01-01T00:00:00Z' }];
      const { stdout, exitCode } = await capture(() => systemListCommand({ json: true }));
      expect(exitCode).toBeUndefined();
      expect(JSON.parse(stdout)).toEqual({ ok: true, names: listReturn });
    });

    it('human mode lists names without prompting or printing values', async () => {
      listReturn = [{ name: '_CONNECTOR_FOO_KEY' }];
      const { stdout } = await capture(() => systemListCommand({}));
      expect(stdout.includes('_CONNECTOR_FOO_KEY')).toBe(true);
    });
  });

  describe('systemRmCommand', () => {
    it('refuses a bad name before opening the store', async () => {
      const { exitCode, stdout } = await capture(() => systemRmCommand('nope', { json: true }));
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ code: 'SYSTEM_STORE_BAD_NAME' });
      expect(removeCalls).toEqual([]);
    });

    it('--yes skips confirmation and removes', async () => {
      const { exitCode, stdout } = await capture(() =>
        systemRmCommand('_CONNECTOR_FOO_KEY', { json: true, yes: true }),
      );
      expect(exitCode).toBeUndefined();
      expect(removeCalls).toEqual(['_CONNECTOR_FOO_KEY']);
      expect(JSON.parse(stdout)).toEqual({ ok: true, name: '_CONNECTOR_FOO_KEY' });
    });

    it('without --yes, non-interactive refuses with SYSTEM_STORE_NEEDS_TTY', async () => {
      setTTY(false);
      const { exitCode, stdout } = await capture(() =>
        systemRmCommand('_CONNECTOR_FOO_KEY', { json: true }),
      );
      expect(exitCode).toBe(3);
      expect(JSON.parse(stdout)).toMatchObject({ code: 'SYSTEM_STORE_NEEDS_TTY' });
      expect(removeCalls).toEqual([]);
    });

    it('without --yes, interactive default-no: declining leaves the entry untouched', async () => {
      setTTY(true);
      promptQueue.push({ confirmed: false });
      const { stdout } = await capture(() => systemRmCommand('_CONNECTOR_FOO_KEY', { json: true }));
      expect(removeCalls).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'CANCELLED' });
    });

    it('without --yes, interactive confirm: removes', async () => {
      setTTY(true);
      promptQueue.push({ confirmed: true });
      const { stdout } = await capture(() => systemRmCommand('_CONNECTOR_FOO_KEY', { json: true }));
      expect(removeCalls).toEqual(['_CONNECTOR_FOO_KEY']);
      expect(JSON.parse(stdout)).toEqual({ ok: true, name: '_CONNECTOR_FOO_KEY' });
    });

    it('--json routes the removal-confirmation prompt to stderr too', async () => {
      setTTY(true);
      promptQueue.push({ confirmed: true });
      await capture(() => systemRmCommand('_CONNECTOR_FOO_KEY', { json: true }));
      expect(createPromptModuleCalls).toEqual([{ output: process.stderr }]);
    });
  });
});
