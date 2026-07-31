/**
 * `capy invite` and `capy kick`, served as compiled screens.
 *
 * What these pin, in rough order of what would hurt most if it broke:
 *
 *   - the redeem code goes CLI → page and never back. It is the one piece of
 *     recovery-equivalent material in this parcel, and the whole reason `--web`
 *     stops printing it: an agent shelling `capy` reads stdout.
 *   - a submit the screen could not have produced is refused inline rather
 *     than applied. Guessing here grants somebody access to secrets.
 *   - the rail is `invitePlan`'s array, not one this file rebuilt.
 *   - the removal confirm is about the member the CLI resolved, and nothing
 *     else the screen can express reaches a DELETE.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildInviteData,
  buildKickData,
  askInviteInBrowser,
  confirmKickInBrowser,
  serveInviteCode,
  type WebInviteParams,
  type WebKickParams,
} from '../../src/ui/memberScreens';
import { invitePlan } from '../../src/core/invitePlan';
import { SCREEN_CSP } from '../../src/ui/screens/serve';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const NOW = new Date('2026-07-30T00:00:00Z');

const INVITE: WebInviteParams = {
  email: 'bob@example.com',
  orgName: 'mikes-market',
  callerEmail: 'mike@example.com',
  callerRole: 'owner',
  grantableRoles: ['member', 'project-admin', 'admin'],
  projects: [
    { id: 'p1', name: 'storefront', isCwd: true },
    { id: 'p2', name: 'warehouse', isCwd: false },
  ],
  plan: { defaultTtl: '7d', canAskExpiry: true },
  open: false,
  now: NOW,
};

const ISSUED = {
  redeemCommand: 'capy redeem AgSECRETREDEEMCODE0001',
  expiresAtIso: '2026-08-06T00:00:00.000Z',
  expiresRelative: 'in 7 days',
  role: 'member',
  reissued: false,
  grantedProjects: [{ id: 'p1', name: 'storefront' }],
  assignmentFailures: [],
};

describe('buildInviteData', () => {
  test('the rail is invitePlan\'s array, not a second one built for the page', () => {
    const d = buildInviteData(INVITE, 'n');
    expect(d.stops).toEqual(invitePlan(INVITE.plan));
  });

  test('the browser\'s own answers move the rail forward without inventing a flag', () => {
    const d = buildInviteData(INVITE, 'n', { role: 'member', projectIds: ['p1', 'p2'] });
    expect(d.stops[0]).toMatchObject({ id: 'role', state: 'done', answer: 'member' });
    expect(d.stops[0].flag).toBeUndefined();
    expect(d.stops[1]).toMatchObject({ state: 'done', answer: 'storefront, warehouse' });
    expect(d.stops[2].state).toBe('current');
    expect(d.step).toBe('expiry');
  });

  test('choosing an org-wide role in the browser skips the project stop', () => {
    const d = buildInviteData(INVITE, 'n', { role: 'admin' });
    expect(d.stops[1].state).toBe('skipped');
    expect(d.step).toBe('expiry');
  });

  test('the role list is the caller\'s grantable set, with what each one reaches', () => {
    const d = buildInviteData({ ...INVITE, grantableRoles: ['member', 'project-admin'] }, 'n');
    expect(d.grantableRoles.map((r) => r.value)).toEqual(['member', 'project-admin']);
    // The slug, not `Member` / `Project Admin`: the picker's display labels
    // cannot be pasted into the `--role` flag they belong to.
    expect(d.grantableRoles.every((r) => r.note.length > 0)).toBe(true);
    expect(d.grantableRoles.find((r) => r.value === 'member')!.needsProjects).toBe(true);
    // The CLI's own `default: 'member'`, carried rather than restated.
    expect(d.defaultRole).toBe('member');
  });

  test('admin is the one role that needs no projects', () => {
    const d = buildInviteData(INVITE, 'n');
    expect(d.grantableRoles.find((r) => r.value === 'admin')!.needsProjects).toBe(false);
  });

  test('the cwd project keeps the CLI\'s sort and its tick, and says why', () => {
    const d = buildInviteData(INVITE, 'n');
    expect(d.projects[0].isCwd).toBe(true);
    expect(d.projects.map((p) => p.name)).toEqual(['storefront', 'warehouse']);
  });

  test('the presets are the --ttl flag\'s own documented lifetimes', () => {
    const d = buildInviteData(INVITE, 'n');
    expect(d.expiry.presets.map((p) => p.ttl)).toEqual(['30m', '24h', '7d']);
    // Resolved by the CLI, not by the page: the same computation that will
    // bind `notAfter` into the KMS wrap.
    expect(d.expiry.presets[2].expiresAtIso).toBe('2026-08-06T00:00:00.000Z');
    expect(d.expiry.presets[2].relative).toBe('in 7 days');
    // The ceiling that clamps a longer invite and tells nobody.
    expect(d.expiry.serverCapDays).toBe(30);
  });

  test('an environment override is named rather than applied in silence', () => {
    const d = buildInviteData(
      { ...INVITE, plan: { defaultTtl: '1h', envTtl: '1h', canAskExpiry: true } },
      'n',
    );
    expect(d.expiry.envOverrideTtl).toBe('1h');
    expect(d.expiry.defaultTtl).toBe('1h');
  });

  test('an address argv changed is shown beside the one argv typed', () => {
    // The untrimmed address is baked into the HKDF salt, so ` bob@x.com` mints
    // a code nobody can ever redeem — and that only surfaces days later.
    const d = buildInviteData({ ...INVITE, rawEmail: ' Bob@Example.com ' }, 'n');
    expect(d.rawInviteeEmail).toBe(' Bob@Example.com ');
    expect(d.inviteeEmail).toBe('bob@example.com');
    // Unchanged means nothing to show.
    expect(buildInviteData({ ...INVITE, rawEmail: 'bob@example.com' }, 'n').rawInviteeEmail).toBeUndefined();
  });

  test('an existing membership travels with the status the CLI throws away', () => {
    const d = buildInviteData(
      { ...INVITE, existing: { role: 'member', status: 'invited', projects: [{ id: 'p1', name: 'storefront' }] } },
      'n',
    );
    expect(d.existing).toEqual({
      role: 'member',
      status: 'invited',
      projects: [{ id: 'p1', name: 'storefront' }],
    });
    // Their current projects open the picker, so a re-issue does not silently
    // narrow what they already hold.
    expect(d.resolved!.projectIds).toEqual(['p1']);
  });

  test('strips the terminal colour codes off anything the CLI also prints', () => {
    const d = buildInviteData(
      {
        ...INVITE,
        orgName: '\x1b[1mmikes-market\x1b[0m',
        projects: [{ id: 'p1', name: '\x1b[90mstorefront\x1b[0m', isCwd: false }],
      },
      'n',
    );
    expect(d.orgName).toBe('mikes-market');
    expect(d.projects[0].name).toBe('storefront');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('no invite payload carries key material until there is a code to carry', () => {
    // The question steps are asked before anything is minted, so there is
    // nothing secret to leak yet — and nothing that looks like it.
    for (const answered of [{}, { role: 'member' }, { role: 'member', projectIds: ['p1'] }]) {
      const json = JSON.stringify(buildInviteData(INVITE, 'n', answered));
      expect(json).not.toContain('capy redeem');
      expect(json).not.toContain('AgSECRET');
    }
  });

  test('the code page carries the code, and only the code page does', () => {
    const d = buildInviteData(INVITE, 'display-only', { role: 'member', projectIds: ['p1'] }, ISSUED);
    expect(d.step).toBe('code');
    expect(d.issued!.redeemCommand).toBe(ISSUED.redeemCommand);
    // Named projects, so "which projects did this grant" is answerable from
    // the page rather than from a list of uuids.
    expect(d.issued!.grantedProjects).toEqual([{ id: 'p1', name: 'storefront' }]);
  });

  test('a minted code closes the route: nothing is left outstanding', () => {
    // The expiry stop is a question only while there is somewhere to ask it. On
    // the code page the lifetime is already bound into the KMS wrap, so a stop
    // sitting at `current` would be describing a question this run never had.
    const d = buildInviteData(INVITE, 'display-only', { role: 'member', projectIds: ['p1'] }, ISSUED);
    const byId = Object.fromEntries(d.stops.map((s) => [s.id, s]));
    expect(byId.expiry.state).toBe('done');
    expect(byId.expiry.answer).toBe('7d');
    expect(byId.expiry.flag).toBe('default');
    expect(d.stops.filter((s) => s.state === 'upcoming').map((s) => s.id)).toEqual([]);
  });

  test('the service\'s own prose reaches the code page as words, not escapes', () => {
    // The receipt carries two things the CLI also PRINTS: the projects granted
    // and the service's message for each one it could not assign. A payload is
    // not a terminal.
    const d = buildInviteData(INVITE, 'display-only', { role: 'member' }, {
      ...ISSUED,
      grantedProjects: [{ id: 'p1', name: '\x1b[90mstorefront\x1b[0m' }],
      assignmentFailures: [
        { project: { id: 'p2', name: '\x1b[90mwarehouse\x1b[0m' }, error: '\x1b[31m503\x1b[0m' },
      ],
    });
    expect(d.issued!.grantedProjects).toEqual([{ id: 'p1', name: 'storefront' }]);
    expect(d.issued!.assignmentFailures).toEqual([
      { project: { id: 'p2', name: 'warehouse' }, error: '503' },
    ]);
    expect(JSON.stringify(d)).not.toContain('\x1b');
    // The code itself is untouched: it is not prose and every byte matters.
    expect(d.issued!.redeemCommand).toBe(ISSUED.redeemCommand);
  });

  test('both escapes are offered, and the code stop\'s one is a warning', () => {
    const d = buildInviteData(INVITE, 'n');
    expect(d.nonTty!.questions.command).toContain('--role');
    expect(d.nonTty!.questions.command).toContain('--project');
    expect(d.nonTty!.reveal.command).toBe('capy invite bob@example.com --json');
    expect(d.nonTty!.reveal.why).toContain('bearer credential');
  });
});

describe('askInviteInBrowser', () => {
  test('walks role, projects and expiry, and hands back what was answered', async () => {
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('bob@example.com');
    expect(page).not.toContain('id="screen"');

    const submit = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'submit', ...payload } }),
      });

    expect((await (await submit({ step: 'role', role: 'member' })).json()).next).toBe(true);
    expect((await (await submit({ step: 'projects', projectIds: ['p1', 'p2'] })).json()).next).toBe(true);
    await submit({ step: 'expiry', ttl: '24h' });

    expect(await done).toEqual({
      role: 'member',
      projectIds: ['p1', 'p2'],
      ttl: '24h',
      cancelled: false,
    });
  });

  test('an org-wide role never reaches the projects step', async () => {
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const submit = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'submit', ...payload } }),
      });

    await submit({ step: 'role', role: 'admin' });
    await submit({ step: 'expiry', ttl: '30m' });

    expect(await done).toEqual({ role: 'admin', projectIds: [], ttl: '30m', cancelled: false });
  });

  test('a role this caller cannot grant is refused, not minted', async () => {
    // The screen offers only the grantable set, so `owner` could not have come
    // from it — and the refusal is the CLI's own sentence for the same case.
    let url = '';
    let settled = false;
    const done = askInviteInBrowser({
      ...INVITE,
      grantableRoles: ['member', 'project-admin'],
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', step: 'role', role: 'admin' } }),
    });
    // Inline refusal: 200 with an error keeps the user on the step.
    expect(res.status).toBe(200);
    expect((await res.json()).error).toContain("can't grant");
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('a project outside this organization is refused, not granted', async () => {
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const submit = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'submit', ...payload } }),
      });

    await submit({ step: 'role', role: 'member' });
    const bad = await submit({ step: 'projects', projectIds: ['p1', 'p9'] });
    expect((await bad.json()).error).toContain('not in this organization');

    // Answering with a real one finishes the step.
    expect((await (await submit({ step: 'projects', projectIds: ['p1'] })).json()).next).toBe(true);
    await submit({ step: 'expiry', ttl: '7d' });
    expect((await done).projectIds).toEqual(['p1']);
  });

  test('an empty project set is refused in the CLI\'s own words', async () => {
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, timeoutMs: 4_000, onListen: (u) => (url = u) });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const submit = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'submit', ...payload } }),
      });

    await submit({ step: 'role', role: 'member' });
    const res = await submit({ step: 'projects', projectIds: [] });
    // Verbatim the terminal checkbox's own validator message.
    expect((await res.json()).error).toBe('Pick at least one project');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done.catch(() => undefined);
  });

  test('a lifetime --ttl could not parse is refused with --ttl\'s own sentence', async () => {
    let url = '';
    const done = askInviteInBrowser({
      ...INVITE,
      plan: { defaultTtl: '7d', canAskExpiry: true, role: { value: 'admin', flag: '--role admin' } },
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', step: 'expiry', ttl: 'forever' } }),
    });
    expect((await res.json()).error).toContain('Use e.g. 30m, 24h, 7d');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done.catch(() => undefined);
  });

  test('cancelling mints nothing and says so', async () => {
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });

    expect(await done).toEqual({ role: '', projectIds: [], cancelled: true });
  });
});

describe('serveInviteCode', () => {
  test('the code renders in the page and the page cannot send it anywhere', async () => {
    const page = await serveInviteCode(INVITE, ISSUED, { role: 'member', projectIds: ['p1'] }, { open: false });
    const res = await fetch(page.url);
    const html = await res.text();

    expect(html).toContain(ISSUED.redeemCommand);
    // The display-only policy: no remote origins, no eval, and — the load
    // bearing line — no socket at all, so the one document in this flow that
    // holds key material has no way to speak.
    expect(res.headers.get('content-security-policy')).toBe(SCREEN_CSP);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    // Single use: the token is spent, so a code cannot be re-read out of a URL
    // that ends up in a shell history or a browser's session restore.
    expect((await fetch(page.url)).status).toBe(404);
    page.close();
  });

  test('it binds the loopback only, and refuses a wrong token', async () => {
    const page = await serveInviteCode(INVITE, ISSUED, {}, { open: false });
    const u = new URL(page.url);
    expect(u.hostname).toBe('127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${u.port}/s/not-the-token`)).status).toBe(404);
    page.close();
  });
});

// ---------------------------------------------------------------------------
// kick
// ---------------------------------------------------------------------------

const KICK: WebKickParams = {
  orgName: 'mikes-market',
  callerRole: 'owner',
  currentUserId: 'u-mike',
  member: {
    membershipId: 'mem-bob-2',
    userId: 'u-bob',
    email: 'bob@example.com',
    role: 'member',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    projects: [{ id: 'p1', name: 'storefront', role: 'member' }],
  },
  open: false,
};

describe('buildKickData', () => {
  test('opens on the removal confirm, about the member the CLI resolved', () => {
    const d = buildKickData(KICK, 'n');
    expect(d.view).toBe('confirm-remove');
    expect(d.subjectUserId).toBe('u-bob');
    expect(d.members).toHaveLength(1);
    expect(d.members[0]).toMatchObject({ membershipId: 'mem-bob-2', email: 'bob@example.com' });
  });

  test('an unredeemed invite is a pending member, not a blank badge', () => {
    // The service says `invited`; the screen's vocabulary is `pending`. Passed
    // through unmapped, the badge disappears — which is exactly how an issued
    // -but-unredeemed invite is invisible in every terminal surface today.
    const d = buildKickData({ ...KICK, member: { ...KICK.member, status: 'invited' } }, 'n');
    expect(d.members[0].status).toBe('pending');
    expect(buildKickData(KICK, 'n').members[0].status).toBe('active');
  });

  test('an org-wide role is marked as reaching everything', () => {
    // What the confirm reads out as "loses access to every project in this
    // organization" rather than counting rows that are not the whole story.
    const d = buildKickData({ ...KICK, member: { ...KICK.member, role: 'admin' } }, 'n');
    expect(d.members[0].hasAllAccess).toBe(true);
    expect(buildKickData(KICK, 'n').members[0].hasAllAccess).toBe(false);
  });

  test('this run assigns no roles, and draws no branch toggles', () => {
    // `capy kick` holds one DELETE. Shipping a role matrix or a grant list
    // would draw controls it could only refuse.
    const d = buildKickData(KICK, 'n');
    expect(d.assignableRoles).toEqual([]);
    expect(d.allProjects).toEqual([]);
    expect(d.members[0].projects[0].branches).toEqual([]);
  });

  test('strips the terminal colour codes off anything the CLI also prints', () => {
    const d = buildKickData({ ...KICK, orgName: '\x1b[1mmikes-market\x1b[0m' }, 'n');
    expect(d.orgName).toBe('mikes-market');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('nothing about a member is key material, and none of it is invented', () => {
    const json = JSON.stringify(buildKickData(KICK, 'n'));
    expect(json).not.toContain('capy redeem');
    // Emails and project names are PII and identifiers, not secrets — but they
    // stay on the loopback page rather than going back to whatever opened it.
    expect(json).toContain('bob@example.com');
  });
});

describe('confirmKickInBrowser', () => {
  test('the document carries the decline this screen cannot send by itself', async () => {
    // `confirm-remove`'s decline — the answer the terminal DEFAULTS to — flips
    // the view client-side and tells the CLI nothing, so the served document
    // gets a bridge that reports it. Driven for real in browserFlow.e2e; what
    // is checked here is that it ships with the page and addresses its cancel
    // with this run's own single-use nonce.
    let url = '';
    const done = confirmKickInBrowser({ ...KICK, timeoutMs: 3_000, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const page = await (await fetch(u.href)).text();
    expect(page).toContain("__action: 'cancel'");
    expect(page).toContain(nonce);
    // Inside the document, not appended past it.
    expect(page.lastIndexOf("__action: 'cancel'")).toBeLessThan(page.lastIndexOf('</body>'));

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });

  test('an explicit removal of this member is the only thing that returns true', async () => {
    let url = '';
    const done = confirmKickInBrowser({ ...KICK, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('bob@example.com');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { action: 'remove', membershipId: 'mem-bob-2' } }),
    });

    expect(await done).toBe(true);
  });

  test('a removal aimed at a different membership is refused', async () => {
    // The id in this payload is what a DELETE is about to be pointed at, so it
    // is resolved against the membership the CLI found rather than trusted.
    let url = '';
    let settled = false;
    const done = confirmKickInBrowser({ ...KICK, timeoutMs: 4_000, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { action: 'remove', membershipId: 'mem-someone-else' } }),
    });
    expect((await res.json()).error).toContain('not the member this command is about');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });

  test('a queued batch of role edits is refused and pointed at capy users', async () => {
    // The screen's list view can express role and grant changes. `capy kick`
    // cannot apply one, and answering ok would report changes it never made.
    let url = '';
    const done = confirmKickInBrowser({ ...KICK, timeoutMs: 4_000, onListen: (u) => (url = u) });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: {
          __action: 'apply',
          edits: [{ id: 'e1', kind: 'org-role', userId: 'u-bob', email: 'bob@example.com', from: 'member', to: 'admin' }],
        },
      }),
    });
    expect((await res.json()).error).toContain('capy users');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });

  test('cancelling removes nobody', async () => {
    let url = '';
    const done = confirmKickInBrowser({ ...KICK, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });

    expect(await done).toBe(false);
  });
});
