/**
 * `capy agents` (CAP-681) — CLI-layer wiring: TTY-gated confirm, `--print`
 * (no writes, works headless, `--json` wraps the block as `{ok, block}`),
 * `--remove` (deletes a file left empty/whitespace-only), `--json` shape
 * `{ok, files}`, coded refusals (including a symlink escaping the repo). The
 * marker-text logic itself (idempotent replace, byte-exact preservation,
 * CRLF, the append<->remove round trip) is covered for real in
 * tests/core/agentsBlockPlan.test.ts; this file mocks `inquirer` (like
 * tests/commands/systemCommand.test.ts) and exercises the command layer
 * against real temp-directory files.
 *
 * No `let`/mutation (house style, CARDINAL RULE 1): per-test scratch
 * directories are plain function parameters via `withTempRoot`, not a
 * `beforeEach`-assigned module variable; captured stdout/stderr/exit-code
 * come from the mock library's own `.mock.calls` (its state, not ours) via
 * pure rendering, not `+=`/`push` accumulation.
 */
import { mock, spyOn, describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { AGENTS_BLOCK, blockForNewline } from '../../src/core/agentsBlockPlan';

const fakePrompt = mock(async (_questions: unknown) => ({ confirmed: false }));
const createPromptModuleMock = mock((_opts: unknown) => fakePrompt);
mock.module('inquirer', () => ({
  default: {
    prompt: fakePrompt,
    createPromptModule: createPromptModuleMock,
  },
}));

afterAll(() => mock.restore());

// Registered after mock.module() above so the mocked 'inquirer' is what
// agentsCommand.ts resolves — mirrors tests/commands/systemCommand.test.ts.
// A `const` at module scope: dynamic `import()` is cached by the module
// system, so this "loads" instantly everywhere else it's referenced too;
// nothing here is ever reassigned.
const {
  agentsCommand,
  resolveRepoRoot,
  writeAgentsBlock,
  removeAgentsBlockFromFiles,
  agentsBlockAlreadyPresent,
  offerAgentsSetupAfterInit,
} = await import('../../src/commands/agentsCommand');

/** Sentinel thrown by the mocked `process.exit`, carrying the exit code — never lets a test actually exit the runner. */
class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('process.exit called');
  }
}

/** Renders a spy's captured calls the way `console.log(...args)` would have joined and printed them. */
function renderCalls(calls: readonly unknown[][]): string {
  if (calls.length === 0) return '';
  return calls.map((args) => args.map(String).join(' ')).join('\n') + '\n';
}

/** Runs `fn`, returning the code passed to `process.exit`, or `undefined` if it never called it. */
async function exitCodeOf(fn: () => Promise<void>): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

/** Runs `fn`, capturing stdout/stderr and the exit code — never lets `process.exit` actually exit the test runner. */
async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const exitCode = await exitCodeOf(fn);
    return { exitCode, stdout: renderCalls(logSpy.mock.calls), stderr: renderCalls(errSpy.mock.calls) };
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

const ORIGINAL_CWD = process.cwd();

/**
 * Creates a fresh temp directory, hands it to `fn` as a plain parameter (no
 * shared mutable fixture), and always cleans up (cwd + the directory itself)
 * afterward — including when `fn` throws.
 */
async function withTempRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'capy-agents-test-'));
  try {
    await fn(root);
  } finally {
    process.chdir(ORIGINAL_CWD);
    rmSync(root, { recursive: true, force: true });
  }
}

/** `withTempRoot`, but also `chdir`s into it first — for the `agentsCommand()` CLI-wiring tests, which resolve the repo root from `process.cwd()`. */
async function withTempRootAsCwd(fn: (root: string) => Promise<void> | void): Promise<void> {
  await withTempRoot(async (root) => {
    process.chdir(root);
    await fn(root);
  });
}

describe('agentsCommand', () => {
  beforeEach(() => {
    fakePrompt.mockClear();
    createPromptModuleMock.mockClear();
  });
  afterEach(() => setTTY(false));

  describe('resolveRepoRoot', () => {
    it('falls back to cwd when not inside a git repo', async () => {
      // A bare tmp dir is not a git repo, so `git rev-parse --show-toplevel`
      // fails and the fallback is cwd itself.
      await withTempRoot((root) => {
        expect(resolveRepoRoot(root)).toBe(root);
      });
    });
  });

  describe('dry run (apply = false)', () => {
    it('write plan reports the change and writes nothing', async () => {
      await withTempRoot((root) => {
        const files = writeAgentsBlock(root, false);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'created' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('remove plan reports the removal and leaves the file byte-identical', async () => {
      await withTempRoot((root) => {
        writeAgentsBlock(root);
        const before = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
        const files = removeAgentsBlockFromFiles(root, false);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before);
      });
    });
  });

  describe('writeAgentsBlock (file targeting)', () => {
    it('neither AGENTS.md nor CLAUDE.md exists: creates AGENTS.md only', async () => {
      await withTempRoot((root) => {
        const files = writeAgentsBlock(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'created' }]);
        expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
      });
    });

    it('only AGENTS.md exists: updates AGENTS.md only, never creates CLAUDE.md', async () => {
      await withTempRoot((root) => {
        writeFileSync(join(root, 'AGENTS.md'), '# Repo\n');
        const files = writeAgentsBlock(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'updated' }]);
        expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
      });
    });

    it('only CLAUDE.md exists: updates CLAUDE.md only, never creates AGENTS.md', async () => {
      await withTempRoot((root) => {
        writeFileSync(join(root, 'CLAUDE.md'), '# Repo\n');
        const files = writeAgentsBlock(root);
        expect(files).toEqual([{ path: 'CLAUDE.md', action: 'updated' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('both exist: updates both (deterministic AGENTS.md-then-CLAUDE.md order)', async () => {
      await withTempRoot((root) => {
        writeFileSync(join(root, 'AGENTS.md'), '# Repo A\n');
        writeFileSync(join(root, 'CLAUDE.md'), '# Repo C\n');
        const files = writeAgentsBlock(root);
        expect(files).toEqual([
          { path: 'AGENTS.md', action: 'updated' },
          { path: 'CLAUDE.md', action: 'updated' },
        ]);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
        expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toContain('<!-- capy:agents:begin -->');
      });
    });

    it('is idempotent: a second run reports unchanged and leaves bytes identical', async () => {
      await withTempRoot((root) => {
        writeAgentsBlock(root);
        const before = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
        const files = writeAgentsBlock(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'unchanged' }]);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before);
      });
    });

    it('throws a coded CapyError on a malformed file and does not write it', async () => {
      await withTempRoot((root) => {
        const malformed = '<!-- capy:agents:begin -->\nno end marker\n';
        writeFileSync(join(root, 'AGENTS.md'), malformed);
        expect(() => writeAgentsBlock(root)).toThrow();
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(malformed);
      });
    });

    it('refuses (coded AGENTS_FILE_OUTSIDE_REPO) when AGENTS.md is a symlink pointing outside the repo, and never writes through it', async () => {
      await withTempRoot(async (root) => {
        await withTempRoot(async (outside) => {
          const target = join(outside, 'secret.md');
          writeFileSync(target, 'not capy content\n');
          symlinkSync(target, join(root, 'AGENTS.md'));

          try {
            writeAgentsBlock(root);
            throw new Error('expected writeAgentsBlock to throw');
          } catch (err) {
            expect((err as { code?: string }).code).toBe('AGENTS_FILE_OUTSIDE_REPO');
          }
          // Never followed the symlink to write through it.
          expect(readFileSync(target, 'utf-8')).toBe('not capy content\n');
        });
      });
    });
  });

  describe('removeAgentsBlockFromFiles', () => {
    it('an interior block (content follows it): `before` is untouched, only the block\'s own 1-newline terminator is stripped from `after`', async () => {
      await withTempRoot((root) => {
        // Content follows the block ("kept tail"), so this is NOT the
        // "appended at EOF" shape — before must survive byte-for-byte
        // (3 CRLF and all), and only the ONE newline that is never
        // "content" (the block's own mandatory line terminator) comes off
        // the front of `after`.
        const before = '# Repo\r\n\r\n\r\n';
        const after = '\r\n\r\nkept tail\r\n';
        // The block itself must be CRLF too, matching the file — a file this
        // consistently CRLF would never really hold an LF-only block, and an
        // inconsistent fixture would throw off detectNewline's own count.
        writeFileSync(join(root, 'AGENTS.md'), `${before}${blockForNewline('\r\n')}${after}`);
        const files = removeAgentsBlockFromFiles(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before + '\r\nkept tail\r\n');
      });
    });

    it('reports "absent" for a file with no markers, without touching it', async () => {
      await withTempRoot((root) => {
        const content = '# Repo\nnothing to remove\n';
        writeFileSync(join(root, 'AGENTS.md'), content);
        const files = removeAgentsBlockFromFiles(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'absent' }]);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(content);
      });
    });

    it('no files at all: returns an empty list', async () => {
      await withTempRoot((root) => {
        expect(removeAgentsBlockFromFiles(root)).toEqual([]);
      });
    });

    it('a file Capy created (nothing but the block) is deleted, not left empty, on remove', async () => {
      await withTempRoot((root) => {
        writeAgentsBlock(root); // AGENTS.md now holds ONLY the block
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
        const files = removeAgentsBlockFromFiles(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('a file that becomes whitespace-only (but NOT exactly empty) after remove is kept, not deleted', async () => {
      await withTempRoot((root) => {
        // Blank lines on both sides of the block, but content follows it
        // (another blank line), so this isn't the "appended at EOF" shape —
        // `before` is left untouched and only the block's own one-newline
        // terminator is stripped from `after`, leaving whitespace behind.
        // Only an EXACTLY empty result is treated as "nothing but the
        // block" and deleted; merely whitespace-only is not.
        writeFileSync(join(root, 'AGENTS.md'), `\n\n${AGENTS_BLOCK}\n\n`);
        const files = removeAgentsBlockFromFiles(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('\n\n\n');
      });
    });

    it('a file with real content besides the block survives remove, not deleted', async () => {
      await withTempRoot((root) => {
        writeFileSync(join(root, 'AGENTS.md'), `# Real docs\n\n${AGENTS_BLOCK}\n`);
        const files = removeAgentsBlockFromFiles(root);
        expect(files).toEqual([{ path: 'AGENTS.md', action: 'removed' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('# Real docs');
      });
    });

    it('refuses (coded AGENTS_FILE_OUTSIDE_REPO) when AGENTS.md is a symlink pointing outside the repo, and never touches it', async () => {
      await withTempRoot(async (root) => {
        await withTempRoot(async (outside) => {
          const target = join(outside, 'secret.md');
          writeFileSync(target, `${AGENTS_BLOCK}\n`);
          symlinkSync(target, join(root, 'AGENTS.md'));

          try {
            removeAgentsBlockFromFiles(root);
            throw new Error('expected removeAgentsBlockFromFiles to throw');
          } catch (err) {
            expect((err as { code?: string }).code).toBe('AGENTS_FILE_OUTSIDE_REPO');
          }
          expect(readFileSync(target, 'utf-8')).toBe(`${AGENTS_BLOCK}\n`);
        });
      });
    });
  });

  describe('agentsBlockAlreadyPresent', () => {
    it('false when neither file exists', async () => {
      await withTempRoot((root) => {
        expect(agentsBlockAlreadyPresent(root)).toBe(false);
      });
    });
    it('true once written', async () => {
      await withTempRoot((root) => {
        writeAgentsBlock(root);
        expect(agentsBlockAlreadyPresent(root)).toBe(true);
      });
    });
    it('a symlink escaping the repo is skipped (treated as not-present), never throws', async () => {
      await withTempRoot(async (root) => {
        await withTempRoot(async (outside) => {
          const target = join(outside, 'secret.md');
          writeFileSync(target, `${AGENTS_BLOCK}\n`);
          symlinkSync(target, join(root, 'AGENTS.md'));
          expect(agentsBlockAlreadyPresent(root)).toBe(false);
        });
      });
    });
  });

  describe('agentsCommand CLI wiring', () => {
    it('--print writes nothing and works without a TTY', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(false);
        const { exitCode, stdout } = await capture(() => agentsCommand({ print: true }));
        expect(exitCode).toBeUndefined();
        expect(stdout).toContain('<!-- capy:agents:begin -->');
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('--print --json emits {ok:true, block} as JSON, not raw markdown', async () => {
      await withTempRootAsCwd(async () => {
        setTTY(false);
        const { exitCode, stdout } = await capture(() => agentsCommand({ print: true, json: true }));
        expect(exitCode).toBeUndefined();
        const payload = JSON.parse(stdout);
        expect(payload).toEqual({ ok: true, block: AGENTS_BLOCK });
      });
    });

    it('non-TTY, no --print, no --json: coded human refusal, exit 3, no write', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(false);
        const { exitCode, stderr } = await capture(() => agentsCommand({}));
        expect(exitCode).toBe(3);
        expect(stderr).toContain('needs a terminal');
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('non-TTY with --json: coded JSON refusal {ok:false, code: AGENTS_SETUP_NEEDS_TTY}, exit 3, no write', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(false);
        const { exitCode, stdout } = await capture(() => agentsCommand({ json: true }));
        expect(exitCode).toBe(3);
        const payload = JSON.parse(stdout);
        expect(payload).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('TTY + confirmed yes + --json: writes and returns {ok:true, files:[...]}', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(true);
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: true }));
        const { exitCode, stdout } = await capture(() => agentsCommand({ json: true }));
        expect(exitCode).toBeUndefined();
        const payload = JSON.parse(stdout);
        expect(payload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'created' }] });
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
        // --json keeps stdout pure JSON, so the confirm prompt must not render there.
        expect(createPromptModuleMock.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('TTY + declined: no write, {ok:false, code: CANCELLED} under --json', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(true);
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: false }));
        const { stdout } = await capture(() => agentsCommand({ json: true }));
        const payload = JSON.parse(stdout);
        expect(payload).toMatchObject({ ok: false, code: 'CANCELLED' });
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('--remove, non-TTY: coded refusal, no write', async () => {
      await withTempRootAsCwd(async () => {
        setTTY(false);
        const { exitCode, stdout } = await capture(() => agentsCommand({ remove: true, json: true }));
        expect(exitCode).toBe(3);
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
      });
    });

    it('--remove, TTY confirmed: deletes the (Capy-created) file and reports via --json', async () => {
      await withTempRootAsCwd(async (root) => {
        writeAgentsBlock(root);
        setTTY(true);
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: true }));
        const { stdout } = await capture(() => agentsCommand({ remove: true, json: true }));
        const payload = JSON.parse(stdout);
        expect(payload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'removed' }] });
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });
  });

  describe('offerAgentsSetupAfterInit (the one extra `capy init` prompt)', () => {
    it('non-TTY: never prompts, never writes', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(false);
        await offerAgentsSetupAfterInit();
        expect(fakePrompt).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('TTY + block already present: skips the prompt entirely', async () => {
      await withTempRootAsCwd(async () => {
        writeAgentsBlock(process.cwd()); // writeAgentsBlock itself doesn't prompt
        fakePrompt.mockClear();
        setTTY(true);
        await offerAgentsSetupAfterInit();
        expect(fakePrompt).not.toHaveBeenCalled();
      });
    });

    it('TTY + absent + confirmed yes: writes the block', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(true);
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: true }));
        await offerAgentsSetupAfterInit();
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain(AGENTS_BLOCK);
      });
    });

    it('TTY + absent + declined: writes nothing', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(true);
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: false }));
        await offerAgentsSetupAfterInit();
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('never throws, even if the write fails', async () => {
      await withTempRootAsCwd(async (root) => {
        setTTY(true);
        // AGENTS.md as a directory makes the write fail — offerAgentsSetupAfterInit
        // must swallow that rather than turn a successful `capy init` into a failure.
        mkdirSync(join(root, 'AGENTS.md'));
        fakePrompt.mockImplementationOnce(async () => ({ confirmed: true }));
        await expect(offerAgentsSetupAfterInit()).resolves.toBeUndefined();
      });
    });
  });

  /**
   * CAP-659 — `--yes` / `--non-tty`, exercised through a real Commander
   * `Command` (the actual `commander` package, `parseAsync` with injected
   * argv) rather than calling `agentsCommand()` directly, so the option
   * parsing itself (short flag `-y`, `--non-tty`, `--json`) is covered, not
   * just the handler. This subcommand's options mirror `src/index.ts`'s
   * `agents` registration exactly (the same split `tests/core/cliHelpDoc.test.ts`
   * already uses for its own hand-built trees) — `tests/commands/helpJsonCli.test.ts`
   * is what proves the real BUILT `dist/index.js` registers the identical
   * flags end to end.
   */
  describe('agents CLI wiring — real argument parser, non-TTY (CAP-659)', () => {
    const ORIGINAL_HOME = process.env.HOME;

    afterEach(() => {
      if (ORIGINAL_HOME === undefined) delete process.env.HOME;
      else process.env.HOME = ORIGINAL_HOME;
    });

    /** Mirrors the `agents` command registration in src/index.ts / src/index-dev.ts. */
    function buildAgentsProgram(): Command {
      const program = new Command();
      program.exitOverride();
      program
        .command('agents')
        .option('--print', 'print the block to stdout without writing anything')
        .option('--remove', 'remove the block from AGENTS.md / CLAUDE.md')
        .option('-y, --yes', 'skip the confirmation prompt (required non-interactively)')
        .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
        .option('--json', 'emit machine-readable JSON instead of the human UI')
        .action(async (options) => {
          await agentsCommand({
            print: options.print,
            remove: options.remove,
            json: options.json,
            yes: options.yes,
            nonTty: options.nonTty,
          });
        });
      return program;
    }

    function runCli(args: readonly string[]): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
      return capture(() => buildAgentsProgram().parseAsync(['node', 'capy', ...args]));
    }

    /** `withTempRootAsCwd`, but also isolates `HOME` at the fixture root for the duration of `fn`. */
    async function withIsolatedFixtureRepo(fn: (root: string) => Promise<void> | void): Promise<void> {
      await withTempRootAsCwd(async (root) => {
        process.env.HOME = root;
        await fn(root);
      });
    }

    it('--yes writes the block with no TTY, --json stdout is exactly one parseable JSON object, and a second run is idempotent', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        setTTY(false);
        const first = await runCli(['agents', '--json', '--yes']);
        expect(first.exitCode).toBeUndefined();
        expect(fakePrompt).not.toHaveBeenCalled();
        const payload = JSON.parse(first.stdout.trim()); // throws if stdout carries anything but one JSON value
        expect(payload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'created' }] });
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);

        const before = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
        const second = await runCli(['agents', '--json', '--yes']);
        const secondPayload = JSON.parse(second.stdout.trim());
        expect(secondPayload).toEqual({ ok: true, files: [{ path: 'AGENTS.md', action: 'unchanged' }] });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before);
      });
    });

    it('human mode, --yes, write: reports "Created AGENTS.md" and the success message never says "Removed"', async () => {
      await withIsolatedFixtureRepo(async () => {
        setTTY(false);
        const { stdout, exitCode } = await runCli(['agents', '--yes']);
        expect(exitCode).toBeUndefined();
        expect(stdout).toContain('Created AGENTS.md');
        expect(stdout).not.toContain('Removed');
      });
    });

    it('--remove --yes removes the (Capy-created) block with no TTY', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        setTTY(false);
        await runCli(['agents', '--yes']); // seed it, non-interactively
        fakePrompt.mockClear();
        const { exitCode } = await runCli(['agents', '--remove', '--yes']);
        expect(exitCode).toBeUndefined();
        expect(fakePrompt).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('without --yes and no TTY: coded refusal naming --yes in `unanswered`, exit 3, file untouched', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        setTTY(false);
        const { exitCode, stdout } = await runCli(['agents', '--json']);
        expect(exitCode).toBe(3);
        const payload = JSON.parse(stdout);
        expect(payload).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
        expect(payload.unanswered).toEqual([{ id: 'confirm', flag: '--yes' }]);
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('--remove without --yes and no TTY: coded refusal, pre-existing file byte-identical', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        writeAgentsBlock(root);
        const before = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
        setTTY(false);
        const { exitCode, stdout } = await runCli(['agents', '--remove', '--json']);
        expect(exitCode).toBe(3);
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'AGENTS_SETUP_NEEDS_TTY' });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before);
      });
    });

    it('--non-tty forces the refusal even on a real TTY, without --yes', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        setTTY(true);
        const { exitCode } = await runCli(['agents', '--non-tty', '--json']);
        expect(exitCode).toBe(3);
        expect(fakePrompt).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });

    it('--print is unchanged: still works with no TTY and no --yes, and writes nothing', async () => {
      await withIsolatedFixtureRepo(async (root) => {
        setTTY(false);
        const { exitCode, stdout } = await runCli(['agents', '--print']);
        expect(exitCode).toBeUndefined();
        expect(stdout).toContain('<!-- capy:agents:begin -->');
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      });
    });
  });
});
