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
// Everything loads progressively. The list draws from `GET /projects` alone
// (its variable summary feeds the Variables and Last updated columns and the
// order, its repos the Linked repo column). A project's secrets index is read
// when its Secrets, Deployments or Connectors tab is first shown, and the member
// list when the Users tab (or a branch's access dialog) first needs it; each is
// kept (`ProjectsData.lazy`). The reads are effects the driver performs, and
// their results come back through `applyProjectIndexLoaded` / `applyMembersLoaded`.
//
// What the service did not return to the caller is hidden, never shown empty:
// a refused index (PERMISSION_DENIED) hides the project's Secrets, Deployments
// and Connectors tabs, a refused member list the Users tab; the repo links hide
// the Linked repo column. Every such decision keys off a status, a code or a
// field being absent — `ProjectsData` carries `null` for "not returned".
//
// The index this screen reads carries names and hashes only: nothing here can
// show a value (the embedded secrets screen reveals one on request, exactly as
// `capy secrets` does).

import type { MemberDetail, SecretIndexLocation, SecretIndexRow, SecretIndexSkipped } from '../service/serviceClient';
import { formatRepo, type ProjectRepoSummary } from '../commands/projectsCommand';
import { DRY_RUN_LABEL } from '../commands/secretsSetText';
import { ERROR_CODES } from '../types';
import { formatRelativeTime } from './relativeTime';
import { ACCENT } from './colors';
import { filterByQuery } from './searchMatch';
import { oscHyperlink } from './osc8';
import { clipLine, truncateCell } from './pickerTable';
import { BEHIND_LABEL, DEPLOYED_LABEL, TARGET_STATUS_HEADING } from '../core/deployStatus';
import { DELETE_CANCELLED_TEXT, DELETE_DRY_RUN_TEXT, deleteQuestion } from '../commands/projectLifecycleCommand';
import {
  type SecretsScreenEffect,
  type SecretsScreenState,
  handleKey as handleSecretsKey,
  initialSecretsScreenState,
  render as renderSecrets,
  scopeRowKey,
  BOX_DIVIDER,
  BOX_FULL_WIDTH,
  betweenRules,
  searchInput,
  sortedCopy,
} from './secretsScreen';
import {
  type BranchRef,
  type RepoRowRef,
  type ManageDialog,
  type ManageEffect,
  type ManageFinished,
  type ManageRefusal,
  type TokenRow,
  SETTINGS_ROWS,
  manageDone,
  manageKey,
  manageTokensLoaded,
  renderManage,
  settingsLabel,
  startBranch,
  startRepoRemove,
  REMOTE_TAG,
  repoRowKey,
  startSettings,
} from './projectManage';
import {
  type ProjectUserRow,
  type UsersDialog,
  type UsersEffect,
  type UsersFinished,
  projectUserRows,
  renderUsersDialog,
  startChange,
  startInvite,
  usersCopied,
  usersDialogDone,
  usersDialogKey,
} from './projectUsers';

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
  readonly branches: readonly { readonly id: string; readonly name: string; readonly protected: boolean }[];
  /** Linked repos; absent when they were not returned to the caller (the Git Repos tab is then hidden). `[]`: none linked. */
  readonly repos?: readonly ProjectRepoSummary[];
  /**
   * The variable summary `GET /projects` carries (a current service sends it; an older one does not, and these
   * stay absent). `variableCount` is `null` when the service cannot say (the index is not ready) or the caller
   * does not administer the project.
   */
  readonly variableCount?: number | null;
  readonly variablesUpdatedAt?: string | null;
  readonly indexStatus?: string | null;
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

/** Where one project's secrets index stands. It is read when the project's Secrets (or Deployments, Connectors) tab is first shown. */
export type ProjectIndexLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly index: ProjectsIndex }
  /** The service refused it (PERMISSION_DENIED): what it feeds is hidden. */
  | { readonly status: 'denied' }
  /** Any other failure: the tab says so, and shows it again (and asks again) next time it is selected. */
  | { readonly status: 'failed' };

/** Where the org's member list stands. It is read when the Users tab (or the branch access dialog) first needs it. */
export type MembersLoad = 'unloaded' | 'loading' | 'loaded' | 'denied' | 'failed';

/** What the loader leaves to load on demand. Absent from `ProjectsData` when `index` and `members` are already in hand. */
export interface LazyLoads {
  /** Each opened project's index, by project id: read once, kept. A service that ignores the project filter sends the whole org: the screen reads this project's rows from it. */
  readonly indexes: Readonly<Record<string, ProjectIndexLoad>>;
  readonly members: MembersLoad;
  /** The projects the caller administers, from `GET /orgs/:id/me`: read only for a service whose list does not say (`null` otherwise, or when it could not be read). */
  readonly adminProjectIds: readonly string[] | null;
}

/**
 * Everything the screen shows. `null` (or `reposShown: false`) means the service did not return it to the caller.
 * With `lazy` set, `index` is `null` and `members` is `null` until loaded: they are not "hidden", they are not here yet.
 */
export interface ProjectsData {
  readonly projects: readonly ProjectItem[];
  readonly index: ProjectsIndex | null;
  readonly members: readonly MemberDetail[] | null;
  /** Whether the org's repo links were returned (the Linked repo column). */
  readonly reposShown: boolean;
  /** The caller's user id: their own row on the Users tab is locked (nobody changes their own role). Absent: unknown. */
  readonly selfUserId?: string;
  readonly lazy?: LazyLoads;
}

/** True when the list carries the variable summary (some project has `variable_count`, `null` or not). */
export function listHasSummary(projects: readonly ProjectItem[]): boolean {
  return projects.some((p) => p.variableCount !== undefined);
}

/** The list alone says the caller administers this project: it carries its repos, a count, or an index status. */
function administeredByList(project: ProjectItem): boolean {
  return project.repos !== undefined || typeof project.variableCount === 'number' || (project.indexStatus !== undefined && project.indexStatus !== null);
}

/** Whether the list (or the admin ids read for an older service) says who administers what; otherwise a tab cannot be decided before it loads. */
function administrationKnown(data: ProjectsData): boolean {
  return listHasSummary(data.projects) || data.projects.some((p) => p.repos !== undefined) || (data.lazy?.adminProjectIds ?? null) !== null;
}

/** Whether the caller administers `project`, as far as the list and the admin ids say. */
function administered(data: ProjectsData, project: ProjectItem): boolean {
  return administeredByList(project) || (data.lazy?.adminProjectIds ?? []).includes(project.id);
}

/** The index to read `projectId`'s rows from: the one loaded for it, else the one supplied up front. `null`: none (yet). */
export function indexOf(data: ProjectsData, projectId: string): ProjectsIndex | null {
  const load = data.lazy?.indexes[projectId];
  return load !== undefined && load.status === 'loaded' ? load.index : data.index;
}

/**
 * What the index says about one project: `hidden` when it was not returned for
 * it (no index, a project skipped for any other reason, or one the caller does
 * not administer), `empty` when it was and the project has no secrets yet
 * (including one skipped as NO_KEEP_FILE: nobody has pushed to it), `rows` otherwise.
 */
export type ProjectIndexState = 'hidden' | 'empty' | 'rows';

export function projectIndexState(index: ProjectsIndex | null, projectId: string): ProjectIndexState {
  if (index === null) return 'hidden';
  const skip = index.skipped.find((s) => s.project_id === projectId);
  if (skip !== undefined) return skip.code === ERROR_CODES.NO_KEEP_FILE ? 'empty' : 'hidden';
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

/**
 * What the list says a project last changed. With the index supplied up front: what the index says. When the list
 * says who administers what, a project the caller does not administer has no time (`null`); an administered one
 * shows the summary's `variables_updated_at`, the creation time when it has none. When it does not say (an older
 * service), the creation time.
 */
export function listUpdatedAt(data: ProjectsData, project: ProjectItem): string | null {
  if (data.lazy === undefined) return lastUpdatedOf(data.index, project);
  if (administrationKnown(data) && !administered(data, project)) return null;
  const stamp = project.variablesUpdatedAt;
  return stamp !== undefined && stamp !== null && timeOf(stamp) !== null ? stamp : project.createdAt;
}

/**
 * What the project's index tabs (Secrets, Deployments, Connectors) show:
 * `rows`, `empty` or `hidden` as `projectIndexState` says once the index is in; `pending` before that
 * (the tab is shown and resolves on load); `failed` when the read failed for any reason but a refusal.
 */
export type IndexTabState = ProjectIndexState | 'pending' | 'failed';

export function indexTabState(data: ProjectsData, project: ProjectItem): IndexTabState {
  if (data.lazy === undefined) return projectIndexState(data.index, project.id);
  const load = data.lazy.indexes[project.id];
  if (load !== undefined && load.status === 'denied') return 'hidden';
  if (load !== undefined && load.status === 'failed') return 'failed';
  if (load !== undefined && load.status === 'loaded') return projectIndexState(load.index, project.id);
  // Not read yet. When the list says who administers what, a project the caller does not administer is hidden at once.
  return administrationKnown(data) && !administered(data, project) ? 'hidden' : 'pending';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export type ProjectTab = 'secrets' | 'users' | 'repos' | 'branches' | 'deployments' | 'connectors' | 'settings';
/** → moves forward through this order (wrapping), ← back. Secrets is selected when a project opens. */
export const PROJECT_TABS: readonly ProjectTab[] = ['secrets', 'users', 'repos', 'branches', 'deployments', 'connectors', 'settings'];

const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  secrets: 'Secrets', // COPY-FLAG
  users: 'Users', // COPY-FLAG
  repos: 'Git Repos', // COPY-FLAG
  branches: 'Capy Branches', // COPY-FLAG
  deployments: 'Deployments', // COPY-FLAG
  connectors: 'Connectors', // COPY-FLAG
  settings: 'Settings', // COPY-FLAG
};

/** The Settings tab's actions, in order. Enter runs the one under the cursor. */
// The Settings rows are `projectManage.ts`'s SETTINGS_ROWS.

/** The tabs that read the project's secrets index. */
const INDEX_TABS: readonly ProjectTab[] = ['secrets', 'deployments', 'connectors'];

/** Whether the Users tab is shown: unless the member list was refused (before it loads, it is shown and resolves on load). */
function usersTabShown(data: ProjectsData): boolean {
  return data.lazy === undefined ? data.members !== null : data.lazy.members !== 'denied';
}

/**
 * The tabs a project shows: only those whose data the service returned to the
 * caller. Secrets, Deployments and Connectors come from the secrets index;
 * Users from the user list; Git Repos from the project's linked repos.
 * Before that data has loaded, a tab shows unless the list already says the
 * caller does not administer the project (then the index tabs are hidden); it resolves on load.
 */
export function visibleTabs(data: ProjectsData, project: ProjectItem): readonly ProjectTab[] {
  const indexShown = indexTabState(data, project) !== 'hidden';
  const shown: Readonly<Record<ProjectTab, boolean>> = {
    secrets: indexShown,
    users: usersTabShown(data),
    repos: project.repos !== undefined,
    branches: true,
    deployments: indexShown,
    connectors: indexShown,
    // Always shown: the service decides who may delete (a refusal is shown in its words).
    settings: true,
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
  return projectUserRows(members, projectId).map((r) => ({ email: r.email, role: r.role }));
}

/** The Users tab's rows for `project`, with the caller's own row locked. */
function userRowsOf(data: ProjectsData, projectId: string): readonly ProjectUserRow[] {
  return projectUserRows(data.members ?? [], projectId, data.selfUserId ?? null);
}

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

/**
 * The repo's page on GitHub, at the project's folder (`/tree/HEAD/<folder>`: GitHub resolves HEAD to the
 * default branch). `null` for a repo not on GitHub: it is shown as text, with no link.
 */
export function repoUrl(repo: ProjectRepoSummary): string | null {
  if (repo.host.toLowerCase() !== 'github.com') return null;
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  return repo.path === '.' ? base : `${base}/tree/HEAD/${repo.path}`;
}

/** The Git Repos tab's lines with each GitHub URL made clickable (OSC 8). A URL cut short to fit stays plain text. */
function linkRepoLines(lines: readonly string[], repos: readonly ProjectRepoSummary[]): readonly string[] {
  const urls = repos.map(repoUrl).filter((u): u is string => u !== null);
  return lines.map((line) => {
    const url = urls.find((u) => line.includes(u));
    return url === undefined ? line : line.replace(url, oscHyperlink(url, url));
  });
}

/** The table a (non-Secrets) tab shows. */
export function tabTable(data: ProjectsData, project: ProjectItem, tab: ProjectTab, now?: Date): TabTable {
  const index = indexOf(data, project.id);
  const rows = index === null ? [] : projectRows(index.rows, project.id);
  if (tab === 'users') {
    return { headings: ['EMAIL', 'ROLE'], rows: projectMembers(data.members ?? [], project.id).map((m) => [m.email, m.role]) }; // COPY-FLAG: EMAIL, ROLE
  }
  if (tab === 'repos') return { headings: ['REPO'], rows: (project.repos ?? []).map((r) => [repoUrl(r) ?? formatRepo(r)]) }; // COPY-FLAG: REPO
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

/** What a tab says while its data is being read, and when reading it failed. */
export const LOADING_TEXT = 'Loading...'; // COPY-FLAG
export const LOAD_FAILED_TEXT = 'Could not load.'; // COPY-FLAG

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
  /** The Users tab's selected row. */
  readonly userCursor: number;
  /** The Settings tab's selected row. */
  readonly settingsCursor: number;
  /** The Capy Branches tab's selected branch. */
  readonly branchCursor: number;
  /** The Git Repos tab's selected row. */
  readonly repoCursor: number;
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
  /** The delete question (Settings → Delete project), over the open project; `null` when closed. */
  readonly dialog: DeleteDialog | null;
  /** The Users tab's dialog (invite, change a role, remove), over the open project; `null` when closed. */
  readonly usersDialog: UsersDialog | null;
  /** The Settings and Capy Branches tabs' dialog (deploy tokens, branch actions), over the open project; `null` when closed. */
  readonly manage: ManageDialog | null;
  /** Short lines shown above the footer until the next key (what a delete did). */
  readonly notes: readonly string[];
  /**
   * By project id: the keys (`repoRowKey`) of the rows whose folder holds the project's keep.lock on the remote.
   * A project absent here has not been checked; `[]` is "being checked" or "none".
   */
  readonly remoteRows: Readonly<Record<string, readonly string[]>>;
  readonly quit: boolean;
  /** Printed after the screen is left (the embedded edit and deploy confirmations). */
  readonly exitText: string | null;
}

export function initialProjectsScreenState(data: ProjectsData, dryRun: boolean = false): ProjectsScreenState {
  return { data, dryRun, query: '', cursor: 0, open: null, dialog: null, usersDialog: null, manage: null, notes: [], remoteRows: {}, quit: false, exitText: null };
}

/** Most recently updated first; projects with no known time last (including, when the list says who administers what, those the caller does not administer); then by name. */
export function sortProjects(data: ProjectsData): readonly ProjectItem[] {
  const at = (p: ProjectItem): number => {
    const iso = listUpdatedAt(data, p);
    return iso === null ? -Infinity : timeOf(iso) ?? -Infinity;
  };
  return sortedCopy(data.projects, (a, b) => at(b) - at(a) || a.name.localeCompare(b.name));
}

/** The projects the search shows, most recently updated first. */
export function filteredProjects(state: Pick<ProjectsScreenState, 'data' | 'query'>): readonly ProjectItem[] {
  return filterByQuery(sortProjects(state.data), state.query, (p) => p.name);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function projectById(data: ProjectsData, id: string): ProjectItem | undefined {
  return data.projects.find((p) => p.id === id);
}

// ── Reducer ───────────────────────────────────────────────────────────────────

// ── Delete (Settings tab) ───────────────────────────────────────────────────────
//
// `capy project delete`'s rules, through `commands/projectDeleteActions.ts`:
// the same summary first, then the same question with No as the default
// (Enter, `n` and Esc all answer No), then the DELETE — never forced from here.
// The service refuses anyone but an org owner, and a project with live deploy
// tokens; the refusal is shown as `capy project delete` words it.

/** The project a delete is about. */
export interface ProjectRefLite {
  readonly id: string;
  readonly name: string;
}

/** A coded refusal, with `capy project delete`'s words. */
export interface ScreenRefusal {
  readonly code: string;
  readonly message: string;
  readonly lines: readonly string[];
}

/** The summary shown before the question, or why it could not be read. */
export type DeletePreviewLoaded = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly refusal: ScreenRefusal };

/** The delete's answer: what to tell the person, or the refusal. */
export type DeleteFinished = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly refusal: ScreenRefusal };

export type DeleteDialog =
  | { readonly step: 'loading'; readonly project: ProjectRefLite }
  | { readonly step: 'confirm'; readonly project: ProjectRefLite; readonly lines: readonly string[]; readonly scroll?: number }
  | { readonly step: 'deleting'; readonly project: ProjectRefLite }
  | { readonly step: 'refused'; readonly project: ProjectRefLite; readonly refusal: ScreenRefusal; readonly scroll?: number };

/** The screen's own effects: the ones `capy secrets` does not have. */
export type ProjectsOwnEffect =
  | { readonly type: 'projectDeletePreview'; readonly project: ProjectRefLite }
  | { readonly type: 'projectDelete'; readonly project: ProjectRefLite }
  | ProjectsLoadEffect
  | UsersEffect
  | ManageEffect;

/** Reads the data a tab needs the first time it is shown. The result comes back through `applyProjectIndexLoaded` / `applyMembersLoaded`. */
export type ProjectsLoadEffect =
  | { readonly type: 'projectIndexLoad'; readonly projectId: string }
  | { readonly type: 'projectMembersLoad' };

/** What reading one project's secrets index came back with: its rows, or a refusal (`denied`: PERMISSION_DENIED) or another failure. */
export type ProjectIndexLoaded =
  | { readonly ok: true; readonly rows: readonly SecretIndexRow[]; readonly skipped: readonly SecretIndexSkipped[] }
  | { readonly ok: false; readonly denied: boolean };

/** What reading the org's member list came back with. */
export type MembersLoaded = { readonly ok: true; readonly members: readonly MemberDetail[] } | { readonly ok: false; readonly denied: boolean };

/** Opens the delete question for `project`: its summary is read first. */
function startDelete(state: ProjectsScreenState, project: ProjectItem): ProjectsReduceResult {
  const ref = { id: project.id, name: project.name };
  return { state: { ...state, dialog: { step: 'loading', project: ref } }, effect: { type: 'projectDeletePreview', project: ref } };
}

function handleDialogKey(state: ProjectsScreenState, dialog: DeleteDialog, key: string): ProjectsReduceResult {
  const isEsc = key === KEY_ESC || key === KEY_ESC_ESC || key === KEY_CTRL_C;
  if (dialog.step === 'deleting') return noEffect(state);
  // A long summary or refusal scrolls; the question and its keys stay put.
  const scrolled = scrollDialog(dialog, key);
  if (scrolled !== null) return noEffect({ ...state, dialog: scrolled });
  if (dialog.step === 'refused') return noEffect({ ...state, dialog: null });
  if (dialog.step === 'loading') return noEffect(isEsc ? { ...state, dialog: null, notes: [DELETE_CANCELLED_TEXT] } : state);
  if (key === 'y' || key === 'Y') {
    // A dry run asks the question and stops: the DELETE is never sent.
    if (state.dryRun) return noEffect({ ...state, dialog: null, notes: [DELETE_DRY_RUN_TEXT] });
    return { state: { ...state, dialog: { step: 'deleting', project: dialog.project } }, effect: { type: 'projectDelete', project: dialog.project } };
  }
  // No is the default: Enter answers it, like the terminal question.
  if (key === 'n' || key === 'N' || key === KEY_ENTER || isEsc) return noEffect({ ...state, dialog: null, notes: [DELETE_CANCELLED_TEXT] });
  return noEffect(state);
}

/** The dialog scrolled by `key` (↑↓, PgUp/PgDn), or `null` when `key` is not a scroll key. The render keeps the window inside the lines. */
function scrollDialog(dialog: DeleteDialog, key: string): DeleteDialog | null {
  if (dialog.step !== 'confirm' && dialog.step !== 'refused') return null;
  const delta = ((): number | null => {
    if (key === KEY_UP) return -1;
    if (key === KEY_DOWN) return 1;
    if (key === KEY_PGUP) return -PAGE_SIZE;
    if (key === KEY_PGDN) return PAGE_SIZE;
    return null;
  })();
  if (delta === null) return null;
  const count = dialog.step === 'confirm' ? dialog.lines.length : dialog.refusal.lines.length + 1;
  return { ...dialog, scroll: Math.max(0, Math.min(Math.max(0, count - 1), (dialog.scroll ?? 0) + delta)) };
}

/** The summary arrived: the question is asked, or the refusal shown. Dropped when the dialog has moved on. */
export function applyDeletePreview(state: ProjectsScreenState, projectId: string, loaded: DeletePreviewLoaded): ProjectsScreenState {
  const dialog = state.dialog;
  if (dialog === null || dialog.step !== 'loading' || dialog.project.id !== projectId) return state;
  return {
    ...state,
    dialog: loaded.ok ? { step: 'confirm', project: dialog.project, lines: loaded.lines } : { step: 'refused', project: dialog.project, refusal: loaded.refusal },
  };
}

/** `data` with `change` applied to the index supplied up front and to every index loaded for a project. */
function mapIndexes(data: ProjectsData, change: (index: ProjectsIndex) => ProjectsIndex): ProjectsData {
  const loaded = (load: ProjectIndexLoad): ProjectIndexLoad => (load.status === 'loaded' ? { status: 'loaded', index: change(load.index) } : load);
  const lazy: Pick<ProjectsData, 'lazy'> = data.lazy === undefined
    ? {}
    : { lazy: { ...data.lazy, indexes: Object.fromEntries(Object.entries(data.lazy.indexes).map(([id, load]) => [id, loaded(load)])) } };
  return { ...data, index: data.index === null ? null : change(data.index), ...lazy };
}

/** `data` without the project: gone from the list and from every index (so no row still counts it as another project). */
function withoutProject(data: ProjectsData, projectId: string): ProjectsData {
  const pruned = mapIndexes(data, (index) => ({
    ...index,
    rows: index.rows
      .map((r) => ({ ...r, locations: r.locations.filter((l) => l.project_id !== projectId) }))
      .filter((r) => r.locations.length > 0),
    skipped: index.skipped.filter((sk) => sk.project_id !== projectId),
  }));
  const lazy: Pick<ProjectsData, 'lazy'> = pruned.lazy === undefined
    ? {}
    : { lazy: { ...pruned.lazy, indexes: Object.fromEntries(Object.entries(pruned.lazy.indexes).filter(([id]) => id !== projectId)) } };
  return { ...pruned, projects: pruned.projects.filter((p) => p.id !== projectId), ...lazy };
}

/** The delete answered: on success, back to the list without the project, saying so; else the refusal. */
export function applyDeleteDone(state: ProjectsScreenState, projectId: string, finished: DeleteFinished): ProjectsScreenState {
  const dialog = state.dialog;
  if (dialog === null || dialog.step !== 'deleting' || dialog.project.id !== projectId) return state;
  if (!finished.ok) return { ...state, dialog: { step: 'refused', project: dialog.project, refusal: finished.refusal } };
  const data = withoutProject(state.data, projectId);
  const shown = filteredProjects({ data, query: state.query });
  return { ...state, data, dialog: null, open: null, cursor: clampIndex(state.cursor, shown.length), notes: finished.lines };
}

export type ProjectsScreenEffect = SecretsScreenEffect | ProjectsOwnEffect;

export interface ProjectsReduceResult {
  readonly state: ProjectsScreenState;
  readonly effect: ProjectsScreenEffect;
}

const noEffect = (state: ProjectsScreenState): ProjectsReduceResult => ({ state, effect: null });

/** Pure reducer: `(state, key) => { state, effect }`. */
export function handleKey(state: ProjectsScreenState, key: string): ProjectsReduceResult {
  return withRepoRowsCheck(reduceKey(state, key));
}

function reduceKey(state: ProjectsScreenState, key: string): ProjectsReduceResult {
  // The notes last until the next key.
  if (state.notes.length > 0) return reduceKey({ ...state, notes: [] }, key);
  if (state.dialog) return handleDialogKey(state, state.dialog, key);
  if (state.usersDialog && state.open) return handleUsersDialogKey(state, state.open, state.usersDialog, key);
  if (state.manage && state.open) return handleManageKey(state, state.manage, key);
  if (state.open) return handleProjectKey(state, state.open, key);
  return handleListKey(state, key);
}

const rowRefOf = (r: ProjectRepoSummary): RepoRowRef => ({ host: r.host, owner: r.owner, name: r.name, path: r.path });

/**
 * The first time a project's Git Repos tab is shown, its rows are checked against GitHub once (the `[remote]` tag).
 * Only when the key started nothing else: the check then starts on the next key.
 */
function withRepoRowsCheck(result: ProjectsReduceResult): ProjectsReduceResult {
  const { state, effect } = result;
  if (effect !== null || state.open === null || state.open.tab !== 'repos' || state.quit) return result;
  const project = projectById(state.data, state.open.projectId);
  const rows = project?.repos ?? [];
  if (project === undefined || rows.length === 0 || state.remoteRows[project.id] !== undefined) return result;
  return {
    state: { ...state, remoteRows: { ...state.remoteRows, [project.id]: [] } },
    effect: { type: 'projectRepoRowsCheck', project: { id: project.id, name: project.name }, rows: rows.map(rowRefOf) },
  };
}

/** The check came back: `remote` are the rows whose folder holds the project's keep.lock on the remote. */
export function applyRepoRowsChecked(state: ProjectsScreenState, projectId: string, remote: readonly RepoRowRef[]): ProjectsScreenState {
  return { ...state, remoteRows: { ...state.remoteRows, [projectId]: remote.map(repoRowKey) } };
}

/**
 * The embedded secrets screen over `project`'s rows (none until its index is in). The "also in N other projects" note
 * counts only what the index response holds: a response limited to this project holds no other project's
 * locations, so no note is shown; the whole org's index (a service that ignores the filter) shows it.
 */
function secretsStateFor(data: ProjectsData, project: ProjectItem, dryRun: boolean): SecretsScreenState {
  const index = indexOf(data, project.id);
  const rows = index === null ? [] : projectRows(index.rows, project.id);
  const scope = {
    title: project.name,
    otherProjects: index === null ? {} : otherProjectCounts(index.rows, project.id),
    hints: [
      { key: '←→', label: 'switch tab' }, // COPY-FLAG
    ],
  };
  return initialSecretsScreenState(rows, dryRun, scope);
}

/** Opens `project`: its secrets screen, scoped to its rows. */
function openProject(state: ProjectsScreenState, project: ProjectItem): ProjectsScreenState {
  const tab = visibleTabs(state.data, project)[0] ?? 'branches';
  return { ...state, open: { projectId: project.id, tab, secrets: secretsStateFor(state.data, project, state.dryRun), scroll: 0, userCursor: 0, settingsCursor: 0, branchCursor: 0, repoCursor: 0 } };
}

/** `state` with the lazy loads changed (only when the data has any). */
function withLazy(state: ProjectsScreenState, change: (lazy: LazyLoads) => LazyLoads): ProjectsScreenState {
  return state.data.lazy === undefined ? state : { ...state, data: { ...state.data, lazy: change(state.data.lazy) } };
}

function startIndexLoad(state: ProjectsScreenState, projectId: string): ProjectsReduceResult {
  const started = withLazy(state, (lazy) => ({ ...lazy, indexes: { ...lazy.indexes, [projectId]: { status: 'loading' } } }));
  return { state: started, effect: { type: 'projectIndexLoad', projectId } };
}

function startMembersLoad(state: ProjectsScreenState): ProjectsReduceResult {
  return { state: withLazy(state, (lazy) => ({ ...lazy, members: 'loading' })), effect: { type: 'projectMembersLoad' } };
}

/** The member list has not been read (or its last read failed). */
function membersWanted(data: ProjectsData): boolean {
  return data.lazy !== undefined && (data.lazy.members === 'unloaded' || data.lazy.members === 'failed');
}

/** The member list is not in yet (not asked for, on its way, or its read failed): what needs it waits. A refusal is not pending: there is nothing more to wait for. */
function membersPending(data: ProjectsData): boolean {
  return data.lazy !== undefined && (data.lazy.members === 'unloaded' || data.lazy.members === 'loading' || data.lazy.members === 'failed');
}

/** The member list is in, or was supplied up front: the Users tab can act on it. */
function membersReady(data: ProjectsData): boolean {
  return data.lazy === undefined || data.lazy.members === 'loaded';
}

/**
 * Reads what the selected tab needs when it is first shown: the project's secrets index for Secrets,
 * Deployments and Connectors, the member list for Users. Nothing when it is in, or on its way.
 */
function loadsFor(state: ProjectsScreenState): ProjectsReduceResult {
  const view = state.open;
  const lazy = state.data.lazy;
  const project = view === null ? undefined : projectById(state.data, view.projectId);
  if (view === null || lazy === undefined || project === undefined) return noEffect(state);
  if (INDEX_TABS.includes(view.tab)) {
    const load = lazy.indexes[view.projectId];
    const wanted = (load === undefined || load.status === 'failed') && indexTabState(state.data, project) !== 'hidden';
    return wanted ? startIndexLoad(state, view.projectId) : noEffect(state);
  }
  return view.tab === 'users' && membersWanted(state.data) ? startMembersLoad(state) : noEffect(state);
}

/** The open project's tab moved to the first one shown, when the selected one has just been hidden (a refusal). */
function settleTab(state: ProjectsScreenState): ProjectsReduceResult {
  const view = state.open;
  const project = view === null ? undefined : projectById(state.data, view.projectId);
  if (view === null || project === undefined) return noEffect(state);
  const tabs = visibleTabs(state.data, project);
  if (tabs.includes(view.tab)) return noEffect(state);
  return loadsFor({ ...state, open: { ...view, tab: tabs[0] ?? 'branches', scroll: 0 } });
}

/** The load's result for one project: its index, or what the failure was. */
function indexLoadOf(data: ProjectsData, project: ProjectItem, lazy: LazyLoads, loaded: ProjectIndexLoaded): ProjectIndexLoad {
  if (!loaded.ok) return { status: loaded.denied ? 'denied' : 'failed' };
  const covered = administered(data, project) ? [project.id] : lazy.adminProjectIds;
  return { status: 'loaded', index: { rows: loaded.rows, skipped: loaded.skipped, coveredProjectIds: covered } };
}

/** One project's secrets index arrived (or was refused, or failed). Kept for the rest of the session; the embedded secrets screen is built from it. */
export function applyProjectIndexLoaded(state: ProjectsScreenState, projectId: string, loaded: ProjectIndexLoaded): ProjectsReduceResult {
  const project = projectById(state.data, projectId);
  const lazy = state.data.lazy;
  if (project === undefined || lazy === undefined || lazy.indexes[projectId]?.status !== 'loading') return noEffect(state);
  const load = indexLoadOf(state.data, project, lazy, loaded);
  const stored = withLazy(state, (l) => ({ ...l, indexes: { ...l.indexes, [projectId]: load } }));
  const view = stored.open;
  // The project is open: its secrets screen is built now (nothing was shown there before, so nothing is lost).
  const open = view !== null && view.projectId === projectId && load.status === 'loaded'
    ? { ...view, secrets: secretsStateFor(stored.data, project, stored.dryRun) }
    : view;
  return settleTab({ ...stored, open });
}

/** The load's outcome for the member list. */
function membersLoadOf(loaded: MembersLoaded): MembersLoad {
  if (loaded.ok) return 'loaded';
  return loaded.denied ? 'denied' : 'failed';
}

/** The org's member list arrived (or was refused, or failed). Kept for the rest of the session. */
export function applyMembersLoaded(state: ProjectsScreenState, loaded: MembersLoaded): ProjectsReduceResult {
  if (state.data.lazy === undefined || state.data.lazy.members !== 'loading') return noEffect(state);
  const data = { ...state.data, members: loaded.ok ? loaded.members : null, lazy: { ...state.data.lazy, members: membersLoadOf(loaded) } };
  return settleTab({ ...state, data });
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
    return project ? loadsFor(openProject(state, project)) : noEffect(state);
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
 * project screen keeps ←/→ (they switch tabs) and Ctrl-C, and Esc once the
 * search is empty (Esc then goes back instead of quitting). Tab and Shift-Tab
 * stay the secrets screen's: they move its column, as in `capy secrets`.
 */
function secretsOwnsKey(secrets: SecretsScreenState, key: string): boolean {
  if (!secretsIdle(secrets)) return true;
  if (key === KEY_LEFT || key === KEY_RIGHT || key === KEY_CTRL_C) return false;
  if (key === KEY_ESC || key === KEY_ESC_ESC) return secrets.search.query !== '';
  return true;
}

/** One key, passed to the embedded secrets screen. When it quits (an edit or deploy finished), so does this screen, with its text. */
function forwardToSecrets(state: ProjectsScreenState, view: ProjectView, key: string): ProjectsReduceResult {
  const stepped = handleSecretsKey(view.secrets, key);
  if (stepped.state.quit) return { state: { ...state, quit: true, exitText: stepped.state.exitText }, effect: stepped.effect };
  return { state: { ...state, open: { ...view, secrets: stepped.state } }, effect: stepped.effect };
}

/** The Secrets tab is showing the embedded secrets screen (the project has rows in the index). */
function onSecretsScreen(data: ProjectsData, view: ProjectView): boolean {
  const project = projectById(data, view.projectId);
  return view.tab === 'secrets' && project !== undefined && indexTabState(data, project) === 'rows';
}

/**
 * Inside a project. On the Secrets tab, keys go to the embedded secrets screen
 * (see `secretsOwnsKey`). Otherwise: ← / → change tab, Esc goes back
 * to the list, the arrows scroll the tab's table, Ctrl-C quits.
 */
function handleProjectKey(state: ProjectsScreenState, view: ProjectView, key: string): ProjectsReduceResult {
  const project = projectById(state.data, view.projectId);
  if (project === undefined) return noEffect({ ...state, open: null });
  if (onSecretsScreen(state.data, view) && secretsOwnsKey(view.secrets, key)) return forwardToSecrets(state, view, key);
  if (key === KEY_CTRL_C) return noEffect({ ...state, quit: true });
  if (key === KEY_ESC || key === KEY_ESC_ESC) return noEffect({ ...state, open: null });
  // Settings: Enter runs the action under the cursor (its only one, Delete project, asks first).
  const tabs = visibleTabs(state.data, project);
  if (key === KEY_RIGHT) return loadsFor({ ...state, open: { ...view, tab: stepTab(tabs, view.tab, 1), scroll: 0 } });
  if (key === KEY_LEFT) return loadsFor({ ...state, open: { ...view, tab: stepTab(tabs, view.tab, -1), scroll: 0 } });
  if (view.tab === 'users') return handleUsersTabKey(state, view, project, key);
  if (view.tab === 'settings') return handleSettingsTabKey(state, view, project, key);
  if (view.tab === 'branches') return handleBranchesTabKey(state, view, project, key);
  if (view.tab === 'repos') return handleReposTabKey(state, view, project, key);
  const lastLine = Math.max(0, tabTable(state.data, project, view.tab).rows.length - 1);
  const scrollBy = (delta: number): ProjectsReduceResult =>
    noEffect({ ...state, open: { ...view, scroll: Math.max(0, Math.min(lastLine, view.scroll + delta)) } });
  if (key === KEY_UP) return scrollBy(-1);
  if (key === KEY_DOWN) return scrollBy(1);
  if (key === KEY_PGUP) return scrollBy(-PAGE_SIZE);
  if (key === KEY_PGDN) return scrollBy(PAGE_SIZE);
  return noEffect(state);
}

// ── Users tab ─────────────────────────────────────────────────────────────────
//
// The rules and dialogs are `projectUsers.ts`; this wires them to the screen:
// the cursor over the tab's rows, the dialog over the project, and the org's
// users read again after each change.

/** On the Users tab: the arrows move the cursor, Enter opens the row's role choices, i invites. */
function handleUsersTabKey(state: ProjectsScreenState, view: ProjectView, project: ProjectItem, key: string): ProjectsReduceResult {
  // Nothing to act on until the member list is in.
  if (!membersReady(state.data)) return noEffect(state);
  const rows = userRowsOf(state.data, project.id);
  const ref = { id: project.id, name: project.name };
  const moveTo = (cursor: number): ProjectsReduceResult => noEffect({ ...state, open: { ...view, userCursor: clampIndex(cursor, rows.length) } });
  if (key === KEY_UP) return moveTo(view.userCursor - 1);
  if (key === KEY_DOWN) return moveTo(view.userCursor + 1);
  if (key === KEY_PGUP) return moveTo(view.userCursor - PAGE_SIZE);
  if (key === KEY_PGDN) return moveTo(view.userCursor + PAGE_SIZE);
  if (key === 'i' || key === 'I') return noEffect({ ...state, usersDialog: startInvite(ref) });
  const row = rows[clampIndex(view.userCursor, rows.length)];
  if (key === KEY_ENTER && row !== undefined) {
    const opened = startChange(ref, row);
    return noEffect({ ...state, usersDialog: opened.dialog, notes: opened.notes });
  }
  return noEffect(state);
}

function handleUsersDialogKey(state: ProjectsScreenState, view: ProjectView, dialog: UsersDialog, key: string): ProjectsReduceResult {
  const stepped = usersDialogKey(dialog, key, { dryRun: state.dryRun, rows: userRowsOf(state.data, view.projectId) });
  return { state: { ...state, usersDialog: stepped.dialog, notes: stepped.notes }, effect: stepped.effect };
}

/** `data` with the member list replaced (it is in now, whatever its load said before). */
function withMembers(data: ProjectsData, members: readonly MemberDetail[]): ProjectsData {
  return { ...data, members, ...(data.lazy === undefined ? {} : { lazy: { ...data.lazy, members: 'loaded' as const } }) };
}

/**
 * An invite, role change or removal came back. The org's users, read again,
 * replace the old list (the cursor stays inside it); a new person's redeem
 * command is also kept for after the screen closes, so it is not lost.
 */
export function applyUsersDone(state: ProjectsScreenState, finished: UsersFinished): ProjectsScreenState {
  if (state.usersDialog === null || state.usersDialog.step !== 'working') return state;
  const stepped = usersDialogDone(state.usersDialog, finished);
  const data = finished.ok && finished.members !== null ? withMembers(state.data, finished.members) : state.data;
  const open = state.open === null
    ? null
    : { ...state.open, userCursor: clampIndex(state.open.userCursor, userRowsOf(data, state.open.projectId).length) };
  const exitText = finished.ok && finished.redeemCommand !== undefined
    ? [state.exitText, ...finished.lines, '', 'Send them this command:', '', `  ${finished.redeemCommand}`].filter((l) => l !== null).join('\n') // reused from `capy invite`
    : state.exitText;
  return { ...state, data, open, usersDialog: stepped.dialog, notes: stepped.notes, exitText };
}

// ── Settings and Capy Branches tabs ─────────────────────────────────────────
//
// The rules and dialogs are `projectManage.ts`; this wires them to the screen.

/** On the Settings tab: the arrows move the cursor; Enter copies the id, opens the deploy tokens, or asks to delete. */
function handleSettingsTabKey(state: ProjectsScreenState, view: ProjectView, project: ProjectItem, key: string): ProjectsReduceResult {
  const moveTo = (cursor: number): ProjectsReduceResult => noEffect({ ...state, open: { ...view, settingsCursor: clampIndex(cursor, SETTINGS_ROWS.length) } });
  if (key === KEY_UP) return moveTo(view.settingsCursor - 1);
  if (key === KEY_DOWN) return moveTo(view.settingsCursor + 1);
  if (key !== KEY_ENTER) return noEffect(state);
  const row = SETTINGS_ROWS[clampIndex(view.settingsCursor, SETTINGS_ROWS.length)];
  if (row === 'delete') return startDelete(state, project);
  const started = startSettings({ id: project.id, name: project.name }, row);
  return { state: { ...state, manage: started.dialog, notes: started.notes }, effect: started.effect };
}

/** On the Capy Branches tab: the arrows move the cursor; Enter offers the branch's actions. */
function handleBranchesTabKey(state: ProjectsScreenState, view: ProjectView, project: ProjectItem, key: string): ProjectsReduceResult {
  const moveTo = (cursor: number): ProjectsReduceResult => noEffect({ ...state, open: { ...view, branchCursor: clampIndex(cursor, project.branches.length) } });
  if (key === KEY_UP) return moveTo(view.branchCursor - 1);
  if (key === KEY_DOWN) return moveTo(view.branchCursor + 1);
  if (key === KEY_PGUP) return moveTo(view.branchCursor - PAGE_SIZE);
  if (key === KEY_PGDN) return moveTo(view.branchCursor + PAGE_SIZE);
  const branch = project.branches[clampIndex(view.branchCursor, project.branches.length)];
  if (key !== KEY_ENTER || branch === undefined) return noEffect(state);
  const started = startBranch({ id: project.id, name: project.name }, branch);
  return noEffect({ ...state, manage: started.dialog, notes: started.notes });
}

/** On the Git Repos tab: the arrows move the cursor; d asks to remove the row (the project's only row stays). */
function handleReposTabKey(state: ProjectsScreenState, view: ProjectView, project: ProjectItem, key: string): ProjectsReduceResult {
  const rows = project.repos ?? [];
  const moveTo = (cursor: number): ProjectsReduceResult => noEffect({ ...state, open: { ...view, repoCursor: clampIndex(cursor, rows.length) } });
  if (key === KEY_UP) return moveTo(view.repoCursor - 1);
  if (key === KEY_DOWN) return moveTo(view.repoCursor + 1);
  if (key === KEY_PGUP) return moveTo(view.repoCursor - PAGE_SIZE);
  if (key === KEY_PGDN) return moveTo(view.repoCursor + PAGE_SIZE);
  const row = rows[clampIndex(view.repoCursor, rows.length)];
  if ((key !== 'd' && key !== 'D') || row === undefined) return noEffect(state);
  const started = startRepoRemove({ id: project.id, name: project.name }, { host: row.host, owner: row.owner, name: row.name, path: row.path }, rows.length);
  return noEffect({ ...state, manage: started.dialog, notes: started.notes });
}

function handleManageKey(state: ProjectsScreenState, dialog: ManageDialog, key: string): ProjectsReduceResult {
  const stepped = manageKey(dialog, key, { dryRun: state.dryRun, members: state.data.members ?? [] });
  const next = { ...state, manage: stepped.dialog, notes: stepped.notes };
  // Who can use a branch needs the member list: it is read the first time that dialog opens.
  if (stepped.dialog !== null && stepped.dialog.step === 'access' && membersWanted(state.data)) return startMembersLoad(next);
  return { state: next, effect: stepped.effect };
}

/** The project's id was copied (or not). */
export function applyIdCopied(state: ProjectsScreenState, ok: boolean): ProjectsScreenState {
  return { ...state, notes: [ok ? 'Copied the project ID.' : 'Could not copy the project ID.'] }; // COPY-FLAG
}

/** The deploy tokens arrived (or were refused). */
export function applyTokensLoaded(
  state: ProjectsScreenState,
  loaded: { readonly ok: true; readonly tokens: readonly TokenRow[] } | { readonly ok: false; readonly refusal: ManageRefusal },
): ProjectsScreenState {
  return { ...state, manage: manageTokensLoaded(state.manage, loaded) };
}

/** `project` with `branches` in place of its own. When a branch is gone, the list's variable count is no longer known (`null`). */
function withNewBranches(project: ProjectItem, branches: readonly BranchRef[]): ProjectItem {
  const names = new Set(branches.map((b) => b.name));
  const lostOne = project.branches.some((b) => !names.has(b.name));
  return { ...project, branches, ...(lostOne && project.variableCount !== undefined ? { variableCount: null } : {}) };
}

/** `data` with `projectId`'s branches replaced; every index forgets the locations of a branch that is gone. */
function withBranches(data: ProjectsData, projectId: string, branches: readonly BranchRef[]): ProjectsData {
  const names = new Set(branches.map((b) => b.name));
  const pruned = mapIndexes(data, (index) => ({
    ...index,
    rows: index.rows
      .map((r) => ({ ...r, locations: r.locations.filter((l) => l.project_id !== projectId || names.has(l.branch)) }))
      .filter((r) => r.locations.length > 0),
  }));
  return { ...pruned, projects: pruned.projects.map((p) => (p.id === projectId ? withNewBranches(p, branches) : p)) };
}

/** Whether a stored link is `row`: same host, owner and name (owner and name compare case-insensitively, as on the service) and the same folder. */
function isRepoRow(link: ProjectRepoSummary, row: RepoRowRef): boolean {
  return link.host === row.host && link.owner.toLowerCase() === row.owner.toLowerCase() && link.name.toLowerCase() === row.name.toLowerCase() && link.path === row.path;
}

/** `data` with `row` gone from `projectId`'s repo links. */
function withoutRepoRow(data: ProjectsData, projectId: string, row: RepoRowRef): ProjectsData {
  return {
    ...data,
    projects: data.projects.map((p) => (p.id === projectId && p.repos !== undefined ? { ...p, repos: p.repos.filter((r) => !isRepoRow(r, row)) } : p)),
  };
}

/** A token revoke or branch change came back: what was read again replaces the old, and the dialog moves on. */
export function applyManageDone(state: ProjectsScreenState, finished: ManageFinished): ProjectsScreenState {
  if (state.manage === null || state.manage.step !== 'working' || state.open === null) return state;
  const stepped = manageDone(state.manage, finished);
  const membersIn = finished.ok && finished.members !== undefined ? withMembers(state.data, finished.members) : state.data;
  const withNewBranches = finished.ok && finished.branches !== undefined ? withBranches(membersIn, state.open.projectId, finished.branches) : membersIn;
  const data = finished.ok && finished.removedRepoRow !== undefined ? withoutRepoRow(withNewBranches, state.open.projectId, finished.removedRepoRow) : withNewBranches;
  const project = projectById(data, state.open.projectId);
  const open = {
    ...state.open,
    branchCursor: clampIndex(state.open.branchCursor, project?.branches.length ?? 0),
    repoCursor: clampIndex(state.open.repoCursor, project?.repos?.length ?? 0),
  };
  return { ...state, data, open, manage: stepped.dialog, notes: stepped.notes };
}

/** The copy of a redeem command finished. */
export function applyUsersCopied(state: ProjectsScreenState, ok: boolean): ProjectsScreenState {
  return { ...state, usersDialog: usersCopied(state.usersDialog, ok) };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function visLen(s: string): number {
  // Colour codes and OSC 8 hyperlink markers take no columns.
  return Array.from(s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '')).length;
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

/** The list's VARIABLES cell: the summary's count; `—` when the service cannot say (`null`). Without a summary: what the index supplied up front says. */
export function listVariablesCell(data: ProjectsData, project: ProjectItem): string {
  if (data.lazy === undefined) return variablesCell(data.index, project);
  return typeof project.variableCount === 'number' ? String(project.variableCount) : '—';
}

/** The list's LAST UPDATED cell, from `listUpdatedAt`. */
export function listLastUpdatedCell(data: ProjectsData, project: ProjectItem, now?: Date): string {
  const at = listUpdatedAt(data, project);
  return at === null ? '—' : formatRelativeTime(at, now);
}

/** The VARIABLES column needs a count to show: some project's numeric count in the list, or an index supplied up front. Otherwise (an older service, a plain member) it is hidden. */
function variablesColumnShown(data: ProjectsData): boolean {
  return data.lazy === undefined ? data.index !== null : data.projects.some((p) => typeof p.variableCount === 'number');
}

/** The LAST UPDATED column: with the index supplied up front, when it was; with the list's own times, unless the list says the caller administers no project. */
function updatedColumnShown(data: ProjectsData): boolean {
  if (data.lazy === undefined) return data.index !== null;
  return !administrationKnown(data) || data.projects.some((p) => administered(data, p));
}

function listColumns(data: ProjectsData, available: number): readonly ListColumn[] {
  const variables: readonly ListColumn[] = variablesColumnShown(data)
    ? [{ heading: 'VARIABLES', width: 10, cell: (p) => listVariablesCell(data, p) }] // COPY-FLAG
    : [];
  const updated: readonly ListColumn[] = !updatedColumnShown(data)
    ? []
    : [{ heading: 'LAST UPDATED', width: 14, cell: (p) => listLastUpdatedCell(data, p) }]; // COPY-FLAG
  const fixed = [...variables, ...updated].reduce((sum, c) => sum + c.width + MARGIN, 0);
  const rest = Math.max(16, available - 2 - fixed);
  // NAME is as wide as the longest name (never under its heading), capped at half the room when repos share it.
  const longest = data.projects.reduce((w, p) => Math.max(w, visLen(p.name)), visLen('NAME'));
  const nameW = data.reposShown ? Math.min(Math.max(16, Math.floor(rest * 0.5)), longest) : Math.min(rest, longest);
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
  const query = searchInput(state.query, 'type to filter by project name', true); // COPY-FLAG

  const head: readonly string[] = [
    `${m}${BOLD}capy projects${RESET}${dryRunTag(state.dryRun)} ${DIM}(${total} project${total === 1 ? '' : 's'})${RESET}`,
    // Its lines stop one space short of each edge of the terminal, as in `capy secrets`.
    ...betweenRules(`${m}${DIM}search:${RESET} ${query} ${DIM}${projects.length}/${total}${RESET}`, termWidth - 2).map((l, i) => (i === 1 ? l : ` ${l}`)),
    '',
    `${m}${DIM}${columns.map((c) => padTo(c.heading, c.width)).join(gap)}${RESET}`,
    '',
  ];
  // Rows start one column left of the margin with a one-column ▶ pointer, so each name sits under its heading.
  // The highlight runs to one column short of the right edge: the same space each side.
  const rows = projects.map((p, i) => {
    const pointer = i === cursor ? '▶' : ' ';
    const line = pointer + columns.map((c) => padTo(c.cell(p), c.width)).join(gap);
    return i === cursor ? `${INVERSE}${padTo(line, Math.max(available, termWidth - 2))}${RESET}` : line;
  });
  const footer: readonly string[] = [
    '',
    ...noteLines(state.notes),
    m + joinHints([
      renderHint(null, '↑↓ navigate'), // COPY-FLAG
      renderHint('enter', 'open'), // COPY-FLAG
      renderHint('esc', 'clear/quit'), // COPY-FLAG
    ]),
  ];
  const bodyHeight = Math.max(3, termHeight - head.length - footer.length);
  const offset = scrollFor(cursor, rows.length, bodyHeight);
  const emptyLine = total === 0 ? 'No projects found.' : 'No projects match.'; // COPY-FLAG: "No projects match." is new
  const body = rows.length === 0 ? [`${m}${DIM}${emptyLine}${RESET}`] : rows.slice(offset, offset + bodyHeight).map((l) => m.slice(1) + l);
  return [...head, ...body, ...footer];
}

/**
 * The tabs on one line, each ` label ` (a space each side): the selected one a highlighted block,
 * the others dim. Every tab is padded alike, so switching tabs moves nothing.
 */
function tabRow(tabs: readonly ProjectTab[], selected: ProjectTab): string {
  // The selected tab's padding is half blocks (▐ … ▌) in the highlight's colour (the inverse background
  // is the text colour): half a cell each side, so the block starts inside the box's corner, not over it.
  return tabs.map((t) => (t === selected ? `${BOLD}▐${INVERSE}${TAB_LABELS[t]}${RESET}${BOLD}▌${RESET}` : `${DIM} ${TAB_LABELS[t]} ${RESET}`)).join('');
}

/** Columns the tab row needs: each label and its two spaces. */
function tabRowWidth(tabs: readonly ProjectTab[]): number {
  return tabs.reduce((sum, t) => sum + visLen(TAB_LABELS[t]) + 2, 0);
}

/** The tab bar on its own, used when the box does not fit: the tab row and the hint to switch. */
function tabBarLine(tabs: readonly ProjectTab[], selected: ProjectTab): string {
  return `${' '.repeat(MARGIN)}${tabRow(tabs, selected)}  ${DIM}←→${RESET}`;
}

/** Lines the boxed layout adds around the content: a blank line, the tab row, the box's top and its bottom. */
const BOX_CHROME_LINES = 4;
/** The box's side borders and one space of padding inside each: `│ ` and ` │`. */
const BOX_SIDE_COLUMNS = 4;

/** Whether the boxed layout fits `width` (otherwise the one-line tab bar is used). */
function boxFits(tabs: readonly ProjectTab[], width: number): boolean {
  return width >= Math.max(1 + tabRowWidth(tabs) + 1, 30);
}

/**
 * A rule the full `width`, the tab row, then the content in a square box exactly
 * `width` columns wide, with one space of padding inside its sides.
 *
 *  ─────────────────────────────
 *   Secrets  Users  Git Repos      (the selected tab highlighted)
 *  ┌───────────────────────────┐
 *  │ content                   │
 *  └───────────────────────────┘
 */
function boxedTabs(tabs: readonly ProjectTab[], selected: ProjectTab, content: readonly string[], width: number): readonly string[] {
  const dim = (text: string): string => `${DIM}${text}${RESET}`;
  const rule = '─'.repeat(Math.max(0, width - 2));
  // Each line brings its own left space (screen margins less one), so a row can sit a column left of the text;
  // the right side is always one space.
  const inner = Math.max(1, width - 3);
  const side = dim('│');
  // clipLine keeps colour codes intact; the padding is counted on what is visible.
  const fit = (l: string, room: number): string => {
    const clipped = clipLine(l, room);
    return clipped + ' '.repeat(Math.max(0, room - visLen(clipped)));
  };
  const boxLine = (l: string): string => {
    if (l === BOX_DIVIDER) return dim(`├${rule}┤`);
    // A row marked full width meets both sides (a highlighted row's bar runs side to side).
    if (l.startsWith(BOX_FULL_WIDTH)) return `${side}${fit(l.slice(BOX_FULL_WIDTH.length), width - 2)}${RESET}${side}`;
    // Content comes with the screen margin; in the box one space of padding takes its place.
    return `${side}${fit(l.startsWith(' ') ? l.slice(1) : l, inner)}${RESET} ${side}`;
  };
  return [
    '', // a blank line above the tabs
    tabRow(tabs, selected),
    dim(`┌${rule}┐`),
    ...content.map(boxLine),
    dim(`└${rule}┘`),
  ];
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
  const shown = table.rows.slice(scroll, scroll + Math.max(1, height - 3));
  // The headings with a blank line above and below them.
  return ['', `${m}${DIM}${line(table.headings)}${RESET}`, '', ...shown.map((r) => m + line(r))];
}

/** What a tab says while its data is on its way, or when reading it failed; `null` when it is in (or the tab reads nothing lazily). */
function pendingLines(data: ProjectsData, project: ProjectItem, tab: ProjectTab): readonly string[] | null {
  const m = ' '.repeat(MARGIN);
  const say = (text: string): readonly string[] => [`${m}${DIM}${text}${RESET}`];
  if (INDEX_TABS.includes(tab)) {
    const state = indexTabState(data, project);
    if (state === 'pending') return say(LOADING_TEXT);
    return state === 'failed' ? say(LOAD_FAILED_TEXT) : null;
  }
  if (tab !== 'users' || data.lazy === undefined) return null;
  if (data.lazy.members === 'failed') return say(LOAD_FAILED_TEXT);
  return data.lazy.members === 'loaded' ? null : say(LOADING_TEXT);
}

/** A (non-embedded) tab's lines: the no-secrets note, the Settings actions, or the tab's table. */
function tabBody(
  state: ProjectsScreenState,
  project: ProjectItem,
  view: ProjectView,
  height: number,
  available: number,
  width: number,
  boxed: boolean,
): readonly string[] {
  const m = ' '.repeat(MARGIN);
  const pending = pendingLines(state.data, project, view.tab);
  if (pending !== null) return pending;
  if (view.tab === 'secrets') return NO_SECRETS_YET_LINES.map((l) => `${m}${l}`);
  if (view.tab === 'settings') return settingsLines(project.id, view.settingsCursor, width, boxed);
  if (view.tab === 'branches') return branchLines(project, view.branchCursor, width, boxed);
  if (view.tab === 'repos') return linkRepoLines(repoLines(project, state.remoteRows[project.id] ?? [], view.repoCursor, width, boxed), project.repos ?? []);
  if (view.tab === 'users') return usersTabLines(userRowsOf(state.data, project.id), view.userCursor, height, available, width, boxed);
  return tabTableLines(tabTable(state.data, project, view.tab), view.scroll, height, available);
}

/**
 * The Users tab: EMAIL and ROLE, with a cursor drawn like the secrets rows (the highlight side to side in
 * the box) but with no caret. Locked rows (owner, admins, you) are dim.
 */
function usersTabLines(
  rows: readonly ProjectUserRow[],
  cursor: number,
  height: number,
  available: number,
  width: number,
  boxed: boolean,
): readonly string[] {
  const m = ' '.repeat(MARGIN);
  if (rows.length === 0) return ['', `${m}${DIM}(none)${RESET}`];
  const gap = ' '.repeat(MARGIN);
  const emailW = Math.min(Math.max(visLen('EMAIL'), ...rows.map((r) => visLen(r.email))), Math.max(10, available - 16));
  const selected = clampIndex(cursor, rows.length);
  const bodyHeight = Math.max(1, height - 3);
  const offset = scrollFor(selected, rows.length, bodyHeight);
  const line = (r: ProjectUserRow, pointer: string): string => `${pointer}${padTo(r.email, emailW)}${gap}${r.role}`;
  const shown = rows.slice(offset, offset + bodyHeight).map((r, i) => {
    if (offset + i === selected) {
      // No caret: carets mark rows that open (collapsible); these rows open a picker, so they are only highlighted.
      const bar = `${INVERSE}${padTo(line(r, ' '), Math.max(1, width - 2))}${RESET}`;
      return boxed ? BOX_FULL_WIDTH + bar : m.slice(1) + bar;
    }
    const text = line(r, ' ');
    return r.lock === null ? m.slice(1) + text : `${m.slice(1)}${DIM}${text}${RESET}`;
  });
  return ['', `${m}${DIM}${padTo('EMAIL', emailW)}${gap}ROLE${RESET}`, '', ...shown]; // COPY-FLAG: EMAIL, ROLE
}

/** `usersActive`: the Users tab's keys (change role, invite) work, because the member list is in. */
function projectFooter(tab: ProjectTab, usersActive: boolean, repoRowCount: number): string {
  const lead = ((): readonly string[] => {
    // The Settings tab has actions, not a table: Enter runs the one under the cursor.
    if (tab === 'settings') return [renderHint(null, '↑↓ navigate'), renderHint('enter', 'select')]; // COPY-FLAG
    if (tab === 'branches') return [renderHint(null, '↑↓ navigate'), renderHint('enter', 'actions')]; // COPY-FLAG
    if (tab === 'users' && !usersActive) return [renderHint(null, '↑↓ navigate')]; // COPY-FLAG
    if (tab === 'users') return [renderHint(null, '↑↓ navigate'), renderHint('enter', 'change role'), renderHint('i', 'invite')]; // COPY-FLAG
    // The project's only row stays: d is offered only when there is another.
    if (tab === 'repos') return repoRowCount > 1 ? [renderHint(null, '↑↓ navigate'), renderHint('d', 'remove')] : [renderHint(null, '↑↓ navigate')]; // COPY-FLAG
    return [renderHint(null, '↑↓ scroll')]; // COPY-FLAG
  })();
  return joinHints([
    ...lead,
    renderHint('←→', 'switch tab'), // COPY-FLAG
    renderHint('esc', 'back'), // COPY-FLAG
  ]);
}

/**
 * The Settings tab: its actions as rows, the first highlighted (the only one so far), with no caret, drawn like the
 * secrets rows otherwise: in the box the highlight runs side to side; on its own it starts one column in and
 * stops one column short of the right edge. `width` is the terminal's.
 */
function settingsLines(projectId: string, cursor: number, width: number, boxed: boolean): readonly string[] {
  return ['', ...actionRows(SETTINGS_ROWS.map((row) => settingsLabel(row, projectId)), cursor, width, boxed)];
}

/**
 * Rows you act on (Settings, Capy Branches): the one under the cursor highlighted, with no caret (carets mark
 * rows that open). In the box the highlight runs side to side; on its own it starts one column in and stops
 * one column short of the right edge. `width` is the terminal's.
 */
function actionRows(labels: readonly string[], cursor: number, width: number, boxed: boolean): readonly string[] {
  const m = ' '.repeat(MARGIN);
  const selected = clampIndex(cursor, labels.length);
  return labels.map((label, i) => {
    if (i !== selected) return `${m}${label}`;
    const bar = `${INVERSE}${padTo(` ${label}`, Math.max(1, width - 2))}${RESET}`;
    return boxed ? BOX_FULL_WIDTH + bar : m.slice(1) + bar;
  });
}

/** The Capy Branches tab: each branch (protected ones say so), with a cursor. */
function branchLines(project: ProjectItem, cursor: number, width: number, boxed: boolean): readonly string[] {
  if (project.branches.length === 0) return ['', `${' '.repeat(MARGIN)}${DIM}(none)${RESET}`];
  return ['', ...actionRows(project.branches.map((b) => (b.protected ? `${b.name} (protected)` : b.name)), cursor, width, boxed)];
}

/** The Git Repos tab: each stored row (a repo, at the folder the project was seen in), with a cursor. */
function repoLines(project: ProjectItem, remoteKeys: readonly string[], cursor: number, width: number, boxed: boolean): readonly string[] {
  const rows = project.repos ?? [];
  if (rows.length === 0) return ['', `${' '.repeat(MARGIN)}${DIM}(none)${RESET}`];
  const label = (r: ProjectRepoSummary): string => {
    const text = repoUrl(r) ?? formatRepo(r);
    return remoteKeys.includes(repoRowKey(rowRefOf(r))) ? `${text} ${REMOTE_TAG}` : text;
  };
  return ['', ...actionRows(rows.map(label), cursor, width, boxed)];
}

/** The notes (what a delete did), dim, above the footer. */
function noteLines(notes: readonly string[]): readonly string[] {
  return notes.map((n) => `${' '.repeat(MARGIN)}${DIM}${n}${RESET}`);
}

/** The delete question: `capy project delete`'s summary, then its question; or the refusal. */
function renderDialog(state: ProjectsScreenState, dialog: DeleteDialog, termHeight: number): readonly string[] {
  const m = ' '.repeat(MARGIN);
  const head = [`${m}${BOLD}capy projects${RESET}${dryRunTag(state.dryRun)}`, ''];
  if (dialog.step === 'loading') return [...head, `${m}${DIM}Loading project...${RESET}`, '', m + renderHint('esc', 'cancel')]; // COPY-FLAG
  if (dialog.step === 'deleting') return [...head, `${m}${DIM}Deleting project ${dialog.project.name}...${RESET}`]; // COPY-FLAG
  const body = dialog.step === 'refused'
    ? [dialog.refusal.message, ...dialog.refusal.lines].map((l) => `${m}${l}`)
    : dialog.lines.map((l) => `${m}${l}`);
  const question = dialog.step === 'refused' ? [] : [`${m}${BOLD}${deleteQuestion(dialog.project.name)}${RESET}`];
  const keys = dialog.step === 'refused'
    ? [renderHint('esc', 'back')]
    : [renderHint('y', 'yes'), renderHint('esc', 'no')]; // COPY-FLAG
  // The question and its keys stay at the bottom; the lines above them scroll when they do not fit.
  const room = Math.max(1, termHeight - head.length - question.length - 2);
  const overflows = body.length > room;
  const top = Math.min(dialog.scroll ?? 0, Math.max(0, body.length - room));
  const shown = overflows ? body.slice(top, top + room) : body;
  const scrollHint = overflows ? [renderHint(null, '↑↓ scroll')] : []; // COPY-FLAG
  return [...head, ...shown, ...question, '', m + joinHints([...scrollHint, ...keys])];
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
  const boxed = boxFits(tabs, width);
  // Inside the box the content has the box's inner width, and the chrome's lines less height.
  const innerWidth = boxed ? Math.max(1, width - BOX_SIDE_COLUMNS) : width;
  const innerHeight = (titleLines: number): number => Math.max(3, termHeight - titleLines - (boxed ? BOX_CHROME_LINES : 2));
  // Over the box, the title starts one column in, where the tabs' text does (it comes with the 2-space margin).
  const frame = (title: string, content: readonly string[]): string =>
    finish(boxed ? [title.startsWith(' ') ? title.slice(1) : title, ...boxedTabs(tabs, view.tab, content, width)] : [title, '', tabBarLine(tabs, view.tab), ...content]);

  if (onSecretsScreen(state.data, view)) {
    const secrets = view.secrets;
    if (secrets.edit !== null || secrets.deploy !== null || secrets.sortMenu !== null) return renderSecrets(secrets, termWidth, termHeight);
    // In the box, the box's top is the search bar's top border.
    const shown: SecretsScreenState = boxed && secrets.scope !== undefined ? { ...secrets, scope: { ...secrets.scope, inBox: true } } : secrets;
    // Each of its lines ends in CLEAR_EOL; they are re-fitted to the box here (its search bar can be wider).
    // In the box it is rendered wide enough that its rows (marked full width) fill the box side to side.
    const [title, ...rest] = renderSecrets(shown, boxed ? width + 2 : innerWidth, innerHeight(1) + 1)
      .split('\n')
      .map((l) => (l.endsWith(CLEAR_EOL) ? l.slice(0, -CLEAR_EOL.length) : l));
    return frame(title, rest);
  }

  const m = ' '.repeat(MARGIN);
  const title = `${m}${BOLD}${project.name}${RESET}${dryRunTag(state.dryRun)}`;
  const footer: readonly string[] = ['', ...noteLines(state.notes), m + projectFooter(view.tab, membersReady(state.data), project.repos?.length ?? 0)];
  const bodyHeight = Math.max(3, innerHeight(1) - footer.length);
  const available = Math.max(20, boxed ? innerWidth : innerWidth - MARGIN * 2);
  const body = tabBody(state, project, view, bodyHeight, available, width, boxed);
  const filler = Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => '');
  return frame(title, [...body, ...filler, ...footer]);
}

/** Pure render: a total function of state and terminal size. No line is wider than the terminal. */
export function render(state: ProjectsScreenState, termWidth: number, termHeight: number): string {
  const width = Math.max(1, termWidth);
  if (state.dialog) {
    return renderDialog(state, state.dialog, termHeight)
      .slice(0, Math.max(1, termHeight))
      .map((l) => clipLine(l, width) + CLEAR_EOL)
      .join('\n');
  }
  if (state.manage && state.open) {
    const m = ' '.repeat(MARGIN);
    const project = projectById(state.data, state.open.projectId);
    const head = [`${m}${BOLD}capy projects${RESET}${dryRunTag(state.dryRun)} ${DIM}${project?.name ?? ''}${RESET}`, ''];
    // A refused member list draws the dialog's empty list, as it did when there were no members to show.
    const body = state.manage.step === 'access' && membersPending(state.data)
      ? [`${m}${DIM}${state.data.lazy?.members === 'failed' ? LOAD_FAILED_TEXT : LOADING_TEXT}${RESET}`]
      : renderManage(state.manage, width, m, state.data.members ?? []);
    return [...head, ...body]
      .slice(0, Math.max(1, termHeight))
      .map((l) => clipLine(l, width) + CLEAR_EOL)
      .join('\n');
  }
  if (state.usersDialog && state.open) {
    const m = ' '.repeat(MARGIN);
    const project = projectById(state.data, state.open.projectId);
    const head = [`${m}${BOLD}capy projects${RESET}${dryRunTag(state.dryRun)} ${DIM}${project?.name ?? ''}${RESET}`, ''];
    // The dialog wraps its own long lines (a redeem command), so it is never clipped mid-command.
    return [...head, ...renderUsersDialog(state.usersDialog, width, m)]
      .slice(0, Math.max(1, termHeight))
      .map((l) => clipLine(l, width) + CLEAR_EOL)
      .join('\n');
  }
  if (state.open) return renderProject(state, state.open, termWidth, termHeight);
  return renderList(state, termWidth, termHeight)
    .map((l) => clipLine(l, width) + CLEAR_EOL)
    .join('\n');
}
