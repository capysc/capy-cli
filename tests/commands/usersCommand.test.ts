/**
 * `capy grant-branch` / `capy revoke-branch` (CAP-659 Phase 2/3).
 *
 * Both used to take no options at all and call the service immediately —
 * no confirm, no `--json`, no `--dry-run`, and the same unconditional
 * `resolveContext()` auth hang every other org command had. This file
 * covers the command-layer wiring this brief adds: the confirm + its
 * `-y/--yes`/`--non-tty` gate, `--json`, and the dry-run preview — through
 * `UsersCommand.grantBranch`/`revokeBranch` directly, with the service layer
 * mocked.
 */
import { mock, spyOn, jest, describe, it, expect, beforeEach, afterAll } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetToken = jest.fn();
const mockGetValidToken = jest.fn();
const mockSetToken = jest.fn();
const mockListProjects = jest.fn();
const mockListMemberDetails = jest.fn();
const mockListBranches = jest.fn();
const mockGrantProtectedBranch = jest.fn();
const mockRevokeProtectedBranch = jest.fn();

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
    getValidToken: mockGetValidToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetToken,
    listProjects: mockListProjects,
    listMemberDetails: mockListMemberDetails,
    listBranches: mockListBranches,
    grantProtectedBranch: mockGrantProtectedBranch,
    revokeProtectedBranch: mockRevokeProtectedBranch,
  })),
}));

const mockPromptFn = jest.fn();
mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn },
  prompt: mockPromptFn,
}));

afterAll(() => mock.restore());

import { UsersCommand } from '../../src/commands/usersCommand';

/** Captures console.log/console.error output into one buffer, in call order. */
function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return { out: () => buf, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

describe('UsersCommand.grantBranch / revokeBranch', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123' });
    mockAuthenticateSilent.mockResolvedValue({ success: true });
    mockAuthenticate.mockResolvedValue({ success: true });
    mockGetToken.mockReturnValue({ access_token: 'tok' });
    mockGetValidToken.mockResolvedValue({ access_token: 'tok' });
    mockListProjects.mockResolvedValue([{ id: 'p1', name: 'storefront' }]);
    mockListMemberDetails.mockResolvedValue({
      members: [{ membershipId: 'm1', userId: 'user-alice', email: 'alice@acme.com', role: 'member', status: 'active', projects: [] }],
    });
    mockListBranches.mockResolvedValue([{ id: 'b1', name: 'main', project_id: 'p1', is_protected: true }]);
    mockGrantProtectedBranch.mockResolvedValue(undefined);
    mockRevokeProtectedBranch.mockResolvedValue(undefined);
  });

  describe('non-interactive gate', () => {
    it('grantBranch: no TTY, no --yes → PROTECTED_BRANCH_NEEDS_TTY, exit 3, never calls the service', async () => {
      await expect(new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main')).rejects.toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(3);
      expect(mockGrantProtectedBranch).not.toHaveBeenCalled();
    });

    it('revokeBranch: no TTY, no --yes → PROTECTED_BRANCH_NEEDS_TTY, exit 3', async () => {
      await expect(new UsersCommand().revokeBranch('alice@acme.com', 'storefront', 'main')).rejects.toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(3);
      expect(mockRevokeProtectedBranch).not.toHaveBeenCalled();
    });

    it('--non-tty without --yes also refuses', async () => {
      await expect(
        new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { nonTty: true }),
      ).rejects.toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(3);
    });

    it('--json refusal is coded, pure JSON on stdout', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(JSON.parse(cap.out())).toEqual({ ok: false, code: 'PROTECTED_BRANCH_NEEDS_TTY', error: expect.any(String) });
    });
  });

  describe('--yes', () => {
    it('grantBranch: skips the prompt, resolves ids, grants', async () => {
      await new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { yes: true });
      expect(mockPromptFn).not.toHaveBeenCalled();
      expect(mockGrantProtectedBranch).toHaveBeenCalledWith('org-123', 'p1', 'b1', 'user-alice');
    });

    it('revokeBranch: skips the prompt, resolves ids, revokes', async () => {
      await new UsersCommand().revokeBranch('alice@acme.com', 'storefront', 'main', { yes: true });
      expect(mockRevokeProtectedBranch).toHaveBeenCalledWith('org-123', 'p1', 'b1', 'user-alice');
    });

    it('--json reports the grant', async () => {
      const cap = captureOutput();
      try {
        await new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { yes: true, json: true });
      } finally {
        cap.restore();
      }
      expect(JSON.parse(cap.out())).toEqual({ ok: true, email: 'alice@acme.com', project: 'storefront', branch: 'main' });
    });

    it('unknown project refuses PROJECT_NOT_FOUND, coded', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().grantBranch('alice@acme.com', 'nope', 'main', { yes: true, json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(JSON.parse(cap.out())).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' });
      expect(mockGrantProtectedBranch).not.toHaveBeenCalled();
    });

    it('unknown branch refuses BRANCH_NOT_FOUND, coded', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'nope', { yes: true, json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(JSON.parse(cap.out())).toMatchObject({ ok: false, code: 'BRANCH_NOT_FOUND' });
    });

    it('unknown member refuses MEMBER_NOT_FOUND, coded', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().grantBranch('nobody@acme.com', 'storefront', 'main', { yes: true, json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(JSON.parse(cap.out())).toMatchObject({ ok: false, code: 'MEMBER_NOT_FOUND' });
    });
  });

  describe('interactive confirm (real TTY)', () => {
    it('grantBranch: confirmed → grants; declined → cancels, never grants', async () => {
      const wasTTY = process.stdin.isTTY;
      (process.stdin as any).isTTY = true;
      try {
        mockPromptFn.mockResolvedValueOnce({ confirmed: false });
        await new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main');
        expect(mockGrantProtectedBranch).not.toHaveBeenCalled();

        mockPromptFn.mockResolvedValueOnce({ confirmed: true });
        await new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main');
        expect(mockGrantProtectedBranch).toHaveBeenCalledWith('org-123', 'p1', 'b1', 'user-alice');
      } finally {
        (process.stdin as any).isTTY = wasTTY;
      }
    });
  });

  describe('CAP-659 dry-run preview', () => {
    it('grantBranch --dry-run --yes: previews, never grants', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { dryRun: true, yes: true, json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockGrantProtectedBranch).not.toHaveBeenCalled();
      expect(JSON.parse(cap.out())).toEqual({
        ok: true,
        dry_run: true,
        command: 'grant-branch',
        changes: [{ where: 'capy_service', action: 'grant protected-branch access', target: 'alice@acme.com → storefront/main', reversible: true }],
        unanswered: [],
      });
    });

    it('revokeBranch --dry-run without --yes: confirm unanswered, exit 3, never revokes', async () => {
      const cap = captureOutput();
      try {
        await expect(
          new UsersCommand().revokeBranch('alice@acme.com', 'storefront', 'main', { dryRun: true, json: true }),
        ).rejects.toThrow('process.exit');
      } finally {
        cap.restore();
      }
      expect(mockExit).toHaveBeenCalledWith(3);
      expect(mockRevokeProtectedBranch).not.toHaveBeenCalled();
      expect(JSON.parse(cap.out()).unanswered).toEqual([{ id: 'confirm', flag: '-y, --yes' }]);
    });

    it('dry-run never prompts, even on a real TTY', async () => {
      const wasTTY = process.stdin.isTTY;
      (process.stdin as any).isTTY = true;
      try {
        await expect(
          new UsersCommand().grantBranch('alice@acme.com', 'storefront', 'main', { dryRun: true }),
        ).rejects.toThrow('process.exit');
        expect(mockPromptFn).not.toHaveBeenCalled();
      } finally {
        (process.stdin as any).isTTY = wasTTY;
      }
    });

    it('still refuses on an unknown project under dry-run (same checks)', async () => {
      await expect(
        new UsersCommand().grantBranch('alice@acme.com', 'nope', 'main', { dryRun: true, yes: true }),
      ).rejects.toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
