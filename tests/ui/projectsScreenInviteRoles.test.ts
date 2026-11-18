import { describe, expect, test } from 'bun:test';
import type { MemberDetail } from '../../src/service/serviceClient';
import { type ProjectsData, type ProjectsScreenState, handleKey, initialProjectsScreenState, render } from '../../src/ui/projectsScreen';
import { inviteChoices, usersDialogKey } from '../../src/ui/projectUsers';

/**
 * The role step of the Users tab invite in `capy projects`: each role says what it can access, and Admin (org-wide)
 * is offered only to a caller who may grant it (an org owner or admin).
 */

const ENTER = '\r';
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

const members: readonly MemberDetail[] = [
  member('u_owner', 'owner@x.co', 'owner'),
  member('u_admin', 'admin@x.co', 'admin'),
  member('u_pa', 'pa@x.co', 'project-admin', 'project-admin'),
];

const dataFor = (selfUserId: string | undefined): ProjectsData => ({
  projects: [{ id: 'p1', name: 'web', createdAt: null, branches: [], repos: [] }],
  index: null,
  members,
  reposShown: true,
  ...(selfUserId === undefined ? {} : { selfUserId }),
});

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);

/** The role step of an invite for new@x.co, as `selfUserId` sees it. */
const roleStep = (selfUserId: string | undefined, dryRun = false): ProjectsScreenState => {
  const opened = press(initialProjectsScreenState(dataFor(selfUserId), dryRun), ENTER);
  const atUsers = opened.open?.tab === 'users' ? opened : press(opened, RIGHT);
  return press(atUsers, 'i', 'new@x.co', ENTER);
};

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const shown = (state: ProjectsScreenState): string => plain(render(state, 120, 40));

describe('who is offered Admin', () => {
  test('an owner and an org admin are offered Member, Project Admin and Admin', () => {
    expect(roleStep('u_owner').usersDialog).toMatchObject({ step: 'inviteRole', choices: ['member', 'project-admin', 'admin'] });
    expect(roleStep('u_admin').usersDialog).toMatchObject({ step: 'inviteRole', choices: ['member', 'project-admin', 'admin'] });
  });

  test('a project admin is offered Member and Project Admin only', () => {
    expect(roleStep('u_pa').usersDialog).toMatchObject({ step: 'inviteRole', choices: ['member', 'project-admin'] });
    expect(shown(roleStep('u_pa'))).not.toContain('access to all projects');
  });

  test('an unknown caller is not offered Admin', () => {
    expect(roleStep(undefined).usersDialog).toMatchObject({ step: 'inviteRole', choices: ['member', 'project-admin'] });
  });

  test('a caller of the reducer that says nothing about Admin gets the two project roles', () => {
    const stepped = usersDialogKey({ step: 'email', project: { id: 'p1', name: 'web' }, email: 'new@x.co', error: null }, ENTER, { dryRun: false, rows: [] });
    expect(stepped.dialog).toMatchObject({ step: 'inviteRole', choices: inviteChoices(false) });
  });
});

describe('what the role step shows', () => {
  test('each role has what it can access beside it', () => {
    const text = shown(roleStep('u_owner'));
    expect(text).toContain('Member - no access to protected branches');
    expect(text).toContain('Project Admin - access to all branches, invite users to project');
    expect(text).toContain('Admin - access to all projects');
  });
  test('the description is grey, on the selected row and on the others', () => {
    const raw = render(roleStep('u_owner'), 120, 40);
    expect(raw).toContain('Member\x1b[0m\x1b[90m - no access to protected branches\x1b[0m');
    expect(raw).toContain('  Project Admin\x1b[90m - access to all branches, invite users to project\x1b[0m');
    expect(raw).toContain('  Admin\x1b[90m - access to all projects\x1b[0m');
  });
});

describe('choosing a role', () => {
  test('Enter on the first choice invites a Member, as before', () => {
    expect(handleKey(roleStep('u_owner'), ENTER).effect).toEqual({ type: 'projectUserInvite', project: { id: 'p1', name: 'web' }, email: 'new@x.co', role: 'member' });
  });

  test('the third choice invites an Admin', () => {
    const onAdmin = press(roleStep('u_owner'), DOWN, DOWN);
    expect(handleKey(onAdmin, ENTER).effect).toEqual({ type: 'projectUserInvite', project: { id: 'p1', name: 'web' }, email: 'new@x.co', role: 'admin' });
  });

  test('down from the last choice wraps to the first, for two choices and for three', () => {
    expect(press(roleStep('u_owner'), DOWN, DOWN, DOWN).usersDialog).toMatchObject({ choice: 0 });
    expect(press(roleStep('u_pa'), DOWN, DOWN).usersDialog).toMatchObject({ choice: 0 });
  });

  test('a dry run sends nothing for Admin either', () => {
    const onAdmin = press(roleStep('u_owner', true), DOWN, DOWN);
    const stepped = handleKey(onAdmin, ENTER);
    expect(stepped.effect).toBeNull();
    expect(stepped.state.usersDialog).toBeNull();
  });
});
