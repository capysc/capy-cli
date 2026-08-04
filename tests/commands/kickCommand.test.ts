import { mock, spyOn, jest, describe, test, it, expect, beforeEach, afterAll } from 'bun:test';

// Mock dependencies before importing KickCommand
const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockRefreshToken = jest.fn();
const mockGetToken = jest.fn();
const mockSetToken = jest.fn();
const mockListMemberDetails = jest.fn();
const mockKickMember = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
  })),
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    authenticateSilent: mockAuthenticateSilent,
    refreshToken: mockRefreshToken,
    getToken: mockGetToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetToken,
    listMemberDetails: mockListMemberDetails,
    kickMember: mockKickMember,
  })),
}));

const mockPromptFn = jest.fn().mockResolvedValue({ confirm: true });
mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn },
  prompt: mockPromptFn,
}));

// The browser confirm. Stubbed rather than driven here — the real page is
// clicked in tests/ui/browserFlow.e2e.test.ts — because what this file is for
// is the wiring either side of it: which confirm gets asked, and whether a
// DELETE follows the answer.
const mockConfirmInBrowser = jest.fn();
mock.module('../../src/ui/memberScreens', () => ({
  confirmKickInBrowser: mockConfirmInBrowser,
}));

afterAll(() => { mock.restore(); });

import { KickCommand } from '../../src/commands/kickCommand';

describe('KickCommand', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({
      initialized: true,
      organizationId: 'org-123',
    });
    // Silent-fallback chain: authenticateSilent(orgId) returns the cached
    // session — short-circuits the chain without ever hitting interactive auth.
    mockAuthenticateSilent.mockResolvedValue({ success: true, organizations: [{ id: 'org-123' }] });
    mockAuthenticate.mockResolvedValue({ success: true });
    mockRefreshToken.mockResolvedValue(false);
    mockGetToken.mockReturnValue({ access_token: 'tok' });
    mockKickMember.mockResolvedValue(undefined);
  });

  it('finds member by email (not userId) and kicks', async () => {
    mockListMemberDetails.mockResolvedValue({
      members: [
        {
          membershipId: 'mem-owner-1',
          userId: 'user-uuid-owner',
          email: 'owner@acme.com',
          role: 'owner',
          status: 'active',
          createdAt: '2025-01-01T00:00:00Z',
          projects: [],
        },
        {
          membershipId: 'mem-alice-2',
          userId: 'user-uuid-alice',
          email: 'alice@acme.com',
          role: 'member',
          status: 'active',
          createdAt: '2025-02-01T00:00:00Z',
          projects: [],
        },
      ],
    });

    const cmd = new KickCommand();
    await cmd.execute('alice@acme.com');

    expect(mockListMemberDetails).toHaveBeenCalledWith('org-123');
    expect(mockKickMember).toHaveBeenCalledWith('org-123', 'mem-alice-2');
  });

  it('matches email case-insensitively', async () => {
    mockListMemberDetails.mockResolvedValue({
      members: [
        {
          membershipId: 'mem-bob-3',
          userId: 'user-uuid-bob',
          email: 'Bob@ACME.com',
          role: 'member',
          status: 'active',
          createdAt: '2025-02-01T00:00:00Z',
          projects: [],
        },
      ],
    });

    const cmd = new KickCommand();
    await cmd.execute('bob@acme.com');

    expect(mockKickMember).toHaveBeenCalledWith('org-123', 'mem-bob-3');
  });

  it('exits if no member matches email', async () => {
    mockListMemberDetails.mockResolvedValue({
      members: [
        {
          membershipId: 'mem-1',
          userId: 'user-uuid-1',
          email: 'alice@acme.com',
          role: 'member',
          status: 'active',
          createdAt: '2025-02-01T00:00:00Z',
          projects: [],
        },
      ],
    });

    const cmd = new KickCommand();
    await expect(cmd.execute('nobody@acme.com')).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockKickMember).not.toHaveBeenCalled();
  });

  describe('--web', () => {
    beforeEach(() => {
      mockListMemberDetails.mockResolvedValue({
        members: [
          {
            membershipId: 'mem-alice-2',
            userId: 'user-uuid-alice',
            email: 'alice@acme.com',
            role: 'member',
            status: 'active',
            createdAt: '2025-02-01T00:00:00Z',
            projects: [{ id: 'p1', name: 'storefront', role: 'member', branches: [] }],
          },
        ],
      });
    });

    it('asks the browser instead of the terminal, and removes on yes', async () => {
      mockConfirmInBrowser.mockResolvedValue(true);

      await new KickCommand().execute('alice@acme.com', { web: true });

      expect(mockPromptFn).not.toHaveBeenCalled();
      expect(mockKickMember).toHaveBeenCalledWith('org-123', 'mem-alice-2');
      // The screen is told which membership this run is about, so a submit
      // aimed at any other one can be refused rather than performed.
      expect(mockConfirmInBrowser.mock.calls[0][0].member).toMatchObject({
        membershipId: 'mem-alice-2',
        email: 'alice@acme.com',
      });
    });

    it('removes nobody when the browser says no', async () => {
      mockConfirmInBrowser.mockResolvedValue(false);

      await new KickCommand().execute('alice@acme.com', { web: true });

      expect(mockKickMember).not.toHaveBeenCalled();
    });

    it('a browser that never answered is a no, not an error', async () => {
      // Closed, timed out, interrupted: `runBrowserWizard` rejects for all
      // three, and none of them is agreement to cut somebody off from every
      // secret in the organization.
      mockConfirmInBrowser.mockRejectedValue(new Error('Timed out waiting for the browser'));

      await new KickCommand().execute('alice@acme.com', { web: true });

      expect(mockKickMember).not.toHaveBeenCalled();
    });

    it('never opens the developer\'s real browser when CAPY_WEB_NO_OPEN is set', async () => {
      // The flag every test in this repo sets. The command has to honour it, or
      // a suite run hijacks a window on somebody's machine.
      const prev = process.env.CAPY_WEB_NO_OPEN;
      process.env.CAPY_WEB_NO_OPEN = '1';
      mockConfirmInBrowser.mockResolvedValue(false);
      try {
        await new KickCommand().execute('alice@acme.com', { web: true });
        expect(mockConfirmInBrowser.mock.calls[0][0].open).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.CAPY_WEB_NO_OPEN;
        else process.env.CAPY_WEB_NO_OPEN = prev;
      }
    });

    it('leaves the terminal confirm alone without the flag', async () => {
      mockPromptFn.mockResolvedValue({ confirm: true });

      await new KickCommand().execute('alice@acme.com');

      expect(mockConfirmInBrowser).not.toHaveBeenCalled();
      expect(mockPromptFn).toHaveBeenCalled();
      expect(mockKickMember).toHaveBeenCalledWith('org-123', 'mem-alice-2');
    });
  });
});
