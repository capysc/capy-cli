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
import { ACCENT } from './colors';

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

// ── Chunk tokenizing ─────────────────────────────────────────────────────────
//
// A single stdin `data` event can carry more than one keypress — a paste, a
// fast typist, or scripted/piped input can all deliver e.g. "APIFY\r" as one
// chunk. `handleKey` only ever consumes one token at a time, so the driver
// must split a chunk into tokens BEFORE feeding the reducer, in order, or
// everything after the first character is silently dropped. This is that
// split, kept pure and exported so it's testable on its own.

/** A byte belongs to a CSI sequence's parameter/intermediate region (ECMA-48): digits, `;`, `?`, etc. */
function isCsiParamByte(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

/** A byte that terminates a CSI sequence (ECMA-48 final byte range). */
function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Scans a CSI sequence (`ESC [ params... final`) starting at `rest[start]`
 * (the byte right after `ESC [`). Consumes up through the final byte as one
 * token. If the chunk ends before a final byte appears (the sequence is
 * split across two `data` events, or the chunk is simply truncated — e.g. a
 * bracketed-paste marker like `ESC[200~` counts as an ordinary CSI sequence
 * here since bracketed paste isn't enabled on this screen), whatever was
 * scanned is still returned as ONE token rather than falling through to
 * per-character tokenizing — that would otherwise chop something like an
 * unrecognized `ESC[200~` into stray `[`, `2`, `0`, `0`, `~` characters that
 * would each get typed into the search bar.
 */
function scanCsi(rest: string, start: number): { readonly token: string; readonly length: number } {
  if (start >= rest.length) return { token: rest, length: rest.length };
  const code = rest.charCodeAt(start);
  if (isCsiFinalByte(code)) return { token: rest.slice(0, start + 1), length: start + 1 };
  if (isCsiParamByte(code)) return scanCsi(rest, start + 1);
  // A byte outside both ranges means this was never a well-formed CSI
  // sequence — stop before it rather than consuming something unrelated.
  return { token: rest.slice(0, start), length: start };
}

/** `rest` starts with `ESC`. Reads exactly one escape-rooted token: a CSI sequence, an SS3 sequence (`ESC O <byte>`), a double `ESC ESC` (some terminals double-emit one physical Escape keypress this way), or a lone `ESC`. */
function readEscapeToken(rest: string): { readonly token: string; readonly length: number } {
  if (rest.length === 1) return { token: ESC, length: 1 };
  const second = rest[1];
  if (second === ESC) return { token: `${ESC}${ESC}`, length: 2 };
  if (second === '[') return scanCsi(rest, 2);
  if (second === 'O') return rest.length >= 3 ? { token: rest.slice(0, 3), length: 3 } : { token: rest, length: rest.length };
  // ESC followed by an ordinary character (e.g. an Alt+key combo some
  // terminals send this way) — treat the ESC as its own token; the next
  // character is tokenized on its own in the next recursive step.
  return { token: ESC, length: 1 };
}

/**
 * Splits one raw stdin chunk into key tokens, in the order they arrived.
 * Everything that isn't an escape sequence is split one Unicode code point
 * at a time — via `codePointAt`/`fromCodePoint`, not raw indexing, so a
 * surrogate-pair character (an emoji, say) is one token, not two broken
 * halves. Pure; the driver's only job is to feed each returned token
 * through `handleKey` in order.
 */
export function tokenizeKeys(chunk: string): readonly string[] {
  return tokenizeFrom(chunk, 0);
}

function tokenizeFrom(chunk: string, index: number): readonly string[] {
  if (index >= chunk.length) return [];

  if (chunk[index] === ESC) {
    const { token, length } = readEscapeToken(chunk.slice(index));
    return [token, ...tokenizeFrom(chunk, index + length)];
  }

  const codePoint = chunk.codePointAt(index);
  const char = codePoint === undefined ? chunk[index] : String.fromCodePoint(codePoint);
  return [char, ...tokenizeFrom(chunk, index + char.length)];
}

// ── Column cycling ───────────────────────────────────────────────────────────

export type ColumnMode = 'service' | 'users' | 'branch' | 'project';
/** Tab cycles forward through this order (wrapping); Shift-Tab backward. SERVICE is the default/first-shown column. */
export const COLUMN_ORDER: readonly ColumnMode[] = ['service', 'users', 'branch', 'project'];

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
    column: 'service',
    cursorIndex: 0,
    search: { query: '' },
    popup: null,
    quit: false,
  };
}

// ── Search matching (CAP-678) ────────────────────────────────────────────────
//
// The always-on search bar matches a row on any of five signals: its NAME,
// any location's PROJECT, BRANCH, or SERVICE (case-insensitive substring,
// query trimmed of surrounding whitespace), or an exact VALUE match — the
// query's own sha256-slice hash (via the same `hashValue`
// `resolveSecretValue` uses) compared against `row.value_hash`. Nothing
// about the query or a candidate value ever leaves this process; this is a
// pure, local, in-memory comparison against a hash the server already sent.
//
// `computeFilteredRows` is the single pass that does both the filtering and
// the "why did this row match" bookkeeping the UI tags rows with — it hashes
// the query at most twice (once for the raw query, once more only if
// trimming changed it) regardless of how many rows there are, never once per
// row.

export type MatchReason = 'value' | 'name' | 'project' | 'branch' | 'service';

export interface MatchedRow {
  readonly row: SecretIndexRow;
  /** Every reason `row` matched, in priority order (value > name > project > branch > service); empty when the query is blank. */
  readonly reasons: readonly MatchReason[];
}

/**
 * Whether `location`'s Dokploy service (if it has one) matches `qLower`:
 * a substring of `service.name`, of `service.dokploy_project`, or of the
 * `"dokploy_project / name"` label those two form together (so a query
 * spanning the " / " separator still matches) — never `compose_id`, which
 * this spec doesn't call for. A `null` service (no Dokploy connector at
 * this location) never matches anything.
 */
function locationServiceMatches(location: SecretIndexLocation, qLower: string): boolean {
  const service = location.service;
  if (service === null) return false;
  const combinedLabel = service.name && service.dokploy_project ? `${service.dokploy_project} / ${service.name}` : undefined;
  const candidates = [service.name, service.dokploy_project, combinedLabel].filter((s): s is string => Boolean(s));
  return candidates.some((s) => s.toLowerCase().includes(qLower));
}

/** `qLower` is the trimmed, lowercased query; `rawHash`/`trimmedHash` are the query's hash(es) — computed once by the caller, never here. */
function rowMatchReasons(row: SecretIndexRow, qLower: string, rawHash: string, trimmedHash: string | null): readonly MatchReason[] {
  const isValueMatch = row.value_hash === rawHash || (trimmedHash !== null && row.value_hash === trimmedHash);
  const isNameMatch = row.name.toLowerCase().includes(qLower);
  const isProjectMatch = row.locations.some((l) => l.project_name.toLowerCase().includes(qLower));
  const isBranchMatch = row.locations.some((l) => l.branch.toLowerCase().includes(qLower));
  const isServiceMatch = row.locations.some((l) => locationServiceMatches(l, qLower));
  return (
    [
      [isValueMatch, 'value'] as const,
      [isNameMatch, 'name'] as const,
      [isProjectMatch, 'project'] as const,
      [isBranchMatch, 'branch'] as const,
      [isServiceMatch, 'service'] as const,
    ] satisfies readonly (readonly [boolean, MatchReason])[]
  )
    .filter(([matched]) => matched)
    .map(([, reason]) => reason);
}

/**
 * Filters `rows` against `query` and, for each survivor, records which
 * signal(s) it matched on — in one pass, so the query's hash(es) are
 * computed exactly once no matter how many rows are scanned. An
 * empty/whitespace-only query short-circuits to "everything matches, no
 * reasons" before any hashing happens (mirrors the old NAME-only filter's
 * behavior when the bar is empty).
 */
function computeFilteredRows(rows: readonly SecretIndexRow[], query: string): readonly MatchedRow[] {
  const trimmed = query.trim();
  const qLower = trimmed.toLowerCase();
  if (!qLower) return rows.map((row) => ({ row, reasons: [] as const }));

  // Computed ONCE per filter pass — never inside the per-row map below.
  const rawHash = hashValue(query);
  const trimmedHash = trimmed !== query ? hashValue(trimmed) : null;

  return rows
    .map((row) => ({ row, reasons: rowMatchReasons(row, qLower, rawHash, trimmedHash) }))
    .filter((m) => m.reasons.length > 0);
}

/** Rows currently visible, plus why each one matched — see the module note above `computeFilteredRows`. */
export function filteredRowsWithReasons(state: SecretsScreenState): readonly MatchedRow[] {
  return computeFilteredRows(state.rows, state.search.query);
}

/** Rows currently visible, after the live filter (name, project, branch, service, or exact value — see `computeFilteredRows`). */
export function filteredRows(state: SecretsScreenState): readonly SecretIndexRow[] {
  return computeFilteredRows(state.rows, state.search.query).map((m) => m.row);
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
  return computeFilteredRows(rows, query).map((m) => m.row);
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

  // Only `\r` opens details — deliberately NOT `\n`. Bracketed paste isn't
  // enabled on this screen, so a multi-line paste arrives as plain bytes
  // with `\n` as its line separator; treating `\n` as Enter would open a
  // popup per pasted line. A real Enter keypress sends `\r` in raw mode.
  // (This can't fully distinguish a real Enter from a literal `\r` inside
  // pasted CRLF-style text — that ambiguity is inherent to an unbracketed
  // raw stream and is an accepted, documented limitation here.)
  if (key === '\r') {
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

/** Just the branch name(s) now — PROJECT is its own column, so no `project · ` prefix here. `+N` counts DISTINCT branch names across the row's locations, same convention as SERVICE/PROJECT (not raw location count — two locations on the same branch name don't inflate it). */
export function formatBranchCell(row: SecretIndexRow): string {
  const first = row.locations[0];
  if (!first) return '—';
  const distinct = new Set(row.locations.map((l) => l.branch));
  return distinct.size > 1 ? `${first.branch} +${distinct.size - 1}` : first.branch;
}

/** Project name of the first location; `+N` for more DISTINCT projects across the row's locations. */
export function formatProjectCell(row: SecretIndexRow): string {
  const first = row.locations[0];
  if (!first) return '—';
  const distinct = new Set(row.locations.map((l) => l.project_name));
  return distinct.size > 1 ? `${first.project_name} +${distinct.size - 1}` : first.project_name;
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
  if (column === 'service') return formatServiceCell(row);
  if (column === 'users') return formatUsersCell(row);
  if (column === 'branch') return formatBranchCell(row);
  return formatProjectCell(row);
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

/**
 * Builds the NAME column's cell for one row: `left` (pointer + name)
 * left-aligned, `tag` (a match-reason tag, already ANSI-wrapped, or `''`
 * for no tag) right-justified against the column's own right edge — so the
 * column's fixed 2-space `gap` to the next column is the ONLY space after
 * the tag's closing `]`, never more. Widths are measured with ANSI
 * stripped (`visLen`), so styling never throws off alignment.
 *
 * When `left` + a minimum 1-space separator + `tag` would overflow
 * `width`, `left` — never `tag` — is truncated (via the existing
 * `truncate` ellipsis style) just enough to make room.
 */
function buildNameCell(left: string, tag: string, width: number): string {
  if (tag === '') return pad(left, width);
  const tagVis = visLen(tag);
  const maxLeftVis = Math.max(0, width - tagVis - 1);
  const fittedLeft = visLen(left) > maxLeftVis ? truncate(left, maxLeftVis) : left;
  const separatorWidth = Math.max(1, width - visLen(fittedLeft) - tagVis);
  return fittedLeft + ' '.repeat(separatorWidth) + tag;
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
  const placeholder = `${DIM}type to filter — name, project, branch, service, or exact value${RESET}`;
  const typedQuery = `${ACCENT}${state.search.query}${RESET}`;
  const queryDisplay = state.search.query !== '' ? typedQuery : focused ? placeholder : '';
  const countLabel = `${matchedCount}/${state.rows.length}`;
  return `${DIM}search:${RESET} ${queryDisplay}${caret} ${DIM}${countLabel}${RESET}`;
}

/** Pure render — a total function of state + terminal size. Never mutates `state`; any "clamping" of a display-only quantity (e.g. panning past the end of a value) is a local `const`, never written back. */
export function render(state: SecretsScreenState, termWidth: number, termHeight: number): string {
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);
  const matched = filteredRowsWithReasons(state);
  const rows = matched.map((mr) => mr.row);
  const matchActive = state.search.query.trim() !== '';
  const cursorIndex = clampIndex(state.cursorIndex, rows.length);

  const headerLines: readonly string[] = [
    `${m}${BOLD}capy secrets${RESET} ${DIM}(${state.rows.length} secret${state.rows.length === 1 ? '' : 's'})${RESET}`,
    m + searchBarLine(state, rows.length),
    '',
  ];

  const nameW = Math.max(16, Math.floor(available * 0.4));
  const updatedW = 14;
  const gap = '  ';
  const middleW = Math.max(10, available - nameW - updatedW - gap.length * 2);

  const headerLine = pad('NAME', nameW) + gap + pad(columnHeaderLabel(state.column), middleW) + gap + pad('UPDATED', updatedW);
  // Everything pushed before the body, in one array — `preBodyLines.length`
  // below stands in for what used to be `lines.length` read mid-mutation.
  const preBodyLines: readonly string[] = [...headerLines, m + DIM + headerLine + RESET];

  const bodyLines: readonly string[] = matched.map(({ row, reasons }, i) => {
    const isSelected = i === cursorIndex;
    const pointer = isSelected ? '▶ ' : '  ';
    // Strongest reason only (reasons is already priority-ordered) — a
    // compact blue tag, right-justified against the NAME column's own edge
    // (see `buildNameCell`), and only while a query is actually active (an
    // empty query carries no reasons anyway, but this also guards
    // `matchActive` for callers that ever hand in a non-empty `reasons`
    // alongside a cleared query).
    const tag = matchActive && reasons.length > 0 ? `${ACCENT}[${reasons[0]}]${RESET}` : '';
    const nameCell = buildNameCell(pointer + row.name, tag, nameW);
    const middleCell = pad(formatMiddleCell(row, state.column), middleW);
    const updatedCell = pad(formatUpdatedCell(row), updatedW);
    const line = nameCell + gap + middleCell + gap + updatedCell;
    return isSelected ? INVERSE + padVis(line, available) + RESET : line;
  });

  const withPopup: readonly string[] =
    state.popup && rows[cursorIndex]
      ? spliceIn(bodyLines, cursorIndex, buildPopupLines(rows[cursorIndex], state.popup, available))
      : bodyLines;

  const reserved = preBodyLines.length + 1 /* table header already pushed above */ + 2 /* footer */;
  const bodyHeight = Math.max(6, termHeight - reserved);
  const scrollOffset = computeScrollOffset(withPopup, cursorIndex, bodyHeight, state.popup !== null);
  const slice = withPopup.slice(scrollOffset, scrollOffset + bodyHeight);

  const bodyOutputLines: readonly string[] =
    rows.length === 0 ? [`${m}${DIM}No secrets match.${RESET}`] : slice.map((line) => m + line);

  const footerLines: readonly string[] = ['', m + footerLine(state)];

  const lines: readonly string[] = [...preBodyLines, ...bodyOutputLines, ...footerLines];

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
