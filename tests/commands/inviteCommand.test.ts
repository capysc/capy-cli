/**
 * `capy invite`, at the command level.
 *
 * WHAT THIS FILE IS FOR, in order of what would hurt most if it broke:
 *
 *   1. THE REDEEM CODE STOPS BEING PRINTED UNDER `--web`. It carries a
 *      double-wrapped copy of the organization key: whoever holds it can join
 *      the org until it expires. `--web` is agent-only and an agent shelling
 *      `capy` reads stdout, so under it the code goes to a page and NOWHERE
 *      else — not stdout, not stderr, not the clipboard prompt. That is the
 *      load-bearing claim of this whole path and it was pinned by nothing:
 *      code reading confirmed it held, and one refactor would have moved the
 *      `console.log` out of its `else` branch with no test to notice.
 *   2. THE PAGE IS STILL THERE WHEN THE COMMAND RETURNS. A URL printed for a
 *      server that has already been torn down is worse than no page at all —
 *      the code is unreachable and unrecoverable. So the page is fetched AFTER
 *      `execute()` has resolved, the way a human opening the printed link does.
 *   3. A CANCELLED BROWSER MINTS NOTHING. Everything past the browser hands
 *      somebody a copy of the org key.
 *   4. The rail `--json` prints describes the run that happened.
 *
 * The browser itself is driven in tests/ui/browserFlow.e2e.test.ts. Here the
 * question wizard is stubbed and the CODE PAGE IS REAL, because the code page
 * is where the invariant above lives.
 *
 * NEVER remove `CAPY_WEB_NO_OPEN`. Without it these tests open the developer's
 * real browser.
 */
import { mock, spyOn, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';

process.env.CAPY_WEB_NO_OPEN = '1';

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

// The question wizard is stubbed; the code page is not. `serveInviteCode` is
// the real one, on a real loopback server, because "the code is on the page and
// not on stdout" cannot be checked against a stub of the page.
const real = await import('../../src/ui/memberScreens');
const mockAskInBrowser = jest.fn();
mock.module('../../src/ui/memberScreens', () => ({
  ...real,
  askInviteInBrowser: mockAskInBrowser,
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

/** The loopback URL the `--web` run prints for its code page. */
const pageUrlIn = (output: string): string =>
  output.match(/http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+/)?.[0] ?? '';

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

  describe('--web keeps the redeem code off stdout', () => {
    test('the code is on the page, the page is reachable, and neither stream holds it', async () => {
      mockAskInBrowser.mockResolvedValue({
        role: 'member',
        projectIds: ['p1'],
        ttl: '24h',
        cancelled: false,
      });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true });
      } finally {
        cap.restore();
      }
      const output = cap.out();

      // The command has RETURNED. The page has to survive that — a URL printed
      // for a server already torn down hands the user nothing.
      const url = pageUrlIn(output);
      expect(url, `no code-page URL in output:\n${output}`).not.toBe('');
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const html = await res.text();

      // The code, read off the page the way the browser reads it.
      const redeem = html.match(/capy redeem [A-Za-z0-9_\-+/=]+/)?.[0] ?? '';
      expect(redeem, 'the page carries no redeem command').not.toBe('');
      expect(redeem.length).toBeGreaterThan('capy redeem '.length + 40);

      // …and nowhere in what the caller — an agent reading stdout — was given.
      expect(output).not.toContain(redeem);
      expect(output).not.toContain(redeem.slice('capy redeem '.length));
      expect(output).not.toMatch(/redeem [A-Za-z0-9_\-+/=]{20,}/);
      // The clipboard prompt is a second copy of the same credential.
      expect(mockPromptFn).not.toHaveBeenCalled();
      // What it DOES say: where the code is, and that this is deliberate.
      expect(output).toContain('deliberately not printed here');
    });

    test('--json still puts the code on stdout, because it was asked for', async () => {
      // A caller that explicitly asks for the code in a machine-readable form
      // gets it. `--web` is the flag that means "there is a browser to hand it
      // to"; `--json` is the one that means "I am the one who needs it".
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          json: true,
          role: 'admin',
          ttl: '24h',
        });
      } finally {
        cap.restore();
      }
      const parsed = JSON.parse(cap.out());
      expect(parsed.redeemCommand).toMatch(/^capy redeem /);
      expect(parsed.redeemCode.length).toBeGreaterThan(40);
    });

    test('without --web the code is printed, which is what --web exists to stop', async () => {
      // The control for the test above: same command, no flag, and the code is
      // right there on stdout. Without this the leak test could pass because
      // nothing was minted at all.
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          role: 'admin',
          ttl: '24h',
          nonTty: true,
        });
      } finally {
        cap.restore();
      }
      // `capy` is bold on this path, so the two words are not adjacent bytes.
      expect(cap.out()).toMatch(/redeem [A-Za-z0-9_\-+/=]{20,}/);
    });
  });

  describe('the browser is asked, and its answer is the run', () => {
    test('cancelling mints nothing and says so', async () => {
      mockAskInBrowser.mockResolvedValue({ role: '', projectIds: [], cancelled: true });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true });
      } finally {
        cap.restore();
      }

      expect(cap.out()).toContain('No invite created.');
      // Everything past the browser hands somebody a copy of the org key.
      expect(mockCreateInvite).not.toHaveBeenCalled();
      expect(mockWrapOuterLayer).not.toHaveBeenCalled();
      expect(pageUrlIn(cap.out())).toBe('');
    });

    test('the page is told what the code is bound to, not what argv typed', async () => {
      // `innerWrap` lowercases into the HKDF salt, so `Bob@Example.com` mints a
      // code bound to `bob@example.com`. The screen draws "The address was
      // cleaned up" from the two together — and could not, while the producer
      // set neither.
      mockAskInBrowser.mockResolvedValue({ role: 'admin', projectIds: [], cancelled: false });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('Bob@Example.com', { web: true });
      } finally {
        cap.restore();
      }

      const params = mockAskInBrowser.mock.calls[0][0];
      expect(params.email).toBe('bob@example.com');
      expect(params.rawEmail).toBe('Bob@Example.com');
    });

    test('a project flag that settled the stop still reaches the invite', async () => {
      // `--project` settles the projects stop, so the browser never serves it
      // and its answer comes back empty. Read as "no projects", this run grants
      // nothing and reports success.
      mockAskInBrowser.mockResolvedValue({ role: 'member', projectIds: [], ttl: '7d', cancelled: false });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true, projects: ['warehouse'] });
      } finally {
        cap.restore();
      }

      expect(mockCreateInvite).toHaveBeenCalledWith('org-123', 'bob@example.com', 'member', 'p2');
    });

    test('a lifetime argv gave outranks one the browser offered', async () => {
      // The bound on the one divergence `--web` introduces. The browser asks
      // about expiry and the terminal never does, so `capy invite bob` and
      // `capy invite bob --web` can mint different lifetimes — but only where
      // argv left the lifetime unspecified. Name it on the command line and
      // both paths mint the same invite, because §8.2's precedence puts an
      // explicit flag above a control the same run put on screen.
      mockAskInBrowser.mockResolvedValue({
        role: 'member',
        projectIds: ['p1'],
        ttl: '30m',
        cancelled: false,
      });

      const cap = captureOutput();
      const before = Date.now();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true, json: true, ttl: '24h' });
      } finally {
        cap.restore();
      }

      const parsed = JSON.parse(cap.out());
      const lifetimeMs = Date.parse(parsed.expiresAt) - before;
      expect(lifetimeMs).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(lifetimeMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
      expect(parsed.stops.find((s: any) => s.id === 'expiry').flag).toBe('--ttl 24h');
    });

    test('never opens the developer\'s real browser when CAPY_WEB_NO_OPEN is set', async () => {
      mockAskInBrowser.mockResolvedValue({ role: 'admin', projectIds: [], cancelled: false });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true });
      } finally {
        cap.restore();
      }

      expect(mockAskInBrowser.mock.calls[0][0].open).toBe(false);
    });

    test('a run every flag already answered opens no browser at all', async () => {
      // `--web` is where a question gets asked, not a page that must be opened.
      // Nothing is outstanding here, so nothing is served but the code.
      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          web: true,
          role: 'admin',
          ttl: '24h',
        });
      } finally {
        cap.restore();
      }

      expect(mockAskInBrowser).not.toHaveBeenCalled();
      expect(pageUrlIn(cap.out())).not.toBe('');
    });
  });

  describe('the rail describes the run that happened', () => {
    test('a re-issue that asked nothing reports nothing outstanding', async () => {
      // `capy invite <existing member> --web` with no --role takes the pure
      // re-issue branch: no browser opens and the default lifetime is used. The
      // rail used to carry `expiry · current` on a run that had already minted
      // the code — a stop whose state does not describe what the run did.
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
        await new InviteCommand().execute('bob@example.com', { web: true, json: true });
      } finally {
        cap.restore();
      }

      const { stops } = JSON.parse(cap.out());
      expect(mockAskInBrowser).not.toHaveBeenCalled();
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
      mockAskInBrowser.mockResolvedValue({
        role: 'member',
        projectIds: ['p1', 'p2'],
        ttl: '24h',
        cancelled: false,
      });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true, json: true });
      } finally {
        cap.restore();
      }

      const parsed = JSON.parse(cap.out());
      const projects = parsed.stops.find((s: any) => s.id === 'projects');
      expect(projects.answer).toBe('storefront');
      expect(projects.answer).not.toContain('warehouse');
      expect(projects.detail).toContain('warehouse');
      expect(parsed.projectAssignmentFailures).toHaveLength(1);
    });

    test('an answer given in the browser carries no flag, and one argv gave does', async () => {
      mockAskInBrowser.mockResolvedValue({
        role: 'member',
        projectIds: ['p1'],
        ttl: '30m',
        cancelled: false,
      });

      const cap = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', { web: true, json: true });
      } finally {
        cap.restore();
      }

      const { stops } = JSON.parse(cap.out());
      const byId = Object.fromEntries(stops.map((s: any) => [s.id, s]));
      expect(byId.role.flag).toBeUndefined();
      expect(byId.role.answer).toBe('member');
      expect(byId.expiry.answer).toBe('30m');
      expect(byId.expiry.flag).toBeUndefined();

      const cap2 = captureOutput();
      try {
        await new InviteCommand().execute('bob@example.com', {
          web: true,
          json: true,
          role: 'admin',
          ttl: '24h',
        });
      } finally {
        cap2.restore();
      }
      const flagged = Object.fromEntries(
        JSON.parse(cap2.out()).stops.map((s: any) => [s.id, s]),
      );
      expect(flagged.role.flag).toBe('--role admin');
      expect(flagged.expiry.flag).toBe('--ttl 24h');
    });
  });

  test('a role this caller cannot grant is refused before a browser opens', async () => {
    mockGetOrgMe.mockResolvedValue({ role: 'project-admin', user_id: 'u-mike', admin_projects: ['p1'] });

    const cap = captureOutput();
    try {
      await expect(
        new InviteCommand().execute('bob@example.com', { web: true, role: 'admin' }),
      ).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockAskInBrowser).not.toHaveBeenCalled();
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });
});
