import { mock, spyOn, jest, describe, test, it, expect, beforeEach, afterAll } from 'bun:test';

// Mock dependencies before importing KickCommand
const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
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
    getToken: mockGetToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setToken: mockSetToken,
    setTokenRefresher: jest.fn(),
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
    mockAuthenticate.mockResolvedValue({ success: true });
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
});
