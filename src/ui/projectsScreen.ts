// Interactive TUI for `capy projects`.
//
// Same pure core / imperative shell split as `capy secrets` (secretsScreen.ts):
// `handleKey(state, key)` is a pure reducer and `render(state, width, height)`
// a pure function of state. The driver (`projectsScreenDriver.ts`) owns every
// side effect.
//
// Two levels: the project list (type to filter by name, Enter opens one), and
// inside one project the `capy secrets` screen limited to that project's
// locations — the same reducer and renderer, embedded with a
// `SecretsScreenScope`, so search, edit and deploy are the ones `capy secrets`
// has, not copies.
//
// What the service did not return to the caller is hidden, never shown empty:
// the org secrets index (403 for a plain member) hides the Variables and Last
// updated columns and the project's Secrets tab; the repo links hide the Linked
// repo column. Every such decision keys off a status, a code or a field being
// absent — `ProjectsData` carries `null` for "not returned".
//
// The index this screen reads carries names and hashes only: nothing here can
// show a value (the embedded secrets screen reveals one on request, exactly as
// `capy secrets` does).

import type { MemberDetail, SecretIndexRow, SecretIndexSkipped } from '../service/serviceClient';
import { formatRepo, type ProjectRepoSummary } from '../commands/projectsCommand';
import { DRY_RUN_LABEL } from '../commands/secretsSetText';
import { formatRelativeTime } from './relativeTime';
import { ACCENT } from './colors';
import { filterByQuery } from './searchMatch';
import { clipLine, truncateCell } from './pickerTable';
import {
  type SecretsScreenEffect,
  type SecretsScreenState,
  handleKey as handleSecretsKey,
  initialSecretsScreenState,
  render as renderSecrets,
  scopeRowKey,
} from './secretsScreen';

// ── ANSI and keys (the same ones `capy secrets` reads) ─────────────────────────

const ESC = '\x1b';
const CLEAR_EOL = `${ESC}[K`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const YELLOW = `${ESC}[33m`;

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_RIGHT = `${ESC}[C`;
const KEY_LEFT = `${ESC}[D`;
const KEY_PGUP = `${ESC}[5~`;
const KEY_PGDN = `${ESC}[6~`;
const KEY_TAB = '\t';
const KEY_SHIFT_TAB = `${ESC}[Z`;
const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const KEY_CTRL_C = '\x03';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_BACKSPACE2 = '\b';

const PAGE_SIZE = 10;
const MARGIN = 2;

// ── Data ──────────────────────────────────────────────────────────────────────

/** One live project, as `GET /projects` (and its branch list) describes it. */
export interface ProjectItem {
  readonly id: string;
  readonly name: string;
  /** Absent from services that predate it: `null`. */
  readonly createdAt: string | null;
  readonly branches: readonly { readonly name: string; readonly protected: boolean }[];
  /** Linked repos; absent when they were not returned to the caller (the Git repos tab is then hidden). `[]`: none linked. */
  readonly repos?: readonly ProjectRepoSummary[];
}

/** The org secrets index (`GET /orgs/:orgId/secrets`), fetched once. */
export interface ProjectsIndex {
  readonly rows: readonly SecretIndexRow[];
  readonly skipped: readonly SecretIndexSkipped[];
  /**
   * The projects the index covers: the caller's `admin_projects` from
   * `GET /orgs/:orgId/me` (the index lists exactly the projects the caller
   * administers). `null` when that could not be read: a project then counts as
   * covered only when the index has rows for it.
   */
  readonly coveredProjectIds: readonly string[] | null;
}

/** Everything the screen shows. `null` (or `reposShown: false`) means the service did not return it to the caller. */
export interface ProjectsData {
  readonly projects: readonly ProjectItem[];
  readonly index: ProjectsIndex | null;
  readonly members: readonly MemberDetail[] | null;
  /** Whether the org's repo links were returned (the Linked repo column). */
  readonly reposShown: boolean;
}

/**
 * What the index says about one project: `hidden` when it was not returned for
 * it (no index, a skipped project, or one the caller does not administer),
 * `empty` when it was and the project has no secrets yet, `rows` otherwise.
 */
export type ProjectIndexState = 'hidden' | 'empty' | 'rows';

export function projectIndexState(index: ProjectsIndex | null, projectId: string): ProjectIndexState {
  if (index === null) return 'hidden';
  if (index.skipped.some((s) => s.project_id === projectId)) return 'hidden';
  if (index.rows.some((r) => r.locations.some((l) => l.project_id === projectId))) return 'rows';
  return index.coveredProjectIds !== null && index.coveredProjectIds.includes(projectId) ? 'empty' : 'hidden';
}

/** The index rows of one project, each keeping only that project's locations. Rows with none there are left out. */
export function projectRows(rows: readonly SecretIndexRow[], projectId: string): readonly SecretIndexRow[] {
  return rows
    .map((row) => ({ ...row, locations: row.locations.filter((l) => l.project_id === projectId) }))
    .filter((row) => row.locations.length > 0);
}

/** For each row with a location in `projectId`: how many OTHER projects its (name, value) also lives in, by `scopeRowKey`. Only rows with at least one are listed. */
export function otherProjectCounts(rows: readonly SecretIndexRow[], projectId: string): Readonly<Record<string, number>> {
  return Object.fromEntries(
    rows
      .filter((row) => row.locations.some((l) => l.project_id === projectId))
      .map((row) => [scopeRowKey(row), new Set(row.locations.map((l) => l.project_id).filter((id) => id !== projectId)).size] as const)
      .filter(([, count]) => count > 0),
  );
}

/** How many variable NAMES the project has in the index (a name with different values on two branches counts once). `null`: not returned. */
export function variableCount(index: ProjectsIndex | null, projectId: string): number | null {
  const state = projectIndexState(index, projectId);
  if (index === null || state === 'hidden') return null;
  return new Set(projectRows(index.rows, projectId).map((r) => r.name)).size;
}

/** Epoch ms of an ISO time, or `null` when it is not one. */
function timeOf(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When the project last changed: the latest `changed_at` across its locations
 * in the index; the project's creation time when none carries one (entries
 * written before it was tracked). `null` when the index was not returned for
 * it, or neither time is known.
 */
export function lastUpdatedOf(index: ProjectsIndex | null, project: ProjectItem): string | null {
  if (index === null || projectIndexState(index, project.id) === 'hidden') return null;
  const stamps = projectRows(index.rows, project.id)
    .flatMap((r) => r.locations.map((l) => l.changed_at))
    .filter((t): t is string => t !== undefined && timeOf(t) !== null);
  if (stamps.length === 0) return project.createdAt;
  return stamps.reduce((latest, t) => ((timeOf(t) ?? 0) > (timeOf(latest) ?? 0) ? t : latest));
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Inside one project. */
export interface ProjectView {
  readonly projectId: string;
  /** The project's secrets: the `capy secrets` screen over this project's rows. */
  readonly secrets: SecretsScreenState;
}

export interface ProjectsScreenState {
  readonly data: ProjectsData;
  /** `capy --dry-run projects`: the embedded edit and deploy flows only plan. */
  readonly dryRun: boolean;
  /** The list's search. */
  readonly query: string;
  /** The list's cursor, an index into the filtered list. */
  readonly cursor: number;
  /** The project that is open, or `null` on the list. */
  readonly open: ProjectView | null;
  readonly quit: boolean;
  /** Printed after the screen is left (the embedded edit and deploy confirmations). */
  readonly exitText: string | null;
}

export function initialProjectsScreenState(data: ProjectsData, dryRun: boolean = false): ProjectsScreenState {
  return { data, dryRun, query: '', cursor: 0, open: null, quit: false, exitText: null };
}

/** The projects the search shows, in the service's order. */
export function filteredProjects(state: Pick<ProjectsScreenState, 'data' | 'query'>): readonly ProjectItem[] {
  return filterByQuery(state.data.projects, state.query, (p) => p.name);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function projectById(data: ProjectsData, id: string): ProjectItem | undefined {
  return data.projects.find((p) => p.id === id);
}

// ── Reducer ───────────────────────────────────────────────────────────────────

/** The screen's own effects (none yet: everything it starts belongs to the embedded secrets screen). */
export type ProjectsOwnEffect = { readonly type: 'projectsNone' };

export type ProjectsScreenEffect = SecretsScreenEffect | ProjectsOwnEffect;

export interface ProjectsReduceResult {
  readonly state: ProjectsScreenState;
  readonly effect: ProjectsScreenEffect;
}

const noEffect = (state: ProjectsScreenState): ProjectsReduceResult => ({ state, effect: null });

/** Pure reducer: `(state, key) => { state, effect }`. */
export function handleKey(state: ProjectsScreenState, key: string): ProjectsReduceResult {
  if (state.open) return handleProjectKey(state, state.open, key);
  return handleListKey(state, key);
}

/** Opens `project`: its secrets screen, scoped to its rows. */
function openProject(state: ProjectsScreenState, project: ProjectItem): ProjectsScreenState {
  const index = state.data.index;
  const rows = index === null ? [] : projectRows(index.rows, project.id);
  const scope = {
    title: project.name,
    otherProjects: index === null ? {} : otherProjectCounts(index.rows, project.id),
    hints: [],
  };
  return { ...state, open: { projectId: project.id, secrets: initialSecretsScreenState(rows, state.dryRun, scope) } };
}

/** The list: a search bar that is always live (like `capy secrets`), arrows to move, Enter to open. */
function handleListKey(state: ProjectsScreenState, key: string): ProjectsReduceResult {
  const projects = filteredProjects(state);
  if (key === KEY_CTRL_C) return noEffect({ ...state, quit: true });
  if (key === KEY_ESC || key === KEY_ESC_ESC) {
    return noEffect(state.query !== '' ? withQuery(state, '') : { ...state, quit: true });
  }
  if (key === KEY_UP) return noEffect({ ...state, cursor: clampIndex(state.cursor - 1, projects.length) });
  if (key === KEY_DOWN) return noEffect({ ...state, cursor: clampIndex(state.cursor + 1, projects.length) });
  if (key === KEY_PGUP) return noEffect({ ...state, cursor: clampIndex(state.cursor - PAGE_SIZE, projects.length) });
  if (key === KEY_PGDN) return noEffect({ ...state, cursor: clampIndex(state.cursor + PAGE_SIZE, projects.length) });
  if (key === KEY_ENTER) {
    const project = projects[clampIndex(state.cursor, projects.length)];
    return noEffect(project ? openProject(state, project) : state);
  }
  if (key === KEY_BACKSPACE || key === KEY_BACKSPACE2) return noEffect(withQuery(state, state.query.slice(0, -1)));
  if (key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) !== 0x7f) return noEffect(withQuery(state, state.query + key));
  return noEffect(state);
}

/** Sets the list's search and keeps the cursor inside what it now shows. */
function withQuery(state: ProjectsScreenState, query: string): ProjectsScreenState {
  const shown = filteredProjects({ data: state.data, query });
  return { ...state, query, cursor: clampIndex(state.cursor, shown.length) };
}

/** The embedded secrets screen is on its list, with nothing open over it. */
function secretsIdle(secrets: SecretsScreenState): boolean {
  return secrets.popup === null && secrets.edit === null && secrets.deploy === null && secrets.sortMenu === null;
}

/**
 * Whether `key` belongs to the embedded secrets screen. Everything does while
 * one of its dialogs (details, edit, deploy, sort) is open. On its list, the
 * project screen keeps Tab, Shift-Tab and Ctrl-C, and Esc once the search is
 * empty (Esc then goes back instead of quitting).
 */
function secretsOwnsKey(secrets: SecretsScreenState, key: string): boolean {
  if (!secretsIdle(secrets)) return true;
  if (key === KEY_TAB || key === KEY_SHIFT_TAB || key === KEY_CTRL_C) return false;
  if (key === KEY_ESC || key === KEY_ESC_ESC) return secrets.search.query !== '';
  return true;
}

/** On the embedded list, ←/→ move its column (Tab is the project screen's). */
function translateForSecrets(secrets: SecretsScreenState, key: string): string {
  if (!secretsIdle(secrets)) return key;
  if (key === KEY_RIGHT) return KEY_TAB;
  if (key === KEY_LEFT) return KEY_SHIFT_TAB;
  return key;
}

/** One key, passed to the embedded secrets screen. When it quits (an edit or deploy finished), so does this screen, with its text. */
function forwardToSecrets(state: ProjectsScreenState, view: ProjectView, key: string): ProjectsReduceResult {
  const stepped = handleSecretsKey(view.secrets, translateForSecrets(view.secrets, key));
  if (stepped.state.quit) return { state: { ...state, quit: true, exitText: stepped.state.exitText }, effect: stepped.effect };
  return { state: { ...state, open: { ...view, secrets: stepped.state } }, effect: stepped.effect };
}

function handleProjectKey(state: ProjectsScreenState, view: ProjectView, key: string): ProjectsReduceResult {
  const project = projectById(state.data, view.projectId);
  if (project === undefined) return noEffect({ ...state, open: null });
  if (secretsOwnsKey(view.secrets, key)) return forwardToSecrets(state, view, key);
  if (key === KEY_CTRL_C) return noEffect({ ...state, quit: true });
  if (key === KEY_ESC || key === KEY_ESC_ESC) return noEffect({ ...state, open: null });
  return noEffect(state);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function visLen(s: string): number {
  return Array.from(s.replace(/\x1b\[[0-9;]*m/g, '')).length;
}

function padTo(text: string, width: number): string {
  const cell = truncateCell(text, width);
  return cell + ' '.repeat(Math.max(0, width - visLen(cell)));
}

function dryRunTag(dryRun: boolean): string {
  return dryRun ? `  ${BOLD}${YELLOW}${DRY_RUN_LABEL}${RESET}` : '';
}

const renderHint = (key: string | null, label: string): string => (key === null ? `${DIM}${label}${RESET}` : `${BOLD}${key}${RESET}${DIM} ${label}${RESET}`);
const joinHints = (hints: readonly string[]): string => hints.join(`${DIM} · ${RESET}`);

/** The list's columns: NAME always; the others only when the service returned their data. */
interface ListColumn {
  readonly heading: string;
  readonly width: number;
  readonly cell: (project: ProjectItem) => string;
}

/** `owner/name` of the first linked repo, `+N` for more; `—` for none (or not returned). */
export function linkedRepoCell(project: ProjectItem): string {
  const repos = project.repos ?? [];
  if (repos.length === 0) return '—';
  return repos.length > 1 ? `${formatRepo(repos[0])} +${repos.length - 1}` : formatRepo(repos[0]);
}

export function variablesCell(index: ProjectsIndex | null, project: ProjectItem): string {
  const count = variableCount(index, project.id);
  return count === null ? '—' : String(count);
}

export function lastUpdatedCell(index: ProjectsIndex | null, project: ProjectItem, now?: Date): string {
  const at = lastUpdatedOf(index, project);
  return at === null ? '—' : formatRelativeTime(at, now);
}

function listColumns(data: ProjectsData, available: number): readonly ListColumn[] {
  const variables: readonly ListColumn[] = data.index === null
    ? []
    : [{ heading: 'VARIABLES', width: 10, cell: (p) => variablesCell(data.index, p) }]; // COPY-FLAG
  const updated: readonly ListColumn[] = data.index === null
    ? []
    : [{ heading: 'LAST UPDATED', width: 14, cell: (p) => lastUpdatedCell(data.index, p) }]; // COPY-FLAG
  const fixed = [...variables, ...updated].reduce((sum, c) => sum + c.width + MARGIN, 0);
  const rest = Math.max(16, available - 2 - fixed);
  const nameW = data.reposShown ? Math.max(16, Math.floor(rest * 0.5)) : rest;
  const repo: readonly ListColumn[] = data.reposShown
    ? [{ heading: 'LINKED REPO', width: Math.max(10, rest - nameW - MARGIN), cell: linkedRepoCell }] // COPY-FLAG
    : [];
  return [{ heading: 'NAME', width: nameW, cell: (p) => p.name }, ...variables, ...repo, ...updated];
}

/** The scroll offset that keeps `cursor` in a window of `height` lines. */
function scrollFor(cursor: number, count: number, height: number): number {
  if (cursor < height) return 0;
  return Math.min(cursor - height + 1, Math.max(0, count - height));
}

function renderList(state: ProjectsScreenState, termWidth: number, termHeight: number): readonly string[] {
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);
  const projects = filteredProjects(state);
  const total = state.data.projects.length;
  const cursor = clampIndex(state.cursor, projects.length);
  const columns = listColumns(state.data, available);
  const gap = ' '.repeat(MARGIN);
  const placeholder = `${DIM}type to filter by project name${RESET}`; // COPY-FLAG
  const query = state.query === '' ? placeholder : `${ACCENT}${state.query}${RESET}`;

  const head: readonly string[] = [
    `${m}${BOLD}capy projects${RESET}${dryRunTag(state.dryRun)} ${DIM}(${total} project${total === 1 ? '' : 's'})${RESET}`,
    `${m}${DIM}search:${RESET} ${query}▏ ${DIM}${projects.length}/${total}${RESET}`,
    '',
    `${m}${DIM}  ${columns.map((c) => padTo(c.heading, c.width)).join(gap)}${RESET}`,
  ];
  const rows = projects.map((p, i) => {
    const pointer = i === cursor ? '▶ ' : '  ';
    const line = pointer + columns.map((c) => padTo(c.cell(p), c.width)).join(gap);
    return i === cursor ? `${INVERSE}${padTo(line, available)}${RESET}` : line;
  });
  const footer: readonly string[] = [
    '',
    m + joinHints([
      renderHint(null, '↑↓ navigate'), // COPY-FLAG
      renderHint('enter', 'open'), // COPY-FLAG
      renderHint('esc', 'clear/quit'), // COPY-FLAG
    ]),
  ];
  const bodyHeight = Math.max(3, termHeight - head.length - footer.length);
  const offset = scrollFor(cursor, rows.length, bodyHeight);
  const emptyLine = total === 0 ? 'No projects found.' : 'No projects match.'; // COPY-FLAG: "No projects match." is new
  const body = rows.length === 0 ? [`${m}${DIM}${emptyLine}${RESET}`] : rows.slice(offset, offset + bodyHeight).map((l) => m + l);
  return [...head, ...body, ...footer];
}

function renderProject(state: ProjectsScreenState, view: ProjectView, termWidth: number, termHeight: number): string {
  return renderSecrets(view.secrets, termWidth, termHeight);
}

/** Pure render: a total function of state and terminal size. No line is wider than the terminal. */
export function render(state: ProjectsScreenState, termWidth: number, termHeight: number): string {
  if (state.open) return renderProject(state, state.open, termWidth, termHeight);
  const width = Math.max(1, termWidth);
  return renderList(state, termWidth, termHeight)
    .map((l) => clipLine(l, width) + CLEAR_EOL)
    .join('\n');
}
