/**
 * `capy edit NAME` on a terminal is `capy add NAME --force`: the same hidden prompt, the same write path.
 *
 *  - it asks for the value once, with the masked password prompt `capy add` uses, and never asks "overwrite?";
 *  - a new name is created, an existing one overwritten, through `writeAndSync` (encrypt + sync + push);
 *  - `--no-push` writes `.env` only (the real `writeAndSync`, a real `FileManager` in a temp folder);
 *  - `--dry-run` refuses with DRY_RUN_UNSUPPORTED before any prompt, any read or any write;
 *  - no terminal (or `--non-tty`) and no piped value is a coded refusal with no prompt;
 *  - `capy edit` with no name does not take this path.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh). All values are fake.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stubbedGate, gateRan } from '../helpers/gateMock';
import * as realShared from '../../src/commands/connectors/shared';
import * as realKeepLockPr from '../../src/commands/keepLockPr';
import * as realProfileConfig from '../../src/config/profileConfig';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { KeepFile } from '../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-edit-name-prompt-${process.pid}`);
const ORIGINAL_CWD = process.cwd();
const PROJECT_KEY = 'test-project-key';
const FAKE_VALUE = 'fake-value-for-test-only';

mock.module('../../src/sync/gate', () => stubbedGate());

/** The questions each `inquirer.prompt` call was given. */
const promptSpy = mock(async (_questions: readonly unknown[]) => ({ value: FAKE_VALUE, ok: true }));
mock.module('inquirer', () => ({ default: { prompt: promptSpy } }));

// Captured BEFORE mock.module: bun rewrites the already-imported namespace in place, so `realShared.writeAndSync`
// would afterwards be the wrapper below, and the wrapper calling it would recurse forever.
const realWriteAndSync = realShared.writeAndSync;

const contextSpy = mock(async (_opts: unknown): Promise<ResolvedContext> => {
  throw new Error('contextSpy: no context set for this test');
});
const writeSpy = mock(async (_ctx: ResolvedContext, _name: string, _value: string | undefined, _opts: { push: boolean }) => undefined);
mock.module('../../src/commands/connectors/shared', () => ({
  ...realShared,
  resolveContext: contextSpy,
  // The pushing path is the server's (tested elsewhere): it is recorded. The `.env`-only path is the real one.
  writeAndSync: async (ctx: ResolvedContext, name: string, value: string | undefined, opts: { push: boolean }) => {
    await writeSpy(ctx, name, value, opts);
    if (!opts.push) await realWriteAndSync(ctx, name, value, opts);
  },
}));

const prStepSpy = mock(async (_req: unknown) => ({ keep_lock: { changed: false } }));
mock.module('../../src/commands/keepLockPr', () => ({ ...realKeepLockPr, runKeepLockPrStep: prStepSpy }));

const localOnlySpy = mock(() => false);
mock.module('../../src/config/profileConfig', () => ({ ...realProfileConfig, isLocalOnly: localOnlySpy }));

import { EditCommand } from '../../src/commands/editCommand';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { readLocalPlaintext } from '../../src/sync/commit';
import { ERROR_CODES } from '../../src/types/index';
import { DRY_RUN_UNSUPPORTED_MESSAGES } from '../../src/commands/pipedValue';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('process.exit called');
  }
}

const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTTY(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true, writable: true });
}

function restoreTTY(stream: NodeJS.WriteStream | NodeJS.ReadStream, original: PropertyDescriptor | undefined): void {
  if (original === undefined) {
    Reflect.deleteProperty(stream, 'isTTY');
    return;
  }
  Object.defineProperty(stream, 'isTTY', original);
}

function renderCalls(calls: readonly unknown[][]): string {
  return calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** Runs `fn`, capturing stdout/stderr and the exit code; `process.exit` never exits the runner. */
async function capture(fn: () => Promise<void>) {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await fn().then(() => null, (e: unknown) => e);
  const stdout = renderCalls(logSpy.mock.calls);
  const stderr = renderCalls(errSpy.mock.calls);
  const exits = exitSpy.mock.calls;
  [exitSpy, logSpy, errSpy].forEach((s) => s.mockRestore());
  return { exitCode: exits.length > 0 ? (exits[exits.length - 1][0] as number | undefined) : undefined, stdout, stderr, thrown: thrown instanceof ExitSignal ? null : thrown };
}

function fakeContext(localPlaintext: Record<string, string>): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return {
    pm: new ProjectManager(TEST_DIR),
    fileManager: new FileManager(TEST_DIR),
    orgId: 'o',
    projectId: 'p',
    branch: 'development',
    userId: 'u',
    projectKey: PROJECT_KEY,
    keep,
    localPlaintext,
  } as unknown as ResolvedContext;
}

const questionsOf = (callIndex: number): readonly Record<string, unknown>[] => promptSpy.mock.calls[callIndex][0] as readonly Record<string, unknown>[];

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  setTTY(true);
  [promptSpy, contextSpy, writeSpy, prStepSpy, localOnlySpy, gateRan].forEach((m) => m.mockClear());
  localOnlySpy.mockImplementation(() => false);
  contextSpy.mockImplementation(async () => fakeContext({}));
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
  restoreTTY(process.stdin, ORIGINAL_STDIN_TTY);
  restoreTTY(process.stdout, ORIGINAL_STDOUT_TTY);
});

describe('capy edit NAME on a terminal', () => {
  test('asks once, with the masked password prompt capy add uses, and sets a new name', async () => {
    const out = await capture(() => new EditCommand().execute({ name: 'NEW_NAME' }));
    expect(out.exitCode).toBeUndefined();
    expect(out.thrown).toBeNull();
    expect(promptSpy.mock.calls.length).toBe(1);
    const [question] = questionsOf(0);
    expect(question).toMatchObject({ type: 'password', mask: '*' });
    expect(String(question.message)).toContain('NEW_NAME');
    expect(writeSpy.mock.calls.length).toBe(1);
    const [, name, value, opts] = writeSpy.mock.calls[0];
    expect([name, value, opts]).toEqual(['NEW_NAME', FAKE_VALUE, { push: true }]);
    expect(gateRan.mock.calls.length).toBe(1); // bare `capy` ran first, like add
    expect(out.stdout).toContain('Saved 1 variable(s): NEW_NAME');
  });

  test('overwrites an existing name without asking "overwrite?"', async () => {
    contextSpy.mockImplementation(async () => fakeContext({ EXISTING: 'old-fake-value' }));
    const out = await capture(() => new EditCommand().execute({ name: 'EXISTING' }));
    expect(out.exitCode).toBeUndefined();
    expect(out.thrown).toBeNull();
    // One question in total: the value. No confirm question was ever asked.
    expect(promptSpy.mock.calls.length).toBe(1);
    expect(questionsOf(0).map((q) => q.type)).toEqual(['password']);
    expect(writeSpy.mock.calls.map((c) => [c[1], c[2]])).toEqual([['EXISTING', FAKE_VALUE]]);
  });

  test('an empty answer is refused with INVALID_FORMAT and writes nothing', async () => {
    promptSpy.mockImplementationOnce(async () => ({ value: '', ok: true }));
    const out = await capture(() => new EditCommand().execute({ name: 'EMPTY_ONE' }));
    expect(out.thrown).toMatchObject({ code: ERROR_CODES.INVALID_FORMAT });
    expect(out.exitCode).toBeUndefined();
    expect(writeSpy.mock.calls.length).toBe(0);
  });

  test('--no-push writes .env only: the value is in .env (encrypted), and nothing is pushed', async () => {
    const out = await capture(() => new EditCommand().execute({ name: 'LOCAL_ONLY_WRITE', noPush: true }));
    expect(out.exitCode).toBeUndefined();
    expect(out.thrown).toBeNull();
    expect(writeSpy.mock.calls.map((c) => c[3])).toEqual([{ push: false }]);
    const held = readLocalPlaintext(new FileManager(TEST_DIR), PROJECT_KEY);
    expect(held.LOCAL_ONLY_WRITE).toBe(FAKE_VALUE);
    expect(out.stdout).toContain('.env only');
  });

  test('--pr / --no-pr / --pr-base and --resolve/--conflict reach the same steps add uses, and the PR step is named edit', async () => {
    const pr = { prBase: 'trunk' };
    const conflictFlags = { resolve: ['LEFT=local'], conflict: 'c_0123456789ab' };
    await capture(() => new EditCommand().execute({ name: 'WITH_FLAGS', pr, conflictFlags: conflictFlags as never }));
    const [req] = prStepSpy.mock.calls[0] as [{ command: string; flags: unknown; records: readonly unknown[] }];
    expect(req.command).toBe('edit');
    expect(req.flags).toEqual(pr);
    const [gateOpts] = gateRan.mock.calls[0] as [{ conflictFlags: unknown }];
    expect(gateOpts.conflictFlags).toEqual(conflictFlags);
  });

  test('--dry-run: DRY_RUN_UNSUPPORTED before any prompt, any read and any write', async () => {
    const json = await capture(() => new EditCommand().execute({ name: 'DRY_ONE', dryRun: true, json: true }));
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED, error: DRY_RUN_UNSUPPORTED_MESSAGES.editPrompt });
    const human = await capture(() => new EditCommand().execute({ name: 'DRY_ONE', dryRun: true }));
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toBe(DRY_RUN_UNSUPPORTED_MESSAGES.editPrompt);
    expect(promptSpy.mock.calls.length).toBe(0);
    expect(contextSpy.mock.calls.length).toBe(0);
    expect(writeSpy.mock.calls.length).toBe(0);
    expect(gateRan.mock.calls.length).toBe(0);
  });

  test('no terminal and no piped value (--non-tty on a terminal): EDIT_NEEDS_TTY, no prompt', async () => {
    const out = await capture(() => new EditCommand().execute({ name: 'NO_TTY', nonTty: true, json: true }));
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.EDIT_NEEDS_TTY });
    expect(promptSpy.mock.calls.length).toBe(0);
    expect(writeSpy.mock.calls.length).toBe(0);
  });

  test('a bad name is refused with INVALID_FORMAT, not echoed, before any prompt', async () => {
    const out = await capture(() => new EditCommand().execute({ name: 'BAD-NAME=hunter2', json: true }));
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.INVALID_FORMAT });
    expect(out.stdout).not.toContain('hunter2');
    expect(promptSpy.mock.calls.length).toBe(0);
  });

  test('a local-only profile is refused with a code (it has no organization to write to), before any prompt', async () => {
    localOnlySpy.mockImplementation(() => true);
    const out = await capture(() => new EditCommand().execute({ name: 'LOCAL_PROFILE', json: true }));
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.EDIT_STDIN_LOCAL_ONLY });
    expect(promptSpy.mock.calls.length).toBe(0);
    expect(writeSpy.mock.calls.length).toBe(0);
  });
});

describe('capy edit with no name still opens the editor', () => {
  test('it does not prompt, resolve a write context or write: it goes on to the editor\'s own setup (keep.lock check)', async () => {
    const out = await capture(() => new EditCommand().execute({}));
    // The temp folder has no keep.lock: the editor's setup is what answers.
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No keep.lock found');
    expect(gateRan.mock.calls.length).toBe(1);
    expect(promptSpy.mock.calls.length).toBe(0);
    expect(contextSpy.mock.calls.length).toBe(0);
    expect(writeSpy.mock.calls.length).toBe(0);
  });
});
