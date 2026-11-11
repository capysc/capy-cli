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

import type { MemberDetail, SecretIndexLocation, SecretIndexRow, SecretIndexSkipped } from '../service/serviceClient';
import { formatRepo, type ProjectRepoSummary } from '../commands/projectsCommand';
import { DRY_RUN_LABEL } from '../commands/secretsSetText';
import { formatRelativeTime } from './relativeTime';
import { ACCENT } from './colors';
import { filterByQuery } from './searchMatch';
import { clipLine, truncateCell } from './pickerTable';
import { BEHIND_LABEL, DEPLOYED_LABEL, TARGET_STATUS_HEADING } from '../core/deployStatus';
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

// ── Tabs ──────────────────────────────────────────────────────────────────────

export type ProjectTab = 'secrets' | 'users' | 'repos' | 'branches' | 'deployments' | 'connectors';
/** Tab moves forward through this order (wrapping), Shift-Tab back. Secrets is selected when a project opens. */
export const PROJECT_TABS: readonly ProjectTab[] = ['secrets', 'users', 'repos', 'branches', 'deployments', 'connectors'];

const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  secrets: 'Secrets', // COPY-FLAG
  users: 'Users', // COPY-FLAG
  repos: 'Git repos', // COPY-FLAG
  branches: 'Capy branches', // COPY-FLAG
  deployments: 'Deployments', // COPY-FLAG
  connectors: 'Connectors', // COPY-FLAG
};

/**
 * The tabs a project shows: only those whose data the service returned to the
 * caller. Secrets, Deployments and Connectors come from the secrets index;
 * Users from the member list; Git repos from the project's linked repos.
 */
export function visibleTabs(data: ProjectsData, project: ProjectItem): readonly ProjectTab[] {
  const indexShown = projectIndexState(data.index, project.id) !== 'hidden';
  const shown: Readonly<Record<ProjectTab, boolean>> = {
    secrets: indexShown,
    users: data.members !== null,
    repos: project.repos !== undefined,
    branches: true,
    deployments: indexShown,
    connectors: indexShown,
  };
  return PROJECT_TABS.filter((t) => shown[t]);
}

function stepTab(tabs: readonly ProjectTab[], current: ProjectTab, dir: 1 | -1): ProjectTab {
  const idx = Math.max(0, tabs.indexOf(current));
  return tabs[(idx + dir + tabs.length) % tabs.length] ?? current;
}

/** One line of a tab's table: its cells, in the tab's column order. */
type TabRow = readonly string[];

interface TabTable {
  readonly headings: readonly string[];
  readonly rows: readonly TabRow[];
}

/**
 * The project's members and their roles: everyone with a role in this project
 * (their project role), plus the org's owners and admins, who reach every
 * project (their org role).
 */
export function projectMembers(members: readonly MemberDetail[], projectId: string): readonly { readonly email: string; readonly role: string }[] {
  return members.flatMap((m) => {
    const membership = m.projects.find((p) => p.id === projectId);
    if (membership !== undefined) return [{ email: m.email, role: membership.role ?? m.role }];
    return ORG_WIDE_ROLES.includes(m.role) ? [{ email: m.email, role: m.role }] : [];
  });
}

/** Org roles that reach every project (the service's own role values). */
const ORG_WIDE_ROLES: readonly string[] = ['owner', 'admin'];

/** One deploy target of one branch, as `capy secrets` records it: when it was last deployed, and whether it is behind or pending. */
export interface DeploymentEntry {
  readonly provider: string;
  readonly target: string;
  readonly branch: string;
  readonly lastDeployedAt: string | null;
  /** Some variable there holds an older value than Capy has. */
  readonly behind: boolean;
  /** Written with `capy deploy --no-deploy` and not shipped yet. */
  readonly pending: boolean;
}

/** Every (target, branch) of the project's rows, each once: the latest delivery, behind if any variable is, pending if any is. */
export function projectDeployments(rows: readonly SecretIndexRow[]): readonly DeploymentEntry[] {
  const flat = rows.flatMap((r) => r.locations.flatMap((l) => (l.targets ?? []).map((t) => ({ ...t, branch: l.branch }))));
  const keyOf = (t: { readonly provider: string; readonly target: string; readonly branch: string }): string => JSON.stringify([t.provider, t.target, t.branch]);
  const keys = Array.from(new Set(flat.map(keyOf)));
  return keys.map((key) => {
    const group = flat.filter((t) => keyOf(t) === key);
    const stamps = group.map((t) => t.deployed_at).filter((d): d is string => d !== undefined && timeOf(d) !== null);
    return {
      provider: group[0].provider,
      target: group[0].target,
      branch: group[0].branch,
      lastDeployedAt: stamps.length === 0 ? null : stamps.reduce((a, b) => ((timeOf(b) ?? 0) > (timeOf(a) ?? 0) ? b : a)),
      behind: group.some((t) => t.stale),
      pending: group.some((t) => t.pending === true),
    };
  });
}

/** A location's inbound connector: `connector.provider`, falling back to `service.provider` (a server that predates `connector`). */
function connectorProviderOf(location: SecretIndexLocation): string | undefined {
  return location.connector?.provider ?? location.service?.provider;
}

/** Each variable and branch whose value came in through a connector, with that connector. */
export function projectConnectors(rows: readonly SecretIndexRow[]): readonly { readonly name: string; readonly branch: string; readonly connector: string }[] {
  return rows.flatMap((r) =>
    r.locations.flatMap((l) => {
      const provider = connectorProviderOf(l);
      if (provider === undefined) return [];
      const name = l.service?.name;
      return [{ name: r.name, branch: l.branch, connector: name ? `[${provider}] ${name}` : `[${provider}]` }];
    }),
  );
}

/** The table a (non-Secrets) tab shows. */
export function tabTable(data: ProjectsData, project: ProjectItem, tab: ProjectTab, now?: Date): TabTable {
  const rows = data.index === null ? [] : projectRows(data.index.rows, project.id);
  if (tab === 'users') {
    return { headings: ['EMAIL', 'ROLE'], rows: projectMembers(data.members ?? [], project.id).map((m) => [m.email, m.role]) }; // COPY-FLAG: EMAIL, ROLE
  }
  if (tab === 'repos') return { headings: ['REPO'], rows: (project.repos ?? []).map((r) => [formatRepo(r)]) };
  if (tab === 'branches') {
    return { headings: ['BRANCH'], rows: project.branches.map((b) => [b.protected ? `${b.name} (protected)` : b.name]) };
  }
  if (tab === 'deployments') {
    return {
      headings: ['TARGET', 'BRANCH', 'LAST DEPLOYED', TARGET_STATUS_HEADING], // COPY-FLAG: LAST DEPLOYED
      rows: projectDeployments(rows).map((d) => [
        `[${d.provider}] ${d.target}`,
        d.branch,
        d.lastDeployedAt === null ? '—' : formatRelativeTime(d.lastDeployedAt, now),
        `${d.behind ? BEHIND_LABEL : DEPLOYED_LABEL}${d.pending ? ' (pending)' : ''}`,
      ]),
    };
  }
  if (tab === 'connectors') {
    return { headings: ['NAME', 'BRANCH', 'CONNECTOR'], rows: projectConnectors(rows).map((c) => [c.name, c.branch, c.connector]) };
  }
  return { headings: [], rows: [] };
}

/** What the Secrets tab says for a project nobody has pushed secrets to yet. */
export const NO_SECRETS_YET_LINES: readonly string[] = [
  'This project has no secrets yet.', // COPY-FLAG
  'To add some, run `capy push` from a folder linked to this project.', // COPY-FLAG
];

// ── State ─────────────────────────────────────────────────────────────────────

/** Inside one project. */
export interface ProjectView {
  readonly projectId: string;
  /** The selected tab: one of `visibleTabs`. */
  readonly tab: ProjectTab;
  /** The project's secrets: the `capy secrets` screen over this project's rows. Kept while other tabs are shown. */
  readonly secrets: SecretsScreenState;
  /** The first line shown of a (non-Secrets) tab's table. */
  readonly scroll: number;
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
    hints: [{ key: 'tab', label: 'next tab' }], // COPY-FLAG
  };
  const tab = visibleTabs(state.data, project)[0] ?? 'branches';
  return { ...state, open: { projectId: project.id, tab, secrets: initialSecretsScreenState(rows, state.dryRun, scope), scroll: 0 } };
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

/** The Secrets tab is showing the embedded secrets screen (the project has rows in the index). */
function onSecretsScreen(data: ProjectsData, view: ProjectView): boolean {
  return view.tab === 'secrets' && projectIndexState(data.index, view.projectId) === 'rows';
}

/**
 * Inside a project. On the Secrets tab, keys go to the embedded secrets screen
 * (see `secretsOwnsKey`). Otherwise: Tab / Shift-Tab change tab, Esc goes back
 * to the list, the arrows scroll the tab's table, Ctrl-C quits.
 */
function handleProjectKey(state: ProjectsScreenState, view: ProjectView, key: string): ProjectsReduceResult {
  const project = projectById(state.data, view.projectId);
  if (project === undefined) return noEffect({ ...state, open: null });
  if (onSecretsScreen(state.data, view) && secretsOwnsKey(view.secrets, key)) return forwardToSecrets(state, view, key);
  if (key === KEY_CTRL_C) return noEffect({ ...state, quit: true });
  if (key === KEY_ESC || key === KEY_ESC_ESC) return noEffect({ ...state, open: null });
  const tabs = visibleTabs(state.data, project);
  if (key === KEY_TAB) return noEffect({ ...state, open: { ...view, tab: stepTab(tabs, view.tab, 1), scroll: 0 } });
  if (key === KEY_SHIFT_TAB) return noEffect({ ...state, open: { ...view, tab: stepTab(tabs, view.tab, -1), scroll: 0 } });
  const lastLine = Math.max(0, tabTable(state.data, project, view.tab).rows.length - 1);
  const scrollBy = (delta: number): ProjectsReduceResult =>
    noEffect({ ...state, open: { ...view, scroll: Math.max(0, Math.min(lastLine, view.scroll + delta)) } });
  if (key === KEY_UP) return scrollBy(-1);
  if (key === KEY_DOWN) return scrollBy(1);
  if (key === KEY_PGUP) return scrollBy(-PAGE_SIZE);
  if (key === KEY_PGDN) return scrollBy(PAGE_SIZE);
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

/** The tab bar: every visible tab, the selected one highlighted, then how to move between them. */
function tabBarLine(tabs: readonly ProjectTab[], selected: ProjectTab): string {
  const labels = tabs.map((t) => (t === selected ? `${INVERSE}${BOLD} ${TAB_LABELS[t]} ${RESET}` : `${DIM} ${TAB_LABELS[t]} ${RESET}`));
  return `${' '.repeat(MARGIN)}${labels.join(' ')}  ${DIM}⇥${RESET}`;
}

/** A tab's table: dim headings, then its rows from `scroll`, fitted to `available` columns. `(none)` when it has no rows. */
function tabTableLines(table: TabTable, scroll: number, height: number, available: number): readonly string[] {
  const m = ' '.repeat(MARGIN);
  if (table.rows.length === 0) return [`${m}${DIM}(none)${RESET}`];
  const gap = ' '.repeat(MARGIN);
  const natural = table.headings.map((h, i) => Math.max(visLen(h), ...table.rows.map((r) => visLen(r[i] ?? ''))));
  // The last column takes what is left, so a long cell is cut there rather than pushing the others off screen.
  const widths = natural.map((w, i) =>
    i === natural.length - 1 ? Math.max(4, available - natural.slice(0, -1).reduce((sum, n) => sum + n + MARGIN, 0)) : w,
  );
  const line = (cells: readonly string[]): string => cells.map((c, i) => padTo(c, widths[i])).join(gap).trimEnd();
  const shown = table.rows.slice(scroll, scroll + Math.max(1, height - 1));
  return [`${m}${DIM}${line(table.headings)}${RESET}`, ...shown.map((r) => m + line(r))];
}

function projectFooter(): string {
  return joinHints([
    renderHint(null, '↑↓ scroll'), // COPY-FLAG
    renderHint('tab', 'next tab'), // COPY-FLAG
    renderHint('esc', 'back'), // COPY-FLAG
  ]);
}

/**
 * Inside a project. The Secrets tab is the embedded secrets screen with the tab
 * bar under its title; its edit, deploy and sort screens take the whole
 * terminal, as in `capy secrets`. Every other tab is a table.
 */
function renderProject(state: ProjectsScreenState, view: ProjectView, termWidth: number, termHeight: number): string {
  const project = projectById(state.data, view.projectId);
  if (project === undefined) return '';
  const tabs = visibleTabs(state.data, project);
  const width = Math.max(1, termWidth);
  const finish = (lines: readonly string[]): string => lines.map((l) => clipLine(l, width) + CLEAR_EOL).join('\n');

  if (onSecretsScreen(state.data, view)) {
    const secrets = view.secrets;
    if (secrets.edit !== null || secrets.deploy !== null || secrets.sortMenu !== null) return renderSecrets(secrets, termWidth, termHeight);
    // Each of its lines ends in CLEAR_EOL; they are re-fitted to the terminal here (its search bar can be wider).
    const [title, ...rest] = renderSecrets(secrets, termWidth, Math.max(1, termHeight - 1))
      .split('\n')
      .map((l) => (l.endsWith(CLEAR_EOL) ? l.slice(0, -CLEAR_EOL.length) : l));
    return finish([title, tabBarLine(tabs, view.tab), ...rest]);
  }

  const m = ' '.repeat(MARGIN);
  const available = Math.max(20, termWidth - MARGIN * 2);
  const head: readonly string[] = [`${m}${BOLD}${project.name}${RESET}${dryRunTag(state.dryRun)}`, tabBarLine(tabs, view.tab), ''];
  const footer: readonly string[] = ['', m + projectFooter()];
  const bodyHeight = Math.max(3, termHeight - head.length - footer.length);
  const body = view.tab === 'secrets'
    ? NO_SECRETS_YET_LINES.map((l) => `${m}${l}`)
    : tabTableLines(tabTable(state.data, project, view.tab), view.scroll, bodyHeight, available);
  return finish([...head, ...body, ...footer]);
}

/** Pure render: a total function of state and terminal size. No line is wider than the terminal. */
export function render(state: ProjectsScreenState, termWidth: number, termHeight: number): string {
  if (state.open) return renderProject(state, state.open, termWidth, termHeight);
  const width = Math.max(1, termWidth);
  return renderList(state, termWidth, termHeight)
    .map((l) => clipLine(l, width) + CLEAR_EOL)
    .join('\n');
}
