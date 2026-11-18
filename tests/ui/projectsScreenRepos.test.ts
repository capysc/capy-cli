import { describe, expect, mock, test } from 'bun:test';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyManageDone,
  applyRepoRowsChecked,
  handleKey,
  initialProjectsScreenState,
  render,
} from '../../src/ui/projectsScreen';
import { createProjectManageActions } from '../../src/commands/projectManageActions';
import { LAST_REPO_LOCK_TEXT, MANAGE_CANCELLED_TEXT, MANAGE_DRY_RUN_TEXT } from '../../src/ui/projectManage';

/**
 * The Git Repos tab of `capy projects`: every stored row (a repo, at the folder
 * the project was seen in), with a cursor. d removes the selected row after a
 * question, for cleaning up a row that should not be there. The project's only
 * row is never removed.
 */

const ENTER = '\r';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m|\x1b\[K|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

const link = (owner: string, name: string, path: string) => ({ host: 'github.com', owner, name, path, github_repo_id: null });
const REAL = link('Acme', 'mono', 'backend');
const TEMP = link('Acme', 'mono', '.claude/capy-temp');

const dataWith = (repos: readonly ReturnType<typeof link>[]): ProjectsData => ({
  projects: [{ id: 'p1', name: 'backend', createdAt: null, branches: [{ id: 'b', name: 'development', protected: false }], repos }],
  index: null,
  members: null,
  reposShown: true,
});

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);

/** The project open on the Git Repos tab. */
const atRepos = (repos: readonly ReturnType<typeof link>[], dryRun = false): ProjectsScreenState => {
  const first = press(initialProjectsScreenState(dataWith(repos), dryRun), ENTER);
  return first.open?.tab === 'repos' ? first : press(first, RIGHT);
};

const TEMP_ROW = { host: 'github.com', owner: 'Acme', name: 'mono', path: '.claude/capy-temp' };

describe('the Git Repos tab', () => {
  test('shows every stored row, and the arrows move a cursor over them', () => {
    const state = atRepos([REAL, TEMP]);
    expect(state.open?.tab).toBe('repos');
    const frame = strip(render(state, 120, 20));
    expect(frame).toContain('https://github.com/Acme/mono/tree/HEAD/backend');
    expect(frame).toContain('https://github.com/Acme/mono/tree/HEAD/.claude/capy-temp');
    expect(press(state, DOWN).open?.repoCursor).toBe(1);
    expect(press(state, DOWN, DOWN).open?.repoCursor).toBe(1);
  });
});

describe('d removes the selected row', () => {
  test('d asks first; No is the default and nothing is sent', () => {
    const asked = handleKey(press(atRepos([REAL, TEMP]), DOWN), 'd');
    expect(asked.effect).toBeNull();
    expect(asked.state.manage).toMatchObject({ step: 'confirmRemoveRepo', row: TEMP_ROW });
    const answered = handleKey(asked.state, ENTER);
    expect(answered.effect).toBeNull();
    expect(answered.state.manage).toBeNull();
    expect(answered.state.notes).toEqual([MANAGE_CANCELLED_TEXT]);
  });

  test('y sends the removal of the row under the cursor, and only that row', () => {
    const sent = handleKey(press(atRepos([REAL, TEMP]), DOWN, 'd'), 'y');
    expect(sent.effect).toEqual({ type: 'projectRepoRemove', project: { id: 'p1', name: 'backend' }, row: TEMP_ROW });
    expect(sent.state.manage?.step).toBe('working');
  });

  test('when it comes back, that row is gone, the same repo\'s other folder stays, and the cursor stays inside the list', () => {
    const working = handleKey(press(atRepos([REAL, TEMP]), DOWN, 'd'), 'y').state;
    const done = applyManageDone(working, { ok: true, lines: ['Removed.'], removedRepoRow: TEMP_ROW });
    expect(done.data.projects[0].repos).toEqual([REAL]);
    expect(done.open?.repoCursor).toBe(0);
    expect(done.manage).toBeNull();
    expect(done.notes).toEqual(['Removed.']);
  });

  test('the project\'s only row is not removable: no question, no effect', () => {
    const only = handleKey(atRepos([REAL]), 'd');
    expect(only.effect).toBeNull();
    expect(only.state.manage).toBeNull();
    expect(only.state.notes).toEqual([LAST_REPO_LOCK_TEXT]);
  });

  test('the d hint is shown only when there is another row', () => {
    expect(strip(render(atRepos([REAL, TEMP]), 120, 20))).toMatch(/d remove/);
    expect(strip(render(atRepos([REAL]), 120, 20))).not.toMatch(/d remove/);
  });

  test('a dry run asks and sends nothing', () => {
    const answered = handleKey(press(atRepos([REAL, TEMP], true), 'd'), 'y');
    expect(answered.effect).toBeNull();
    expect(answered.state.notes).toEqual([MANAGE_DRY_RUN_TEXT]);
  });

  test('a refusal from the service is shown, and the list is unchanged', () => {
    const working = handleKey(press(atRepos([REAL, TEMP]), 'd'), 'y').state;
    const done = applyManageDone(working, { ok: false, refusal: { code: 'PROJECT_REPO_LAST', message: 'refused' } });
    expect(done.manage).toMatchObject({ step: 'refused', refusal: { code: 'PROJECT_REPO_LAST' } });
    expect(done.data.projects[0].repos).toEqual([REAL, TEMP]);
  });
});

describe('the action', () => {
  test('removes the row through the service and reports which one', async () => {
    const client = { deleteProjectRepoRow: mock(async () => ({ ok: true, removed: 1, repos: [] })) };
    const done = await createProjectManageActions(client as never, 'o').removeRepoRow({ id: 'p1', name: 'backend' }, TEMP_ROW);
    expect(client.deleteProjectRepoRow.mock.calls).toEqual([['o', 'p1', TEMP_ROW]]);
    expect(done).toMatchObject({ ok: true, removedRepoRow: TEMP_ROW });
  });

  test('a failure comes back as a refusal, never a throw', async () => {
    const client = { deleteProjectRepoRow: mock(async () => { throw new Error('nope'); }) };
    expect(await createProjectManageActions(client as never, 'o').removeRepoRow({ id: 'p1', name: 'backend' }, TEMP_ROW)).toMatchObject({ ok: false });
  });
});

describe('the [remote] tag', () => {
  const REAL_ROW = { host: 'github.com', owner: 'Acme', name: 'mono', path: 'backend' };

  test('the first time the tab is shown, the rows are checked against GitHub once', () => {
    const first = press(initialProjectsScreenState(dataWith([REAL, TEMP]), false), ENTER);
    const onTab = first.open?.tab === 'repos' ? { state: first, effect: null } : handleKey(first, RIGHT);
    const again = handleKey(onTab.state, DOWN);

    expect(onTab.state.open?.tab).toBe('repos');
    expect(first.open?.tab === 'repos' ? handleKey(initialProjectsScreenState(dataWith([REAL, TEMP]), false), ENTER).effect : onTab.effect).toEqual({
      type: 'projectRepoRowsCheck',
      project: { id: 'p1', name: 'backend' },
      rows: [REAL_ROW, TEMP_ROW],
    });
    expect(again.effect).toBeNull();
  });

  test('a row that holds the project\'s keep.lock on the remote is tagged; the other is not', () => {
    const state = applyRepoRowsChecked(atRepos([REAL, TEMP]), 'p1', [{ ...REAL_ROW, owner: 'acme', name: 'MONO' }]);
    const lines = strip(render(state, 120, 20)).split('\n');

    expect(lines.find((l) => l.includes('/tree/HEAD/backend'))).toContain('[remote]');
    expect(lines.find((l) => l.includes('capy-temp'))).not.toContain('[remote]');
  });

  test('before the check comes back, and when nothing could be read, no row is tagged', () => {
    expect(strip(render(atRepos([REAL, TEMP]), 120, 20))).not.toContain('[remote]');
    expect(strip(render(applyRepoRowsChecked(atRepos([REAL, TEMP]), 'p1', []), 120, 20))).not.toContain('[remote]');
  });

  describe('the check', () => {
    const client = {} as never;
    const githubWith = (files: Readonly<Record<string, string>>, base: string | null = 'main') => ({
      getDefaultBranches: mock(async (repos: readonly unknown[]) => ({ ok: true as const, value: repos.map(() => base) })),
      getFile: mock(async (_repo: unknown, path: string) => ({ ok: true as const, value: files[path] ?? null })),
    });
    const check = (github: ReturnType<typeof githubWith> | undefined) =>
      createProjectManageActions(client, 'o', async () => github as never).remoteRepoRows({ id: 'p1', name: 'backend' }, [REAL_ROW, TEMP_ROW]);

    test('a row is remote when its folder holds this project\'s keep.lock on the default branch', async () => {
      const github = githubWith({ 'backend/keep.lock': '{"project_id":"p1"}' });

      expect(await check(github)).toEqual([REAL_ROW]);
      expect(github.getDefaultBranches.mock.calls).toHaveLength(1);
      expect(github.getFile.mock.calls.map((c) => `${c[1]}@${c[2]}`)).toEqual(['backend/keep.lock@main', '.claude/capy-temp/keep.lock@main']);
    });

    test('another project\'s keep.lock, no keep.lock, no default branch, or no gh: not remote', async () => {
      expect(await check(githubWith({ 'backend/keep.lock': '{"project_id":"other"}' }))).toEqual([]);
      expect(await check(githubWith({}))).toEqual([]);
      expect(await check(githubWith({ 'backend/keep.lock': '{"project_id":"p1"}' }, null))).toEqual([]);
      expect(await check(undefined)).toEqual([]);
    });

    test('a read that throws is never a failure of the screen', async () => {
      const github = githubWith({});
      github.getFile.mockImplementation(async () => {
        throw new Error('boom');
      });

      expect(await check(github)).toEqual([]);
    });
  });
});

describe('the confirm hint', () => {
  test('lists y and n only', () => {
    const frame = strip(render(press(atRepos([REAL, TEMP]), DOWN, 'd'), 120, 20));

    expect(frame).toMatch(/y yes/);
    expect(frame).toMatch(/n no/);
    expect(frame).not.toMatch(/enter no/);
  });
});
