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
 *                  top row, go up one folder (never above `root`)
 *   Enter          choose the highlighted folder
 *   typing         filter the folders already loaded, by name
 *   Esc            clear the filter, or leave path typing (Ctrl+C cancels)
 *   ~ or / first   type a path instead (Tab completes a folder name)
 *
 * Folders are read only when opened; nothing is written. Symlinks are never
 * followed: listings skip them and a typed path is resolved to its real
 * folder. Hidden folders and dependency folders are skipped. The key handling
 * is a pure function (`stepFolderKey`) so it is tested without a terminal.
 */
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
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

const ESC = '\x1b[';
const DIM = (s: string) => `${ESC}90m${s}${ESC}0m`;
const ACCENT = (s: string) => `${ESC}36m${s}${ESC}0m`;
const BOLD = (s: string) => `${ESC}1m${s}${ESC}0m`;
const KEY = (s: string) => `${ESC}1;97m${s}${ESC}0m`;

/** Files that mark a folder as a project, besides a `.env`; the same list setup already uses. */
export const PACKAGE_MARKERS: readonly string[] = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json'];

/** Dependency and build folders never listed (hidden dot-folders are skipped too). */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'bower_components', 'vendor', 'venv', '__pycache__', 'Pods', 'target']);

/** Whether a folder name is listed: not hidden, not a dependency folder. */
export const isListedFolderName = (name: string): boolean => !name.startsWith('.') && !SKIPPED_FOLDERS.has(name);

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
  /** The real folder at `path` (symlinks resolved), or `null` when there is none. */
  realFolder(path: string): string | null;
}

/** `.env` first, then folders with any marker (Git counts), then the rest; each group by name, ignoring case. */
export function sortFolders(folders: readonly FolderInfo[]): readonly FolderInfo[] {
  const rank = (f: FolderInfo): number => (f.markers.includes('.env') ? 0 : f.markers.length > 0 ? 1 : 2);
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1));
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
        .filter((entry) => entry.isDirectory() && isListedFolderName(entry.name))
        .map((entry) => entry.name);
      return sortFolders(names.map((name) => diskFolders.info(join(path, name))));
    } catch {
      return null;
    }
  },
  realFolder(path) {
    try {
      const real = realpathSync(path);
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  },
};

/** Whether `path` is `root` or inside it. */
export const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
  /** Nothing above this folder can be browsed or chosen. The terminal's is the filesystem root. */
  readonly root: string;
  /** Where the picker started: the folder Capy runs in. */
  readonly start: string;
  /** The folder being browsed: the top row. */
  readonly base: string;
  readonly baseInfo: FolderInfo;
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
  /** For an open folder: its subfolders, `[]` when none, `null` when it couldn't be read. */
  readonly children: readonly FolderInfo[] | null | undefined;
  /** True for the top row while it is the folder Capy runs in. */
  readonly isStart: boolean;
}

export type FolderStep =
  | { readonly kind: 'state'; readonly state: FolderState }
  | { readonly kind: 'choose'; readonly path: string };

export function initialFolderState(start: string, source: FolderSource, root: string = resolve(sep)): FolderState {
  root = source.realFolder(root) ?? root;
  return {
    root, start, base: start, baseInfo: source.info(start), expanded: [], children: { [start]: source.list(start) },
    active: 0, query: '', typing: null, error: undefined,
  };
}

const relativeLabel = (base: string, path: string): string =>
  path === base ? `${basename(base) || base}/` : `${relative(base, path).split(sep).join('/')}/`;

/** Every loaded folder under the base, depth first, ignoring which are open. */
function loadedFolders(state: FolderState): readonly FolderInfo[] {
  const walk = (path: string): readonly FolderInfo[] =>
    (state.children[path] ?? []).flatMap((f) => [f, ...walk(f.path)]);
  return walk(state.base);
}

/** The rows on screen: the base, then its open tree; or, under a filter, every loaded folder whose name matches. */
export function visibleRows(state: FolderState): readonly FolderRow[] {
  if (state.query.trim() !== '') {
    return filterByQuery(loadedFolders(state), state.query, (f) => f.name).map((info) => ({
      info, depth: 1, expanded: false, label: relativeLabel(state.base, info.path), children: undefined, isStart: false,
    }));
  }
  const walk = (path: string, depth: number): readonly FolderRow[] =>
    (state.children[path] ?? []).flatMap((info) => {
      const open = state.expanded.includes(info.path);
      const row: FolderRow = { info, depth, expanded: open, label: `${info.name}/`, children: open ? state.children[info.path] : undefined, isStart: false };
      return [row, ...(open ? walk(info.path, depth + 1) : [])];
    });
  const top: FolderRow = {
    info: state.baseInfo, depth: 0, expanded: true, label: relativeLabel(state.base, state.base),
    children: state.children[state.base], isStart: state.base === state.start,
  };
  return [top, ...walk(state.base, 1)];
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

/**
 * Tab: complete the typed path's last segment to the one subfolder it starts, or to what all matches share.
 * Only a literal last segment is completed; `~`, `.` and `..` are left as typed.
 */
export function completeTyped(text: string, base: string, source: FolderSource): string {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf(sep));
  const head = text.slice(0, cut + 1);
  const stem = text.slice(cut + 1);
  if (stem === '~' || stem === '.' || stem === '..' || stem.trim() !== stem) return text;
  const parent = head === '' ? base : resolveTyped(head, base);
  const names = (source.list(parent) ?? []).map((f) => f.name).filter((name) => name.startsWith(stem));
  if (names.length === 0) return text;
  const shared = names.reduce((acc, name) => {
    const n = [...acc].findIndex((ch, i) => name[i] !== ch);
    return n === -1 ? acc.slice(0, name.length) : acc.slice(0, n);
  });
  return `${head}${shared}${names.length === 1 ? '/' : ''}`;
}

/** Browse `path` with the cursor on `focus` when it is one of its rows. */
function browse(state: FolderState, path: string, source: FolderSource, focus?: string): FolderState {
  const loaded = state.children[path];
  const next: FolderState = {
    ...state, base: path, baseInfo: source.info(path), expanded: [], children: { ...state.children, [path]: loaded !== undefined ? loaded : source.list(path) },
    query: '', typing: null, error: undefined, active: 0,
  };
  const index = focus === undefined ? 0 : visibleRows(next).findIndex((row) => row.info.path === focus);
  return { ...next, active: Math.max(0, index) };
}

export const NO_FOLDER = 'No folder at that path. Check the path, or press Esc to browse.'; // COPY-FLAG
export const outsideRoot = (root: string): string =>
  `That folder is outside where Capy can set up. Choose a folder inside ${displayPath(root)}, or press Esc to browse.`; // COPY-FLAG
export const CANT_OPEN = "Can't open this folder. Check its permissions, or choose another."; // COPY-FLAG

function stepTyping(state: FolderState, key: FolderKey, source: FolderSource): FolderStep {
  const text = state.typing ?? '';
  if (key.name === 'escape') return same({ ...state, typing: null, error: undefined });
  if (isEnterKey(key)) {
    const real = source.realFolder(resolveTyped(text, state.base));
    if (real === null) return same({ ...state, error: NO_FOLDER });
    if (!isInside(state.root, real)) return same({ ...state, error: outsideRoot(state.root) });
    return same(browse(state, real, source));
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
  const rows = visibleRows(state);
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

  const filtering = state.query.trim() !== '';
  if (key.name === 'escape') {
    if (state.query === '') return same({ ...state, error: undefined });
    // Back to the tree with the cursor on the folder it was on, when that folder is visible there.
    const cleared = { ...state, query: '', error: undefined };
    const index = row ? visibleRows(cleared).findIndex((r) => r.info.path === row.info.path) : -1;
    return same({ ...cleared, active: Math.max(0, index) });
  }

  if (key.name === 'right' && row && !filtering) {
    if (row.depth === 0 || row.expanded) {
      const next = rows[state.active + 1];
      return next && next.depth > row.depth ? move(state.active + 1) : same(state);
    }
    if (!row.info.readable) return same({ ...state, error: CANT_OPEN });
    const loaded = state.children[row.info.path];
    const children = loaded !== undefined ? loaded : source.list(row.info.path);
    return same({ ...state, expanded: [...state.expanded, row.info.path], children: { ...state.children, [row.info.path]: children }, error: undefined });
  }
  if (key.name === 'left' && row && !filtering) {
    if (row.depth > 0 && row.expanded) {
      return same({ ...state, expanded: state.expanded.filter((p) => p !== row.info.path && !p.startsWith(row.info.path + sep)), error: undefined });
    }
    if (row.depth >= 1) return move(rows.findIndex((r) => r.info.path === dirname(row.info.path)));
    const up = dirname(state.base);
    return up === state.base || !isInside(state.root, up) ? same(state) : same(browse(state, up, source, state.base));
  }

  if (isBackspaceKey(key)) {
    return state.query === '' ? same(state) : same({ ...state, query: state.query.slice(0, -1), active: 0, error: undefined });
  }
  if (isPrintable(key)) {
    const char = key.sequence ?? '';
    if (state.query === '' && (char === '~' || char === '/')) return same({ ...state, typing: char, error: undefined });
    if (state.query === '' && char === ' ') return same(state);
    return same({ ...state, query: state.query + char, active: 0, error: undefined });
  }
  return same(state);
}

/** `/Users/x/code` as `~/code`. */
export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

const MARKER_LABEL: Readonly<Record<string, string>> = { git: 'Git' };

/** What an open folder says when it has nothing to show. */
const openNote = (row: FolderRow): string =>
  !row.expanded ? '' : row.children === null ? "can't open this folder" : row.children?.length === 0 ? 'no folders inside' : ''; // COPY-FLAG

/** One row as text, without the cursor. `active` colours the name. */
export function rowText(row: FolderRow, filtering = false, active = false): string {
  const indent = '  '.repeat(Math.max(row.depth - 1, 0));
  const chevron = row.depth === 0 || filtering ? '' : !row.info.readable ? '  ' : row.expanded ? '▾ ' : '▸ ';
  const name = active ? ACCENT(row.label) : row.label;
  const here = row.isStart ? ` ${DIM('(this folder)')}` : ''; // COPY-FLAG
  const markers = row.info.readable ? row.info.markers.map((m) => MARKER_LABEL[m] ?? m).join(' · ') : "can't open"; // COPY-FLAG
  const note = openNote(row);
  return `${indent}${chevron}${name}${here}${markers ? `  ${DIM(markers)}` : ''}${note ? `  ${DIM(`— ${note}`)}` : ''}`;
}

/** What Enter does, said in full. */
export function chooseLine(row: FolderRow | undefined, base: string): string {
  if (!row) return '';
  if (!row.info.readable) return DIM(CANT_OPEN);
  const where = row.isStart ? 'this folder' : row.depth === 0 ? displayPath(row.info.path) : relativeLabel(base, row.info.path); // COPY-FLAG
  return `${KEY('enter')} ${DIM('sets up Capy in')} ${BOLD(where)}`; // COPY-FLAG
}

export const FOLDER_KEYS_HELP = [
  `${KEY('↑↓')} ${DIM('move')}`,
  `${KEY('→')} ${DIM('open')}`,
  `${KEY('←')} ${DIM('back')}`,
  `${KEY('enter')} ${DIM('choose')}`,
  DIM('type to filter'),
  `${KEY('esc')} ${DIM('clear')}`,
  `${KEY('~')} ${DIM('or')} ${KEY('/')} ${DIM('type a path')}`,
].join('  '); // COPY-FLAG

export interface FolderTreeConfig {
  readonly message: string;
  readonly start: string;
  /** Nothing above it can be browsed or chosen; the filesystem root when left out. */
  readonly root?: string;
  readonly source?: FolderSource;
  readonly pageSize?: number;
}

/** The visible slice of `count` rows that keeps `active` on screen. */
export function windowFor(count: number, active: number, pageSize: number): { readonly start: number; readonly end: number } {
  if (count <= pageSize) return { start: 0, end: count };
  const start = Math.min(Math.max(active - Math.floor(pageSize / 2), 0), count - pageSize);
  return { start, end: start + pageSize };
}

/** Cut a line with colour codes to `width` visible characters, so a long name can't wrap and throw off the window. */
export function fitLine(line: string, width: number): string {
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  const fitted = parts.reduce<{ readonly out: string; readonly left: number }>((acc, part) => {
    if (part.startsWith('\x1b[')) return { ...acc, out: acc.out + part };
    if (acc.left <= 0) return acc;
    const chars = [...part];
    return chars.length <= acc.left
      ? { out: acc.out + part, left: acc.left - chars.length }
      : { out: `${acc.out}${chars.slice(0, Math.max(acc.left - 1, 0)).join('')}…`, left: 0 };
  }, { out: '', left: width });
  return `${fitted.out}${ESC}0m`;
}

export const folderTree = createPrompt<string, FolderTreeConfig>((config, done) => {
  const source = config.source ?? diskFolders;
  const pageSize = config.pageSize ?? 12;
  const theme = makeTheme({} as any) as any;
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const prefix = usePrefix({ status, theme });
  const [state, setState] = useState<FolderState>(() => initialFolderState(config.start, source, config.root));
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

  const width = Math.max((process.stdout.columns || 80) - 1, 20);
  const filtering = state.query.trim() !== '';
  const rows = visibleRows(state);
  const view = windowFor(rows.length, state.active, pageSize);
  const lines = rows.slice(view.start, view.end).map((row, i) => {
    const active = view.start + i === state.active;
    const text = rowText(row, filtering, active);
    return fitLine(active ? `${ACCENT('❯')} ${text}` : `  ${row.info.readable ? text : DIM(text)}`, width);
  });
  const empty = filtering && rows.length === 0
    ? `  ${DIM('No loaded folder matches. Press Esc to clear the filter, then → to open more folders.')}` // COPY-FLAG
    : '';
  const position = rows.length > pageSize ? DIM(`${state.active + 1} of ${rows.length}`) : '';
  const bar = state.typing !== null
    ? `${DIM('path:')} ${ACCENT(state.typing)}${DIM('▏')}  ${DIM('tab completes · enter opens · esc browses')}` // COPY-FLAG
    : state.query !== ''
      ? `${DIM('filter:')} ${ACCENT(state.query)}${DIM('▏')}`
      : '';

  return [
    [prefix, message].filter(Boolean).join(' '),
    fitLine(`  ${DIM(displayPath(state.base))}`, width),
    bar && fitLine(bar, width),
    ...lines,
    empty && fitLine(empty, width),
    position,
    state.error ? fitLine(theme.style.error(state.error), width) : '',
    ' ',
    fitLine(chooseLine(rows[state.active], state.base), width),
    fitLine(FOLDER_KEYS_HELP, width),
  ].filter(Boolean).join('\n');
}) as unknown as (config: FolderTreeConfig, context?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) => Promise<string>;
