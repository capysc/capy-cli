/**
 * The `capy secrets` edit flow (CAP-698), driven through the screen's own pure
 * reducer: `e` / Ctrl+E open the dialog, the value is masked, the
 * location and repo pickers use `capy deploy`'s keys, Esc goes back one step at a
 * time, and the confirmation is the approved copy, byte for byte.
 */
import { describe, test, expect } from 'bun:test';
import {
  SecretsScreenState,
  applyRepos,
  applyRunDone,
  handleKey,
  initialSecretsScreenState,
  applyValueResult,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import type { EditFlow } from '../../src/ui/secretsEditFlow';
import { renderSecretSetConfirmation, TERMINAL_STYLE } from '../../src/commands/secretsSetText';
import type { SecretSetResult } from '../../src/commands/secretsSet';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import { ERROR_CODES } from '../../src/types/index';

const ESC = '\x1b';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_U = '\x15';
const CTRL_R = '\x12';
const OLD = 'SENTINEL-old-secret-31337';
const CTRL_E = '\x05';
const CTRL_C = '\x03';
const VALUE = 'SENTINEL-typed-value-77';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const row = (over: Partial<SecretIndexRow> = {}): SecretIndexRow => ({
  name: 'ANTHROPIC_API_KEY',
  value_hash: 'hash1',
  locations: [
    { project_id: 'p1', project_name: 'monorepo-backend', branch: 'production', protected: true, service: null },
    { project_id: 'p1', project_name: 'monorepo-backend', branch: 'staging', protected: false, service: null },
    { project_id: 'p2', project_name: 'swot-server', branch: 'development', protected: false, service: null },
    { project_id: 'p3', project_name: 'unlinked-app', branch: 'development', protected: false, service: null },
  ],
  users: [],
  ...over,
});

const press = (state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState =>
  keys.reduce((s, k) => handleKey(s, k).state, state);
const type = (state: SecretsScreenState, text: string): SecretsScreenState => press(state, ...tokenizeKeys(text));
const frame = (state: SecretsScreenState): string => strip(render(state, 100, 30));
const flowOf = (state: SecretsScreenState): EditFlow => state.edit as EditFlow;

const start = (rows: readonly SecretIndexRow[] = [row()]) => initialSecretsScreenState(rows);
const atValue = (rows?: readonly SecretIndexRow[]) => press(start(rows), CTRL_E);
const atLocations = () => press(type(atValue(), VALUE), ENTER);

const LINKS: readonly OrgRepoLink[] = [
  { project_id: 'p1', project_name: 'monorepo-backend', host: 'github.com', owner: 'SlideSpeak', name: 'slidespeak-monorepo', path: 'backend', github_repo_id: 1, last_seen_at: '' },
  { project_id: 'p2', project_name: 'swot-server', host: 'github.com', owner: 'SlideSpeak', name: 'swot-analysis-generator-server', path: '.', github_repo_id: 2, last_seen_at: '' },
];

describe('opening the dialog', () => {
  test('Ctrl+E on the list opens it; `e` in the details view opens it', () => {
    expect(flowOf(atValue()).step).toBe('value');
    const inDetails = press(start(), ENTER, 'e');
    expect(inDetails.popup).toBeNull();
    expect(flowOf(inDetails).step).toBe('value');
    expect(flowOf(press(start(), ENTER, 'E')).step).toBe('value');
  });

  test('a plain `e` on the list is search text, as every printable character is: a search can still start with e', () => {
    const s = type(start([row({ name: 'ELEVEN_LABS_KEY' })]), 'eleven');
    expect(s.edit).toBeNull();
    expect(s.search.query).toBe('eleven');
  });

  test('nothing opens it while a filter is typed (the search owns the keyboard)', () => {
    const s = press(type(start(), 'anth'), CTRL_E);
    expect(s.edit).toBeNull();
    expect(s.search.query).toBe('anth');
  });

  test('an empty list has nothing to edit', () => {
    expect(press(start([]), CTRL_E).edit).toBeNull();
  });

  test('the footer advertises it, and stops advertising it while a filter is typed', () => {
    expect(frame(start())).toContain('ctrl+e edit');
    expect(frame(type(start(), 'a'))).not.toContain('ctrl+e edit');
    expect(frame(press(start(), ENTER))).toContain('e edit');
  });
});

describe('the value dialog', () => {
  test('typing `c` and `e` types characters; nothing else triggers while typing', () => {
    const s = type(atValue(), 'ceqrj/');
    expect(flowOf(s)).toMatchObject({ step: 'value', buffer: 'ceqrj/' });
  });

  test('Backspace removes one character; Ctrl+U is ignored (nothing clears the field)', () => {
    const s = press(type(atValue(), 'abc'), '\x7f');
    expect(flowOf(s)).toMatchObject({ buffer: 'ab' });
    expect(flowOf(press(s, CTRL_U))).toMatchObject({ buffer: 'ab' });
    expect(flowOf(press(s, CTRL_U, ...tokenizeKeys('xy')))).toMatchObject({ buffer: 'abxy' });
  });

  test('the hint is `enter next · ctrl+r reveal · esc cancel` (no ctrl+u), and the value is masked: never drawn', () => {
    const s = type(applyValueResult(atValue(), row(), { status: 'ok', value: OLD }), VALUE);
    const text = frame(s);
    expect(text).toContain('enter next · ctrl+r reveal · esc cancel');
    expect(text).not.toContain('ctrl+u');
    expect(text).toContain('•');
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain('SENTINEL');
    expect(text).toContain(`(${VALUE.length} characters)`);
  });

  test('Enter on an empty field does nothing; Esc closes the dialog and returns to the list', () => {
    expect(flowOf(press(atValue(), ENTER)).step).toBe('value');
    expect(press(atValue(), ESC).edit).toBeNull();
    expect(press(atValue(), `${ESC}${ESC}`).edit).toBeNull();
  });

  test('a bracketed paste keeps line breaks; the same chunk typed would not submit mid-paste', () => {
    const pem = '-----BEGIN-----\r\nabc\r\n-----END-----\r\n';
    const s = type(atValue(), `${ESC}[200~${pem}${ESC}[201~`);
    expect(flowOf(s)).toMatchObject({ step: 'value', buffer: '-----BEGIN-----\nabc\n-----END-----\n' });
  });

  test('Ctrl-C still quits from the dialog', () => {
    expect(press(atValue(), CTRL_C).quit).toBe(true);
  });
});

describe('the locations step', () => {
  test('all locations are selected by default, protected ones included, each protected one marked in the PROTECTED column', () => {
    const s = atLocations();
    const flow = flowOf(s);
    expect(flow.step).toBe('locations');
    expect((flow as { box: { checked: number[] } }).box.checked).toEqual([0, 1, 2, 3]);
    const text = frame(s);
    expect(text).toMatch(/◉ {2}monorepo-backend {2}production\s+yes/);
    expect(text).toMatch(/◉ {2}monorepo-backend {2}staging\s*$/m); // not protected: blank column
    expect(text).toContain('PROTECTED');
    expect(text).toContain('4 of 4 locations');
  });

  test('deselect and invert use the deploy picker keys: `a` toggles all, `i` inverts, space toggles one', () => {
    const checked = (s: SecretsScreenState) => (flowOf(s) as { box: { checked: number[] } }).box.checked;
    const s = atLocations();
    expect(checked(press(s, 'a'))).toEqual([]);
    expect(checked(press(s, 'a', 'a'))).toEqual([0, 1, 2, 3]);
    expect(checked(press(s, ' '))).toEqual([1, 2, 3]);
    expect(checked(press(s, ' ', 'i'))).toEqual([0]);
    expect(frame(press(s, 'a'))).toMatch(/◯ {2}monorepo-backend {2}production/);
  });

  test('`/` starts a filter; `a` and `i` are filter text there; Esc ends the filter before it goes back', () => {
    const s = press(atLocations(), '/', 'a', 'i');
    expect(flowOf(s)).toMatchObject({ step: 'locations', box: { searching: true, query: 'ai' } });
    const out = press(s, ESC);
    expect(flowOf(out)).toMatchObject({ step: 'locations', box: { searching: false } });
    expect(flowOf(press(out, ESC)).step).toBe('value');
  });

  test('Esc goes back to the value with what was typed still in the field', () => {
    const back = press(atLocations(), ESC);
    expect(flowOf(back)).toMatchObject({ step: 'value', buffer: VALUE });
  });

  test('Enter with nothing selected does nothing; with some, it asks for the repos of the chosen projects only', () => {
    expect(flowOf(press(atLocations(), 'a', ENTER)).step).toBe('locations');
    const moved = handleKey(press(atLocations(), ' ', DOWN, DOWN, ' '), ENTER);
    expect(flowOf(moved.state).step).toBe('loading');
    expect(moved.effect).toEqual({ type: 'loadRepos', projectIds: ['p1', 'p3'] });
  });
});

describe('the repos step', () => {
  const atRepos = () => applyRepos(handleKey(atLocations(), ENTER).state, { ok: true, links: LINKS, bases: {} });

  test('shows the approved prompt verbatim, every linked repo selected, and the unlinked projects as not linked', () => {
    const s = atRepos();
    expect(flowOf(s).step).toBe('repos');
    const text = frame(s);
    expect(text).toContain('Create a PR with these changes?');
    expect(text).toMatch(/◉ {2}SlideSpeak\/slidespeak-monorepo/);
    expect(text).toMatch(/◉ {2}SlideSpeak\/swot-analysis-generator-server/);
    expect(text).toContain('No linked repo, so no PR: unlinked-app');
    expect((flowOf(s) as { box: { checked: number[] } }).box.checked).toEqual([0, 1]);
  });

  test('deselect and invert use the same keys; Enter runs with the chosen locations and the chosen repos', () => {
    const s = atRepos();
    const run = handleKey(press(s, 'i'), ENTER); // invert: all -> none
    expect(run.effect).toMatchObject({ type: 'runSet', request: { name: 'ANTHROPIC_API_KEY', value: VALUE, repos: [] } });
    const some = handleKey(press(s, ' '), ENTER); // untick the first repo
    expect(some.effect).toMatchObject({ type: 'runSet' });
    const request = (some.effect as { request: { repos: { name: string }[]; locations: unknown[] } }).request;
    expect(request.repos.map((r) => r.name)).toEqual(['swot-analysis-generator-server']);
    expect(request.locations).toHaveLength(4);
    expect(flowOf(some.state).step).toBe('running');
  });

  test('Esc goes back to the locations with their ticks kept; while the repos load, Esc goes back too', () => {
    const edited = press(atLocations(), ' '); // untick the first location
    const loading = handleKey(edited, ENTER).state;
    expect(flowOf(press(loading, ESC))).toMatchObject({ step: 'locations', box: { checked: [1, 2, 3] } });
    const repos = applyRepos(loading, { ok: true, links: LINKS, bases: {} });
    expect(flowOf(press(repos, ESC))).toMatchObject({ step: 'locations', box: { checked: [1, 2, 3] } });
  });

  test('a late repo list (after Esc) is dropped; an unreadable list is a code, and Enter still runs without PRs', () => {
    const loading = handleKey(atLocations(), ENTER).state;
    const back = press(loading, ESC);
    expect(flowOf(applyRepos(back, { ok: true, links: LINKS, bases: {} })).step).toBe('locations');
    const failed = applyRepos(loading, { ok: false, code: ERROR_CODES.PERMISSION_DENIED });
    expect(frame(failed)).toContain(`Repos unavailable (${ERROR_CODES.PERMISSION_DENIED})`);
    expect(handleKey(failed, ENTER).effect).toMatchObject({ type: 'runSet', request: { repos: [] } });
  });

  test('a push in flight is never abandoned: keys and Ctrl-C are ignored while running', () => {
    const running = handleKey(atRepos(), ENTER).state;
    expect(flowOf(running).step).toBe('running');
    expect(press(running, ESC, 'a', CTRL_C).quit).toBe(false);
    expect(flowOf(press(running, ESC, CTRL_C)).step).toBe('running');
  });
});

describe('the confirmation', () => {
  const pr = (repo: string, n: number): SecretSetResult['prs'][number] => ({
    repo,
    url: `https://github.com/${repo}/pull/${n}`,
    base: 'main',
    keep_lock_paths: ['keep.lock'],
    keep_lock_diverged: false,
    locations: [],
  });
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ project: `p${i}`, branch: 'production', protected: false }));
  const base: SecretSetResult = { name: 'ANTHROPIC_API_KEY', updated: refs(6), unchanged: [], prs: [], no_pr: [], failed: [] };

  test('the approved copy, byte for byte, for four repos', () => {
    const result: SecretSetResult = {
      ...base,
      prs: [
        pr('SlideSpeak/slidespeak-monorepo', 8401),
        pr('SlideSpeak/swot-analysis-generator-server', 15),
        pr('SlideSpeak/slidespeak-frontend', 912),
        pr('SlideSpeak/slidespeak-worker', 33),
      ],
    };
    expect(renderSecretSetConfirmation(result)).toBe(
      [
        '✓ ANTHROPIC_API_KEY updated in 6 locations.',
        '',
        "Pull requests (merge each to update that repo's keep.lock):",
        '',
        '  SlideSpeak/slidespeak-monorepo',
        '    https://github.com/SlideSpeak/slidespeak-monorepo/pull/8401',
        '',
        '  SlideSpeak/swot-analysis-generator-server',
        '    https://github.com/SlideSpeak/swot-analysis-generator-server/pull/15',
        '',
        '  SlideSpeak/slidespeak-frontend',
        '    https://github.com/SlideSpeak/slidespeak-frontend/pull/912',
        '',
        '  SlideSpeak/slidespeak-worker',
        '    https://github.com/SlideSpeak/slidespeak-worker/pull/33',
        '',
        'The new value is saved in Capy now. Each repo keeps using the old value',
        'until its PR is merged and pulled.',
      ].join('\n'),
    );
  });

  test('repos that needed no PR are listed under a Skipped heading and description, after the PRs', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      prs: [pr('SlideSpeak/slidespeak-monorepo', 8401)],
      no_pr: [{ repo: 'SlideSpeak/onbrand', reason: 'NO_DIFF_VS_BASE' }],
      skipped: [{ repo: 'SlideSpeak/voice-cloner-server', reason: 'NOTHING_CHANGED' }],
    });
    expect(text).toBe(`✓ ANTHROPIC_API_KEY updated in 6 locations.

Pull requests (merge each to update that repo's keep.lock):

  SlideSpeak/slidespeak-monorepo
    https://github.com/SlideSpeak/slidespeak-monorepo/pull/8401

Skipped
Nothing changed in these repos, so no pull request was opened.

  SlideSpeak/onbrand
  SlideSpeak/voice-cloner-server

The new value is saved in Capy now. Each repo keeps using the old value
until its PR is merged and pulled.`);
  });

  test('in a terminal only the skipped repos are grey; the heading and description are not', () => {
    const text = renderSecretSetConfirmation(
      { ...base, prs: [pr('SlideSpeak/slidespeak-monorepo', 1)], skipped: [{ repo: 'SlideSpeak/onbrand', reason: 'NOTHING_CHANGED' }] },
      TERMINAL_STYLE,
    );
    expect(text).toContain('\nSkipped\nNothing changed in these repos, so no pull request was opened.\n');
    expect(text).toContain('\x1b[90m  SlideSpeak/onbrand\x1b[0m');
    expect(text).not.toContain('\x1b[90m  SlideSpeak/slidespeak-monorepo');
  });

  test('every repo skipped: no pull request section, just the Skipped list', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      updated: [],
      unchanged: refs(2),
      skipped: [{ repo: 'SlideSpeak/onbrand', reason: 'NOTHING_CHANGED' }],
    });
    expect(text).not.toContain('Pull requests');
    expect(text).toContain('Skipped\nNothing changed in these repos, so no pull request was opened.\n\n  SlideSpeak/onbrand');
  });

  test('the two-repo example from the brief, exactly', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      prs: [pr('SlideSpeak/slidespeak-monorepo', 8401), pr('SlideSpeak/swot-analysis-generator-server', 15)],
    });
    expect(text).toBe(`✓ ANTHROPIC_API_KEY updated in 6 locations.

Pull requests (merge each to update that repo's keep.lock):

  SlideSpeak/slidespeak-monorepo
    https://github.com/SlideSpeak/slidespeak-monorepo/pull/8401

  SlideSpeak/swot-analysis-generator-server
    https://github.com/SlideSpeak/swot-analysis-generator-server/pull/15

The new value is saved in Capy now. Each repo keeps using the old value
until its PR is merged and pulled.`);
  });

  test('no per-PR location line and no "not changed" line, even with unchanged locations', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      unchanged: refs(2),
      prs: [{ ...pr('SlideSpeak/slidespeak-monorepo', 1), locations: refs(3) }],
    });
    expect(text).not.toMatch(/unchanged|not changed|production/i);
    expect(text.split('\n').filter((l) => l.startsWith('  ') && !l.startsWith('    '))).toEqual(['  SlideSpeak/slidespeak-monorepo']);
  });

  test('a failed repo shows ✗ with a coded reason, and the other repos are still listed', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      prs: [pr('SlideSpeak/swot-analysis-generator-server', 15)],
      failed: [{ kind: 'repo', repo: 'SlideSpeak/slidespeak-monorepo', code: ERROR_CODES.KEEP_PR_CREATE_FAILED }],
    });
    expect(text).toContain('  SlideSpeak/swot-analysis-generator-server\n    https://github.com/SlideSpeak/swot-analysis-generator-server/pull/15');
    expect(text).toContain(`  SlideSpeak/slidespeak-monorepo\n    ✗ Creating the PR failed. (${ERROR_CODES.KEEP_PR_CREATE_FAILED})`);
  });

  test('a failed location is listed with its code; "6 locations" counts only what was pushed', () => {
    const text = renderSecretSetConfirmation({
      ...base,
      updated: refs(2),
      failed: [{ kind: 'location', project: 'web', branch: 'production', protected: true, code: ERROR_CODES.PERMISSION_DENIED }],
    });
    expect(text.split('\n')[0]).toBe('✓ ANTHROPIC_API_KEY updated in 2 locations.');
    expect(text).toContain(`web · production  ✗ ${ERROR_CODES.PERMISSION_DENIED}`);
  });

  test('through the screen: the run finishing shows the confirmation, any key leaves and hands it to stdout', () => {
    const running = handleKey(
      applyRepos(handleKey(atLocations(), ENTER).state, { ok: true, links: LINKS, bases: {} }),
      ENTER,
    ).state;
    const done = applyRunDone(running, { ok: true, result: { ...base, updated: refs(4), prs: [pr('SlideSpeak/slidespeak-monorepo', 1)] } });
    expect(flowOf(done).step).toBe('done');
    expect(frame(done)).toContain('✓ ANTHROPIC_API_KEY updated in 4 locations.');
    expect(frame(done)).not.toContain(VALUE);
    const left = press(done, 'x');
    expect(left.quit).toBe(true);
    expect(left.exitText).toContain('https://github.com/SlideSpeak/slidespeak-monorepo/pull/1');
    expect(left.exitText).not.toContain(VALUE);
  });

  test('a run that could not start is a code, never a message, and the value is not in it', () => {
    const running = handleKey(
      applyRepos(handleKey(atLocations(), ENTER).state, { ok: true, links: LINKS, bases: {} }),
      ENTER,
    ).state;
    const done = applyRunDone(running, { ok: false, code: 'UNAVAILABLE' });
    expect(frame(done)).toContain('(UNAVAILABLE)');
    expect(frame(done)).not.toContain(VALUE);
  });
});

describe('existing hotkeys are unchanged', () => {
  const rows = [row({ name: 'STRIPE_KEY' }), row({ name: 'DATABASE_URL' })];

  test('arrows move, Tab cycles the column, Enter opens details, r reveals, q/Esc close, Esc clears then quits', () => {
    const s0 = initialSecretsScreenState(rows);
    expect(press(s0, DOWN).cursorIndex).toBe(1);
    expect(press(s0, '\t').column).not.toBe(s0.column);
    const detail = press(s0, ENTER);
    expect(detail.popup).not.toBeNull();
    expect(press(detail, 'r').popup?.revealed).toBe(true);
    expect(press(detail, 'q').popup).toBeNull();
    expect(press(detail, ESC).popup).toBeNull();
    expect(press(type(s0, 'ab'), ESC).search.query).toBe('');
    expect(press(s0, ESC).quit).toBe(true);
    expect(press(s0, CTRL_C).quit).toBe(true);
  });

  test('q, j, k, / are still search text on the list', () => {
    expect(type(initialSecretsScreenState(rows), 'qjk/').search.query).toBe('qjk/');
  });

  test('Ctrl+U on the list does nothing', () => {
    const s = press(type(initialSecretsScreenState(rows), 'ab'), CTRL_U);
    expect(s.search.query).toBe('ab');
  });
});

// ── The shared Old value / New value layout ─────────────────────────────────

describe('the value dialog layout (ui/valueDialog.ts, shared with capy edit)', () => {
  const MARGIN = 2;
  const ROW = row();
  const fetchedOk = (state: SecretsScreenState): SecretsScreenState => applyValueResult(state, ROW, { status: 'ok', value: OLD });
  const opened = () => fetchedOk(atValue());
  const lineOf = (text: string, label: string): string => text.split('\n').find((l) => l.includes(label)) ?? '';

  test('opening asks for the row\'s current value with the same effect the details view uses', () => {
    const r = handleKey(start(), CTRL_E);
    expect(r.effect).toEqual({ type: 'fetchValue', row: ROW });
    const viaDetails = handleKey(press(start(), ENTER), 'e');
    expect(viaDetails.effect).toEqual({ type: 'fetchValue', row: ROW });
  });

  test('labels in one column; both values start at the same column, empty and typed, at several widths', () => {
    [60, 80, 120].forEach((width) => {
      const empty = strip(render(opened(), width, 30));
      const oldCol = lineOf(empty, 'Old value').indexOf('•');
      expect(oldCol).toBe(MARGIN + 12);
      expect(lineOf(empty, 'New value').indexOf('new value')).toBe(oldCol);
      const typed = strip(render(type(opened(), 'abc'), width, 30));
      expect(lineOf(typed, 'New value').indexOf('•')).toBe(oldCol);
      expect(lineOf(typed, 'Old value').indexOf('•')).toBe(oldCol);
    });
  });

  test('the Old value row is masked with 16 dots and says ctrl+r reveal; there is no box around the input', () => {
    const text = frame(opened());
    expect(lineOf(text, 'Old value')).toContain('•'.repeat(16));
    expect(lineOf(text, 'Old value')).toContain('ctrl+r reveal');
    expect(text).not.toContain('[');
    expect(text).not.toContain(OLD);
  });

  test('the placeholder `new value` is shown while empty and gone after typing; Backspace to empty brings it back', () => {
    expect(lineOf(frame(opened()), 'New value')).toContain('new value');
    const typed = type(opened(), 'r');
    expect(lineOf(frame(typed), 'New value')).not.toContain('new value');
    expect(lineOf(frame(press(typed, '\x7f')), 'New value')).toContain('new value');
    // The placeholder is dim (grey), not part of the value.
    expect(render(opened(), 80, 30)).toContain(`${ESC}[90mnew value${ESC}[0m`);
  });

  test('Ctrl+R toggles the old value on screen; typing r types an r and does not toggle', () => {
    const shown = press(opened(), CTRL_R);
    expect(lineOf(frame(shown), 'Old value')).toContain(OLD);
    expect(frame(shown)).toContain('ctrl+r hide');
    expect(frame(press(shown, CTRL_R))).not.toContain(OLD);
    const typedR = press(shown, 'r');
    expect(flowOf(typedR)).toMatchObject({ buffer: 'r', revealed: true });
    expect(flowOf(press(opened(), 'r', 'r'))).toMatchObject({ buffer: 'rr', revealed: false });
  });

  test('before the value has been read Ctrl+R does nothing; a late result for another row is dropped', () => {
    const loading = atValue();
    expect(frame(loading)).toContain('loading…');
    expect(flowOf(press(loading, CTRL_R))).toMatchObject({ revealed: false });
    const other = applyValueResult(loading, { name: 'OTHER', value_hash: 'x' }, { status: 'ok', value: OLD });
    expect(frame(press(other, CTRL_R))).not.toContain(OLD);
  });

  test('an old value that cannot be read: a short coded note instead of dots, and Ctrl+R does nothing', () => {
    const failed = applyValueResult(atValue(), ROW, { status: 'unavailable', code: ERROR_CODES.PERMISSION_DENIED });
    expect(lineOf(frame(failed), 'Old value')).toContain(`unavailable (${ERROR_CODES.PERMISSION_DENIED})`);
    expect(lineOf(frame(failed), 'Old value')).not.toContain('•');
    expect(frame(press(failed, CTRL_R))).not.toContain('ctrl+r hide');
    expect(frame(failed)).toContain('enter next · esc cancel');
  });

  test('going on and back keeps the old value (still masked); the revealed old value is in no later frame or exit text', () => {
    const revealed = press(type(opened(), VALUE), CTRL_R);
    expect(frame(revealed)).toContain(OLD);
    const locations = press(revealed, ENTER);
    expect(frame(locations)).not.toContain(OLD);
    const back = press(locations, ESC);
    expect(flowOf(back)).toMatchObject({ step: 'value', revealed: false, buffer: VALUE });
    expect(frame(back)).not.toContain(OLD);
    const loading = handleKey(press(locations, ENTER), ENTER).state;
    const repos = applyRepos(loading, { ok: true, links: LINKS, bases: {} });
    const running = handleKey(repos, ENTER).state;
    const done = applyRunDone(running, { ok: true, result: { name: 'ANTHROPIC_API_KEY', updated: [], unchanged: [], prs: [], no_pr: [], failed: [] } });
    [locations, loading, repos, running, done].forEach((st) => {
      expect(frame(st)).not.toContain(OLD);
      expect(frame(st)).not.toContain(VALUE);
    });
    const left = press(done, 'x');
    expect(left.exitText ?? '').not.toContain(OLD);
    expect(left.exitText ?? '').not.toContain(VALUE);
  });

  test('dry run: the same layout with the DRY RUN marker, and reveal still works', () => {
    const dry = applyValueResult(press(initialSecretsScreenState([row()], true), CTRL_E), ROW, { status: 'ok', value: OLD });
    expect(frame(dry)).toContain('DRY RUN');
    expect(lineOf(frame(dry), 'Old value')).toContain('•'.repeat(16));
    expect(lineOf(frame(press(dry, CTRL_R)), 'Old value')).toContain(OLD);
  });

  // ── One Ctrl+R toggle for both rows ───────────────────────────────────────

  test('Ctrl+R reveals the typed value as well: plain text with the count; hidden it is dots', () => {
    const typed = type(opened(), 'abc');
    expect(lineOf(frame(typed), 'New value')).toContain('•••');
    const shown = press(typed, CTRL_R);
    expect(lineOf(frame(shown), 'New value')).toContain('abc');
    expect(lineOf(frame(shown), 'New value')).toContain('(3 characters)');
    expect(lineOf(frame(shown), 'Old value')).toContain(OLD);
    expect(lineOf(frame(press(shown, CTRL_R)), 'New value')).not.toContain('abc');
  });

  test('revealed, line breaks show as ↵ and tabs as spaces (the same inline rendering as the old value)', () => {
    const pasted = type(opened(), `${ESC}[200~l1\r\nl2\tx${ESC}[201~`);
    const shown = frame(press(pasted, CTRL_R));
    expect(lineOf(shown, 'New value')).toContain('l1↵l2 x');
  });

  test('both rows stay aligned when revealed, at several widths', () => {
    [60, 100].forEach((width) => {
      const shown = strip(render(press(type(opened(), 'abc'), CTRL_R), width, 30));
      expect(lineOf(shown, 'Old value').indexOf(OLD)).toBe(MARGIN + 12);
      expect(lineOf(shown, 'New value').indexOf('abc')).toBe(MARGIN + 12);
    });
  });

  test('old value unreadable: no hint while empty, Ctrl+R does nothing; with typed text the hint appears and the toggle reveals just the new value', () => {
    const failed = applyValueResult(atValue(), ROW, { status: 'unavailable', code: ERROR_CODES.PERMISSION_DENIED });
    expect(frame(failed)).not.toContain('ctrl+r');
    expect(flowOf(press(failed, CTRL_R))).toMatchObject({ revealed: false });
    const typed = type(failed, 'xy');
    expect(frame(typed)).toContain('enter next · ctrl+r reveal · esc cancel');
    const shown = press(typed, CTRL_R);
    expect(lineOf(frame(shown), 'New value')).toContain('xy');
    expect(lineOf(frame(shown), 'Old value')).toContain(`unavailable (${ERROR_CODES.PERMISSION_DENIED})`);
    expect(frame(shown)).toContain('ctrl+r hide');
  });

  test('the revealed typed value is drawn nowhere past the value step, and is not in the exit text', () => {
    const revealed = press(type(opened(), VALUE), CTRL_R);
    expect(frame(revealed)).toContain(VALUE);
    const locations = press(revealed, ENTER);
    const loading = handleKey(locations, ENTER).state;
    const repos = applyRepos(loading, { ok: true, links: LINKS, bases: {} });
    const running = handleKey(repos, ENTER).state;
    const done = applyRunDone(running, { ok: true, result: { name: 'ANTHROPIC_API_KEY', updated: [], unchanged: [], prs: [], no_pr: [], failed: [] } });
    [locations, loading, repos, running, done].forEach((st) => expect(frame(st)).not.toContain(VALUE));
    expect(press(done, 'x').exitText ?? '').not.toContain(VALUE);
    // And going back to the value step starts hidden again.
    expect(frame(press(locations, ESC))).not.toContain(VALUE);
  });
});
