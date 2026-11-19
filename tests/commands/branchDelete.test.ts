/**
 * `capy branch -D <name>`: it asks first, and with nobody to ask it refuses instead of silently answering "no".
 *
 *  - `runBranchDelete` / `needsConfirmation` / `refuseNeedsConfirmation` are driven with hand-built deps (fakes for the
 *    service calls and the prompt), so nothing touches the network or a real terminal.
 *  - The built entrypoints (`dist/`, needs `bun run build`) prove the refusal happens before any prompt, sign-in or
 *    request, and that `capy help --json` lists the new options.
 *
 * No `let`/mutation: stdout, stderr, exit codes and call records all come from the mock library's own `.mock.calls`.
 */
import { describe, test, expect, spyOn, mock, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import {
  needsConfirmation,
  refuseNeedsConfirmation,
  runBranchDelete,
  codeOfFailure,
  deletePromptMessage,
  type BranchDeleteDeps,
} from '../../src/commands/branchDeleteCommand';
import { CapyError, ERROR_CODES, type Branch } from '../../src/types/index';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('process.exit called');
  }
}

const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setStdinTTY(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true, writable: true });
}

afterEach(() => {
  if (ORIGINAL_STDIN_TTY === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
  else Object.defineProperty(process.stdin, 'isTTY', ORIGINAL_STDIN_TTY);
});

function renderCalls(calls: readonly unknown[][]): string {
  if (calls.length === 0) return '';
  return calls.map((args) => args.map(String).join(' ')).join('\n') + '\n';
}

async function exitCodeOf(fn: () => Promise<void> | void): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

/** Runs `fn`, capturing stdout/stderr and the exit code; `process.exit` never exits the runner. */
async function capture(fn: () => Promise<void> | void): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
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

function branch(name: string, id: string): Branch {
  return { id, name, project_id: 'proj-1', is_protected: false };
}

const BRANCHES: readonly Branch[] = [branch('development', 'b-dev'), branch('preview', 'b-prev')];

function fakeDeps(over: Partial<BranchDeleteDeps> = {}) {
  const listBranches = mock(async (_projectId: string) => BRANCHES);
  const deleteBranch = mock(async (_projectId: string, _branchId: string) => {});
  const confirm = mock(async (_message: string) => true);
  const deps: BranchDeleteDeps = {
    projectId: 'proj-1',
    activeBranch: 'development',
    checkoutHint: 'capy',
    emphasize: (s) => `<b>${s}</b>`,
    listBranches,
    deleteBranch,
    confirm,
    ...over,
  };
  return { deps, listBranches, deleteBranch, confirm };
}

describe('needsConfirmation', () => {
  test('--yes never needs it, whatever the terminal', () => {
    setStdinTTY(false);
    expect(needsConfirmation({ yes: true })).toBe(false);
    expect(needsConfirmation({ yes: true, json: true, nonTty: true })).toBe(false);
  });

  test('stdin that is not a terminal, without --yes, needs it', () => {
    setStdinTTY(false);
    expect(needsConfirmation({})).toBe(true);
  });

  test('--json and --non-tty need it even on a terminal', () => {
    setStdinTTY(true);
    expect(needsConfirmation({ json: true })).toBe(true);
    expect(needsConfirmation({ nonTty: true })).toBe(true);
  });

  test('a terminal without --yes does not (the prompt asks)', () => {
    setStdinTTY(true);
    expect(needsConfirmation({})).toBe(false);
  });
});

describe('refuseNeedsConfirmation', () => {
  test('--json: pure JSON on stdout with CONFIRMATION_REQUIRED, exit 3, nothing on stderr', async () => {
    const r = await capture(() => refuseNeedsConfirmation(true));
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('');
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(ERROR_CODES.CONFIRMATION_REQUIRED);
    expect(body.code).toBe('CONFIRMATION_REQUIRED');
    expect(typeof body.error).toBe('string');
  });

  test('human mode: the message on stderr, nothing on stdout, exit 3', async () => {
    const r = await capture(() => refuseNeedsConfirmation(false));
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
    expect(r.stderr).not.toContain('(y/N)');
  });
});

describe('runBranchDelete', () => {
  test('--yes deletes without asking (human output unchanged)', async () => {
    const { deps, deleteBranch, confirm } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'preview', { yes: true }));
    expect(r.exitCode).toBeUndefined();
    expect(confirm.mock.calls.length).toBe(0);
    expect(deleteBranch.mock.calls).toEqual([['proj-1', 'b-prev']]);
    expect(r.stdout).toBe('Deleted branch "preview"\n');
  });

  test('--json --yes: pure JSON success naming the deleted branch', async () => {
    const { deps, deleteBranch, confirm } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'preview', { yes: true, json: true }));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, branch: { id: 'b-prev', name: 'preview' } });
    expect(confirm.mock.calls.length).toBe(0);
    expect(deleteBranch.mock.calls).toEqual([['proj-1', 'b-prev']]);
  });

  test('interactive path unchanged: asks with the existing wording, deletes on yes', async () => {
    const { deps, deleteBranch, confirm } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'preview', {}));
    expect(confirm.mock.calls).toEqual([['Delete branch "preview"? This will remove all its secrets.']]);
    expect(deletePromptMessage('preview')).toBe('Delete branch "preview"? This will remove all its secrets.');
    expect(deleteBranch.mock.calls.length).toBe(1);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toBe('Deleted branch "preview"\n');
  });

  test('interactive decline: nothing deleted, nothing printed, exit code unchanged (no exit call)', async () => {
    const { deps, deleteBranch } = fakeDeps({ confirm: mock(async () => false) });
    const r = await capture(() => runBranchDelete(deps, 'preview', {}));
    expect(deleteBranch.mock.calls.length).toBe(0);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('unknown branch: the existing line and exit 1 in human mode', async () => {
    const { deps, deleteBranch } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'nope', { yes: true }));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('Branch "nope" not found\n');
    expect(deleteBranch.mock.calls.length).toBe(0);
  });

  test('unknown branch under --json: coded refusal on stdout, exit 1', async () => {
    const { deps } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'nope', { yes: true, json: true }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, code: 'BRANCH_NOT_FOUND', error: 'Branch "nope" not found' });
  });

  test('the current branch: the existing line (bold command) and exit 1 in human mode', async () => {
    const { deps, deleteBranch, confirm } = fakeDeps();
    const r = await capture(() => runBranchDelete(deps, 'development', {}));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('Cannot delete the current branch. Switch first with: <b>capy checkout <other-branch></b>\n');
    expect(confirm.mock.calls.length).toBe(0);
    expect(deleteBranch.mock.calls.length).toBe(0);
  });

  test('the current branch under --json: plain text and a code', async () => {
    const { deps } = fakeDeps({ checkoutHint: 'capy-dev' });
    const r = await capture(() => runBranchDelete(deps, 'development', { yes: true, json: true }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: false,
      code: 'CANNOT_DELETE_CURRENT_BRANCH',
      error: 'Cannot delete the current branch. Switch first with: capy-dev checkout <other-branch>',
    });
  });

  test('--json: a service refusal carrying a `code` passes the code through; the message is only displayed', async () => {
    const refusal = new CapyError('any wording at all', ERROR_CODES.SERVICE_ERROR, {
      status: 400,
      data: { error: 'any wording at all', code: 'LAST_BRANCH' },
    });
    const { deps } = fakeDeps({ deleteBranch: mock(async () => { throw refusal; }) });
    const r = await capture(() => runBranchDelete(deps, 'preview', { yes: true, json: true }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, code: 'LAST_BRANCH', error: 'any wording at all' });
  });

  test('--json: today\'s service answer (no code) keeps the client\'s own code', async () => {
    const refusal = new CapyError('Cannot delete the default branch', ERROR_CODES.SERVICE_ERROR, {
      status: 400,
      data: { error: 'Cannot delete the default branch' },
    });
    const { deps } = fakeDeps({ deleteBranch: mock(async () => { throw refusal; }) });
    const r = await capture(() => runBranchDelete(deps, 'preview', { yes: true, json: true }));
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('SERVICE_ERROR');
    expect(body.error).toBe('Cannot delete the default branch');
  });

  test('human mode: a service refusal is rethrown for the caller\'s error screen, as before', async () => {
    const refusal = new CapyError('nope', ERROR_CODES.SERVICE_ERROR, { status: 400, data: {} });
    const { deps } = fakeDeps({ deleteBranch: mock(async () => { throw refusal; }) });
    await expect(runBranchDelete(deps, 'preview', { yes: true })).rejects.toBe(refusal);
  });
});

describe('codeOfFailure', () => {
  test('body code, then lifted 403 code, then the client code; a non-CapyError is SERVICE_ERROR', () => {
    expect(codeOfFailure(new CapyError('m', ERROR_CODES.SERVICE_ERROR, { data: { code: 'X' } }))).toBe('X');
    expect(codeOfFailure(new CapyError('m', ERROR_CODES.PERMISSION_DENIED, { status: 403, code: 'Y' }))).toBe('Y');
    expect(codeOfFailure(new CapyError('m', ERROR_CODES.AUTH_FAILED, { status: 401 }))).toBe('AUTH_FAILED');
    expect(codeOfFailure(new Error('boom'))).toBe('SERVICE_ERROR');
  });
});

// ── the built entrypoints ────────────────────────────────────────────────

const SCRATCH = mkdtempSync(join(tmpdir(), 'capy-branch-delete-'));
const PROD_CLI = join(__dirname, '../../dist/index.js');
const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

function run(cli: string, args: readonly string[], input: string = ''): { stdout: string; stderr: string; code: number } {
  // stdin is a pipe here, never a terminal. HOME points at a scratch folder, so nothing real is read.
  const r = spawnSync('node', [cli, ...args], {
    encoding: 'utf-8',
    input,
    env: { ...process.env, HOME: SCRATCH },
    cwd: SCRATCH,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe.each([
  ['capy', PROD_CLI],
  ['capy-dev', DEV_CLI],
])('%s branch -D on the built CLI', (_name, cli) => {
  test('stdin not a terminal, no --yes: refuses CONFIRMATION_REQUIRED (exit 3), no prompt, even when "y" is piped in', () => {
    const r = run(cli, ['branch', '-D', 'preview'], 'y\n');
    expect(r.code).toBe(3);
    expect(r.stdout).not.toContain('Delete branch');
    expect(r.stdout).not.toContain('(y/N)');
    expect(r.stderr).not.toContain('(y/N)');
    expect(r.stderr).toContain('--yes');
  });

  test('--json without --yes: pure JSON refusal on stdout, exit 3', () => {
    const r = run(cli, ['branch', '-D', 'preview', '--json']);
    expect(r.code).toBe(3);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('CONFIRMATION_REQUIRED');
    expect(r.stdout).not.toContain('(y/N)');
  });

  test('--non-tty without --yes: refuses the same way', () => {
    const r = run(cli, ['branch', '-D', 'preview', '--non-tty']);
    expect(r.code).toBe(3);
    expect(r.stderr).not.toContain('(y/N)');
    expect(r.stdout).not.toContain('(y/N)');
  });

  test('help --json lists --yes, --json and --non-tty on `branch`, and the codes', () => {
    const r = run(cli, ['help', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const branchDoc = doc.commands.find((c: { path: string }) => c.path === 'branch');
    const longs = branchDoc.options.map((o: { long: string }) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['-D', '--yes', '--json', '--non-tty']));
    expect(branchDoc.supportsJson).toBe(true);
    expect(doc.errorCodes).toContain('CONFIRMATION_REQUIRED');
    expect(doc.errorCodes).toContain('CANNOT_DELETE_CURRENT_BRANCH');
  });
});
