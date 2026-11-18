import { describe, expect, mock, test } from 'bun:test';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyManageDone,
  handleKey,
  initialProjectsScreenState,
  render,
} from '../../src/ui/projectsScreen';
import { createProjectManageActions } from '../../src/commands/projectManageActions';
import { MANAGE_CANCELLED_TEXT, MANAGE_DRY_RUN_TEXT, RENAME_EMPTY_TEXT, SETTINGS_ROWS } from '../../src/ui/projectManage';
import { ERROR_CODES } from '../../src/types/index';

/**
 * Rename project, on the Settings tab of `capy projects`: a text field that starts as the current name. The name's
 * rule and the service decide; a refusal keeps what was typed. The screen has no folder, so no keep.lock is touched.
 */

const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const BACKSPACE = '\x7f';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m|\x1b\[K|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

const PROJECT = { id: 'p1', name: 'frontend' };
const location = { project_id: 'p1', project_name: 'frontend', branch: 'development', protected: false, service: null };

const data: ProjectsData = {
  projects: [{ id: 'p1', name: 'frontend', createdAt: null, branches: [{ id: 'b', name: 'development', protected: false }] }],
  index: { rows: [{ name: 'API_KEY', value_hash: 'h', locations: [location], users: [] }], skipped: [], coveredProjectIds: ['p1'] },
  members: null,
  reposShown: false,
};

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState => keys.reduce((s, k) => handleKey(s, k).state, state);
const downs = Array.from({ length: SETTINGS_ROWS.indexOf('rename') }, () => DOWN);
/** The project open on its Settings tab (← from the first tab wraps to the last), with the rename field open. */
const atRename = (dryRun = false): ProjectsScreenState => press(initialProjectsScreenState(data, dryRun), ENTER, LEFT, ...downs, ENTER);
const clear = Array.from({ length: PROJECT.name.length }, () => BACKSPACE);

describe('Rename project on the Settings tab', () => {
  test('the rows that were there keep their place; Rename project is listed', () => {
    expect(SETTINGS_ROWS.slice(0, 3)).toEqual(['projectId', 'tokens', 'delete']);
    expect(strip(render(press(initialProjectsScreenState(data), ENTER, LEFT), 100, 24))).toContain('Rename project');
  });

  test('Enter opens a field that starts as the current name', () => {
    const state = atRename();

    expect(state.manage).toEqual({ step: 'rename', project: PROJECT, name: 'frontend', error: null });
    expect(strip(render(state, 100, 24))).toContain('Name: frontend');
  });

  test('typing and backspace edit the name; Enter sends the trimmed name', () => {
    const sent = handleKey(press(atRename(), ...clear, ...'  slidespeak-frontend '.split('')), ENTER);

    expect(sent.effect).toEqual({ type: 'projectRename', project: PROJECT, name: 'slidespeak-frontend' });
    expect(sent.state.manage?.step).toBe('working');
  });

  test('Esc cancels; an empty name stays in the field; the same name does nothing', () => {
    const cancelled = handleKey(atRename(), ESC);
    expect(cancelled.effect).toBeNull();
    expect(cancelled.state.manage).toBeNull();
    expect(cancelled.state.notes).toEqual([MANAGE_CANCELLED_TEXT]);

    const empty = handleKey(press(atRename(), ...clear), ENTER);
    expect(empty.effect).toBeNull();
    expect(empty.state.manage).toMatchObject({ step: 'rename', name: '', error: RENAME_EMPTY_TEXT });

    const same = handleKey(atRename(), ENTER);
    expect(same.effect).toBeNull();
    expect(same.state.manage).toBeNull();
  });

  test('a dry run sends nothing', () => {
    const answered = handleKey(press(atRename(true), 'x'), ENTER);

    expect(answered.effect).toBeNull();
    expect(answered.state.notes).toEqual([MANAGE_DRY_RUN_TEXT]);
  });

  test('renamed: the new name is in the list, the title, the secrets rows and the note', () => {
    const working = handleKey(press(atRename(), ...clear, ...'web'.split('')), ENTER).state;
    const done = applyManageDone(working, { ok: true, lines: ['Renamed frontend to web.'], renamed: { id: 'p1', name: 'web' } });

    expect(done.manage).toBeNull();
    expect(done.notes).toEqual(['Renamed frontend to web.']);
    expect(done.data.projects[0].name).toBe('web');
    expect(done.data.index?.rows[0].locations[0].project_name).toBe('web');
    expect(done.open?.tab).toBe('settings');
    expect(strip(render(done, 100, 24)).split('\n')[0]).toContain('web');
    expect(strip(render(press(done, ESC), 100, 24))).not.toContain('frontend');
  });

  test('refused: back in the field with the typed name kept and the refusal shown; nothing is renamed', () => {
    const working = handleKey(press(atRename(), ...clear, ...'taken'.split('')), ENTER).state;
    const done = applyManageDone(working, { ok: false, refusal: { code: 'PROJECT_NAME_EXISTS', message: 'That name is taken.' } });

    expect(done.manage).toEqual({ step: 'rename', project: PROJECT, name: 'taken', error: 'That name is taken.' });
    expect(done.data.projects[0].name).toBe('frontend');
    expect(strip(render(done, 100, 24))).toContain('That name is taken.');
  });
});

describe('the action', () => {
  const client = () => ({ renameProject: mock(async (_org: string, id: string, name: string) => ({ ok: true as const, changed: true, project: { id, name } })) });

  test('renames through the service and reports the name the service stored', async () => {
    const c = client();
    const done = await createProjectManageActions(c as never, 'o').renameProject(PROJECT, 'slidespeak-monorepo/frontend');

    expect(c.renameProject.mock.calls).toEqual([['o', 'p1', 'slidespeak-monorepo/frontend']]);
    expect(done).toMatchObject({ ok: true, renamed: { id: 'p1', name: 'slidespeak-monorepo/frontend' } });
  });

  test('a name the rule refuses is refused with its code, and nothing is sent', async () => {
    const c = client();
    const done = await createProjectManageActions(c as never, 'o').renameProject(PROJECT, 'has space');

    expect(done).toMatchObject({ ok: false, refusal: { code: ERROR_CODES.PROJECT_NAME_INVALID } });
    expect(c.renameProject.mock.calls).toHaveLength(0);
  });

  test('a refusal from the service comes back as a refusal, never a throw', async () => {
    const c = { renameProject: mock(async () => { throw new Error('nope'); }) };

    expect(await createProjectManageActions(c as never, 'o').renameProject(PROJECT, 'web')).toMatchObject({ ok: false });
  });
});
