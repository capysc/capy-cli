import { describe, expect, mock, test } from 'bun:test';
import type { MemberDetail } from '../../src/service/serviceClient';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyManageDone,
  applyTokensLoaded,
  handleKey,
  initialProjectsScreenState,
} from '../../src/ui/projectsScreen';
import { createProjectManageActions } from '../../src/commands/projectManageActions';

/**
 * The Settings tab (project id, deploy tokens, delete) and the Capy Branches tab
 * (protect, manage access, delete) of `capy projects`.
 */

const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

const PROJECT = { id: 'p1', name: 'web' };
const DEV = { id: 'b_dev', name: 'development', protected: false };
const PROD = { id: 'b_prod', name: 'production', protected: true };
const STAGING = { id: 'b_stg', name: 'staging', protected: false };

const member = (userId: string, email: string, projectRole: 'member' | 'project-admin', prodAccess: boolean): MemberDetail => ({
  membershipId: `m_${userId}`,
  userId,
  email,
  role: projectRole,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  projects: [{
    id: 'p1',
    name: 'web',
    role: projectRole,
    branches: [
      { id: 'b_dev', name: 'development', isProtected: false, hasAccess: true },
      { id: 'b_prod', name: 'production', isProtected: true, hasAccess: prodAccess },
    ],
  }],
});

const members: readonly MemberDetail[] = [member('u_dev', 'dev@x.co', 'member', false), member('u_pa', 'pa@x.co', 'project-admin', true)];

const data: ProjectsData = {
  projects: [{ id: 'p1', name: 'web', createdAt: null, branches: [DEV, PROD, STAGING] }],
  index: null,
  members,
  reposShown: false,
  selfUserId: 'u_me',
};

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);

/** The project open on `tab` (Secrets is hidden without an index; ← wraps to Settings). */
const opened = (dryRun = false): ProjectsScreenState => press(initialProjectsScreenState(data, dryRun), ENTER);
const atSettings = (dryRun = false): ProjectsScreenState => press(opened(dryRun), LEFT);
const atBranches = (dryRun = false): ProjectsScreenState => {
  const first = opened(dryRun);
  return first.open?.tab === 'branches' ? first : press(first, RIGHT);
};

const TOKEN = { deployId: 'dep_0123456789abcdef', label: 'vercel', createdBy: 'pa@x.co', createdAt: '2026-01-01T00:00:00.000Z' };

describe('Settings', () => {
  test('the first row is the project id: Enter copies it', () => {
    expect(atSettings().open?.tab).toBe('settings');
    expect(handleKey(atSettings(), ENTER).effect).toEqual({ type: 'projectIdCopy', text: 'p1' });
  });

  test('Deploy tokens: Enter loads them; a token is revoked only after y (No is the default)', () => {
    const loading = handleKey(press(atSettings(), DOWN), ENTER);
    expect(loading.effect).toEqual({ type: 'projectTokensLoad', project: PROJECT });
    const listed = applyTokensLoaded(loading.state, { ok: true, tokens: [TOKEN] });
    const asked = press(listed, ENTER);
    expect(asked.manage?.step).toBe('confirmRevoke');
    [ENTER, 'n', ESC].forEach((key) => {
      const result = handleKey(asked, key);
      expect(result.effect).toBeNull();
      expect(result.state.manage?.step).toBe('tokens');
    });
    expect(handleKey(asked, 'y').effect).toEqual({ type: 'projectTokenRevoke', project: PROJECT, token: TOKEN });
  });

  test('after a revoke, the list is read again and stays open', () => {
    const listed = applyTokensLoaded(handleKey(press(atSettings(), DOWN), ENTER).state, { ok: true, tokens: [TOKEN] });
    const working = handleKey(press(listed, ENTER), 'y').state;
    const done = applyManageDone(working, { ok: true, lines: ['Deploy token dep_01234567... revoked.'], tokens: [] });
    expect(done.manage).toMatchObject({ step: 'tokens', tokens: [] });
    expect(done.notes).toEqual(['Deploy token dep_01234567... revoked.']);
  });

  test('Delete project is the third row', () => {
    expect(handleKey(press(atSettings(), DOWN, DOWN), ENTER).effect).toEqual({ type: 'projectDeletePreview', project: PROJECT });
  });
});

describe('Capy Branches', () => {
  test('development has no actions, and says why', () => {
    const result = handleKey(atBranches(), ENTER);
    expect(result.state.manage).toBeNull();
    expect(result.state.notes[0]).toContain('development');
  });

  test('a protected branch offers Unprotect, Manage access and Delete; an unprotected one Protect and Delete', () => {
    const prod = press(atBranches(), DOWN, ENTER);
    expect(prod.manage).toMatchObject({ step: 'branchMenu', branch: PROD });
    expect(handleKey(prod, ENTER).effect).toEqual({ type: 'projectBranchProtect', project: PROJECT, branch: PROD, protect: false });
    const staging = press(atBranches(), DOWN, DOWN, ENTER);
    expect(handleKey(staging, ENTER).effect).toEqual({ type: 'projectBranchProtect', project: PROJECT, branch: STAGING, protect: true });
    // Up from the first action wraps to the last: Delete branch, which asks first.
    expect(press(staging, UP, ENTER).manage?.step).toBe('confirmDeleteBranch');
  });

  test('Delete branch asks first, with No as the default', () => {
    const asked = press(atBranches(), DOWN, DOWN, ENTER, UP, ENTER);
    [ENTER, 'n', ESC].forEach((key) => expect(handleKey(asked, key).effect).toBeNull());
    expect(handleKey(asked, 'y').effect).toEqual({ type: 'projectBranchDelete', project: PROJECT, branch: STAGING });
  });

  test('Manage access lists the project\'s members only, and Enter grants the one without access', () => {
    const access = press(atBranches(), DOWN, ENTER, DOWN, ENTER);
    expect(access.manage?.step).toBe('access');
    expect(handleKey(access, ENTER).effect).toEqual({
      type: 'projectBranchAccess',
      project: PROJECT,
      branch: PROD,
      user: { userId: 'u_dev', email: 'dev@x.co', hasAccess: false },
      grant: true,
    });
  });

  test('a dry run sends nothing and says so', () => {
    const result = handleKey(press(atBranches(true), DOWN, DOWN, ENTER), ENTER);
    expect(result.effect).toBeNull();
    expect(result.state.notes).toEqual(['Dry run: nothing was changed.']);
  });

  test('a deleted branch leaves the list', () => {
    const working = handleKey(press(atBranches(), DOWN, DOWN, ENTER, UP, ENTER), 'y').state;
    const done = applyManageDone(working, { ok: true, lines: ['Deleted branch "staging"'], branches: [DEV, PROD] });
    expect(done.data.projects[0].branches.map((b) => b.name)).toEqual(['development', 'production']);
    expect(done.manage).toBeNull();
  });
});

describe('the actions', () => {
  const client = () => ({
    listDeployTokens: mock(async () => ({ tokens: [
      { deploy_id: 'dep_live', label: null, created_by: 'u_pa', created_at: '2026-01-01T00:00:00.000Z', revoked_at: null },
      { deploy_id: 'dep_gone', label: null, created_by: 'u_pa', created_at: '2026-01-01T00:00:00.000Z', revoked_at: '2026-02-01T00:00:00.000Z' },
    ] })),
    revokeDeployToken: mock(async () => undefined),
    listMemberDetails: mock(async () => ({ members: [...members] })),
    listBranches: mock(async () => [{ id: 'b_dev', name: 'development', project_id: 'p1', is_protected: false }]),
    setBranchProtected: mock(async () => undefined),
    deleteBranch: mock(async () => undefined),
    grantProtectedBranch: mock(async () => undefined),
    revokeProtectedBranch: mock(async () => undefined),
    getLatestSecrets: mock(async () => null),
    pushSecrets: mock(async () => ({})),
  });

  test('only live tokens are listed, each with its creator\'s email', async () => {
    const loaded = await createProjectManageActions(client() as never, 'o').loadTokens(PROJECT);
    expect(loaded).toEqual({ ok: true, tokens: [{ deployId: 'dep_live', label: null, createdBy: 'pa@x.co', createdAt: '2026-01-01T00:00:00.000Z' }] });
  });

  test('a revoke reads every branch\'s keep to strip the deploy\'s records, and never fails on that step', async () => {
    const c = client();
    const done = await createProjectManageActions(c as never, 'o').revokeToken(PROJECT, { ...TOKEN, deployId: 'dep_live' });
    expect(done.ok).toBe(true);
    expect(c.revokeDeployToken.mock.calls).toEqual([['dep_live']]);
    expect(c.getLatestSecrets.mock.calls).toEqual([['p1', 'development']]);
  });

  test('protect sends the flag and reads the branches again; a refusal comes back coded', async () => {
    const c = client();
    const done = await createProjectManageActions(c as never, 'o').setProtected(PROJECT, STAGING, true);
    expect(c.setBranchProtected.mock.calls).toEqual([['p1', 'b_stg', true]]);
    expect(done).toMatchObject({ ok: true, branches: [DEV] });
    const refusing = { ...c, deleteBranch: mock(async () => { throw new Error('nope'); }) };
    expect(await createProjectManageActions(refusing as never, 'o').deleteBranch(PROJECT, STAGING)).toMatchObject({ ok: false });
  });
});
