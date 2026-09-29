/**
 * `capy agents` (CAP-681) — CLI-layer wiring: TTY-gated confirm, `--print`
 * (no writes, works headless), `--remove`, `--json` shape `{ok, files}`,
 * coded refusals. The marker-text logic itself (idempotent replace,
 * byte-exact preservation, CRLF) is covered for real in
 * tests/core/agentsBlockPlan.test.ts; this file mocks `inquirer` (like
 * tests/commands/systemCommand.test.ts) and exercises the command layer
 * against real temp-directory files.
 */
import { mock, spyOn, describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AGENTS_BLOCK } from '../../src/core/agentsBlockPlan';

let promptQueue: any[] = [];
const createPromptModuleCalls: any[] = [];
const fakePrompt = mock(async (_questions: any) => promptQueue.shift() ?? { confirmed: false });
mock.module('inquirer', () => ({
  default: {
    prompt: fakePrompt,
    createPromptModule: mock((opts: any) => {
      createPromptModuleCalls.push(opts);
      return fakePrompt;
    }),
  },
}));

afterAll(() => mock.restore());

let agentsCommand: typeof import('../../src/commands/agentsCommand').agentsCommand;
let resolveRepoRoot: typeof import('../../src/commands/agentsCommand').resolveRepoRoot;
let writeAgentsBlock: typeof import('../../src/commands/agentsCommand').writeAgentsBlock;
let removeAgentsBlockFromFiles: typeof import('../../src/commands/agentsCommand').removeAgentsBlockFromFiles;
let agentsBlockAlreadyPresent: typeof import('../../src/commands/agentsCommand').agentsBlockAlreadyPresent;
let offerAgentsSetupAfterInit: typeof import('../../src/commands/agentsCommand').offerAgentsSetupAfterInit;

const importModule = async () => {
  const mod = await import('../../src/commands/agentsCommand');
  agentsCommand = mod.agentsCommand;
  resolveRepoRoot = mod.resolveRepoRoot;
  writeAgentsBlock = mod.writeAgentsBlock;
  removeAgentsBlockFromFiles = mod.removeAgentsBlockFromFiles;
  agentsBlockAlreadyPresent = mod.agentsBlockAlreadyPresent;
  offerAgentsSetupAfterInit = mod.offerAgentsSetupAfterInit;
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

let ROOT: string;
const ORIGINAL_CWD = process.cwd();

describe('agentsCommand', () => {
  beforeEach(async () => {
    if (!agentsCommand) await importModule();
    promptQueue = [];
    createPromptModuleCalls.length = 0;
    fakePrompt.mockClear();
    ROOT = mkdtempSync(join(tmpdir(), 'capy-agents-test-'));
  });
  afterEach(() => {
    setTTY(false);
    process.chdir(ORIGINAL_CWD);
    rmSync(ROOT, { recursive: true, force: true });
  });

  describe('resolveRepoRoot', () => {
    it('falls back to cwd when not inside a git repo', () => {
      // ROOT is a bare tmp dir — not a git repo — so `git rev-parse
      // --show-toplevel` fails and the fallback is cwd itself.
      expect(resolveRepoRoot(ROOT)).toBe(ROOT);
    });
  });

  describe('writeAgentsBlock (file targeting)', () => {
    it('neither AGENTS.md nor CLAUDE.md exists: creates AGENTS.md only', () => {
      const files = writeAgentsBlock(ROOT);
      expect(files).toEqual([{ path: 'AGENTS.md', action: 'created' }]);
      expect(existsSync(join(ROOT, 'CLAUDE.md'))).toBe(false);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
    });

    it('only AGENTS.md exists: updates AGENTS.md only, never creates CLAUDE.md', () => {
      writeFileSync(join(ROOT, 'AGENTS.md'), '# Repo\n');
      const files = writeAgentsBlock(ROOT);
      expect(files).toEqual([{ path: 'AGENTS.md', action: 'updated' }]);
      expect(existsSync(join(ROOT, 'CLAUDE.md'))).toBe(false);
    });

    it('only CLAUDE.md exists: updates CLAUDE.md only, never creates AGENTS.md', () => {
      writeFileSync(join(ROOT, 'CLAUDE.md'), '# Repo\n');
      const files = writeAgentsBlock(ROOT);
      expect(files).toEqual([{ path: 'CLAUDE.md', action: 'updated' }]);
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('both exist: updates both', () => {
      writeFileSync(join(ROOT, 'AGENTS.md'), '# Repo A\n');
      writeFileSync(join(ROOT, 'CLAUDE.md'), '# Repo C\n');
      const files = writeAgentsBlock(ROOT);
      expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'AGENTS.md', action: 'updated' },
        { path: 'CLAUDE.md', action: 'updated' },
      ]);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
      expect(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
    });

    it('is idempotent: a second run reports unchanged and leaves bytes identical', () => {
      writeAgentsBlock(ROOT);
      const before = readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8');
      const files = writeAgentsBlock(ROOT);
      expect(files).toEqual([{ path: 'AGENTS.md', action: 'unchanged' }]);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toBe(before);
    });

    it('throws a coded CapyError on a malformed file and does not write it', () => {
      const malformed = '<!-- capy:agents:begin -->\nno end marker\n';
      writeFileSync(join(ROOT, 'AGENTS.md'), malformed);
      expect(() => writeAgentsBlock(ROOT)).toThrow();
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toBe(malformed);
    });
  });

  describe('removeAgentsBlockFromFiles', () => {
    it('removes from every existing file, byte-exact around the block', () => {
      const before = '# Repo\r\n\r\n';
      const after = '\r\nkept tail\r\n';
      writeFileSync(join(ROOT, 'AGENTS.md'), `${before}${AGENTS_BLOCK}${after}`);
      const files = removeAgentsBlockFromFiles(ROOT);
      expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toBe(before + after);
    });

    it('reports "absent" for a file with no markers, without touching it', () => {
      const content = '# Repo\nnothing to remove\n';
      writeFileSync(join(ROOT, 'AGENTS.md'), content);
      const files = removeAgentsBlockFromFiles(ROOT);
      expect(files).toEqual([{ path: 'AGENTS.md', action: 'absent' }]);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toBe(content);
    });

    it('no files at all: returns an empty list', () => {
      expect(removeAgentsBlockFromFiles(ROOT)).toEqual([]);
    });
  });

  describe('agentsBlockAlreadyPresent', () => {
    it('false when neither file exists', () => {
      expect(agentsBlockAlreadyPresent(ROOT)).toBe(false);
    });
    it('true once written', () => {
      writeAgentsBlock(ROOT);
      expect(agentsBlockAlreadyPresent(ROOT)).toBe(true);
    });
  });

  describe('agentsCommand CLI wiring', () => {
    it('--print writes nothing and works without a TTY', async () => {
      setTTY(false);
      process.chdir(ROOT);
      const { exitCode, stdout } = await capture(() => agentsCommand({ print: true }));
      expect(exitCode).toBeUndefined();
      expect(stdout).toContain('<!-- capy:agents:begin -->');
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('non-TTY, no --print, no --json: coded human refusal, exit 3, no write', async () => {
      setTTY(false);
      process.chdir(ROOT);
      const { exitCode, stderr } = await capture(() => agentsCommand({}));
      expect(exitCode).toBe(3);
      expect(stderr).toContain('needs a terminal');
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('non-TTY with --json: coded JSON refusal {ok:false, code: AGENTS_SETUP_NEEDS_TTY}, exit 3, no write', async () => {
      setTTY(false);
      process.chdir(ROOT);
      const { exitCode, stdout } = await capture(() => agentsCommand({ json: true }));
      expect(exitCode).toBe(3);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('TTY + confirmed yes + --json: writes and returns {ok:true, files:[...]}', async () => {
      setTTY(true);
      process.chdir(ROOT);
      promptQueue = [{ confirmed: true }];
      const { exitCode, stdout } = await capture(() => agentsCommand({ json: true }));
      expect(exitCode).toBeUndefined();
      const payload = JSON.parse(stdout);
      expect(payload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'created' }] });
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(true);
      // --json keeps stdout pure JSON, so the confirm prompt must not render there.
      expect(createPromptModuleCalls.length).toBeGreaterThan(0);
    });

    it('TTY + declined: no write, {ok:false, code: CANCELLED} under --json', async () => {
      setTTY(true);
      process.chdir(ROOT);
      promptQueue = [{ confirmed: false }];
      const { stdout } = await capture(() => agentsCommand({ json: true }));
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ ok: false, code: 'CANCELLED' });
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('--remove, non-TTY: coded refusal, no write', async () => {
      setTTY(false);
      process.chdir(ROOT);
      const { exitCode, stdout } = await capture(() => agentsCommand({ remove: true, json: true }));
      expect(exitCode).toBe(3);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
    });

    it('--remove, TTY confirmed: removes and reports via --json', async () => {
      writeAgentsBlock(ROOT);
      setTTY(true);
      process.chdir(ROOT);
      promptQueue = [{ confirmed: true }];
      const { stdout } = await capture(() => agentsCommand({ remove: true, json: true }));
      const payload = JSON.parse(stdout);
      expect(payload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'removed' }] });
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).not.toContain('capy:agents:begin');
    });
  });

  describe('offerAgentsSetupAfterInit (the one extra `capy init` prompt)', () => {
    it('non-TTY: never prompts, never writes', async () => {
      setTTY(false);
      process.chdir(ROOT);
      await offerAgentsSetupAfterInit();
      expect(fakePrompt).not.toHaveBeenCalled();
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('TTY + block already present: skips the prompt entirely', async () => {
      writeAgentsBlock(ROOT);
      fakePrompt.mockClear(); // writeAgentsBlock itself doesn't prompt, but clear defensively before the assertion below
      setTTY(true);
      process.chdir(ROOT);
      await offerAgentsSetupAfterInit();
      expect(fakePrompt).not.toHaveBeenCalled();
    });

    it('TTY + absent + confirmed yes: writes the block', async () => {
      setTTY(true);
      process.chdir(ROOT);
      promptQueue = [{ confirmed: true }];
      await offerAgentsSetupAfterInit();
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(true);
      expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toContain(AGENTS_BLOCK);
    });

    it('TTY + absent + declined: writes nothing', async () => {
      setTTY(true);
      process.chdir(ROOT);
      promptQueue = [{ confirmed: false }];
      await offerAgentsSetupAfterInit();
      expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(false);
    });

    it('never throws, even if the write fails', async () => {
      setTTY(true);
      // AGENTS.md as a directory makes the write fail — offerAgentsSetupAfterInit
      // must swallow that rather than turn a successful `capy init` into a failure.
      mkdirSync(join(ROOT, 'AGENTS.md'));
      process.chdir(ROOT);
      promptQueue = [{ confirmed: true }];
      await expect(offerAgentsSetupAfterInit()).resolves.toBeUndefined();
    });
  });
});
