import { describe, expect, mock, test } from 'bun:test';
import type { SecretIndexRow } from '../../src/service/serviceClient';
import {
  type ProjectsData,
  type ProjectsScreenState,
  applyDeleteDone,
  applyDeletePreview,
  handleKey,
  initialProjectsScreenState,
  otherProjectCounts,
  render,
} from '../../src/ui/projectsScreen';
import { projectsModel } from '../../src/ui/projectsScreenDriver';
import { scopeRowKey } from '../../src/ui/secretsScreen';

/**
 * Deleting a project from `capy projects` (its Settings tab → Delete project):
 * `capy project delete`'s summary, then its question with No as the default,
 * then the delete — or the service's coded refusal, shown in its words.
 */

const ESC = '\x1b';
const ENTER = '\r';
const LEFT = '\x1b[D';
const CTRL_X = '\x18';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const shared: SecretIndexRow = {
  name: 'API_KEY',
  value_hash: 'h1',
  users: [],
  locations: [
    { project_id: 'p1', project_name: 'web', branch: 'development', protected: false, service: null },
    { project_id: 'p2', project_name: 'api', branch: 'development', protected: false, service: null },
  ],
};

const data: ProjectsData = {
  projects: [
    { id: 'p1', name: 'web', createdAt: '2026-02-01T00:00:00.000Z', branches: [], repos: [] },
    { id: 'p2', name: 'api', createdAt: '2026-01-01T00:00:00.000Z', branches: [], repos: [] },
  ],
  index: { rows: [shared], skipped: [], coveredProjectIds: ['p1', 'p2'] },
  members: [],
  reposShown: true,
};

const WEB = { id: 'p1', name: 'web' };
const PREVIEW = ['', '  Project: web (p1)', '  No live deploy tokens.', ''];

const press = (state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);

const DOWN = '\x1b[B';

/** The first project open on its Settings tab (← from Secrets wraps to the last tab, Settings), on Delete project (its third row). */
const atSettings = (state: ProjectsScreenState): ProjectsScreenState => press(state, ENTER, LEFT, DOWN, DOWN);

/** Delete project chosen on the first project's Settings tab, and its summary arrived: the question is up. */
const asked = (dryRun = false): ProjectsScreenState =>
  applyDeletePreview(press(atSettings(initialProjectsScreenState(data, dryRun)), ENTER), 'p1', { ok: true, lines: PREVIEW });

describe('delete from the Settings tab', () => {
  test('Ctrl+X deletes nothing, on the list or in a project', () => {
    const list = initialProjectsScreenState(data);
    expect(handleKey(list, CTRL_X)).toEqual({ state: list, effect: null });
    expect(handleKey(press(list, ENTER, LEFT), CTRL_X).state.dialog).toBeNull();
  });

  test('the Settings tab is the last tab, and Enter on Delete project reads its summary first', () => {
    expect(atSettings(initialProjectsScreenState(data)).open?.tab).toBe('settings');
    const result = handleKey(atSettings(initialProjectsScreenState(data)), ENTER);
    expect(result.effect).toEqual({ type: 'projectDeletePreview', project: WEB });
    expect(result.state.dialog).toEqual({ step: 'loading', project: WEB });
  });

  test('then asks capy project delete\'s question under its summary', () => {
    const frame = strip(render(asked(), 100, 24));
    expect(frame).toContain('Project: web (p1)');
    expect(frame).toContain('Delete project web?');
  });

  test('No is the default: Enter, n and Esc cancel and send nothing', () => {
    [`\r`, 'n', 'N', ESC].forEach((key) => {
      const result = handleKey(asked(), key);
      expect(result.effect).toBeNull();
      expect(result.state.dialog).toBeNull();
      expect(result.state.notes).toEqual(['Cancelled.']);
      expect(result.state.data.projects).toHaveLength(2);
    });
  });

  test('a summary taller than the terminal scrolls, and the question never leaves the screen', () => {
    const long = Array.from({ length: 60 }, (_, i) => `  VAR_${String(i).padStart(2, '0')}`);
    const state = applyDeletePreview(press(atSettings(initialProjectsScreenState(data)), ENTER), 'p1', { ok: true, lines: long });
    const first = strip(render(state, 100, 20));
    expect(first).toContain('Delete project web?');
    expect(first).toContain('VAR_00');
    expect(first).not.toContain('VAR_59');
    const scrolled = press(state, '\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~');
    expect(scrolled.dialog?.step).toBe('confirm');
    const last = strip(render(scrolled, 100, 20));
    expect(last).toContain('VAR_59');
    expect(last).toContain('Delete project web?');
  });

  test('any other key leaves the question up', () => {
    expect(handleKey(asked(), 'x').state.dialog?.step).toBe('confirm');
  });

  test('y deletes (never forced: the effect carries only the project)', () => {
    const result = handleKey(asked(), 'y');
    expect(result.effect).toEqual({ type: 'projectDelete', project: WEB });
    expect(result.state.dialog).toEqual({ step: 'deleting', project: WEB });
    // Keys do nothing while the delete is in flight.
    expect(handleKey(result.state, ESC).state.dialog?.step).toBe('deleting');
  });

  test('deleted: back on the list without it, saying so; no row counts it as another project any more', () => {
    const deleting = handleKey(asked(), 'y').state;
    const lines = ['Deleted project web.', 'An owner or admin can restore it with: capy project restore p1'];
    const done = applyDeleteDone(deleting, 'p1', { ok: true, lines });
    expect(done.dialog).toBeNull();
    expect(done.data.projects.map((p) => p.id)).toEqual(['p2']);
    expect(done.notes).toEqual(lines);
    expect(otherProjectCounts(done.data.index!.rows, 'p2')[scopeRowKey(shared)]).toBeUndefined();
    expect(strip(render(done, 100, 24))).toContain('Deleted project web.');
    // The note lasts until the next key.
    expect(press(done, '\x1b[B').notes).toEqual([]);
  });

  test('refused (live deploy tokens, or not an owner): the refusal is shown and the project stays', () => {
    const deleting = handleKey(asked(), 'y').state;
    const refusal = {
      code: 'PROJECT_HAS_LIVE_DEPLOY_TOKENS',
      message: 'This project has live deploy tokens.',
      lines: ['  dep_1  (created 2026-01-01)', '--force deletes the project anyway. Those deploys stop on their next restart.', 'capy project delete p1 --force'],
    };
    const refused = applyDeleteDone(deleting, 'p1', { ok: false, refusal });
    expect(refused.dialog).toEqual({ step: 'refused', project: WEB, refusal });
    expect(strip(render(refused, 100, 24))).toContain('capy project delete p1 --force');
    const closed = press(refused, 'q');
    expect(closed.dialog).toBeNull();
    expect(closed.data.projects).toHaveLength(2);
  });

  test('a summary that cannot be read is shown as a refusal, never as the question', () => {
    const loading = press(atSettings(initialProjectsScreenState(data)), ENTER);
    const refusal = { code: 'PERMISSION_DENIED', message: 'nope', lines: [] };
    expect(applyDeletePreview(loading, 'p1', { ok: false, refusal }).dialog?.step).toBe('refused');
  });

  test('results for a dialog that has moved on are dropped', () => {
    const cancelled = press(press(atSettings(initialProjectsScreenState(data)), ENTER), ESC);
    expect(cancelled.dialog).toBeNull();
    expect(applyDeletePreview(cancelled, 'p1', { ok: true, lines: PREVIEW })).toBe(cancelled);
    expect(applyDeleteDone(asked(), 'p1', { ok: true, lines: [] }).data.projects).toHaveLength(2);
    expect(applyDeletePreview(press(atSettings(initialProjectsScreenState(data)), ENTER), 'p2', { ok: true, lines: PREVIEW }).dialog?.step).toBe('loading');
  });

  test('--dry-run: y asks nothing of the service, and says nothing was deleted', () => {
    const result = handleKey(asked(true), 'y');
    expect(result.effect).toBeNull();
    expect(result.state.notes).toEqual(['Dry run: nothing was deleted.']);
    expect(result.state.data.projects).toHaveLength(2);
  });
});

describe('the projects model routes its own effects', () => {
  test('preview and delete go to the delete actions, and come back as state changes', async () => {
    const preview = mock(async (_p: { id: string; name: string }) => ({ ok: true as const, lines: PREVIEW }));
    const run = mock(async (_p: { id: string; name: string }) => ({ ok: true as const, lines: ['Deleted project web.'] }));
    const model = projectsModel({ preview, run });
    const first = model.handleKey(atSettings(initialProjectsScreenState(data)), ENTER);
    expect(first.effect !== null && model.isOwnEffect(first.effect)).toBe(true);
    expect(model.isOwnEffect({ type: 'fetchValue', row: shared })).toBe(false);
    const applied = await new Promise<ProjectsScreenState>((resolve) => {
      if (first.effect === null || !model.isOwnEffect(first.effect)) throw new Error('expected an own effect');
      model.performOwn(first.effect, (apply) => resolve(apply(first.state).state));
    });
    expect(applied.dialog?.step).toBe('confirm');
    const yes = model.handleKey(applied, 'y');
    const deleted = await new Promise<ProjectsScreenState>((resolve) => {
      if (yes.effect === null || !model.isOwnEffect(yes.effect)) throw new Error('expected an own effect');
      model.performOwn(yes.effect, (apply) => resolve(apply(yes.state).state));
    });
    expect(preview.mock.calls).toEqual([[WEB]]);
    expect(run.mock.calls).toEqual([[WEB]]);
    expect(deleted.data.projects.map((p) => p.id)).toEqual(['p2']);
  });
});
