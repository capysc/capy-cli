/**
 * `capy invite`, at the command level.
 *
 *   1. The redeem code is printed (or, under `--json`, put on stdout because it
 *      was asked for).
 *   2. The rail `--json` prints describes the run that happened.
 *   3. A role this caller cannot grant is refused before anything is minted.
 *   4. The interactive project checkbox is searchable (CAP-700).
 */
import { mock, spyOn, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';


const mockDetectProjectState = jest.fn();
const mockAuthenticate = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetToken = jest.fn();
const mockSetToken = jest.fn();
const mockGetOrgMe = jest.fn();
const mockListMemberDetails = jest.fn();
const mockListProjects = jest.fn();
const mockWrapOuterLayer = jest.fn();
const mockCreateInvite = jest.fn();
const mockInviteToProject = jest.fn();
const mockCoDecrypt = jest.fn();

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
    getOrgMe: mockGetOrgMe,
    listMemberDetails: mockListMemberDetails,
    listProjects: mockListProjects,
    wrapOuterLayer: mockWrapOuterLayer,
    createInvite: mockCreateInvite,
    inviteToProject: mockInviteToProject,
    coDecrypt: mockCoDecrypt,
  })),
}));

// The org key. Real crypto runs on top of it, so the redeem code these tests
// look for is a real one built the way a real run builds it.
//
// Both modules keep everything they already export: `mock.module` is
// process-wide, and a factory that returns only the one function under test
// silently empties the module for every other file in the same run. This file
// is in run-tests.sh's isolated list for the same reason, belt and braces.
const realGlobalConfig = await import('../../src/config/globalConfig');
mock.module('../../src/config/globalConfig', () => ({
  ...realGlobalConfig,
  hasOrgKey: () => true,
}));
const realKeyResolver = await import('../../src/crypto/keyResolver');
mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  unwrapMasterKey: async () => Buffer.alloc(32, 7),
}));

const mockPromptFn = jest.fn();
mock.module('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPromptFn },
  prompt: mockPromptFn,
}));

// The terminal project checkbox (CAP-700) is its own prompt, not an inquirer
// question — stubbed so the test can see what it was asked and answer it.
const mockSearchableCheckbox = jest.fn();
mock.module('../../src/ui/searchableCheckbox', () => ({
  searchableCheckbox: mockSearchableCheckbox,
}));

afterAll(() => {
  mock.restore();
});

import { InviteCommand } from '../../src/commands/inviteCommand';

/** Everything the command wrote, in the order a caller's shell would see it. */
function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return {
    out: () => buf,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

describe('InviteCommand', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123' });
    mockAuthenticateSilent.mockResolvedValue({
      success: true,
      user_id: 'u-mike',
      user_email: 'mike@example.com',
      organization_name: 'mikes-market',
      organizations: [{ id: 'org-123' }],
    });
    mockAuthenticate.mockResolvedValue({ success: true, user_id: 'u-mike' });
    mockGetToken.mockReturnValue({ access_token: 'tok' });
    mockGetOrgMe.mockResolvedValue({ role: 'owner', user_id: 'u-mike', admin_projects: [] });
    mockListMemberDetails.mockResolvedValue({ members: [] });
    mockListProjects.mockResolvedValue([
      { id: 'p1', name: 'storefront' },
      { id: 'p2', name: 'warehouse' },
    ]);
    mockWrapOuterLayer.mockResolvedValue({ ciphertext: 'outer-blob' });
    mockCreateInvite.mockResolvedValue({ id: 'inv-1' });
    mockInviteToProject.mockResolvedValue(undefined);
  });

  describe('the redeem code', () => {
    test('--json puts the code on stdout, because it was asked for', async () => {
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          json: true,
          role: 'admin',
          ttl: '6h',
        });
      } finally {
        cap.restore();
      }
      const parsed = JSON.parse(cap.out());
      expect(parsed.redeemCommand).toMatch(/^capy redeem /);
      expect(parsed.redeemCode.length).toBeGreaterThan(40);
    });

    test('without --json the code is printed for the caller to send', async () => {
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          role: 'admin',
          ttl: '6h',
          nonTty: true,
        });
      } finally {
        cap.restore();
      }
      // `capy` is bold on this path, so the two words are not adjacent bytes.
      expect(cap.out()).toMatch(/redeem [A-Za-z0-9_\-+/=]{20,}/);
    });

    test('a lifetime argv gave sets the expiry and is named on the rail', async () => {
      const cap = captureOutput();
      const before = Date.now();
      try {
        await new InviteCommand().execute('bob@example.com', { json: true, role: 'admin', ttl: '6h' });
      } finally {
        cap.restore();
      }

      const parsed = JSON.parse(cap.out());
      const lifetimeMs = Date.parse(parsed.expiresAt) - before;
      expect(lifetimeMs).toBeGreaterThan(5 * 60 * 60 * 1000);
      expect(lifetimeMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000 + 5_000);
      expect(parsed.stops.find((s: any) => s.id === 'expiry').flag).toBe('--ttl 6h');
    });

    test('a project flag reaches the invite', async () => {
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          role: 'member',
          projects: ['warehouse'],
          nonTty: true,
          json: true,
        });
      } finally {
        cap.restore();
      }

      expect(mockCreateInvite).toHaveBeenCalledWith('org-123', 'bob@example.com', 'member', 'p2');
    });
  });

  describe('the rail describes the run that happened', () => {
    test('a re-issue that asked nothing reports nothing outstanding', async () => {
      // `capy invite <existing member>` with no --role takes the pure re-issue
      // branch: nothing is asked and the default lifetime is used. The rail
      // used to carry `expiry · current` on a run that had already minted the
      // code — a stop whose state does not describe what the run did.
      mockListMemberDetails.mockResolvedValue({
        members: [
          {
            membershipId: 'mem-bob',
            userId: 'u-bob',
            email: 'bob@example.com',
            role: 'member',
            status: 'active',
            projects: [{ id: 'p1', name: 'storefront' }],
          },
        ],
      });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { json: true });
      } finally {
        cap.restore();
      }

      const { stops } = JSON.parse(cap.out());
      expect(stops.map((s: any) => [s.id, s.state])).toEqual([
        ['role', 'done'],
        ['projects', 'done'],
        ['expiry', 'done'],
        ['code', 'current'],
      ]);
      // And it names what settled the lifetime nobody was asked about.
      expect(stops.find((s: any) => s.id === 'expiry').flag).toBe('default');
    });

    test('a project the service refused is not reported as one this invite granted', async () => {
      // The fan-out is per project and can fail one at a time. A rail that
      // lists a refused project as granted is a rail arguing with the failure
      // printed underneath it.
      mockInviteToProject.mockRejectedValue(new Error('503 from the service'));

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          json: true,
          role: 'member',
          projects: ['p1', 'p2'],
          nonTty: true,
        });
      } finally {
        cap.restore();
      }

      const parsed = JSON.parse(cap.out());
      const projects = parsed.stops.find((s: any) => s.id === 'projects');
      expect(projects.answer).toBe('p1');
      expect(projects.answer).not.toContain('p2');
      expect(projects.detail).toContain('p2');
      expect(parsed.projectAssignmentFailures).toHaveLength(1);
    });

    test('an answer an argv flag gave names the flag', async () => {
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          json: true,
          role: 'admin',
          ttl: '6h',
        });
      } finally {
        cap.restore();
      }
      const flagged = Object.fromEntries(JSON.parse(cap.out()).stops.map((s: any) => [s.id, s]));
      expect(flagged.role.flag).toBe('--role admin');
      expect(flagged.expiry.flag).toBe('--ttl 6h');
    });
  });

  test('a role this caller cannot grant is refused before anything is minted', async () => {
    mockGetOrgMe.mockResolvedValue({ role: 'project-admin', user_id: 'u-mike', admin_projects: ['p1'] });

    const cap = captureOutput();
    try {
      await expect(
        new InviteCommand().execute('bob@example.com', { role: 'admin', nonTty: true }),
      ).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });

  describe('the interactive project checkbox is searchable (CAP-700)', () => {
    const planInput = {} as any;
    const askProjects = (opts: Record<string, unknown>, interactive: boolean) =>
      (new InviteCommand() as any).resolveInviteeProjects(
        'member',
        opts,
        { listProjects: mockListProjects },
        interactive,
        false,
        [],
        planInput,
      );

    test('asks the searchable checkbox with the same message, in project order, nothing pre-ticked without a cwd project', async () => {
      mockSearchableCheckbox.mockResolvedValue(['p2']);
      const result = await askProjects({}, true);
      expect(mockSearchableCheckbox).toHaveBeenCalledTimes(1);
      const config = mockSearchableCheckbox.mock.calls[0][0] as any;
      expect(config.message).toBe('Grant Member access to which projects?');
      expect(config.choices).toEqual([
        { name: 'storefront', value: 'p1', checked: false },
        { name: 'warehouse', value: 'p2', checked: false },
      ]);
      expect(result).toEqual({ projectId: 'p2', extraProjectIds: [], projectSource: undefined });
    });

    test('the cwd project is listed first and pre-ticked', async () => {
      mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123', projectId: 'p2' });
      mockSearchableCheckbox.mockResolvedValue(['p2', 'p1']);
      const result = await askProjects({}, true);
      const config = mockSearchableCheckbox.mock.calls[0][0] as any;
      expect(config.choices.map((c: any) => [c.value, c.checked])).toEqual([['p2', true], ['p1', false]]);
      expect(result).toEqual({ projectId: 'p2', extraProjectIds: ['p1'], projectSource: undefined });
    });

    test('still refuses an empty selection', async () => {
      mockSearchableCheckbox.mockResolvedValue(['p1']);
      await askProjects({}, true);
      const config = mockSearchableCheckbox.mock.calls[0][0] as any;
      expect(config.validate([])).toBe('Pick at least one project');
      expect(config.validate(['p1'])).toBe(true);
    });

    test('--project and non-interactive runs never open the picker', async () => {
      const byFlag = await askProjects({ projects: ['warehouse'] }, true);
      expect(byFlag.projectId).toBe('p2');
      mockDetectProjectState.mockResolvedValue({ initialized: true, organizationId: 'org-123', projectId: 'p1' });
      const piped = await askProjects({}, false);
      expect(piped.projectId).toBe('p1');
      expect(mockSearchableCheckbox).not.toHaveBeenCalled();
    });
  });
});
