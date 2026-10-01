/**
 * `capy info` (read-only, CAP-659 Phase 2/3) — the "Not signed in" refusal
 * now honors `--json` (it used to be prose-on-stderr even then, the one gap
 * in an otherwise fully-coded command).
 */
import { mock, spyOn, jest, describe, it, expect, beforeEach, afterAll } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockAuthenticate = jest.fn();
const mockGetToken = jest.fn();
const mockGetValidToken = jest.fn();
const mockSetToken = jest.fn();
const mockListMembers = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
  })),
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticateSilent: mockAuthenticateSilent,
    authenticate: mockAuthenticate,
    getToken: mockGetToken,
    getValidToken: mockGetValidToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetToken,
    listMembers: mockListMembers,
  })),
}));

afterAll(() => mock.restore());

import { InfoCommand } from '../../src/commands/infoCommand';

function captureExit(): { exitCode: () => number | undefined; restore: () => void } {
  let code: number | undefined;
  const spy = spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`__exit_${c}__`);
  }) as never);
  return { exitCode: () => code, restore: () => spy.mockRestore() };
}

function captureOutput(): { stdout: () => string; stderr: () => string; restore: () => void } {
  let out = '';
  let err = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => { out += a.join(' ') + '\n'; }) as any);
  const errSpy = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => { err += a.join(' ') + '\n'; }) as any);
  return { stdout: () => out, stderr: () => err, restore: () => { log.mockRestore(); errSpy.mockRestore(); } };
}

describe('InfoCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetToken.mockReturnValue(undefined);
    mockGetValidToken.mockResolvedValue(undefined);
  });

  it('not signed in, outside a project, human mode: unchanged prose on stderr, exit 1', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: false, organizationId: undefined });
    mockAuthenticateSilent.mockResolvedValue({ success: false });
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new InfoCommand().execute({})).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(exit.exitCode()).toBe(1);
    expect(out.stderr()).toContain('Not signed in');
    expect(out.stdout()).toBe('');
  });

  it('not signed in, --json: coded JSON on stdout, nothing on stderr', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: false, organizationId: undefined });
    mockAuthenticateSilent.mockResolvedValue({ success: false });
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new InfoCommand().execute({ json: true })).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(exit.exitCode()).toBe(1);
    expect(out.stderr()).toBe('');
    expect(JSON.parse(out.stdout())).toEqual({ ok: false, code: 'AUTH_FAILED', error: expect.any(String) });
  });

  it('not signed in, WITH a keep.lock (hasKeep): still tries interactive auth, same as before', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-1' });
    mockAuthenticateSilent.mockResolvedValue({ success: false });
    mockAuthenticate.mockResolvedValue({ success: false });
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new InfoCommand().execute({ json: true })).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(mockAuthenticate).toHaveBeenCalledWith('org-1');
    expect(JSON.parse(out.stdout())).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
  });

  it('signed in, --json: pure JSON success shape, unaffected', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: false, organizationId: undefined, projectName: undefined, projectId: undefined, activeBranch: undefined });
    mockAuthenticateSilent.mockResolvedValue({
      success: true,
      user_id: 'u1',
      user_email: 'a@b.com',
      organizations: [],
    });
    const out = captureOutput();
    try {
      await new InfoCommand().execute({ json: true });
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.stdout());
    expect(parsed).toMatchObject({ user: { email: 'a@b.com', userId: 'u1' } });
  });
});
