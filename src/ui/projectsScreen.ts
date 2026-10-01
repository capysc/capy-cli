// Interactive TUI for `capy projects` — a type-to-search list, modeled
// directly on `secretsScreen.ts`/`secretsScreenDriver.ts`'s pure core /
// imperative shell split (same reasoning applies here: `handleKey(state,
// key)` is a pure reducer, `render(state, width, height)` is a pure
// function of state, and the only side effects — raw stdin/stdout — live in
// `projectsScreenDriver.ts`, which calls this module but never the
// reverse).
//
// Unlike secrets, there is nothing here to fetch or decrypt: every project
// and its branches are already loaded up front by `ProjectsCommand` before
// the screen ever starts, so `handleKey` never produces an effect — Enter's
// "inspect" view is just a different render of data the state already
// holds, not a new network round-trip.

import type { ProjectBranchSummary, ProjectSummary } from '../commands/projectsCommand';
import {
  ESC,
  CLEAR_EOL,
  INVERSE,
  RESET,
  DIM,
  BOLD,
  TERMINAL_SCREEN_ANSI,
  KEY_UP,
  KEY_DOWN,
  KEY_ESC,
  KEY_ESC_ESC,
  KEY_CTRL_C,
  KEY_BACKSPACE,
  KEY_BACKSPACE2,
  tokenizeKeys,
} from './interactiveKeys';
import { ACCENT } from './colors';

export const PROJECTS_SCREEN_ANSI = TERMINAL_SCREEN_ANSI;
export { tokenizeKeys };

// ── State ────────────────────────────────────────────────────────────────────

export interface SearchState {
  readonly query: string;
}

export interface ProjectsScreenState {
  readonly projects: readonly ProjectSummary[];
  readonly cursorIndex: number;
  readonly search: SearchState;
  /** Id of the project whose inline "inspect" detail is open, or null when the list owns the screen. Mirrors `secretsScreen.ts`'s popup — but since every field it shows is already in `projects`, opening it needs no effect. */
  readonly inspectingId: string | null;
  readonly quit: boolean;
}

export function initialProjectsScreenState(projects: readonly ProjectSummary[]): ProjectsScreenState {
  return {
    projects,
    cursorIndex: 0,
    search: { query: '' },
    inspectingId: null,
    quit: false,
  };
}

// ── Search matching ──────────────────────────────────────────────────────────
//
// Case-insensitive substring over the project's own name or any of its
// branch names — the only two fields `capy projects` already fetches (see
// `ProjectsCommand.loadProjectSummaries`). An empty/whitespace-only query
// matches everything, same convention `secretsScreen.ts` uses.

function projectMatches(project: ProjectSummary, qLower: string): boolean {
  if (project.name.toLowerCase().includes(qLower)) return true;
  return project.branches.some((b) => b.name.toLowerCase().includes(qLower));
}

function computeFilteredProjects(projects: readonly ProjectSummary[], query: string): readonly ProjectSummary[] {
  const qLower = query.trim().toLowerCase();
  if (!qLower) return projects;
  return projects.filter((p) => projectMatches(p, qLower));
}

/** Projects currently visible, after the live filter (name or any branch name — see `computeFilteredProjects`). */
export function filteredProjects(state: ProjectsScreenState): readonly ProjectSummary[] {
  return computeFilteredProjects(state.projects, state.search.query);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

// ── Reducer (pure) ───────────────────────────────────────────────────────────

/** Sets the search query and reclamps the cursor into the (possibly now-shorter) filtered set — never resets it to the top just because the query changed. */
function applyQuery(state: ProjectsScreenState, query: string): ProjectsScreenState {
  const matches = computeFilteredProjects(state.projects, query);
  return { ...state, search: { query }, cursorIndex: clampIndex(state.cursorIndex, matches.length) };
}

function handleInspectKey(state: ProjectsScreenState, key: string): ProjectsScreenState {
  // The inspect detail absorbs every key except what closes it, exactly
  // like `secretsScreen.ts`'s popup — `q`/`Q` close it here (there's no
  // search box to type into while it's open), same as Esc.
  if (key === KEY_ESC || key === KEY_ESC_ESC || key === 'q' || key === 'Q') {
    return { ...state, inspectingId: null };
  }
  return state;
}

/**
 * The list view: a search bar that's ALWAYS live (fzf-style, matching
 * `capy secrets` — no separate "search mode" to enter or leave). Every
 * printable character, including `q`/`j`/`k`, types into the query. Esc
 * clears a non-empty query; pressed again (query already empty) it quits,
 * so one key reliably backs all the way out. Ctrl-C (handled one level up)
 * always quits regardless of query state.
 */
function handleListKey(state: ProjectsScreenState, key: string): ProjectsScreenState {
  const matches = filteredProjects(state);

  if (key === KEY_ESC || key === KEY_ESC_ESC) {
    if (state.search.query !== '') return applyQuery(state, '');
    return { ...state, quit: true };
  }

  if (key === KEY_UP) {
    return { ...state, cursorIndex: clampIndex(state.cursorIndex - 1, matches.length) };
  }
  if (key === KEY_DOWN) {
    return { ...state, cursorIndex: clampIndex(state.cursorIndex + 1, matches.length) };
  }

  // Only `\r` opens the inspect view — deliberately NOT `\n`, same reasoning
  // `secretsScreen.ts` documents: a pasted multi-line chunk arrives with
  // `\n` line separators, and treating those as Enter would pop a detail
  // view open per pasted line.
  if (key === '\r') {
    const project = matches[clampIndex(state.cursorIndex, matches.length)];
    if (!project) return state;
    return { ...state, inspectingId: project.id };
  }

  if (key === KEY_BACKSPACE || key === KEY_BACKSPACE2) {
    return applyQuery(state, state.search.query.slice(0, -1));
  }

  // Any other single printable character (including 'q') types into the
  // search bar — same contract as `secretsScreen.ts`'s list view.
  if (key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) !== 0x7f) {
    return applyQuery(state, state.search.query + key);
  }

  return state;
}

/** Pure reducer: `(state, key) => state`. Never touches stdin/stdout — see module doc. Unlike `secretsScreen.ts`'s `handleKey`, this never needs to return an effect (nothing here is ever fetched). */
export function handleKey(state: ProjectsScreenState, key: string): ProjectsScreenState {
  if (key === KEY_CTRL_C) return { ...state, quit: true };
  if (state.inspectingId !== null) return handleInspectKey(state, key);
  return handleListKey(state, key);
}

// ── Rendering (pure) ─────────────────────────────────────────────────────────

const MARGIN = 2;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visLen(s: string): number {
  return stripAnsi(s).length;
}

function truncate(s: string, maxLen: number): string {
  if (visLen(s) <= maxLen) return s;
  const stripped = stripAnsi(s);
  return stripped.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function pad(s: string, width: number): string {
  const v = visLen(s);
  if (v >= width) return truncate(s, width);
  return s + ' '.repeat(width - v);
}

function padVis(s: string, width: number): string {
  const v = visLen(s);
  return v >= width ? s : s + ' '.repeat(width - v);
}

/** `name (protected)` for a protected branch, `name` otherwise — the same label `ProjectsCommand.formatBranches` already uses for the static (non-interactive) output. */
function formatBranchLabel(branch: ProjectBranchSummary): string {
  return branch.protected ? `${branch.name} ${DIM}(protected)${RESET}` : branch.name;
}

/** The BRANCHES cell for one row: every branch name, comma-joined, protected ones marked — identical wording to `ProjectsCommand.formatBranches` (the non-interactive table). `(no branches)` when there are none. */
export function formatBranchesCell(project: ProjectSummary): string {
  if (project.branches.length === 0) return `${DIM}(no branches)${RESET}`;
  return project.branches.map(formatBranchLabel).join(', ');
}

/** Always-visible search bar (fzf-style, matching `capy secrets`'s). Shows a dim placeholder when empty and a `<matched>/<total>` count; the insertion caret only appears when the list view actually owns keystrokes (i.e. no inspect view is open). */
function searchBarLine(state: ProjectsScreenState, matchedCount: number): string {
  const focused = state.inspectingId === null;
  const caret = focused ? '▏' : '';
  const placeholder = `${DIM}type to filter — name or branch${RESET}`;
  const typedQuery = `${ACCENT}${state.search.query}${RESET}`;
  const queryDisplay = state.search.query !== '' ? typedQuery : focused ? placeholder : '';
  const countLabel = `${matchedCount}/${state.projects.length}`;
  return `${DIM}search:${RESET} ${queryDisplay}${caret} ${DIM}${countLabel}${RESET}`;
}

function buildInspectLines(project: ProjectSummary, width: number): readonly string[] {
  const indent = '  ';
  const inner = '   ';
  const ruleWidth = Math.max(10, width - indent.length);
  const rule = `${indent}${DIM}╶${'─'.repeat(Math.max(0, ruleWidth - 2))}╴${RESET}`;
  const contentWidth = Math.max(20, ruleWidth - inner.length - 1);

  const topLines: readonly string[] = [
    rule,
    '',
    `${indent}${inner}${BOLD}${truncate(project.name, contentWidth)}${RESET}`,
    '',
    `${indent}${inner}${BOLD}branches${RESET}`,
  ];

  const branchLines: readonly string[] =
    project.branches.length === 0
      ? [`${indent}${inner}${DIM}(no branches)${RESET}`]
      : project.branches.map(
          (b) => `${indent}${inner}${truncate(b.name, contentWidth)}${b.protected ? ` ${DIM}(protected)${RESET}` : ''}`,
        );

  return [...topLines, ...branchLines, '', rule];
}

function spliceIn(bodyLines: readonly string[], afterIndex: number, insert: readonly string[]): string[] {
  return [...bodyLines.slice(0, afterIndex + 1), ...insert, ...bodyLines.slice(afterIndex + 1)];
}

/** Same "just enough to keep the cursor row visible" scroll policy `secretsScreen.ts` uses. */
function computeScrollOffset(lines: readonly string[], cursorLineIdx: number, bodyHeight: number, inspectOpen: boolean): number {
  if (!inspectOpen) {
    if (cursorLineIdx < bodyHeight) return 0;
    return Math.min(cursorLineIdx - bodyHeight + 1, Math.max(0, lines.length - bodyHeight));
  }
  const target = Math.max(0, cursorLineIdx - 1);
  return Math.min(target, Math.max(0, lines.length - bodyHeight));
}

function footerLine(state: ProjectsScreenState): string {
  if (state.inspectingId !== null) {
    return `${DIM}${RESET}${BOLD}esc${RESET}${DIM}/${RESET}${BOLD}q${RESET}${DIM} close${RESET}`;
  }
  return `${DIM}↑↓ navigate · ${RESET}${BOLD}enter${RESET}${DIM} inspect · ${RESET}${BOLD}esc${RESET}${DIM} clear/quit${RESET}`;
}

/** Pure render — a total function of state + terminal size. Never mutates `state`. */
export function render(state: ProjectsScreenState, termWidth: number, termHeight: number): string {
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);
  const matches = filteredProjects(state);
  const cursorIndex = clampIndex(state.cursorIndex, matches.length);

  const headerLines: readonly string[] = [
    `${m}${BOLD}capy projects${RESET} ${DIM}(${state.projects.length} project${state.projects.length === 1 ? '' : 's'})${RESET}`,
    m + searchBarLine(state, matches.length),
    '',
  ];

  const nameW = Math.max(16, Math.floor(available * 0.35));
  const gap = '  ';
  const branchesW = Math.max(10, available - nameW - gap.length);

  const headerLine = pad('NAME', nameW) + gap + pad('BRANCHES', branchesW);
  const preBodyLines: readonly string[] = [...headerLines, m + DIM + headerLine + RESET];

  const bodyLines: readonly string[] = matches.map((project, i) => {
    const isSelected = i === cursorIndex;
    const pointer = isSelected ? '▶ ' : '  ';
    const nameCell = pad(pointer + project.name, nameW);
    const branchesCell = pad(formatBranchesCell(project), branchesW);
    const line = nameCell + gap + branchesCell;
    return isSelected ? INVERSE + padVis(line, available) + RESET : line;
  });

  const withInspect: readonly string[] =
    state.inspectingId !== null && matches[cursorIndex]
      ? spliceIn(bodyLines, cursorIndex, buildInspectLines(matches[cursorIndex], available))
      : bodyLines;

  const reserved = preBodyLines.length + 1 /* table header already pushed above */ + 2 /* footer */;
  const bodyHeight = Math.max(6, termHeight - reserved);
  const scrollOffset = computeScrollOffset(withInspect, cursorIndex, bodyHeight, state.inspectingId !== null);
  const slice = withInspect.slice(scrollOffset, scrollOffset + bodyHeight);

  const bodyOutputLines: readonly string[] =
    matches.length === 0 ? [`${m}${DIM}No projects match.${RESET}`] : slice.map((line) => m + line);

  const footerLines: readonly string[] = ['', m + footerLine(state)];

  const lines: readonly string[] = [...preBodyLines, ...bodyOutputLines, ...footerLines];

  return lines.map((l) => l + CLEAR_EOL).join('\n');
}
