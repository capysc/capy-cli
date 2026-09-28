// Interactive TUI for `capy secrets` (CAP-675).
//
// Modeled as a pure core / imperative shell, NOT as the mutable-class style
// `EditScreen` uses: `handleKey(state, key)` is a pure reducer (state in,
// state+effect out, no field assignment on an existing object), and
// `render(state, width, height)` is a pure function of state. The only
// side effects — raw stdin/stdout, and the network fetch + decrypt needed to
// reveal a value — live in `secretsScreenDriver.ts`, which calls this module
// but never the reverse.
//
// Security note: the index this screen renders carries NAMES and HASHES only
// (see `SecretsCommand`'s own doc). A value is decrypted at most once per
// details-open, on demand, and only for the one row whose popup is open —
// `resolveSecretValue` below is the pure boundary that decides which
// location to trust and never sees or returns anything but that one row's
// plaintext (or a coded reason it couldn't get one).

import type { SecretIndexLocation, SecretIndexRow, SecretIndexService } from '../service/serviceClient';
import { formatRelativeTime } from './relativeTime';
import { renderInlineValue } from './editScreen';
import { hashValue } from '../commands/statusCommand';

// ── ANSI (mirrors EditScreen's palette/look-and-feel) ───────────────────────

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const MOVE_HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_EOL = `${ESC}[K`;
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;

export const SECRETS_SCREEN_ANSI = {
  ESC,
  HIDE_CURSOR,
  SHOW_CURSOR,
  MOVE_HOME,
  CLEAR_SCREEN,
  CLEAR_EOL,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} as const;

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_LEFT = `${ESC}[D`;
const KEY_RIGHT = `${ESC}[C`;
const KEY_HOME = `${ESC}[H`;
const KEY_HOME2 = `${ESC}[1~`;
const KEY_END = `${ESC}[F`;
const KEY_END2 = `${ESC}[4~`;
const KEY_PGUP = `${ESC}[5~`;
const KEY_PGDN = `${ESC}[6~`;
const KEY_SHIFT_TAB = `${ESC}[Z`;
const KEY_TAB = '\t';
const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const KEY_CTRL_C = '\x03';
const KEY_BACKSPACE = '\x7f';
const KEY_BACKSPACE2 = '\b';

const PAGE_SIZE = 10;
const PAN_STEP = 8;

// ── Column cycling ───────────────────────────────────────────────────────────

export type ColumnMode = 'users' | 'branch' | 'service';
export const COLUMN_ORDER: readonly ColumnMode[] = ['users', 'branch', 'service'];

function nextColumn(column: ColumnMode, dir: 1 | -1): ColumnMode {
  const idx = COLUMN_ORDER.indexOf(column);
  const nextIdx = (idx + dir + COLUMN_ORDER.length) % COLUMN_ORDER.length;
  return COLUMN_ORDER[nextIdx];
}

// ── State ────────────────────────────────────────────────────────────────────

export type ValueState =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly value: string }
  | { readonly status: 'unavailable'; readonly code: string };

export interface PopupState {
  /** Identifies which (name, value_hash) row this popup belongs to, so a value that resolves after the popup moved on (or closed) is dropped instead of applied to the wrong row. */
  readonly rowName: string;
  readonly rowHash: string;
  readonly revealed: boolean;
  readonly value: ValueState;
  readonly panOffset: number;
}

export interface SearchState {
  readonly query: string;
}

export interface SecretsScreenState {
  readonly rows: readonly SecretIndexRow[];
  readonly column: ColumnMode;
  readonly cursorIndex: number;
  readonly search: SearchState;
  readonly popup: PopupState | null;
  readonly quit: boolean;
}

export function initialSecretsScreenState(rows: readonly SecretIndexRow[]): SecretsScreenState {
  return {
    rows,
    column: 'users',
    cursorIndex: 0,
    search: { query: '' },
    popup: null,
    quit: false,
  };
}

/** Rows currently visible, after the live NAME filter (case-insensitive substring). */
export function filteredRows(state: SecretsScreenState): readonly SecretIndexRow[] {
  const q = state.search.query.trim().toLowerCase();
  if (!q) return state.rows;
  return state.rows.filter((r) => r.name.toLowerCase().includes(q));
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

// ── Effects (data describing a side effect the driver must perform — the
// reducer itself performs none) ─────────────────────────────────────────────

export type SecretsScreenEffect = { readonly type: 'fetchValue'; readonly row: SecretIndexRow } | null;

export interface ReduceResult {
  readonly state: SecretsScreenState;
  readonly effect: SecretsScreenEffect;
}

const noEffect = (state: SecretsScreenState): ReduceResult => ({ state, effect: null });

/** Pure reducer: `(state, key) => { state, effect }`. Never touches stdin/stdout/network — see module doc. */
export function handleKey(state: SecretsScreenState, key: string): ReduceResult {
  if (key === KEY_CTRL_C) return noEffect({ ...state, quit: true });

  if (state.popup) return noEffect(handlePopupKey(state, key));

  return handleListKey(state, key);
}

function filteredRowsFor(rows: readonly SecretIndexRow[], query: string): readonly SecretIndexRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

/** Sets the search query and reclamps the cursor into the (possibly now-shorter) filtered set — never resets it to the top just because the query changed. */
function applyQuery(state: SecretsScreenState, query: string): SecretsScreenState {
  const rows = filteredRowsFor(state.rows, query);
  return { ...state, search: { query }, cursorIndex: clampIndex(state.cursorIndex, rows.length) };
}

function handlePopupKey(state: SecretsScreenState, key: string): SecretsScreenState {
  const popup = state.popup;
  if (!popup) return state;

  // `q` closes the popup here (same as Esc) — with the search bar always
  // live in the list view, `q` is no longer a global "quit" key at all;
  // only Ctrl-C, and Esc pressed with an already-empty query, quit the app.
  if (key === KEY_ESC || key === KEY_ESC_ESC || key === 'q' || key === 'Q') {
    return { ...state, popup: null };
  }
  if (key === 'r' || key === 'R') {
    return { ...state, popup: { ...popup, revealed: !popup.revealed } };
  }
  if (key === KEY_LEFT) {
    return { ...state, popup: { ...popup, panOffset: Math.max(0, popup.panOffset - PAN_STEP) } };
  }
  if (key === KEY_RIGHT) {
    return { ...state, popup: { ...popup, panOffset: popup.panOffset + PAN_STEP } };
  }
  if (key === KEY_HOME || key === KEY_HOME2) {
    return { ...state, popup: { ...popup, panOffset: 0 } };
  }
  if (key === KEY_END || key === KEY_END2) {
    return { ...state, popup: { ...popup, panOffset: Number.MAX_SAFE_INTEGER } };
  }
  return state;
}

/**
 * The list view: a search bar that's ALWAYS live (fzf-style, no separate
 * "search mode" to enter or leave) plus navigation. Every printable
 * character types into the query; `q`/`j`/`k`/`/` carry no special meaning
 * here anymore — they're just query text like any other letter. Esc clears
 * a non-empty query; pressed again (query already empty) it quits, so one
 * key reliably backs all the way out. Ctrl-C (handled one level up) always
 * quits regardless of query state.
 */
function handleListKey(state: SecretsScreenState, key: string): ReduceResult {
  const rows = filteredRows(state);

  if (key === KEY_ESC || key === KEY_ESC_ESC) {
    if (state.search.query !== '') return noEffect(applyQuery(state, ''));
    return noEffect({ ...state, quit: true });
  }

  if (key === KEY_TAB) {
    return noEffect({ ...state, column: nextColumn(state.column, 1) });
  }
  if (key === KEY_SHIFT_TAB) {
    return noEffect({ ...state, column: nextColumn(state.column, -1) });
  }

  if (key === KEY_UP) {
    return noEffect({ ...state, cursorIndex: clampIndex(state.cursorIndex - 1, rows.length) });
  }
  if (key === KEY_DOWN) {
    return noEffect({ ...state, cursorIndex: clampIndex(state.cursorIndex + 1, rows.length) });
  }
  if (key === KEY_PGUP) {
    return noEffect({ ...state, cursorIndex: clampIndex(state.cursorIndex - PAGE_SIZE, rows.length) });
  }
  if (key === KEY_PGDN) {
    return noEffect({ ...state, cursorIndex: clampIndex(state.cursorIndex + PAGE_SIZE, rows.length) });
  }

  if (key === '\r' || key === '\n') {
    const row = rows[clampIndex(state.cursorIndex, rows.length)];
    if (!row) return noEffect(state);
    const popup: PopupState = {
      rowName: row.name,
      rowHash: row.value_hash,
      revealed: false,
      value: { status: 'loading' },
      panOffset: 0,
    };
    return { state: { ...state, popup }, effect: { type: 'fetchValue', row } };
  }

  if (key === KEY_BACKSPACE || key === KEY_BACKSPACE2) {
    return noEffect(applyQuery(state, state.search.query.slice(0, -1)));
  }

  // Any other single printable character (including 'q', 'j', 'k', '/')
  // types into the search bar.
  if (key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) !== 0x7f) {
    return noEffect(applyQuery(state, state.search.query + key));
  }

  return noEffect(state);
}

/**
 * Applies a resolved (or failed) value fetch back into state. Dropped as
 * stale (a no-op) if the popup has since closed or moved to a different row
 * — the exact guard that keeps a slow fetch for row A from painting into row
 * B's popup after the user already moved on.
 */
export function applyValueResult(
  state: SecretsScreenState,
  forRow: { readonly name: string; readonly value_hash: string },
  result: ValueState,
): SecretsScreenState {
  if (!state.popup) return state;
  if (state.popup.rowName !== forRow.name || state.popup.rowHash !== forRow.value_hash) return state;
  return { ...state, popup: { ...state.popup, value: result } };
}

// ── Value resolution (pure given an injected decryptor — see module doc) ────

export type LocationDecryptResult = { readonly ok: true; readonly plaintext: string } | { readonly ok: false; readonly code: string };

/** Fetches + decrypts `name`'s value at one location. The actual network/crypto side effect lives in the driver; this type is the seam tests mock. */
export type LocationDecryptor = (location: SecretIndexLocation, name: string) => Promise<LocationDecryptResult>;

/**
 * Tries each of `row.locations` in order until one produces a plaintext
 * whose hash matches `row.value_hash`. A location that refuses the fetch, or
 * whose plaintext hashes to something else, is skipped in favor of the next
 * one — never surfaced as the value. Never invents a placeholder value.
 */
export async function resolveSecretValue(row: SecretIndexRow, decryptAt: LocationDecryptor): Promise<ValueState> {
  return resolveSecretValueLoop(row, decryptAt, 0, 'NO_LOCATIONS');
}

async function resolveSecretValueLoop(
  row: SecretIndexRow,
  decryptAt: LocationDecryptor,
  index: number,
  lastCode: string,
): Promise<ValueState> {
  if (index >= row.locations.length) {
    return { status: 'unavailable', code: lastCode };
  }
  const loc = row.locations[index];
  const result = await decryptAt(loc, row.name);
  if (!result.ok) {
    return resolveSecretValueLoop(row, decryptAt, index + 1, result.code);
  }
  if (hashValue(result.plaintext) === row.value_hash) {
    return { status: 'ok', value: result.plaintext };
  }
  return resolveSecretValueLoop(row, decryptAt, index + 1, 'HASH_MISMATCH');
}

// ── Column cell formatting (pure) ────────────────────────────────────────────

export function formatUsersCell(row: SecretIndexRow): string {
  const n = row.users.length;
  return `${n} user${n === 1 ? '' : 's'}`;
}

export function formatBranchCell(row: SecretIndexRow): string {
  const first = row.locations[0];
  if (!first) return '—';
  const base = `${first.project_name} · ${first.branch}`;
  const extra = row.locations.length - 1;
  return extra > 0 ? `${base} +${extra}` : base;
}

/** Same fallback chain as `SecretsCommand.formatService` — kept as a free function here so the TUI's static and interactive renderings can never quietly diverge in wording. */
export function formatServiceLabel(service: SecretIndexService | null): string {
  if (!service) return '—';
  if (service.name) {
    return service.dokploy_project ? `${service.dokploy_project} / ${service.name}` : service.name;
  }
  if (service.compose_id) return `dokploy:${service.compose_id}`;
  return '—';
}

export function formatServiceCell(row: SecretIndexRow): string {
  const first = row.locations[0] ?? null;
  const label = formatServiceLabel(first ? first.service : null);
  const distinct = new Set(row.locations.map((l) => formatServiceLabel(l.service)));
  return distinct.size > 1 ? `${label} +${distinct.size - 1}` : label;
}

export function formatMiddleCell(row: SecretIndexRow, column: ColumnMode): string {
  if (column === 'users') return formatUsersCell(row);
  if (column === 'branch') return formatBranchCell(row);
  return formatServiceCell(row);
}

/** Most recent `changed_at` across a row's locations, or undefined if none carry one. */
export function mostRecentChangedAt(row: SecretIndexRow): string | undefined {
  const timestamps = row.locations.map((l) => l.changed_at).filter((v): v is string => Boolean(v));
  if (timestamps.length === 0) return undefined;
  return timestamps.reduce((latest, cur) => (new Date(cur).getTime() > new Date(latest).getTime() ? cur : latest));
}

export function formatUpdatedCell(row: SecretIndexRow, now?: Date): string {
  const ts = mostRecentChangedAt(row);
  return ts ? formatRelativeTime(ts, now) : '—';
}

// ── Masking (security-critical — see module doc and CAP-675's spec) ─────────

const FULL_MASK = '••••••••';

/**
 * Never reveals a value ≤8 chars (always the same fixed-width mask, so
 * length itself isn't leaked either). For longer values, shows at most 4
 * characters total, split as a prefix and a suffix, and never more than a
 * third of the value's length — deliberately weaker than
 * `formatSnippet`, which shows values ≤6 chars verbatim; that behavior is
 * not reused here on purpose.
 */
export function maskSecretValue(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length <= 8) return FULL_MASK;
  const maxShown = Math.min(4, Math.floor(value.length / 3));
  const prefixLen = Math.ceil(maxShown / 2);
  const suffixLen = maxShown - prefixLen;
  const prefix = value.slice(0, prefixLen);
  const suffix = suffixLen > 0 ? value.slice(value.length - suffixLen) : '';
  return `${prefix}...${suffix}`;
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

function columnHeaderLabel(column: ColumnMode): string {
  return `${column.toUpperCase()} ⇥`;
}

/**
 * Always-visible search bar (fzf-style — there's no separate "search mode"
 * to enter). Shows a dim placeholder when empty and a `<matched>/<total>`
 * count; the insertion caret only appears when the list view actually owns
 * keystrokes (i.e. no popup is open).
 */
function searchBarLine(state: SecretsScreenState, matchedCount: number): string {
  const focused = state.popup === null;
  const caret = focused ? '▏' : '';
  const queryDisplay = state.search.query !== '' ? state.search.query : focused ? `${DIM}type to filter${RESET}` : '';
  const countLabel = `${matchedCount}/${state.rows.length}`;
  return `${DIM}search:${RESET} ${queryDisplay}${caret} ${DIM}${countLabel}${RESET}`;
}

/** Pure render — a total function of state + terminal size. Never mutates `state`; any "clamping" of a display-only quantity (e.g. panning past the end of a value) is a local `const`, never written back. */
export function render(state: SecretsScreenState, termWidth: number, termHeight: number): string {
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);
  const rows = filteredRows(state);
  const cursorIndex = clampIndex(state.cursorIndex, rows.length);

  const lines: string[] = [];
  lines.push(`${m}${BOLD}capy secrets${RESET} ${DIM}(${state.rows.length} secret${state.rows.length === 1 ? '' : 's'})${RESET}`);
  lines.push(m + searchBarLine(state, rows.length));
  lines.push('');

  const nameW = Math.max(16, Math.floor(available * 0.4));
  const updatedW = 14;
  const gap = '  ';
  const middleW = Math.max(10, available - nameW - updatedW - gap.length * 2);

  const headerLine = pad('NAME', nameW) + gap + pad(columnHeaderLabel(state.column), middleW) + gap + pad('UPDATED', updatedW);
  lines.push(m + DIM + headerLine + RESET);

  const bodyLines: string[] = rows.map((row, i) => {
    const isSelected = i === cursorIndex;
    const pointer = isSelected ? '▶ ' : '  ';
    const nameCell = pad(pointer + row.name, nameW);
    const middleCell = pad(formatMiddleCell(row, state.column), middleW);
    const updatedCell = pad(formatUpdatedCell(row), updatedW);
    const line = nameCell + gap + middleCell + gap + updatedCell;
    return isSelected ? INVERSE + padVis(line, available) + RESET : line;
  });

  const withPopup: string[] =
    state.popup && rows[cursorIndex]
      ? spliceIn(bodyLines, cursorIndex, buildPopupLines(rows[cursorIndex], state.popup, available))
      : bodyLines;

  const reserved = lines.length + 1 /* table header already pushed above */ + 2 /* footer */;
  const bodyHeight = Math.max(6, termHeight - reserved);
  const scrollOffset = computeScrollOffset(withPopup, cursorIndex, bodyHeight, state.popup !== null);
  const slice = withPopup.slice(scrollOffset, scrollOffset + bodyHeight);

  if (rows.length === 0) {
    lines.push(`${m}${DIM}No secrets match.${RESET}`);
  } else {
    for (const line of slice) lines.push(m + line);
  }

  lines.push('');
  lines.push(m + footerLine(state));

  return lines.map((l) => l + CLEAR_EOL).join('\n');
}

function spliceIn(bodyLines: readonly string[], afterIndex: number, insert: readonly string[]): string[] {
  return [...bodyLines.slice(0, afterIndex + 1), ...insert, ...bodyLines.slice(afterIndex + 1)];
}

/** Where a row `cursorIndex` sits inside `lines` (accounting for an inline popup possibly pushing later lines down) determines the scroll window — kept a simple "just enough to keep the cursor row visible" policy, same as EditScreen's. */
function computeScrollOffset(lines: readonly string[], cursorIndex: number, bodyHeight: number, popupOpen: boolean): number {
  const cursorLineIdx = cursorIndex; // one line per row above the popup insert point
  if (!popupOpen) {
    if (cursorLineIdx < bodyHeight) return 0;
    return Math.min(cursorLineIdx - bodyHeight + 1, Math.max(0, lines.length - bodyHeight));
  }
  // Popup open: pin the cursor row near the top so the popup beneath it has room.
  const target = Math.max(0, cursorLineIdx - 1);
  return Math.min(target, Math.max(0, lines.length - bodyHeight));
}

function buildPopupLines(row: SecretIndexRow, popup: PopupState, width: number): string[] {
  const indent = '  ';
  const inner = '   ';
  const ruleWidth = Math.max(10, width - indent.length);
  const rule = `${indent}${DIM}╶${'─'.repeat(Math.max(0, ruleWidth - 2))}╴${RESET}`;
  const labelW = 9;
  const contentWidth = Math.max(20, ruleWidth - inner.length - 1);
  const valueWidth = Math.max(10, contentWidth - labelW);

  const field = (label: string, value: string) => `${indent}${inner}${DIM}${pad(label, labelW)}${RESET}${value}`;

  const lines: string[] = [rule, '', `${indent}${inner}${BOLD}${truncate(row.name, contentWidth)}${RESET}`, ''];
  lines.push(field('value', renderPopupValueLine(popup, valueWidth)));
  lines.push(field('updated', formatUpdatedCell(row)));
  lines.push('');

  lines.push(`${indent}${inner}${BOLD}locations${RESET}`);
  for (const loc of row.locations) {
    const protMarker = loc.protected ? ` ${DIM}(protected)${RESET}` : '';
    const svc = formatServiceLabel(loc.service);
    const updated = loc.changed_at ? formatRelativeTime(loc.changed_at) : '—';
    lines.push(`${indent}${inner}${truncate(`${loc.project_name} · ${loc.branch}`, contentWidth)}${protMarker} ${DIM}· ${svc} · ${updated}${RESET}`);
  }
  lines.push('');

  lines.push(`${indent}${inner}${BOLD}users${RESET}`);
  if (row.users.length === 0) {
    lines.push(`${indent}${inner}${DIM}(none)${RESET}`);
  } else {
    for (const u of row.users) lines.push(`${indent}${inner}${truncate(u.email, contentWidth)}`);
  }

  lines.push('');
  lines.push(rule);
  return lines;
}

function renderPopupValueLine(popup: PopupState, width: number): string {
  if (popup.value.status === 'loading') return `${DIM}loading…${RESET}`;
  if (popup.value.status === 'unavailable') return `${RED}unavailable ${DIM}(${popup.value.code})${RESET}`;

  const raw = popup.value.value;
  if (!popup.revealed) return maskSecretValue(raw);
  if (raw === '') return `${DIM}(empty)${RESET}`;

  const value = renderInlineValue(raw);
  if (value.length <= width) return value;

  const visibleWidth = Math.max(1, width - 4);
  const maxOffset = Math.max(0, value.length - visibleWidth);
  const offset = Math.min(Math.max(0, popup.panOffset), maxOffset);
  const leftIndicator = offset > 0 ? `${DIM}◂${RESET} ` : '  ';
  const rightIndicator = offset < maxOffset ? ` ${DIM}▸${RESET}` : '  ';
  return leftIndicator + value.slice(offset, offset + visibleWidth) + rightIndicator;
}

function footerLine(state: SecretsScreenState): string {
  if (state.popup) {
    const revealLabel = state.popup.revealed ? 'hide' : 'reveal';
    const panHint = state.popup.revealed ? `${DIM} · ${RESET}${BOLD}←/→${RESET}${DIM} pan${RESET}` : '';
    return `${BOLD}r${RESET}${DIM} ${revealLabel}${RESET}${panHint}${DIM} · ${RESET}${BOLD}esc${RESET}${DIM}/${RESET}${BOLD}q${RESET}${DIM} close${RESET}`;
  }
  return `${DIM}↑↓ navigate · ${RESET}${BOLD}tab${RESET}${DIM} column · ${RESET}${BOLD}enter${RESET}${DIM} inspect · ${RESET}${BOLD}esc${RESET}${DIM} clear/quit${RESET}`;
}
