/**
 * The folder picker: a tree of folders the person opens and closes, then
 * chooses one (CAP-929, spec 3m "Rich folder picker, terminal and Keep").
 *
 * Learned from, not imported: inquirer's file-selector prompts, broot, the
 * W3C APG tree view pattern and GitHub's accessible tree view. Keep's
 * FolderTree component uses the same keys:
 *
 *   ↑ ↓ Home End   move through visible rows
 *   →              open a closed folder; on an open one, go to its first child
 *   ←              close an open folder; else go to the parent row; on the
 *                  top row, go up one folder
 *   Enter          choose the highlighted folder
 *   typing         filter the folders already loaded, by name
 *   Esc            clear the filter, or leave path typing
 *   ~ or / first   type a path instead (Tab completes a folder name)
 *
 * Folders are read only when opened; nothing is written. Symlinks are never
 * followed, and hidden folders and node_modules are skipped. The key handling
 * is a pure function (`stepFolderKey`) so it is tested without a terminal.
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  makeTheme,
  isUpKey,
  isDownKey,
  isEnterKey,
  isBackspaceKey,
} from '@inquirer/core';
import { filterByQuery } from './searchMatch';

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const ACCENT = (s: string) => `\x1b[36m${s}\x1b[0m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`;

/** Files that mark a folder as a project, besides a `.env`; the same list setup already uses. */
export const PACKAGE_MARKERS: readonly string[] = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json'];

/** One folder as the picker shows it. `markers` are what it holds: `.env`, its first package file, `keep.lock`, `git`. */
export interface FolderInfo {
  readonly name: string;
  readonly path: string;
  readonly markers: readonly string[];
  /** False when the folder can't be opened (permissions). */
  readonly readable: boolean;
}

/** Where the picker reads folders. The terminal uses the disk; tests use a fake. */
export interface FolderSource {
  /** The folder itself. */
  info(path: string): FolderInfo;
  /** Its subfolders, sorted; `null` when it can't be read. */
  list(path: string): readonly FolderInfo[] | null;
  /** Whether `path` is an existing folder. */
  isFolder(path: string): boolean;
}

const hasProjectMarker = (f: FolderInfo): boolean => f.markers.some((m) => m !== 'git');

/** `.env` first, then folders with any marker, then the rest; each group by name. */
export function sortFolders(folders: readonly FolderInfo[]): readonly FolderInfo[] {
  const rank = (f: FolderInfo): number => (f.markers.includes('.env') ? 0 : hasProjectMarker(f) ? 1 : 2);
  return [...folders].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const exists = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
};

const canOpen = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The folders on this machine, read-only. */
export const diskFolders: FolderSource = {
  info(path) {
    const readable = canOpen(path);
    const packageFile = readable ? PACKAGE_MARKERS.find((m) => exists(join(path, m))) : undefined;
    const markers = readable
      ? [
          ...(exists(join(path, '.env')) ? ['.env'] : []),
          ...(packageFile ? [packageFile] : []),
          ...(exists(join(path, 'keep.lock')) ? ['keep.lock'] : []),
          ...(exists(join(path, '.git')) ? ['git'] : []),
        ]
      : [];
    return { name: basename(path) || path, path, markers, readable };
  },
  list(path) {
    try {
      // Dirent.isDirectory() is false for a symlink, so links are never followed.
      const names = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map((entry) => entry.name);
      return sortFolders(names.map((name) => diskFolders.info(join(path, name))));
    } catch {
      return null;
    }
  },
  isFolder(path) {
    try {
      return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
      return false;
    }
  },
};

/** The slice of a readline keypress event this prompt looks at. */
export interface FolderKey {
  readonly name: string;
  readonly ctrl: boolean;
  readonly sequence?: string;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface FolderState {
  /** The folder being browsed: the top row. */
  readonly base: string;
  /** Folders opened under the base. */
  readonly expanded: readonly string[];
  /** Subfolders read so far, by path; `null` when a folder couldn't be read. */
  readonly children: Readonly<Record<string, readonly FolderInfo[] | null>>;
  /** Position within the visible rows. */
  readonly active: number;
  readonly query: string;
  /** The path being typed, or `null` while browsing. */
  readonly typing: string | null;
  readonly error: string | undefined;
}

export interface FolderRow {
  readonly info: FolderInfo;
  /** 0 is the base itself; its subfolders are 1. */
  readonly depth: number;
  readonly expanded: boolean;
  /** Under a filter, the path shown relative to the base. */
  readonly label: string;
}

export type FolderStep =
  | { readonly kind: 'state'; readonly state: FolderState }
  | { readonly kind: 'choose'; readonly path: string };

export function initialFolderState(base: string, source: FolderSource): FolderState {
  return { base, expanded: [], children: { [base]: source.list(base) }, active: 0, query: '', typing: null, error: undefined };
}

const relativeLabel = (base: string, path: string): string =>
  path === base ? `${basename(base) || base}/` : `${path.slice(base.length).replace(/^[\\/]/, '')}/`;

/** Every loaded folder under the base, depth first, ignoring which are open. */
function loadedFolders(state: FolderState): readonly FolderInfo[] {
  const walk = (path: string): readonly FolderInfo[] =>
    (state.children[path] ?? []).flatMap((f) => [f, ...walk(f.path)]);
  return walk(state.base);
}

/** The rows on screen: the base, then its open tree; or, under a filter, every loaded folder whose name matches. */
export function visibleRows(state: FolderState, source: FolderSource): readonly FolderRow[] {
  const baseInfo = source.info(state.base);
  if (state.query.trim() !== '') {
    return filterByQuery(loadedFolders(state), state.query, (f) => f.name).map((info) => ({
      info, depth: 1, expanded: false, label: relativeLabel(state.base, info.path),
    }));
  }
  const walk = (path: string, depth: number): readonly FolderRow[] =>
    (state.children[path] ?? []).flatMap((info) => {
      const open = state.expanded.includes(info.path);
      return [{ info, depth, expanded: open, label: `${info.name}/` }, ...(open ? walk(info.path, depth + 1) : [])];
    });
  return [{ info: baseInfo, depth: 0, expanded: true, label: relativeLabel(state.base, state.base) }, ...walk(state.base, 1)];
}

const same = (state: FolderState): FolderStep => ({ kind: 'state', state });

function isPrintable(key: FolderKey): boolean {
  const seq = key.sequence ?? '';
  return seq.length === 1 && !key.ctrl && !key.meta && seq >= ' ' && seq !== '\x7f';
}

/** `~/x` and relative paths resolved against the base. */
export function resolveTyped(text: string, base: string): string {
  const trimmed = text.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(base, trimmed);
}

/** Tab: complete the last segment of a typed path to the one subfolder it starts, or to what all matches share. */
export function completeTyped(text: string, base: string, source: FolderSource): string {
  const endsWithSep = text.endsWith('/') || text.endsWith(sep);
  const full = resolveTyped(text, base);
  const parent = endsWithSep ? full : dirname(full);
  const stem = endsWithSep ? '' : basename(full);
  const names = (source.list(parent) ?? []).map((f) => f.name).filter((name) => name.startsWith(stem));
  if (names.length === 0) return text;
  const shared = names.reduce((acc, name) => {
    let i = 0;
    while (i < acc.length && i < name.length && acc[i] === name[i]) i++;
    return acc.slice(0, i);
  });
  const head = endsWithSep ? text : text.slice(0, text.length - stem.length);
  return `${head}${shared}${names.length === 1 ? '/' : ''}`;
}

/** Browse `path` with the cursor on `focus` when it is one of its rows. */
function browse(state: FolderState, path: string, source: FolderSource, focus?: string): FolderState {
  const next: FolderState = { ...state, base: path, expanded: [], children: { [path]: state.children[path] !== undefined ? state.children[path] : source.list(path) }, query: '', typing: null, error: undefined, active: 0 };
  const index = focus === undefined ? 0 : visibleRows(next, source).findIndex((row) => row.info.path === focus);
  return { ...next, active: Math.max(0, index) };
}

const NO_FOLDER = 'No folder at that path. Check the path, or press Esc to browse.'; // COPY-FLAG

function stepTyping(state: FolderState, key: FolderKey, source: FolderSource): FolderStep {
  const text = state.typing ?? '';
  if (key.name === 'escape') return same({ ...state, typing: null, error: undefined });
  if (isEnterKey(key)) {
    const path = resolveTyped(text, state.base);
    return source.isFolder(path) ? same(browse(state, path, source)) : same({ ...state, error: NO_FOLDER });
  }
  if (key.name === 'tab') return same({ ...state, typing: completeTyped(text, state.base, source), error: undefined });
  if (isBackspaceKey(key)) {
    const next = text.slice(0, -1);
    return same({ ...state, typing: next === '' ? null : next, error: undefined });
  }
  if (isPrintable(key)) return same({ ...state, typing: text + (key.sequence ?? ''), error: undefined });
  return same(state);
}

/** One keypress applied to the picker. Pure apart from reading folders through `source`. */
export function stepFolderKey(state: FolderState, key: FolderKey, source: FolderSource): FolderStep {
  if (state.typing !== null) return stepTyping(state, key, source);
  const rows = visibleRows(state, source);
  const row = rows[state.active];
  const move = (active: number): FolderStep => same({ ...state, active: Math.min(Math.max(active, 0), Math.max(rows.length - 1, 0)), error: undefined });

  if (isUpKey(key)) return move(state.active - 1);
  if (isDownKey(key)) return move(state.active + 1);
  if (key.name === 'home') return move(0);
  if (key.name === 'end') return move(rows.length - 1);
  if (key.name === 'pageup') return move(state.active - 10);
  if (key.name === 'pagedown') return move(state.active + 10);

  if (isEnterKey(key)) {
    if (!row) return same(state);
    if (!row.info.readable) return same({ ...state, error: CANT_OPEN });
    return { kind: 'choose', path: row.info.path };
  }

  if (key.name === 'escape') return same({ ...state, query: '', active: 0, error: undefined });

  const filtering = state.query.trim() !== '';
  if (key.name === 'right' && row && !filtering) {
    if (row.depth === 0) return move(state.active + 1);
    if (!row.info.readable) return same({ ...state, error: CANT_OPEN });
    if (row.expanded) return move(state.active + 1);
    const loaded = state.children[row.info.path];
    const children = loaded !== undefined ? loaded : source.list(row.info.path);
    return same({ ...state, expanded: [...state.expanded, row.info.path], children: { ...state.children, [row.info.path]: children }, error: undefined });
  }
  if (key.name === 'left' && row && !filtering) {
    if (row.depth > 0 && row.expanded) {
      return same({ ...state, expanded: state.expanded.filter((p) => p !== row.info.path && !p.startsWith(row.info.path + sep)), error: undefined });
    }
    if (row.depth >= 1) {
      const parent = dirname(row.info.path);
      return move(rows.findIndex((r) => r.info.path === parent));
    }
    const up = dirname(state.base);
    return up === state.base ? same(state) : same(browse(state, up, source, state.base));
  }

  if (isBackspaceKey(key)) return same({ ...state, query: state.query.slice(0, -1), active: 0, error: undefined });
  if (isPrintable(key)) {
    const char = key.sequence ?? '';
    if (state.query === '' && (char === '~' || char === '/')) return same({ ...state, typing: char, error: undefined });
    if (state.query === '' && char === ' ') return same(state);
    return same({ ...state, query: state.query + char, active: 0, error: undefined });
  }
  return same(state);
}

const CANT_OPEN = "Can't open this folder. Check its permissions, or choose another."; // COPY-FLAG

/** `/Users/x/code` as `~/code`. */
export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

const MARKER_LABEL: Readonly<Record<string, string>> = { git: 'Git' };

/** One row as text, without the cursor. */
export function rowText(row: FolderRow): string {
  const indent = '  '.repeat(Math.max(row.depth - 1, 0));
  const chevron = row.depth === 0 ? '' : !row.info.readable ? '  ' : row.expanded ? '▾ ' : '▸ ';
  const name = row.depth === 0 ? `${row.label} ${DIM('(this folder)')}` : row.label; // COPY-FLAG
  const markers = row.info.readable
    ? row.info.markers.map((m) => MARKER_LABEL[m] ?? m).join(DIM(' · '))
    : "can't open"; // COPY-FLAG
  return `${indent}${chevron}${name}${markers ? `  ${DIM(markers)}` : ''}`;
}

/** What Enter does, said in full. */
export function chooseLine(row: FolderRow | undefined, base: string): string {
  if (!row) return '';
  if (!row.info.readable) return DIM(CANT_OPEN);
  const where = row.depth === 0 ? 'this folder' : relativeLabel(base, row.info.path); // COPY-FLAG
  return `${KEY('enter')} ${DIM('sets up Capy in')} ${BOLD(where)}`; // COPY-FLAG
}

export const FOLDER_KEYS_HELP =
  `${KEY('↑↓')} ${DIM('move')}  ${KEY('→')} ${DIM('open')}  ${KEY('←')} ${DIM('back')}  ${DIM('type to filter')}  ${KEY('~')} ${DIM('or')} ${KEY('/')} ${DIM('type a path')}`; // COPY-FLAG

export interface FolderTreeConfig {
  readonly message: string;
  readonly start: string;
  readonly source?: FolderSource;
  readonly pageSize?: number;
}

/** The visible slice of `count` rows that keeps `active` on screen. */
export function windowFor(count: number, active: number, pageSize: number): { readonly start: number; readonly end: number } {
  if (count <= pageSize) return { start: 0, end: count };
  const start = Math.min(Math.max(active - Math.floor(pageSize / 2), 0), count - pageSize);
  return { start, end: start + pageSize };
}

export const folderTree = createPrompt<string, FolderTreeConfig>((config, done) => {
  const source = config.source ?? diskFolders;
  const pageSize = config.pageSize ?? 12;
  const theme = makeTheme({} as any) as any;
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const prefix = usePrefix({ status, theme });
  const [state, setState] = useState<FolderState>(() => initialFolderState(config.start, source));
  const [chosen, setChosen] = useState<string>('');

  useKeypress((key, rl) => {
    rl.clearLine(0);
    const step = stepFolderKey(state, key as FolderKey, source);
    if (step.kind === 'state') {
      setState(step.state);
      return;
    }
    setChosen(step.path);
    setStatus('done');
    done(step.path);
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') return [prefix, message, theme.style.answer(displayPath(chosen))].filter(Boolean).join(' ');

  const rows = visibleRows(state, source);
  const view = windowFor(rows.length, state.active, pageSize);
  const lines = rows.slice(view.start, view.end).map((row, i) => {
    const active = view.start + i === state.active;
    const text = rowText(row);
    return active ? `${ACCENT('❯')} ${ACCENT(text)}` : `  ${row.info.readable ? text : DIM(text)}`;
  });
  const empty = state.query.trim() !== ''
    ? [`  ${DIM('No loaded folder matches. Press → on a folder to load more, or Esc to clear.')}`] // COPY-FLAG
    : rows.length === 1 && state.children[state.base] !== null
      ? [`  ${DIM('No folders inside.')}`] // COPY-FLAG
      : [];
  const position = rows.length > pageSize ? DIM(`${state.active + 1} of ${rows.length}`) : '';
  const bar = state.typing !== null
    ? `${DIM('path:')} ${ACCENT(state.typing)}${DIM('▏')}  ${DIM('tab completes · enter opens · esc browses')}` // COPY-FLAG
    : state.query !== ''
      ? `${DIM('filter:')} ${ACCENT(state.query)}${DIM('▏')}`
      : '';

  return [
    [prefix, message].filter(Boolean).join(' '),
    `  ${DIM(displayPath(state.base))}`,
    bar,
    ...lines,
    ...empty,
    position,
    state.error ? theme.style.error(state.error) : '',
    ' ',
    chooseLine(rows[state.active], state.base),
    FOLDER_KEYS_HELP,
  ].filter(Boolean).join('\n');
}) as unknown as (config: FolderTreeConfig, context?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) => Promise<string>;
