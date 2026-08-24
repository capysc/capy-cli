/**
 * `capy flow cancel <id>` — the org-owner escape hatch for a flow stranded
 * on a repo lock. Covers the command's own decisions: the confirm gate
 * (off-TTY refusal, `--yes` skipping the prompt, an interactive decline),
 * the success shape, and the 404 (not-found-or-not-authorized) reclassification
 * — all with `--json` honoured on both success and every failure path, which
 * is half the point of this command existing.
 *
 * `AuthService` and `ServiceClient` are mocked at the module boundary (same
 * shape as tests/commands/kickCommand.test.ts) — this file is about
 * FlowCancelCommand's own branching, not the real network path (that's
 * ServiceClient.cancelFlow's own unit tests in tests/service/serviceClient.test.ts).
 *
 * `isInteractive` (src/ui/interactive.ts) is ALSO mocked, as a `jest.fn()`
 * configured per test via `.mockImplementation(...)` — never by assigning to
 * `process.stdin.isTTY` (readonly in some runtimes, and a changed property
 * descriptor leaks into sibling test files either way) and never via a
 * shared, reassigned module-scope flag. This is what lets both the off-TTY
 * refusal AND the interactive-prompt paths be exercised deterministically in
 * the same process, regardless of whether the test runner itself has a real
 * TTY — and it is the same per-test-configurable-mock idiom this file already
 * uses for `mockCancelFlow` / `mockPromptFn` below, not a new pattern.
 *
 * Console output is captured per call by `captured()`, which builds a fresh
 * pair of arrays inside its own closure for the duration of one `execute()`
 * call and hands back the joined strings — never a module-scope buffer
 * reassigned between tests, which is exactly the kind of shared state that
 * leaks between them.
 *
 * The real end-to-end wiring (index.ts → argv → this refusal, against a
 * genuinely non-TTY stdin) is proven separately by spawning the built CLI in
 * tests/commands/flowCancelOffTty.test.ts.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetValidToken = jest.fn();
const mockSetTokenProvider = jest.fn();
const mockCancelFlow = jest.fn();
const mockIsInteractive = jest.fn();
const mockPromptFn = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
  })),
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    authenticateSilent: mockAuthenticateSilent,
    getValidToken: mockGetValidToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetTokenProvider,
    cancelFlow: mockCancelFlow,
  })),
}));

mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn },
  prompt: mockPromptFn,
}));

// The real `isInteractive(nonTty?)` returns `false` whenever `nonTty` is
// truthy, and otherwise reads the real TTY. The mock's default keeps that
// same "nonTty always wins" shape rather than dropping it — see the
// "nonTty:true forces the refusal" test below, which relies on it.
mock.module('../../src/ui/interactive', () => ({
  isInteractive: mockIsInteractive,
  EXIT_NEEDS_INPUT: 3,
  refuseNonInteractive: (reason: string, hint: string): never => {
    console.error(`\n  non-interactive: ${reason}`);
    console.error(`  ${hint}\n`);
    process.exit(3);
    throw new Error('unreachable');
  },
}));

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}
const originalExit = process.exit;
(process as any).exit = (code?: number) => {
  throw new ExitError(code ?? 0);
};

afterAll(() => {
  mock.restore();
  (process as any).exit = originalExit;
});

// Top-level await, not `let X: any; beforeAll(() => { ({X} = await import...) })`
// — a single `const` populated once at module evaluation, after the
// `mock.module()` calls above (which run synchronously first).
const { FlowCancelCommand } = await import('../../src/commands/flowCancelCommand');
const { ERROR_CODES, CapyError } = await import('../../src/types/index');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: non-interactive regardless of the `nonTty` argument, matching
  // the deterministic-no-TTY shape every test in this file relies on unless
  // it opts into the interactive branch below.
  mockIsInteractive.mockImplementation(() => false);
  mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123' });
  mockAuthenticateSilent.mockResolvedValue({ success: true });
  mockAuthenticate.mockResolvedValue({ success: true });
  mockGetValidToken.mockResolvedValue({ access_token: 'tok' });
  mockPromptFn.mockResolvedValue({ confirm: true });
  // See pairCommand.test.ts's identical note: Bun does not treat
  // `process.exitCode = undefined` as clearing a prior nonzero value, so `0`
  // (not `undefined`) is the only reset that actually takes.
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

/**
 * Run one `execute()` call with console output captured rather than printed,
 * and any thrown/rejected value handed back instead of failing the test.
 *
 * `logLines`/`errLines` are freshly constructed inside this call and never
 * escape it except as the joined strings returned below — there is no
 * shared buffer for one test's output to bleed into another's.
 */
async function captured(run: () => Promise<void>): Promise<{ error: unknown; log: string; err: string }> {
  const logLines: string[] = [];
  const errLines: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errLines.push(args.map(String).join(' '));
  };
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  console.log = originalLog;
  console.error = originalErr;
  return { error, log: logLines.join('\n'), err: errLines.join('\n') };
}

describe('FlowCancelCommand — success', () => {
  test('--yes skips the confirmation prompt and calls cancelFlow directly', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', { yes: true }));

    expect(error).toBeUndefined();
    expect(mockPromptFn).not.toHaveBeenCalled();
    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
    expect(process.exitCode).toBe(0);
  });

  test('--json emits {ok:true, flow_id, state} on success', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    const { log } = await captured(() => new FlowCancelCommand().execute('flow-abc', { yes: true, json: true }));

    expect(JSON.parse(log)).toEqual({ ok: true, flow_id: 'flow-abc', state: 'cancelled' });
  });

  test('an interactive "yes" proceeds to cancel', async () => {
    mockIsInteractive.mockImplementation((nonTty?: boolean) => (nonTty ? false : true));
    mockPromptFn.mockResolvedValue({ confirm: true });
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', {}));

    expect(error).toBeUndefined();
    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
  });

  test('an interactive decline cancels nothing (non-json: plain "Cancelled.", exit stays 0)', async () => {
    mockIsInteractive.mockImplementation((nonTty?: boolean) => (nonTty ? false : true));
    mockPromptFn.mockResolvedValue({ confirm: false });

    const { error, log } = await captured(() => new FlowCancelCommand().execute('flow-abc', {}));

    expect(error).toBeUndefined();
    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(log).toContain('Cancelled.');
  });

  test('an interactive decline honours --json: {ok:false, code: FLOW_CANCEL_DECLINED}', async () => {
    mockIsInteractive.mockImplementation((nonTty?: boolean) => (nonTty ? false : true));
    mockPromptFn.mockResolvedValue({ confirm: false });

    const { log } = await captured(() => new FlowCancelCommand().execute('flow-abc', { json: true }));

    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(JSON.parse(log)).toEqual({ ok: false, code: ERROR_CODES.FLOW_CANCEL_DECLINED, flow_id: 'flow-abc' });
  });
});

describe('FlowCancelCommand — 404 (not found or not authorized)', () => {
  beforeEach(() => {
    mockCancelFlow.mockRejectedValue(
      new CapyError('Flow flow-missing does not exist, or is not yours to cancel.', ERROR_CODES.FLOW_NOT_FOUND, {
        status: 404,
        flowId: 'flow-missing',
      }),
    );
  });

  test('non-json: prints the honest "does not exist, or is not yours" message and sets exitCode 1', async () => {
    const { error, err } = await captured(() => new FlowCancelCommand().execute('flow-missing', { yes: true }));

    expect(error).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(err).toContain('flow-missing');
    expect(err).toContain('does not exist, or is not yours to cancel');
    // No invented authorization distinction — the message must not claim to
    // know WHICH of the two it is.
    expect(err.toLowerCase()).not.toContain('you are not the owner');
  });

  test('--json honoured on failure: {ok:false, code: FLOW_NOT_FOUND, flow_id, detail}', async () => {
    const { log } = await captured(() => new FlowCancelCommand().execute('flow-missing', { yes: true, json: true }));

    expect(process.exitCode).toBe(1);
    const out = JSON.parse(log);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.FLOW_NOT_FOUND);
    expect(out.flow_id).toBe('flow-missing');
    expect(typeof out.detail).toBe('string');
  });
});

describe('FlowCancelCommand — off-TTY confirmation gate', () => {
  test('off-TTY (no --yes) refuses with EXIT_NEEDS_INPUT (3) and never calls cancelFlow', async () => {
    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', {}));

    expect(error).toBeInstanceOf(ExitError);
    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(mockPromptFn).not.toHaveBeenCalled();
    // No auth/service bootstrap either — the gate is checked before any work.
    expect(mockAuthenticateSilent).not.toHaveBeenCalled();
  });

  test('the refusal exits with code 3 specifically, not a generic 1', async () => {
    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', {}));

    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(3);
  });

  test('--json honoured on the off-TTY refusal too: {ok:false, code: FLOW_CANCEL_CONFIRMATION_REQUIRED}', async () => {
    const { error, log } = await captured(() => new FlowCancelCommand().execute('flow-abc', { json: true }));

    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(3);
    const out = JSON.parse(log);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.FLOW_CANCEL_CONFIRMATION_REQUIRED);
    expect(out.flow_id).toBe('flow-abc');
    expect(mockCancelFlow).not.toHaveBeenCalled();
  });

  test('nonTty:true forces the refusal even when isInteractive would otherwise say yes', async () => {
    mockIsInteractive.mockImplementation((nonTty?: boolean) => (nonTty ? false : true));

    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', { nonTty: true }));

    expect(error).toBeInstanceOf(ExitError);
    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(mockPromptFn).not.toHaveBeenCalled();
  });

  test('--yes overrides the off-TTY refusal — an agent can still cancel non-interactively', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    const { error } = await captured(() => new FlowCancelCommand().execute('flow-abc', { yes: true }));

    expect(error).toBeUndefined();
    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
    expect(process.exitCode).toBe(0);
  });
});
