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

import type { SecretIndexLocation, SecretIndexRow, SecretIndexTarget } from '../service/serviceClient';
import { formatRelativeTime } from './relativeTime';
import { renderInlineValue } from './editScreen';
import { hashValue } from '../commands/statusCommand';
import { ACCENT } from './colors';
import { normalizeQuery, textMatches } from './searchMatch';
import { CANCELLED_NOTHING, DRY_RUN_LABEL } from '../commands/secretsSetText';
import type { RunProgress } from '../commands/secretsSet';
import { clipLine } from './pickerTable';
import { NOT_DEPLOYED, formatSecretRowStatus, secretRowStatus } from '../core/deployStatus';
import { statusBadge, statusColor } from './statusBadge';
import {
  EditEffect,
  EditFlow,
  ReposLoaded,
  RunFinished,
  applyBasesLoaded,
  applyProgress,
  applyReposLoaded,
  basesEffectFor,
  applyOldValue,
  applyRunFinished,
  isRunning,
  renderEdit,
  startEdit,
  stepEdit,
} from './secretsEditFlow';

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
const YELLOW = `${ESC}[33m`;

// Bracketed paste: the terminal wraps pasted text in markers so a multi-line
// value (a PEM key) can be taken verbatim by the edit dialog.
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

export const SECRETS_SCREEN_ANSI = {
  ESC,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
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
/** Ctrl+E: edit the selected row's value, from the list while no filter is typed. The plain `e` is only a hotkey in the details view, where nothing types. */
const KEY_CTRL_E = '\x05';
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

export type ColumnMode = 'project' | 'branch' | 'status' | 'connector' | 'target' | 'integrations' | 'users';
/** Tab cycles forward through this order (wrapping); Shift-Tab backward. PROJECT is the default/first-shown column (CAP-702, Vince 2026-10-03). */
export const COLUMN_ORDER: readonly ColumnMode[] = ['project', 'branch', 'status', 'connector', 'target', 'integrations', 'users'];

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
  /** The edit flow (CAP-698), open while a value is being changed; `null` otherwise. */
  readonly edit: EditFlow | null;
  /** `capy --dry-run secrets`: the edit flow only plans, and every screen says so. */
  readonly dryRun: boolean;
  readonly quit: boolean;
  /** Printed to stdout after the screen is left (the edit confirmation, so it stays in the scrollback). */
  readonly exitText: string | null;
  /** A short dim note shown under the list until the next key (e.g. that an edit was cancelled). */
  readonly note: string | null;
}

export function initialSecretsScreenState(rows: readonly SecretIndexRow[], dryRun: boolean = false): SecretsScreenState {
  return {
    rows,
    column: COLUMN_ORDER[0],
    cursorIndex: 0,
    search: { query: '' },
    popup: null,
    edit: null,
    dryRun,
    quit: false,
    exitText: null,
    note: null,
  };
}

// ── Search matching (CAP-678/CAP-679) ────────────────────────────────────────
//
// The always-on search bar matches a row on any of six signals: its NAME,
// any location's PROJECT, BRANCH, CONNECTOR (inbound), or TARGET (outbound)
// (case-insensitive substring, query trimmed of surrounding whitespace), or
// an exact VALUE match — the query's own sha256-slice hash (via the same
// `hashValue` `resolveSecretValue` uses) compared against `row.value_hash`.
// Nothing about the query or a candidate value ever leaves this process;
// this is a pure, local, in-memory comparison against a hash the server
// already sent.
//
// `computeFilteredRows` is the single pass that does both the filtering and
// the "why did this row match" bookkeeping the UI tags rows with — it hashes
// the query at most twice (once for the raw query, once more only if
// trimming changed it) regardless of how many rows there are, never once per
// row.

export type MatchReason = 'value' | 'name' | 'project' | 'branch' | 'connector' | 'target';

export interface MatchedRow {
  readonly row: SecretIndexRow;
  /** Every reason `row` matched, in priority order (value > name > project > branch > connector > target); empty when the query is blank. */
  readonly reasons: readonly MatchReason[];
}

/**
 * Whether `location`'s inbound connector (if it has one) matches `qLower`:
 * a substring of its provider (`connector.provider`, falling back to
 * `service.provider` on a server that predates CAP-676 — see
 * `SecretIndexConnector`'s doc) or of its name (`service.name` — the
 * connector shape itself carries no name field). No provider at all (no
 * connector AND no service) never matches anything.
 */
function locationConnectorMatches(location: SecretIndexLocation, qLower: string): boolean {
  const provider = location.connector?.provider ?? location.service?.provider;
  const name = location.service?.name;
  const candidates = [provider, name].filter((s): s is string => Boolean(s));
  return candidates.some((s) => textMatches(s, qLower));
}

/** Whether ANY of `location`'s outbound deploy targets (absent/`[]` on a server that predates CAP-676) matches `qLower` — a substring of that target's provider or of its target name. */
function locationTargetMatches(location: SecretIndexLocation, qLower: string): boolean {
  return (location.targets ?? []).some(
    (t) => textMatches(t.provider, qLower) || textMatches(t.target, qLower),
  );
}

/** `qLower` is the trimmed, lowercased query; `rawHash`/`trimmedHash` are the query's hash(es) — computed once by the caller, never here. */
function rowMatchReasons(row: SecretIndexRow, qLower: string, rawHash: string, trimmedHash: string | null): readonly MatchReason[] {
  const isValueMatch = row.value_hash === rawHash || (trimmedHash !== null && row.value_hash === trimmedHash);
  const isNameMatch = textMatches(row.name, qLower);
  const isProjectMatch = row.locations.some((l) => textMatches(l.project_name, qLower));
  const isBranchMatch = row.locations.some((l) => textMatches(l.branch, qLower));
  const isConnectorMatch = row.locations.some((l) => locationConnectorMatches(l, qLower));
  const isTargetMatch = row.locations.some((l) => locationTargetMatches(l, qLower));
  return (
    [
      [isValueMatch, 'value'] as const,
      [isNameMatch, 'name'] as const,
      [isProjectMatch, 'project'] as const,
      [isBranchMatch, 'branch'] as const,
      [isConnectorMatch, 'connector'] as const,
      [isTargetMatch, 'target'] as const,
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
  const qLower = normalizeQuery(query);
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

/** Rows currently visible, after the live filter (name, project, branch, connector, target, or exact value — see `computeFilteredRows`). */
export function filteredRows(state: SecretsScreenState): readonly SecretIndexRow[] {
  return computeFilteredRows(state.rows, state.search.query).map((m) => m.row);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

// ── Effects (data describing a side effect the driver must perform — the
// reducer itself performs none) ─────────────────────────────────────────────

export type SecretsScreenEffect = { readonly type: 'fetchValue'; readonly row: SecretIndexRow } | EditEffect | null;

export interface ReduceResult {
  readonly state: SecretsScreenState;
  readonly effect: SecretsScreenEffect;
}

const noEffect = (state: SecretsScreenState): ReduceResult => ({ state, effect: null });

/** Pure reducer: `(state, key) => { state, effect }`. Never touches stdin/stdout/network — see module doc. */
export function handleKey(state: SecretsScreenState, rawKey: string): ReduceResult {
  const key = rawKey;
  // The note lasts until the next key.
  if (state.note !== null) return handleKey({ ...state, note: null }, rawKey);

  // While an edit runs, Ctrl-C and Esc STOP it (never leave the screen hanging, never cut a push in half).
  if (key === KEY_CTRL_C && !isRunning(state.edit)) return noEffect({ ...state, quit: true });

  if (state.edit) return handleEditFlowKey(state, state.edit, key);

  if (state.popup) {
    return key === 'e' || key === 'E' || key === KEY_CTRL_E ? openEditOnCursor(state) : noEffect(handlePopupKey(state, key));
  }

  return handleListKey(state, key);
}

/**
 * The row under the cursor, as the edit flow's starting point. Its current value
 * is fetched with the same effect (and so the same decrypt path) the details view
 * uses, so the dialog's Old value row can show it on request.
 */
function openEditOnCursor(state: SecretsScreenState): ReduceResult {
  const rows = filteredRows(state);
  const row = rows[clampIndex(state.cursorIndex, rows.length)];
  return row ? { state: { ...state, popup: null, edit: startEdit(row) }, effect: { type: 'fetchValue', row } } : noEffect(state);
}

function handleEditFlowKey(state: SecretsScreenState, flow: EditFlow, key: string): ReduceResult {
  // A dry run only plans (reads): stopping it is immediate and nothing was ever going to change.
  if (state.dryRun && flow.step === 'running' && (key === KEY_CTRL_C || key === KEY_ESC || key === KEY_ESC_ESC)) {
    return { state: { ...state, edit: null, note: CANCELLED_NOTHING }, effect: { type: 'cancelRun', phase: 'planning' } };
  }
  const step = stepEdit(flow, key);
  if (step.exitText !== undefined) return noEffect({ ...state, edit: null, quit: true, exitText: step.exitText });
  return { state: { ...state, edit: step.flow, note: step.note ?? null }, effect: step.effect };
}

/** The run reported progress (a single re-render). */
export function applyRunProgress(state: SecretsScreenState, progress: RunProgress): SecretsScreenState {
  return { ...state, edit: applyProgress(state.edit, progress) };
}

/** The repo list the `loadRepos` effect asked for. */
export function applyRepos(state: SecretsScreenState, result: ReposLoaded): SecretsScreenState {
  return { ...state, edit: applyReposLoaded(state.edit, result) };
}

/**
 * The repo table is up: the effect that reads its BASE column, or `null` when
 * there is nothing to read. The driver performs it right after `applyRepos`.
 */
export function pendingBasesEffect(state: SecretsScreenState): SecretsScreenEffect {
  return basesEffectFor(state.edit);
}

/** The BASE column's data arrived (a single re-render), possibly starting a run that was waiting for it. */
export function applyBases(state: SecretsScreenState, bases: Readonly<Record<string, string>>): ReduceResult {
  const step = applyBasesLoaded(state.edit, bases);
  return { state: { ...state, edit: step.flow }, effect: step.effect };
}

/** The run the `runSet` effect started. */
export function applyRunDone(state: SecretsScreenState, finished: RunFinished): SecretsScreenState {
  return { ...state, edit: applyRunFinished(state.edit, finished) };
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

  // Never while a filter is typed: the search owns the keyboard then. Enter (details), then `e`, edits a filtered row.
  if (key === KEY_CTRL_E && state.search.query === '') return openEditOnCursor(state);

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
  const popup =
    state.popup !== null && state.popup.rowName === forRow.name && state.popup.rowHash === forRow.value_hash
      ? { ...state.popup, value: result }
      : state.popup;
  // The edit dialog's Old value row is fed by the same fetch (and dropped by the same row guard).
  return { ...state, popup, edit: applyOldValue(state.edit, forRow, result) };
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

/** Just the branch name(s) now — PROJECT is its own column, so no `project · ` prefix here. `+N` counts DISTINCT branch names across the row's locations, same convention as CONNECTOR/TARGET/PROJECT (not raw location count — two locations on the same branch name don't inflate it). */
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

// ── CONNECTOR / TARGET / INTEGRATIONS (CAP-679) ─────────────────────────────
//
// CAP-679 renamed the old "service" column: a Dokploy service is really one
// kind of INBOUND CONNECTOR (a value's source), and it was never the only
// half of the picture — a value can also be pushed OUT to one or more
// deploy TARGETS. INTEGRATIONS is the compact, names-free summary of both
// directions at once. None of these three read `SecretsCommand`'s static
// table (see CAP-679's note there on why that table keeps saying SERVICE).

/**
 * One location's inbound-connector label: `[provider] name`, or bare
 * `[provider]` when there's a provider but no name, or `—` when there's no
 * connector at all. Provider prefers the new `connector.provider` (CAP-676)
 * and falls back to the older `service.provider` — a server that predates
 * CAP-676 never sends `connector`, so this is the compatibility seam. Name
 * comes only from `service.name` — the new `connector` shape carries no
 * name field of its own.
 */
function formatLocationConnectorLabel(location: SecretIndexLocation): string {
  const provider = location.connector?.provider ?? location.service?.provider;
  if (!provider) return '—';
  const name = location.service?.name;
  return name ? `[${provider}] ${name}` : `[${provider}]`;
}

/** First location's connector label; `+N` for more DISTINCT connector labels across the row's locations (same "first + distinct count" convention as BRANCH/PROJECT — a location with no connector still counts as its own distinct `—` label, exactly as the old service cell treated a null service). */
export function formatConnectorCell(row: SecretIndexRow): string {
  const first = row.locations[0];
  const label = first ? formatLocationConnectorLabel(first) : '—';
  const distinct = new Set(row.locations.map((l) => formatLocationConnectorLabel(l)));
  return distinct.size > 1 ? `${label} +${distinct.size - 1}` : label;
}

/**
 * One target's label: `[provider] target`, with a trailing `*` when `stale`
 * (chosen over a spelled-out "(stale)" so it stays compact in this
 * already-narrow column; the details popup spells it out instead — see
 * `buildPopupLines`), and ` (pending)` when the config was written by
 * `capy deploy --no-deploy` and never actually shipped — minimal/neutral,
 * spelled out rather than another single-char marker since "pending" isn't
 * something a `*` reads as on its own. Both can apply at once (a pending
 * write can also be stale if the value moved again since).
 */
function formatTargetLabel(target: SecretIndexTarget): string {
  const base = `[${target.provider}] ${target.target}`;
  const staleSuffix = target.stale ? '*' : '';
  const pendingSuffix = target.pending ? ' (pending)' : '';
  return `${base}${staleSuffix}${pendingSuffix}`;
}

/** Every target across every one of `row`'s locations, flattened — a location's `targets` is additive/optional (absent on a server that predates CAP-676), so `?? []` is the compatibility seam here too. */
function allTargetsOf(row: SecretIndexRow): readonly SecretIndexTarget[] {
  return row.locations.flatMap((l) => l.targets ?? []);
}

/** First target's label (across ALL locations, not just the first one — a single location can itself carry more than one target); `+N` for more DISTINCT target labels. No targets anywhere on the row → `—`. */
export function formatTargetCell(row: SecretIndexRow): string {
  const targets = allTargetsOf(row);
  if (targets.length === 0) return '—';
  const label = formatTargetLabel(targets[0]);
  const distinct = new Set(targets.map((t) => formatTargetLabel(t)));
  return distinct.size > 1 ? `${label} +${distinct.size - 1}` : label;
}

/** `in:<provider>` for every distinct inbound-connector provider, then `out:<provider>` for every distinct outbound-target provider — names deliberately left out (that's what CONNECTOR/TARGET are for). `[]` → `—`. */
function integrationsLabels(row: SecretIndexRow): readonly string[] {
  const inProviders = Array.from(
    new Set(row.locations.map((l) => l.connector?.provider ?? l.service?.provider).filter((p): p is string => Boolean(p))),
  );
  const outProviders = Array.from(new Set(allTargetsOf(row).map((t) => t.provider)));
  return [...inProviders.map((p) => `in:${p}`), ...outProviders.map((p) => `out:${p}`)];
}

/** The unfitted INTEGRATIONS label (no column width to pack against) — see `formatIntegrationsCellFitted` for the width-aware version `render()` actually uses. */
export function formatIntegrationsCell(row: SecretIndexRow): string {
  const labels = integrationsLabels(row);
  return labels.length > 0 ? labels.join(' ') : '—';
}

/**
 * Packs as many whole `labels` (space-separated) as fit within `maxWidth`,
 * reserving room for a trailing ` +N` reporting how many didn't — never
 * slicing a label in half the way a generic character-truncation would.
 * Stops at the first label that would overflow (a strict prefix, not a
 * best-effort scan for a later, shorter one) so what's shown is always a
 * stable, predictable prefix of the full list. If even the very first
 * label doesn't fit, falls back to the ordinary ellipsis `truncate` — there
 * is nothing better to show in that little room.
 */
function fitLabelsWithOverflowCount(labels: readonly string[], maxWidth: number): string {
  const full = labels.join(' ');
  if (visLen(full) <= maxWidth) return full;

  const packed = labels.reduce<{ readonly shown: readonly string[]; readonly stopped: boolean }>(
    (acc, label) => {
      if (acc.stopped) return acc;
      const candidateShown = [...acc.shown, label];
      const hiddenAfter = labels.length - candidateShown.length;
      const suffix = hiddenAfter > 0 ? ` +${hiddenAfter}` : '';
      const fits = visLen(candidateShown.join(' ') + suffix) <= maxWidth;
      return fits ? { shown: candidateShown, stopped: false } : { shown: acc.shown, stopped: true };
    },
    { shown: [], stopped: false },
  );

  if (packed.shown.length === 0) return truncate(full, maxWidth);
  const hidden = labels.length - packed.shown.length;
  return hidden > 0 ? `${packed.shown.join(' ')} +${hidden}` : packed.shown.join(' ');
}

function formatIntegrationsCellFitted(row: SecretIndexRow, width: number): string {
  const labels = integrationsLabels(row);
  if (labels.length === 0) return '—';
  return fitLabelsWithOverflowCount(labels, width);
}

/** `width` is the middle column's rendered width — only INTEGRATIONS actually needs it (see `formatIntegrationsCellFitted`); every other column ignores it. */
export function formatMiddleCell(row: SecretIndexRow, column: ColumnMode, width: number): string {
  if (column === 'connector') return formatConnectorCell(row);
  if (column === 'target') return formatTargetCell(row);
  if (column === 'integrations') return formatIntegrationsCellFitted(row, width);
  if (column === 'users') return formatUsersCell(row);
  if (column === 'branch') return formatBranchCell(row);
  if (column === 'status') return secretRowStatusBadge(row);
  return formatProjectCell(row);
}

/** The STATUS cell: the same coloured `● status` badge `capy edit` shows (CAP-702). */
function secretRowStatusBadge(row: SecretIndexRow): string {
  const status = secretRowStatus(row);
  return statusBadge(status.kind, formatSecretRowStatus(status));
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

/** Matches a string ending in a ` +<N>` suffix — the convention every "+N" cell (BRANCH, PROJECT, CONNECTOR, TARGET, and the packed INTEGRATIONS list) uses to report additional distinct values it isn't showing. */
const PLUS_N_SUFFIX = /^(.*)( \+\d+)$/;

/**
 * Same contract as `truncate`, except when `s` (ANSI-stripped) ends in a
 * ` +N` suffix: that suffix is NEVER what gets cut. Only the label before
 * it shrinks — with the usual ellipsis — so a long label can never
 * silently swallow the count standing in for the rest (CAP-679).
 * `slidespeak-monorepo/backend/deploy +2` truncates to
 * `slidespeak-monorepo/backend/d… +2`, not `slidespeak-monorepo/backend…`.
 * Falls back to plain `truncate` when there's no such suffix to protect.
 */
function truncatePreservingPlusN(s: string, maxLen: number): string {
  if (visLen(s) <= maxLen) return s;
  const stripped = stripAnsi(s);
  const match = stripped.match(PLUS_N_SUFFIX);
  if (!match) return truncate(s, maxLen);
  const [, label, suffix] = match;
  const available = Math.max(0, maxLen - suffix.length);
  const truncatedLabel = label.length <= available ? label : label.slice(0, Math.max(0, available - 1)) + '…';
  return `${truncatedLabel}${suffix}`;
}

function pad(s: string, width: number): string {
  const v = visLen(s);
  if (v >= width) return truncatePreservingPlusN(s, width);
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
  const placeholder = `${DIM}type to filter — name, project, branch, connector, target, or exact value${RESET}`;
  const typedQuery = `${ACCENT}${state.search.query}${RESET}`;
  const queryDisplay = state.search.query !== '' ? typedQuery : focused ? placeholder : '';
  const countLabel = `${matchedCount}/${state.rows.length}`;
  return `${DIM}search:${RESET} ${queryDisplay}${caret} ${DIM}${countLabel}${RESET}`;
}

/** Pure render — a total function of state + terminal size. Never mutates `state`; any "clamping" of a display-only quantity (e.g. panning past the end of a value) is a local `const`, never written back. */
export function render(state: SecretsScreenState, termWidth: number, termHeight: number): string {
  if (state.edit) return renderEditScreen(state.edit, termWidth, termHeight, state.dryRun);
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);
  const matched = filteredRowsWithReasons(state);
  const rows = matched.map((mr) => mr.row);
  const matchActive = state.search.query.trim() !== '';
  const cursorIndex = clampIndex(state.cursorIndex, rows.length);

  const headerLines: readonly string[] = [
    `${m}${BOLD}capy secrets${RESET}${dryRunTag(state.dryRun)} ${DIM}(${state.rows.length} secret${state.rows.length === 1 ? '' : 's'})${RESET}`,
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
    const middleCell = pad(formatMiddleCell(row, state.column, middleW), middleW);
    const updatedCell = pad(formatUpdatedCell(row), updatedW);
    const line = nameCell + gap + middleCell + gap + updatedCell;
    // A coloured cell's own RESET would end the highlight mid-row, so the highlight is re-applied after each one.
    return isSelected ? INVERSE + padVis(line, available).replaceAll(RESET, RESET + INVERSE) + RESET : line;
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

  const noteLines: readonly string[] = state.note === null ? [] : [`${m}${DIM}${state.note}${RESET}`];
  const footerLines: readonly string[] = ['', ...noteLines, m + footerLine(state)];

  const lines: readonly string[] = [...preBodyLines, ...bodyOutputLines, ...footerLines];

  return lines.map((l) => l + CLEAR_EOL).join('\n');
}

/** The marker every screen carries while `--dry-run` is on, so nobody mistakes it for the real thing. */
function dryRunTag(dryRun: boolean): string {
  return dryRun ? `  ${BOLD}${YELLOW}${DRY_RUN_LABEL}${RESET}` : '';
}

/** The edit flow's screen: a header, the step's body, and its key hints. */
function renderEditScreen(flow: EditFlow, termWidth: number, termHeight: number, dryRun: boolean): string {
  const m = ' '.repeat(MARGIN);
  const { lines, footer } = renderEdit(flow, termWidth, termHeight, dryRun);
  const out: readonly string[] = [
    `${m}${BOLD}capy secrets${RESET}${dryRunTag(dryRun)}`,
    '',
    ...lines.map((l) => m + l),
    '',
    m + footer,
  ];
  // No line is ever wider than the terminal (a wrapped line would break the layout).
  return out.map((l) => clipLine(l, termWidth) + CLEAR_EOL).join('\n');
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

function buildPopupLines(row: SecretIndexRow, popup: PopupState, width: number): readonly string[] {
  const indent = '  ';
  const inner = '   ';
  const ruleWidth = Math.max(10, width - indent.length);
  const rule = `${indent}${DIM}╶${'─'.repeat(Math.max(0, ruleWidth - 2))}╴${RESET}`;
  const labelW = 9;
  const contentWidth = Math.max(20, ruleWidth - inner.length - 1);
  const valueWidth = Math.max(10, contentWidth - labelW);

  const field = (label: string, value: string) => `${indent}${inner}${DIM}${pad(label, labelW)}${RESET}${value}`;

  const topLines: readonly string[] = [
    rule,
    '',
    `${indent}${inner}${BOLD}${truncate(row.name, contentWidth)}${RESET}`,
    '',
    field('value', renderPopupValueLine(popup, valueWidth)),
    field('updated', formatUpdatedCell(row)),
    field('status', secretRowStatusBadge(row)),
    '',
    `${indent}${inner}${BOLD}locations${RESET}`,
  ];

  // Per-location: project · branch (protected marker), the CONNECTOR that
  // brought the value IN (renamed from "service" — CAP-679), when it
  // changed, and — only when this location has any — every TARGET it was
  // pushed OUT to, each spelled out with its full "(not deployed)" wording (the
  // table's own TARGET column uses a compact `*` instead; there's no room
  // pressure here to justify that shorthand).
  const locationLines: readonly string[] = row.locations.map((loc) => {
    const protMarker = loc.protected ? ` ${DIM}(protected)${RESET}` : '';
    const connectorLabel = formatLocationConnectorLabel(loc);
    const updated = loc.changed_at ? formatRelativeTime(loc.changed_at) : '—';
    const targets = loc.targets ?? [];
    const targetsLabel =
      targets.length > 0
        ? ` · targets: ${targets
            .map((t) => `[${t.provider}] ${t.target}${t.stale ? ` ${statusColor(NOT_DEPLOYED)}(${NOT_DEPLOYED})${DIM}` : ''}${t.pending ? ' (pending)' : ''}`)
            .join(', ')}`
        : '';
    return `${indent}${inner}${truncate(`${loc.project_name} · ${loc.branch}`, contentWidth)}${protMarker} ${DIM}· ${connectorLabel} · ${updated}${targetsLabel}${RESET}`;
  });

  const usersHeaderLines: readonly string[] = ['', `${indent}${inner}${BOLD}users${RESET}`];
  const userLines: readonly string[] =
    row.users.length === 0
      ? [`${indent}${inner}${DIM}(none)${RESET}`]
      : row.users.map((u) => `${indent}${inner}${truncate(u.email, contentWidth)}`);

  return [...topLines, ...locationLines, ...usersHeaderLines, ...userLines, '', rule];
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
    return `${BOLD}r${RESET}${DIM} ${revealLabel}${RESET}${panHint}${DIM} · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${DIM} · ${RESET}${BOLD}esc${RESET}${DIM}/${RESET}${BOLD}q${RESET}${DIM} close${RESET}`; // COPY-FLAG
  }
  const editHint = state.search.query === '' ? `${BOLD}ctrl+e${RESET}${DIM} edit · ${RESET}` : '';
  return `${DIM}↑↓ navigate · ${RESET}${BOLD}tab${RESET}${DIM} column · ${RESET}${BOLD}enter${RESET}${DIM} inspect · ${RESET}${editHint}${BOLD}esc${RESET}${DIM} clear/quit${RESET}`; // COPY-FLAG
}
