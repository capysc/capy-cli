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
 * `isInteractive` (src/ui/interactive.ts) is ALSO mocked, with a controllable
 * return value — never by assigning to `process.stdin.isTTY`, which is
 * readonly in some runtimes and leaks a changed property descriptor into
 * sibling test files. This is what lets both the off-TTY refusal AND the
 * interactive-prompt paths be exercised deterministically in the same
 * process, regardless of whether the test runner itself has a real TTY.
 *
 * The real end-to-end wiring (index.ts → argv → this refusal, against a
 * genuinely non-TTY stdin) is proven separately by spawning the built CLI in
 * tests/commands/flowCancelOffTty.test.ts.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetValidToken = jest.fn();
const mockSetTokenProvider = jest.fn();
const mockCancelFlow = jest.fn();

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

const mockPromptFn = jest.fn();
mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn },
  prompt: mockPromptFn,
}));

// Defaults to non-interactive (`false`), matching the deterministic-no-TTY
// shape every other test in this file relies on. Individual tests flip it to
// exercise the interactive-prompt branch — never by touching
// `process.stdin.isTTY`.
let mockIsInteractiveReturn = false;
mock.module('../../src/ui/interactive', () => ({
  isInteractive: (nonTty?: boolean) => (nonTty ? false : mockIsInteractiveReturn),
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

let FlowCancelCommand: any;
let ERROR_CODES: any;
let CapyError: any;

beforeAll(async () => {
  ({ FlowCancelCommand } = await import('../../src/commands/flowCancelCommand'));
  ({ ERROR_CODES, CapyError } = await import('../../src/types/index'));
});

let logs: string[] = [];
let errs: string[] = [];
const originalLog = console.log;
const originalErr = console.error;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsInteractiveReturn = false;
  mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123' });
  mockAuthenticateSilent.mockResolvedValue({ success: true });
  mockAuthenticate.mockResolvedValue({ success: true });
  mockGetValidToken.mockResolvedValue({ access_token: 'tok' });
  mockPromptFn.mockResolvedValue({ confirm: true });
  // See pairCommand.test.ts's identical note: Bun does not treat
  // `process.exitCode = undefined` as clearing a prior nonzero value, so `0`
  // (not `undefined`) is the only reset that actually takes.
  process.exitCode = 0;
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exitCode = 0;
});

function jsonOut(): any {
  return JSON.parse(logs.join('\n'));
}

describe('FlowCancelCommand — success', () => {
  test('--yes skips the confirmation prompt and calls cancelFlow directly', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    await new FlowCancelCommand().execute('flow-abc', { yes: true });

    expect(mockPromptFn).not.toHaveBeenCalled();
    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
    expect(process.exitCode).toBe(0);
  });

  test('--json emits {ok:true, flow_id, state} on success', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    await new FlowCancelCommand().execute('flow-abc', { yes: true, json: true });

    const out = jsonOut();
    expect(out).toEqual({ ok: true, flow_id: 'flow-abc', state: 'cancelled' });
  });

  test('an interactive "yes" proceeds to cancel', async () => {
    mockIsInteractiveReturn = true;
    mockPromptFn.mockResolvedValue({ confirm: true });
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    await new FlowCancelCommand().execute('flow-abc', {});

    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
  });

  test('an interactive decline cancels nothing (non-json: plain "Cancelled.", exit stays 0)', async () => {
    mockIsInteractiveReturn = true;
    mockPromptFn.mockResolvedValue({ confirm: false });

    await new FlowCancelCommand().execute('flow-abc', {});

    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Cancelled.');
  });

  test('an interactive decline honours --json: {ok:false, code: FLOW_CANCEL_DECLINED}', async () => {
    mockIsInteractiveReturn = true;
    mockPromptFn.mockResolvedValue({ confirm: false });

    await new FlowCancelCommand().execute('flow-abc', { json: true });

    expect(mockCancelFlow).not.toHaveBeenCalled();
    const out = jsonOut();
    expect(out).toEqual({ ok: false, code: ERROR_CODES.FLOW_CANCEL_DECLINED, flow_id: 'flow-abc' });
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
    await new FlowCancelCommand().execute('flow-missing', { yes: true });

    expect(process.exitCode).toBe(1);
    const combined = errs.join('\n');
    expect(combined).toContain('flow-missing');
    expect(combined).toContain('does not exist, or is not yours to cancel');
    // No invented authorization distinction — the message must not claim to
    // know WHICH of the two it is.
    expect(combined.toLowerCase()).not.toContain('you are not the owner');
  });

  test('--json honoured on failure: {ok:false, code: FLOW_NOT_FOUND, flow_id, detail}', async () => {
    await new FlowCancelCommand().execute('flow-missing', { yes: true, json: true });

    expect(process.exitCode).toBe(1);
    const out = jsonOut();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.FLOW_NOT_FOUND);
    expect(out.flow_id).toBe('flow-missing');
    expect(typeof out.detail).toBe('string');
  });
});

describe('FlowCancelCommand — off-TTY confirmation gate', () => {
  test('off-TTY (no --yes) refuses with EXIT_NEEDS_INPUT (3) and never calls cancelFlow', async () => {
    await expect(new FlowCancelCommand().execute('flow-abc', {})).rejects.toBeInstanceOf(ExitError);

    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(mockPromptFn).not.toHaveBeenCalled();
    // No auth/service bootstrap either — the gate is checked before any work.
    expect(mockAuthenticateSilent).not.toHaveBeenCalled();
  });

  test('the refusal exits with code 3 specifically, not a generic 1', async () => {
    try {
      await new FlowCancelCommand().execute('flow-abc', {});
      throw new Error('expected execute() to throw via process.exit');
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(3);
    }
  });

  test('--json honoured on the off-TTY refusal too: {ok:false, code: FLOW_CANCEL_CONFIRMATION_REQUIRED}', async () => {
    try {
      await new FlowCancelCommand().execute('flow-abc', { json: true });
      throw new Error('expected execute() to throw via process.exit');
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(3);
    }
    const out = jsonOut();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.FLOW_CANCEL_CONFIRMATION_REQUIRED);
    expect(out.flow_id).toBe('flow-abc');
    expect(mockCancelFlow).not.toHaveBeenCalled();
  });

  test('nonTty:true forces the refusal even when isInteractive would otherwise say yes', async () => {
    mockIsInteractiveReturn = true;

    await expect(new FlowCancelCommand().execute('flow-abc', { nonTty: true })).rejects.toBeInstanceOf(ExitError);

    expect(mockCancelFlow).not.toHaveBeenCalled();
    expect(mockPromptFn).not.toHaveBeenCalled();
  });

  test('--yes overrides the off-TTY refusal — an agent can still cancel non-interactively', async () => {
    mockCancelFlow.mockResolvedValue({ flow_id: 'flow-abc', state: 'cancelled' });

    await new FlowCancelCommand().execute('flow-abc', { yes: true });

    expect(mockCancelFlow).toHaveBeenCalledWith('flow-abc');
    expect(process.exitCode).toBe(0);
  });
});
