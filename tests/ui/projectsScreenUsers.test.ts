import { describe, expect, mock, test } from 'bun:test';
import type { MemberDetail } from '../../src/service/serviceClient';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyUsersDone,
  handleKey,
  initialProjectsScreenState,
} from '../../src/ui/projectsScreen';
import { createProjectUsersActions } from '../../src/commands/projectUsersActions';

/**
 * The Users tab of `capy projects`: invite by email, change a project role,
 * remove from the project. The owner, org admins and the caller are locked.
 */

const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';

const member = (userId: string, email: string, role: string, projectRole?: string): MemberDetail => ({
  membershipId: `m_${userId}`,
  userId,
  email,
  role,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  projects: projectRole === undefined ? [] : [{ id: 'p1', name: 'web', role: projectRole }],
});

// Rows in member order: owner, admin, me (project-admin), dev (member).
const members: readonly MemberDetail[] = [
  member('u_owner', 'owner@x.co', 'owner'),
  member('u_admin', 'admin@x.co', 'admin'),
  member('u_me', 'me@x.co', 'project-admin', 'project-admin'),
  member('u_dev', 'dev@x.co', 'member', 'member'),
];

const data: ProjectsData = {
  projects: [{ id: 'p1', name: 'web', createdAt: null, branches: [], repos: [] }],
  index: null,
  members,
  reposShown: true,
  selfUserId: 'u_me',
};

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);

/** The project open on its Users tab (Secrets is hidden without an index, so Users is first). */
const atUsers = (dryRun = false): ProjectsScreenState => {
  const opened = press(initialProjectsScreenState(data, dryRun), ENTER);
  return opened.open?.tab === 'users' ? opened : press(opened, RIGHT);
};

/** The cursor on row `n` (0-based). */
const onRow = (n: number, dryRun = false): ProjectsScreenState => press(atUsers(dryRun), ...Array.from({ length: n }, () => DOWN));

describe('locked rows', () => {
  test('the owner, an admin and the caller cannot be changed, and say why', () => {
    expect(press(onRow(0), ENTER).notes).toEqual(["The owner's role cannot be changed"]);
    expect(press(onRow(1), ENTER).notes[0]).toContain('capy users');
    expect(press(onRow(2), ENTER).notes).toEqual(['You cannot change your own role.']);
    [0, 1, 2].forEach((n) => expect(press(onRow(n), ENTER).usersDialog).toBeNull());
  });
});

describe('change a role', () => {
  test('Enter on a member offers the roles, starting on the current one; another role is sent', () => {
    const opened = press(onRow(3), ENTER);
    expect(opened.usersDialog).toMatchObject({ step: 'changeRole', current: 'member', choice: 0 });
    const result = handleKey(press(opened, DOWN), ENTER);
    expect(result.effect).toEqual({
      type: 'projectUserRole',
      project: { id: 'p1', name: 'web' },
      target: { userId: 'u_dev', email: 'dev@x.co' },
      role: 'project-admin',
    });
  });

  test('the role it already has sends nothing', () => {
    const result = handleKey(press(onRow(3), ENTER), ENTER);
    expect(result.effect).toBeNull();
    expect(result.state.usersDialog).toBeNull();
  });

  test('a dry run sends nothing and says so', () => {
    const result = handleKey(press(onRow(3, true), ENTER, DOWN), ENTER);
    expect(result.effect).toBeNull();
    expect(result.state.notes).toEqual(['Dry run: nothing was changed.']);
  });
});

describe('remove from the project', () => {
  const asked = (): ProjectsScreenState => press(onRow(3), ENTER, DOWN, DOWN, ENTER);

  test('asks first, with No as the default', () => {
    expect(asked().usersDialog?.step).toBe('confirmRemove');
    [ENTER, 'n', ESC].forEach((key) => {
      const result = handleKey(asked(), key);
      expect(result.effect).toBeNull();
      expect(result.state.usersDialog).toBeNull();
    });
  });

  test('y removes', () => {
    expect(handleKey(asked(), 'y').effect).toEqual({
      type: 'projectUserRemove',
      project: { id: 'p1', name: 'web' },
      target: { userId: 'u_dev', email: 'dev@x.co' },
    });
  });
});

describe('invite', () => {
  const typed = (email: string): ProjectsScreenState => press(atUsers(), 'i', email);

  test('i asks for an email, then a role; Enter sends the invite', () => {
    const roleStep = press(typed('New@X.co'), ENTER);
    expect(roleStep.usersDialog).toMatchObject({ step: 'inviteRole', email: 'new@x.co' });
    expect(handleKey(roleStep, ENTER).effect).toEqual({ type: 'projectUserInvite', project: { id: 'p1', name: 'web' }, email: 'new@x.co', role: 'member' });
  });

  test('someone already in the project, or reaching every project, is not invited', () => {
    expect(press(typed('dev@x.co'), ENTER).notes).toEqual(['dev@x.co is already in this project.']);
    expect(press(typed('admin@x.co'), ENTER).notes).toEqual(['admin@x.co already reaches every project.']);
  });

  test('not an email: stays on the question', () => {
    expect(press(typed('nope'), ENTER).usersDialog?.step).toBe('email');
  });

  test('a new person: the redeem command is shown, kept for after the screen, and c copies it', () => {
    const working = handleKey(press(typed('new@x.co'), ENTER), ENTER).state;
    const done = applyUsersDone(working, { ok: true, lines: ['Invite created for new@x.co as Member'], members, redeemCommand: 'capy redeem CODE' });
    expect(done.usersDialog).toMatchObject({ step: 'invited', command: 'capy redeem CODE' });
    expect(done.exitText).toContain('capy redeem CODE');
    expect(handleKey(done, 'c').effect).toEqual({ type: 'projectUserCopy', text: 'capy redeem CODE' });
  });

  test('a refusal is shown in the service\'s words', () => {
    const working = handleKey(press(typed('new@x.co'), ENTER), ENTER).state;
    const refused = applyUsersDone(working, { ok: false, refusal: { code: 'PERMISSION_DENIED', message: 'You do not have admin access to this project' } });
    expect(refused.usersDialog).toMatchObject({ step: 'refused' });
  });
});

describe('the invite action', () => {
  const client = () => ({
    listMemberDetails: mock(async () => ({ members: [...members] })),
    inviteToProject: mock(async () => ({ user_id: 'u_dev', email: 'dev@x.co', project_id: 'p1', role: 'member' })),
    changeRole: mock(async () => ({ user_id: 'u_dev', role: 'project-admin', project_id: 'p1' })),
    kickFromProject: mock(async () => undefined),
    createInvite: mock(async () => ({ invite_id: 'i', org_id: 'o', email: '', role: '', user_id: '', project_id: null })),
    wrapOuterLayer: mock(async () => ({ ciphertext: '' })),
    coDecrypt: mock(async () => ({ plaintext: '' })),
  });

  test('someone already in the org is added to the project, never sent a new invite', async () => {
    const c = client();
    const actions = createProjectUsersActions(c as never, 'o', 'u_me');
    const finished = await actions.invite({ id: 'p1', name: 'web' }, 'dev@x.co', 'project-admin');
    expect(finished.ok).toBe(true);
    expect(c.inviteToProject.mock.calls).toEqual([['o', 'p1', 'dev@x.co', 'project-admin']]);
    expect(c.createInvite).not.toHaveBeenCalled();
  });

  test('someone new never goes through the project route (it would make a member with no key)', async () => {
    const c = client();
    const actions = createProjectUsersActions(c as never, 'org_without_a_key_here', 'u_me');
    const finished = await actions.invite({ id: 'p1', name: 'web' }, 'new@x.co', 'member');
    expect(c.inviteToProject).not.toHaveBeenCalled();
    // No org key on this machine: refused, nothing created.
    expect(finished.ok).toBe(false);
    expect(c.createInvite).not.toHaveBeenCalled();
  });
});
