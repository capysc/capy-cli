/**
 * `capy deploy` (token+docs picker) and `capy deploy revoke`, at the command
 * level — regression coverage for two agent-surfacing bugs (CAP-512, CAP-507)
 * both reachable through the hosted MCP's `capy_deploy` tool, which always
 * shells the installed `capy` binary with non-TTY stdin.
 *
 * CAP-512: bare `capy deploy` (no target, no --platform) used to render the
 * platform picker even with no TTY to answer it, hit EOF, and exit 0 having
 * saved nothing — indistinguishable from success. It must now refuse with
 * EXIT_NEEDS_INPUT (3) instead.
 *
 * CAP-507: `capy deploy revoke <id>` had two revoke paths. `--web` resolved
 * the typed prefix against the live listing via `resolveTokenPrefix` before
 * revoking; the terminal path skipped that and handed the raw prefix
 * straight to the service, which 404s on the exact id `capy deploy list`
 * just printed (a prefix, not the full id the service expects). The terminal
 * path must now resolve the same way `--web` does.
 */
import { mock, spyOn, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetToken = jest.fn();
const mockSetToken = jest.fn();
const mockListDeployTokens = jest.fn();
const mockRevokeDeployToken = jest.fn();
const mockFetchDeployInstructions = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
  })),
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    authenticateSilent: mockAuthenticateSilent,
    getToken: mockGetToken,
    getValidToken: mockGetToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetToken,
    listDeployTokens: mockListDeployTokens,
    revokeDeployToken: mockRevokeDeployToken,
    fetchDeployInstructions: mockFetchDeployInstructions,
  })),
}));

const mockPromptFn = jest.fn();
mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn, Separator: class {} },
  prompt: mockPromptFn,
  Separator: class {},
}));

afterAll(() => {
  mock.restore();
});

const { DeployCommand, DeployRevokeCommand, resolveTokenPrefix } = await import(
  '../../src/commands/deployTokenCommand'
);

describe('capy deploy — non-TTY refusal (CAP-512)', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({
      initialized: true,
      organizationId: 'org-123',
      projectId: 'proj-123',
      userId: 'u-mike',
    });
    mockAuthenticateSilent.mockResolvedValue({ success: true, user_id: 'u-mike' });
    mockAuthenticate.mockResolvedValue({ success: true, user_id: 'u-mike' });
    mockGetToken.mockReturnValue({ access_token: 'tok' });
  });

  test('bare deploy, no --platform, non-TTY: refuses with EXIT_NEEDS_INPUT (3), not 0', async () => {
    // This is the whole bug: the pre-fix code fell through inquirer's picker
    // to a silent `exit 0` here. The fix must reach refuseNonInteractive
    // BEFORE ever calling inquirer.prompt.
    const cmd = new DeployCommand(undefined, false, { nonTty: true });

    // `execute()`'s own outer try/catch routes an escaped `process.exit`
    // throw (a testing artifact — real `process.exit` never throws) through
    // `displayErrorAndExit`, which calls a generic `process.exit(1)` of its
    // own. So the exact rejection message isn't a fixed code; what's load-
    // bearing is that EXIT_NEEDS_INPUT (3) was the code the guard itself
    // reached for, which `toHaveBeenCalledWith` below asserts against every
    // recorded call, and that it was reached before exit 0.
    await expect(cmd.execute()).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(3); // EXIT_NEEDS_INPUT — coded, not string-matched
    expect(mockExit).not.toHaveBeenCalledWith(0);
    expect(mockPromptFn).not.toHaveBeenCalled();
  });

  test('same bare invocation WITH --platform supplied: does not refuse (guard is precise, not blanket)', async () => {
    // Regression guard on the guard itself: --platform fully answers the
    // question the picker would have asked, so a non-TTY run must sail
    // through it rather than being refused for a question nobody needed to ask.
    mockFetchDeployInstructions.mockResolvedValue({ platform: 'heroku', markdown: '# docs' });
    const cmd = new DeployCommand(undefined, false, { nonTty: true, platform: 'heroku' });

    try {
      // heroku has no connector, so this reaches the real token-mint step,
      // which needs env/crypto plumbing this test does not set up and will
      // fail further down — irrelevant here. What's under test is only
      // whether the non-interactive picker guard fired.
      await cmd.execute();
    } catch {
      // ignore — downstream failure unrelated to the guard under test
    }

    expect(mockExit).not.toHaveBeenCalledWith(3);
    expect(mockPromptFn).not.toHaveBeenCalled();
  });
});

describe('capy deploy revoke — prefix resolution (CAP-507)', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as any);

  const rows = [
    {
      deployId: 'dep_abc123full',
      label: null,
      createdAge: '2d',
      createdOn: '2026-08-20',
      revokedAge: null,
    },
    {
      deployId: 'dep_abc999other',
      label: null,
      createdAge: '1d',
      createdOn: '2026-08-21',
      revokedAge: null,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({
      initialized: true,
      organizationId: 'org-123',
      projectId: 'proj-123',
      projectName: 'test-project',
      userId: 'u-mike',
    });
    mockAuthenticateSilent.mockResolvedValue({ success: true, user_id: 'u-mike' });
    mockAuthenticate.mockResolvedValue({ success: true, user_id: 'u-mike' });
    mockGetToken.mockReturnValue({ access_token: 'tok' });
    mockListDeployTokens.mockResolvedValue({
      tokens: [
        {
          deploy_id: 'dep_abc123full',
          label: null,
          created_by: 'mike',
          created_at: new Date().toISOString(),
          revoked_at: null,
        },
      ],
    });
    mockRevokeDeployToken.mockResolvedValue(undefined);
  });

  test('terminal path resolves the displayed id and revokes exactly that id — not the raw prefix', async () => {
    // The regression this pins: `capy deploy list` prints "dep_abc123full";
    // a caller (or the docs a connector prints) may pass any unambiguous
    // prefix of it. The service's revoke endpoint 404s on anything other
    // than the exact id, so the CLI — not the service — must resolve it.
    const cmd = new DeployRevokeCommand(undefined, false, { web: false });
    await cmd.execute('dep_abc123');

    expect(mockListDeployTokens).toHaveBeenCalledWith('org-123', 'proj-123');
    expect(mockRevokeDeployToken).toHaveBeenCalledWith('dep_abc123full');
    expect(mockRevokeDeployToken).not.toHaveBeenCalledWith('dep_abc123');
  });

  test('terminal path also accepts the full id unchanged', async () => {
    const cmd = new DeployRevokeCommand(undefined, false, { web: false });
    await cmd.execute('dep_abc123full');

    expect(mockRevokeDeployToken).toHaveBeenCalledWith('dep_abc123full');
  });

  test('terminal path: unknown prefix refuses (exit 1), never calls revoke', async () => {
    const cmd = new DeployRevokeCommand(undefined, false, { web: false });
    await expect(cmd.execute('dep_zzz')).rejects.toThrow('process.exit:1');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRevokeDeployToken).not.toHaveBeenCalled();
  });

  test('terminal path: ambiguous prefix refuses (exit 1), never calls revoke', async () => {
    mockListDeployTokens.mockResolvedValue({
      tokens: [
        {
          deploy_id: 'dep_abc123full',
          label: null,
          created_by: 'mike',
          created_at: new Date().toISOString(),
          revoked_at: null,
        },
        {
          deploy_id: 'dep_abc999other',
          label: null,
          created_by: 'mike',
          created_at: new Date().toISOString(),
          revoked_at: null,
        },
      ],
    });
    const cmd = new DeployRevokeCommand(undefined, false, { web: false });
    await expect(cmd.execute('dep_abc')).rejects.toThrow('process.exit:1');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRevokeDeployToken).not.toHaveBeenCalled();
  });

  test('resolveTokenPrefix: exact id match is never ambiguous, whatever else it prefixes', () => {
    const match = resolveTokenPrefix(rows as any, 'dep_abc123full');
    expect(match.code).toBe('ok');
    if (match.code === 'ok') expect(match.token.deployId).toBe('dep_abc123full');
  });

  test('resolveTokenPrefix: shared prefix across two rows is ambiguous', () => {
    const match = resolveTokenPrefix(rows as any, 'dep_abc');
    expect(match.code).toBe('ambiguous');
  });
});
