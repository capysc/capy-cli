// Single-column TUI for `capy edit`: variables list with an inline popup
// detail view. Built on raw stdin + ANSI codes so we don't add a TUI dependency.
//
// Pure core, thin shell. `reduce(model, action)` takes the whole screen state and one
// action (a key chunk, a finished save) and returns the next state plus (at most) one
// effect for the shell to perform; `render` draws a state. Nothing in the core touches
// stdin, stdout or the network. `EditScreen.run` is the shell: it owns the raw terminal,
// feeds actions in, draws what `render` returns and performs the one effect (a save).
//
// Rows are compared three ways (pinned, yours, theirs); see `reclassifyRow`. A row both
// sides changed is a `conflict`: `m` keeps yours (mine), `t` takes the server's (theirs),
// and nothing is committed while one is undecided.

import { EventEmitter } from 'node:events';
import { formatSnippet, hashValue } from '../commands/statusCommand';
import { anyTargetBehind } from '../core/deployStatus';
import { isContested, isSecretsConflict, type Snapshot } from '../sync/commit';
import type { Resolution, SeenResolution, SeenResolutions } from '../sync/conflicts';
import { statusBadge, statusLabel } from './statusBadge';
import { formatRelativeTime } from './relativeTime';
import { isRevealKey, stepEditBuffer } from './editBuffer';
import { OldValueView, canReveal, renderInlineValue as inlineValue, valueDialogRows } from './valueDialog';
import { ERROR_CODES } from '../types/index';

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const MOVE_HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_EOL = `${ESC}[K`;
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
// Bracketed paste: when enabled the terminal wraps pasted text in these
// markers, so we can append a multi-line paste (e.g. a PEM private key)
// verbatim instead of treating its embedded newlines as Enter/commit.
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;

const MARGIN = 2;
const NO_VALUE = '—';

export interface EditRow {
  readonly key: string;
  readonly localValue: string | undefined;
  readonly remoteValue: string | undefined;
  readonly status: 'in sync' | 'local' | 'remote' | 'conflict' | 'behind' | 'unknown';
  readonly updatedLabel: string;
  /**
   * CAP-702: `deployed_value_hash` of every deploy target this variable was
   * pushed to on the active branch (`null`: never pushed). A row that is
   * otherwise in sync reads `behind` while any of these differs from its
   * value's hash.
   */
  readonly deployedHashes?: readonly (string | null)[];
  /**
   * keep.lock changed_at for this variable on the active branch (ISO8601,
   * server-assigned) — when the value last changed server-side. Drives the
   * UPDATED column's recency label; absent = unknown/never pushed.
   */
  readonly changedAt?: string;
  /**
   * What this folder last agreed with the server (the fingerprint keep.lock pins for the branch; `null`:
   * not pinned). When present the row is compared three ways: pinned, yours (`localValue`), theirs (the
   * server's latest). Absent: only `localValue` and `remoteValue` are compared.
   */
  readonly pinnedHash?: string | null;
  /** The server's fingerprint when the server's value cannot be read here (`remoteValue` is then absent). */
  readonly remoteHash?: string;
  /** The decision for a `conflict` row, with the fingerprints it was made against (CAP-714). Valid only while they still match. */
  readonly resolution?: SeenResolution;
}

export interface EditState {
  readonly projectName: string;
  readonly branch: string;
  readonly rows: readonly EditRow[];
  readonly remoteAvailable: boolean;
  /**
   * Local-only mode: there is no remote. The comparison is committed-vs-working
   * (status is 'in sync' or 'local'/uncommitted), and the UPDATED column shows
   * committed/uncommitted instead of remote-drift wording.
   */
  readonly localMode?: boolean;
  /**
   * `capy edit NAME`: the cursor starts on this row. A key with no row is
   * ignored (the cursor stays at the top).
   */
  readonly focusKey?: string;
  /**
   * `capy edit NAME` for a name that does not exist yet: the value entry for
   * this key opens straight away (its row was added by {@link withNewEntryRow}).
   */
  readonly entryKey?: string;
  /** The server read the rows were drawn from: a commit is planned against it, so a decision binds to what was shown. */
  readonly seen?: Snapshot;
}

/**
 * The state for `capy edit NAME` on a terminal.
 *
 * A name that has a row puts the cursor on it. A name with no row is a NEW
 * variable: a placeholder row (no value yet) is added in sorted position and its
 * value entry opens, so the person types the value for exactly the name they
 * asked for. Nothing is written until they commit it, same as any other edit.
 */
export function focusedOn(state: EditState, name: string): EditState {
  if (state.rows.some((r) => r.key === name)) return { ...state, focusKey: name };
  const placeholder: EditRow = {
    key: name,
    localValue: undefined,
    remoteValue: undefined,
    status: state.localMode || state.remoteAvailable ? 'local' : 'unknown',
    updatedLabel: state.localMode ? 'uncommitted' : NO_VALUE,
  };
  return { ...state, rows: sortedRows([...state.rows, placeholder]), focusKey: name, entryKey: name };
}

/** What a commit carries (CAP-714). */
export interface EditCommitRequest {
  /** Every value the commit is about: the edits typed this session, and each conflict row decided (its own value, so the decision has something to bind to). */
  readonly set: Readonly<Record<string, string>>;
  /** The decisions of the conflict rows, with the fingerprints they were made against. */
  readonly decisions: SeenResolutions;
  /** The server read the rows were drawn from. */
  readonly seen: Snapshot | undefined;
}

/** What the screen shows after re-reading the folder and the server. */
export interface EditLoaded {
  readonly rows: readonly EditRow[];
  readonly remoteAvailable: boolean;
  readonly seen: Snapshot | undefined;
}

export interface EditContext {
  /**
   * Commit (and in server mode, push) `set`; `bound` carries the decisions and the server read they were
   * made against. Resolves to the server-assigned changed_at per variable for the active branch, taken
   * from the push response's keep_file — empty in local mode or when the service didn't return timestamps.
   * Rejects with `SECRETS_CONFLICT` (nothing uploaded) when the server moved under a change.
   */
  readonly saveLocalEdits: (
    set: Record<string, string>,
    bound?: { readonly decisions: SeenResolutions; readonly seen: Snapshot | undefined },
  ) => Promise<Record<string, string>>;
  /** Re-reads the folder and the server (after a save, or a conflict). Absent: rows are updated from what the save returned. */
  readonly reload?: () => Promise<EditLoaded>;
}

// ── Rows: fingerprints, status, decisions ───────────────────────────────────

/** The server's fingerprint for the row (`null`: the server has no such variable). */
const theirsOf = (row: EditRow): string | null => row.remoteHash ?? (row.remoteValue === undefined ? null : hashValue(row.remoteValue));

/** The fingerprint of the row's working value (`null`: none). */
const yoursOf = (row: EditRow): string | null => (row.localValue === undefined ? null : hashValue(row.localValue));

/** The decision for a conflict row, if it was made against the values the row holds now. */
export function choiceOf(row: EditRow): Resolution | undefined {
  const decided = row.resolution;
  if (row.status !== 'conflict' || decided === undefined) return undefined;
  return decided.theirs === theirsOf(row) && decided.yours === yoursOf(row) ? decided.choice : undefined;
}

/** `row` decided: `mine` keeps its working value, `theirs` takes the server's. Bound to the values it holds now. */
export const resolvedAs = (row: EditRow, choice: Resolution): EditRow => ({
  ...row,
  resolution: { choice, theirs: theirsOf(row), yours: yoursOf(row) },
});

const isUnresolved = (row: EditRow): boolean => row.status === 'conflict' && choiceOf(row) === undefined;

/**
 * Local-only row classification: committed-vs-working. `working` is the value
 * in .env; `committed` is the value in the local keep (cache). Shared by the
 * initial build (editCommand) and the in-TUI reclassify so they never drift.
 */
export function classifyLocalRow(
  working: string | undefined,
  committed: string | undefined,
): { status: EditRow['status']; updatedLabel: string } {
  const inSync = working !== undefined && working === committed;
  return inSync
    ? { status: 'in sync', updatedLabel: 'committed' }
    : { status: 'local', updatedLabel: 'uncommitted' };
}

/**
 * How a row reads. Server mode compares three versions when the row knows its pin (`pinnedHash`):
 * `local` (you changed it), `remote` (the server changed it since your pin), `conflict` (both did,
 * to different values; the same test the commit path applies, `isContested`), `in sync`.
 *
 * Pulled out of `EditScreen` so the browser path classifies with this code
 * rather than with a second copy of it. Two implementations of "what changed"
 * is exactly the drift `classifyLocalRow` above was extracted to prevent, and
 * a browser that disagreed with the terminal about which rows are in conflict
 * would be the product disagreeing with itself about somebody's secrets.
 */
export function reclassifyRow(
  row: EditRow,
  mode: { localMode?: boolean; remoteAvailable: boolean },
): EditRow['status'] {
  return withDeployStatus(row, syncStatus(row, mode));
}

/**
 * CAP-702: one status per variable, the one that needs action first —
 * `conflict` → `local`/`remote` → `not deployed` → `in sync`. So only a row
 * that is otherwise in sync can read `not deployed`.
 */
export function withDeployStatus(row: EditRow, status: EditRow['status']): EditRow['status'] {
  if (status !== 'in sync') return status;
  const value = row.localValue ?? row.remoteValue;
  return anyTargetBehind(row.deployedHashes, value === undefined ? undefined : hashValue(value)) ? 'behind' : status;
}

function syncStatus(row: EditRow, mode: { localMode?: boolean; remoteAvailable: boolean }): EditRow['status'] {
  // Local mode: committed-vs-working. remoteValue holds the committed value.
  if (mode.localMode) return classifyLocalRow(row.localValue, row.remoteValue).status;
  if (!mode.remoteAvailable) return 'unknown';
  return row.pinnedHash === undefined ? twoWayStatus(row) : threeWayStatus(row, row.pinnedHash ?? undefined);
}

/** Only the working and the server's value are known (a row without a pin). */
function twoWayStatus(row: EditRow): EditRow['status'] {
  const localPresent = row.localValue !== undefined;
  const remotePresent = row.remoteValue !== undefined;
  if (localPresent && remotePresent && row.localValue === row.remoteValue) return 'in sync';
  if (!localPresent && remotePresent) return 'remote';
  if (localPresent && !remotePresent) return 'local';
  if (row.localValue !== row.remoteValue) return 'conflict';
  return 'in sync';
}

function threeWayStatus(row: EditRow, pinned: string | undefined): EditRow['status'] {
  const yours = yoursOf(row) ?? undefined;
  const theirs = theirsOf(row) ?? undefined;
  if (yours === theirs) return 'in sync';
  const youChanged = yours !== pinned;
  const theyChanged = theirs !== pinned;
  // A value you hold that the server moved under: the commit path's own test. (A variable missing from the folder is not a
  // change to keep: the server's value is pulled.)
  const latest = theirs === undefined ? undefined : { plaintext: row.remoteValue, hash: theirs };
  if (youChanged && theyChanged && row.localValue !== undefined && isContested(pinned, row.localValue, latest)) return 'conflict';
  return youChanged && !theyChanged ? 'local' : 'remote';
}

/** The UPDATED column's label, mode-aware. Local mode has no server timestamps, so it keeps the committed/uncommitted wording; otherwise the label says when the value last changed server-side. */
export function updatedLabelForRow(row: EditRow, mode: { localMode?: boolean }): string {
  if (mode.localMode) return row.status === 'in sync' || row.status === 'behind' ? 'committed' : 'uncommitted';
  return row.changedAt ? formatRelativeTime(row.changedAt) : NO_VALUE;
}

/** `row` with its status and UPDATED label worked out afresh. */
export function classifiedRow(row: EditRow, mode: { localMode?: boolean; remoteAvailable: boolean }): EditRow {
  const status = reclassifyRow(row, mode);
  const classified = { ...row, status };
  return { ...classified, updatedLabel: updatedLabelForRow(classified, mode) };
}

const byKey = (a: EditRow, b: EditRow): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** A sorted copy (`toSorted` is ES2023; this package targets older Node): the input is never changed. */
const sortedRows = (rows: readonly EditRow[]): readonly EditRow[] => Array.from(rows).sort(byKey);

/**
 * Normalizes bracketed-paste content for storage in an edit buffer. Pasted
 * line breaks are kept (so multi-line secrets like PEM keys survive), CRLF/CR
 * are folded to LF, and other control characters (besides tab) are dropped so a
 * stray escape sequence in the paste can't corrupt the value or the terminal.
 */
export function sanitizePastedText(raw: string): string {
  return Array.from(raw.replace(/\r\n?/g, '\n'))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
    })
    .join('');
}

/** One line for a (possibly multi-line) value, length preserved: see ./valueDialog. */
export const renderInlineValue = inlineValue;

// ── The screen's state ──────────────────────────────────────────────────────

interface Editing {
  readonly key: string;
  readonly buffer: string;
  readonly oldValue: string | undefined;
  readonly isNew: boolean;
  readonly revealed: boolean;
}

interface StatusMessage {
  readonly text: string;
  readonly isError: boolean;
}

/** A commit in flight: the names it carries, and whether the screen closes when it lands. */
interface Saving {
  readonly keys: readonly string[];
  readonly quit: boolean;
}

export interface EditModel {
  readonly state: EditState;
  readonly cursorIndex: number;
  readonly revealed: ReadonlySet<string>;
  /**
   * The value dialog (shared layout: ui/valueDialog.ts). `buffer` is what has been
   * typed (it always starts empty); `oldValue` is the current value, held in memory
   * only to show on Ctrl+R; `isNew` is a variable that does not exist yet.
   */
  readonly editing: Editing | null;
  readonly status: StatusMessage | null;
  readonly scrollOffset: number;
  /** The values typed this session and not committed yet. */
  readonly pending: Readonly<Record<string, string>>;
  readonly quitPrompt: boolean;
  readonly popupOpen: boolean;
  readonly popupPan: number;
  /** Accumulates raw stdin between PASTE_START and PASTE_END when a bracketed paste spans several chunks. `null`: not mid-paste. */
  readonly paste: string | null;
  readonly saving: Saving | null;
}

export function initialModel(state: EditState): EditModel {
  const focusIndex = state.rows.findIndex((r) => r.key === state.focusKey);
  const entering = state.entryKey !== undefined && state.rows.some((r) => r.key === state.entryKey);
  return {
    state,
    cursorIndex: Math.max(0, focusIndex),
    revealed: new Set(),
    editing:
      entering && state.entryKey !== undefined
        ? { key: state.entryKey, buffer: '', oldValue: undefined, isNew: true, revealed: false }
        : null,
    status: null,
    scrollOffset: 0,
    pending: {},
    quitPrompt: false,
    popupOpen: entering,
    popupPan: 0,
    paste: null,
    saving: null,
  };
}

/** Names with something to commit: edits typed, and conflict rows decided. */
const dirtyKeys = (model: EditModel): readonly string[] => [
  ...new Set([...Object.keys(model.pending), ...model.state.rows.filter((r) => choiceOf(r) !== undefined).map((r) => r.key)]),
];

const withRows = (model: EditModel, rows: readonly EditRow[]): EditModel => ({ ...model, state: { ...model.state, rows } });

const replaceRow = (model: EditModel, key: string, change: (row: EditRow) => EditRow): EditModel =>
  withRows(model, model.state.rows.map((r) => (r.key === key ? change(r) : r)));

const modeOf = (model: EditModel): { localMode?: boolean; remoteAvailable: boolean } => ({
  localMode: model.state.localMode,
  remoteAvailable: model.state.remoteAvailable,
});

// ── Actions, effects, outcome ───────────────────────────────────────────────

/** What a save came back with. Never carries a value. */
export type SaveResult =
  | { readonly kind: 'saved'; readonly changedAt: Readonly<Record<string, string>>; readonly loaded: EditLoaded | undefined }
  /** The server moved under a change (`SECRETS_CONFLICT`): nothing was uploaded. */
  | { readonly kind: 'conflict'; readonly message: string; readonly loaded: EditLoaded | undefined }
  | { readonly kind: 'failed'; readonly message: string };

export type EditAction =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'saved'; readonly result: SaveResult };

export type EditEffect = { readonly type: 'save'; readonly request: EditCommitRequest };

export interface EditOutcome {
  readonly model: EditModel;
  readonly effect?: EditEffect;
  /** The screen is over. */
  readonly done?: true;
}

const stay = (model: EditModel): EditOutcome => ({ model });
const finished = (model: EditModel): EditOutcome => ({ model, done: true });

// ── Keys ────────────────────────────────────────────────────────────────────

/** Accumulates a bracketed paste across data chunks and, once the closing marker arrives, appends the pasted text to the active edit buffer verbatim (newlines preserved). Pasted outside of edit mode, the content is dropped. */
function consumePaste(model: EditModel, chunk: string): EditModel {
  const buffered = (model.paste ?? '') + chunk;
  const start = buffered.indexOf(PASTE_START);
  if (start === -1) return { ...model, paste: null };
  const end = buffered.indexOf(PASTE_END, start + PASTE_START.length);
  if (end === -1) return { ...model, paste: buffered }; // paste spans more chunks — wait for the rest
  const appended = sanitizePastedText(buffered.substring(start + PASTE_START.length, end));
  if (!model.editing || !appended) return { ...model, paste: null };
  return { ...model, paste: null, editing: { ...model.editing, buffer: model.editing.buffer + appended } };
}

const oldValueView = (editing: { readonly oldValue: string | undefined; readonly isNew: boolean }): OldValueView => {
  if (editing.isNew) return { kind: 'none' };
  return editing.oldValue === undefined
    ? { kind: 'unavailable', code: ERROR_CODES.VARIABLE_NOT_FOUND }
    : { kind: 'value', value: editing.oldValue };
};

/** Buffer the edit in memory; it is written on commit. */
function commitEdit(model: EditModel): EditModel {
  if (!model.editing) return model;
  const { key, buffer } = model.editing;
  const edited = replaceRow(
    { ...model, editing: null, pending: { ...model.pending, [key]: buffer } },
    key,
    (row) => classifiedRow({ ...row, localValue: buffer }, modeOf(model)),
  );
  return { ...edited, status: { text: `Edited ${key} (uncommitted)`, isError: false } };
}

function onEditKey(model: EditModel, key: string): EditModel {
  const editing = model.editing;
  if (!editing) return model;

  // Esc — both bare ESC and ESC ESC (some terminals double-emit)
  if (key === ESC || key === `${ESC}${ESC}`) return { ...model, editing: null };

  // Enter: saves what was typed. An empty box has nothing to save (Esc cancels).
  if (key === '\r' || key === '\n') return editing.buffer !== '' ? commitEdit(model) : model;

  // Ctrl+R shows or hides both rows (on screen only); nothing to show for a new variable until something is typed.
  if (isRevealKey(key)) {
    return canReveal(oldValueView(editing), editing.buffer) ? { ...model, editing: { ...editing, revealed: !editing.revealed } } : model;
  }

  // Backspace, arrows (ignored) and printable text, every letter included:
  // one shared rule with the `capy secrets` edit dialog (see editBuffer.ts).
  const next = stepEditBuffer(editing.buffer, key);
  return next !== editing.buffer ? { ...model, editing: { ...editing, buffer: next } } : model;
}

/** The unresolved conflicts' names, in row order. */
const unresolvedNames = (model: EditModel): readonly string[] => model.state.rows.filter(isUnresolved).map((r) => r.key);

/**
 * `c`: the commit this screen would make, or why it cannot be made yet. A conflict nobody decided blocks it
 * (nothing is uploaded). Otherwise: the edits, plus each decided conflict row with its value and its decision.
 */
function requestCommit(model: EditModel, quit: boolean): EditOutcome {
  const open = unresolvedNames(model);
  if (open.length > 0) {
    return stay({
      ...model,
      quitPrompt: false,
      status: { text: `Choose mine or theirs for ${open.join(', ')}. Nothing was uploaded.`, isError: true }, // COPY-FLAG
    });
  }
  const decided = model.state.rows.filter((r) => choiceOf(r) !== undefined);
  const set = {
    ...model.pending,
    ...Object.fromEntries(decided.flatMap((r) => (r.localValue === undefined ? [] : [[r.key, r.localValue] as const]))),
  };
  const request: EditCommitRequest = {
    set,
    decisions: Object.fromEntries(decided.flatMap((r) => (r.resolution === undefined ? [] : [[r.key, r.resolution] as const]))),
    seen: model.state.seen,
  };
  const keys = Object.keys(set);
  const verb = model.state.localMode ? 'Committing' : 'Committing & pushing';
  return {
    model: {
      ...model,
      quitPrompt: false,
      saving: { keys, quit },
      status: { text: `${verb} ${keys.length} change(s)…`, isError: false },
    },
    effect: { type: 'save', request },
  };
}

function onQuitPromptKey(model: EditModel, key: string): EditOutcome {
  // 'c' commit & push, 'd' discard & quit, 'k'/Esc keep working
  if (key === 'c' || key === 'C') return requestCommit(model, true);
  if (key === 'd' || key === 'D') return finished({ ...model, pending: {} });
  if (key === 'k' || key === 'K' || key === ESC || key === `${ESC}${ESC}`) return stay({ ...model, quitPrompt: false });
  return stay(model);
}

const movedTo = (model: EditModel, cursorIndex: number): EditModel => ({ ...model, cursorIndex, popupPan: 0 });

/** `m` / `t` on a conflict row: the decision, shown on the row until it is committed. */
function decideRow(model: EditModel, choice: Resolution): EditModel {
  const row = model.state.rows[model.cursorIndex];
  if (!row || row.status !== 'conflict') return model;
  return { ...replaceRow(model, row.key, (r) => resolvedAs(r, choice)), status: null };
}

function onListKey(model: EditModel, key: string): EditOutcome {
  if (key === 'q' || key === 'Q') {
    return dirtyKeys(model).length > 0 ? stay({ ...model, quitPrompt: true }) : finished(model);
  }

  // Esc closes the popup (when open)
  if ((key === ESC || key === `${ESC}${ESC}`) && model.popupOpen) return stay({ ...model, popupOpen: false, popupPan: 0 });

  if (key === `${ESC}[A`) return stay(model.cursorIndex > 0 ? movedTo(model, model.cursorIndex - 1) : model);
  if (key === `${ESC}[B`) return stay(model.cursorIndex < model.state.rows.length - 1 ? movedTo(model, model.cursorIndex + 1) : model);

  // Arrow left / right — pan the value when the popup is open + revealed
  if (key === `${ESC}[D`) return stay(model.popupOpen && model.popupPan > 0 ? { ...model, popupPan: Math.max(0, model.popupPan - 8) } : model);
  if (key === `${ESC}[C`) return stay(model.popupOpen ? { ...model, popupPan: model.popupPan + 8 } : model);

  // Home / End — pan to start / end (when popup open + revealed)
  if (key === `${ESC}[H` || key === `${ESC}[1~`) return stay(model.popupOpen ? { ...model, popupPan: 0 } : model);
  if (key === `${ESC}[F` || key === `${ESC}[4~`) return stay(model.popupOpen ? { ...model, popupPan: Number.MAX_SAFE_INTEGER } : model);

  // Enter / Space — toggle popup
  if (key === '\r' || key === '\n' || key === ' ') return stay({ ...model, popupOpen: !model.popupOpen, popupPan: 0 });

  if (key === 'r' || key === 'R') {
    const row = model.state.rows[model.cursorIndex];
    if (!row) return stay(model);
    const revealed = model.revealed.has(row.key)
      ? new Set([...model.revealed].filter((k) => k !== row.key))
      : new Set([...model.revealed, row.key]);
    return stay({ ...model, revealed, popupOpen: true, popupPan: 0 });
  }

  if (key === 'e' || key === 'E') {
    const row = model.state.rows[model.cursorIndex];
    if (!row) return stay(model);
    return stay({
      ...model,
      editing: { key: row.key, buffer: '', oldValue: row.localValue ?? row.remoteValue, isNew: false, revealed: false },
      status: null,
      popupOpen: true,
      popupPan: 0,
    });
  }

  // m / t — mine or theirs for the conflict under the cursor (no other key on this screen is bound to either).
  if (key === 'm' || key === 'M') return stay(decideRow(model, 'mine'));
  if (key === 't' || key === 'T') return stay(decideRow(model, 'theirs'));

  if (key === 'c' || key === 'C') return dirtyKeys(model).length > 0 ? requestCommit(model, false) : stay(model);
  return stay(model);
}

function onData(model: EditModel, key: string): EditOutcome {
  // Bracketed paste arrives as ESC[200~ <content> ESC[201~, possibly split
  // across data chunks. Intercept it before any key dispatch so pasted text
  // (which may contain 'q', newlines, etc.) can never trigger quit/commit or
  // navigation — its content is only ever appended to an active edit buffer.
  if (model.paste !== null || key.includes(PASTE_START)) return stay(consumePaste(model, key));
  // Ctrl-C exits unconditionally
  if (key === '\x03') return finished(model);
  // A commit in flight is not interrupted by keys; it finishes first.
  if (model.saving !== null) return stay(model);
  if (model.quitPrompt) return onQuitPromptKey(model, key);
  if (model.editing) return stay(onEditKey(model, key));
  return onListKey(model, key);
}

// ── A save coming back ──────────────────────────────────────────────────────

/** `loaded`'s rows, with what this screen holds that the disk and the server cannot know: typed values, and decisions (valid only while the values they were made against stand). */
function mergedRows(model: EditModel, loaded: EditLoaded, pending: Readonly<Record<string, string>>, keepDecisions: boolean): readonly EditRow[] {
  const mode = { localMode: model.state.localMode, remoteAvailable: loaded.remoteAvailable };
  const known = new Set(loaded.rows.map((r) => r.key));
  const typed = (row: EditRow): EditRow => {
    const old = model.state.rows.find((r) => r.key === row.key);
    const value = Object.hasOwn(pending, row.key) ? pending[row.key] : row.localValue;
    return classifiedRow({ ...row, localValue: value, ...(keepDecisions && old?.resolution !== undefined ? { resolution: old.resolution } : {}) }, mode);
  };
  // A variable typed here that neither the folder nor the server has yet.
  const added = Object.keys(pending)
    .filter((key) => !known.has(key))
    .map((key): EditRow => classifiedRow({ key, localValue: pending[key], remoteValue: undefined, status: 'local', updatedLabel: NO_VALUE, pinnedHash: null }, mode));
  return sortedRows([...loaded.rows.map(typed), ...added]);
}

/** The model showing `loaded`, the cursor kept on the same variable. */
function withLoaded(model: EditModel, loaded: EditLoaded, pending: Readonly<Record<string, string>>, keepDecisions: boolean): EditModel {
  const rows = mergedRows(model, loaded, pending, keepDecisions);
  const cursorKey = model.state.rows[model.cursorIndex]?.key;
  const at = rows.findIndex((r) => r.key === cursorKey);
  return {
    ...model,
    state: { ...model.state, rows, remoteAvailable: loaded.remoteAvailable, seen: loaded.seen },
    cursorIndex: at === -1 ? Math.min(model.cursorIndex, Math.max(0, rows.length - 1)) : at,
  };
}

/** No re-read was possible: the rows that were committed now agree with what was written, as `markCommitted` of old. */
function committedLocally(model: EditModel, keys: readonly string[], changedAt: Readonly<Record<string, string>>): EditModel {
  const committed = new Set(keys);
  return withRows(
    model,
    model.state.rows.map((row) => {
      if (!committed.has(row.key) || row.localValue === undefined) return row;
      const agreed: EditRow = {
        ...row,
        changedAt: changedAt[row.key] ?? row.changedAt,
        remoteValue: row.localValue,
        remoteHash: undefined,
        pinnedHash: hashValue(row.localValue),
        resolution: undefined,
      };
      return classifiedRow(agreed, modeOf(model));
    }),
  );
}

function onSaved(model: EditModel, result: SaveResult): EditOutcome {
  const saving = model.saving;
  const settled: EditModel = { ...model, saving: null };
  if (result.kind === 'saved') {
    if (saving?.quit === true) return finished({ ...settled, pending: {} });
    const keys = saving?.keys ?? [];
    const refreshed =
      result.loaded === undefined
        ? committedLocally({ ...settled, pending: {} }, keys, result.changedAt)
        : withLoaded({ ...settled, pending: {} }, result.loaded, {}, false);
    return stay({ ...refreshed, status: { text: `Committed ${keys.length} change(s)`, isError: false } });
  }
  if (result.kind === 'conflict' && result.loaded !== undefined) {
    // The server moved between showing and committing: the rows are drawn from the new read, and a decision
    // stands only where the values it was made against do (never an old decision on a new value).
    const refreshed = withLoaded(settled, result.loaded, settled.pending, true);
    const open = unresolvedNames(refreshed);
    return stay({
      ...refreshed,
      status: {
        text: open.length > 0 ? `${open.join(', ')} changed on the server. Nothing was uploaded.` : 'The server changed. Nothing was uploaded.', // COPY-FLAG
        isError: true,
      },
    });
  }
  return stay({ ...settled, status: { text: `Error committing: ${result.message}`, isError: true } });
}

/** One action applied to the screen. */
export function reduce(model: EditModel, action: EditAction): EditOutcome {
  return action.kind === 'data' ? onData(model, action.data) : onSaved(model, action.result);
}

// ── Rendering ───────────────────────────────────────────────────────────────

const visLen = (str: string): number => str.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Naive truncate that ignores ANSI for length calculation. If the visible length already fits, return as-is; otherwise strip codes and clip — we accept that color may be lost at the truncation point. */
function truncate(str: string, maxLen: number): string {
  if (visLen(str) <= maxLen) return str;
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return stripped.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function pad(str: string, width: number): string {
  const v = visLen(str);
  return v >= width ? truncate(str, width) : str + ' '.repeat(width - v);
}

const padVis = (str: string, width: number): string => {
  const v = visLen(str);
  return v >= width ? str : str + ' '.repeat(width - v);
};

function maskedSnippet(row: EditRow): string {
  const value = row.localValue ?? row.remoteValue;
  if (value === undefined || value === '') return NO_VALUE;
  return renderInlineValue(formatSnippet(value));
}

/** The status cell: the coloured badge, saying which side was chosen once a conflict is decided. */
function rowBadge(row: EditRow): string {
  const choice = choiceOf(row);
  return statusBadge(row.status, choice === undefined ? statusLabel(row.status) : `conflict: ${choice}`); // COPY-FLAG
}

function buildTopCells(model: EditModel): { value: string; action: string }[] {
  const { rows, localMode, remoteAvailable, branch } = model.state;
  const countOf = (statuses: readonly EditRow['status'][]): number => rows.filter((r) => statuses.includes(r.status)).length;
  const drift = countOf(['local', 'remote']);
  const conflicts = countOf(['conflict']);
  const unresolved = rows.filter(isUnresolved).length;
  const unknown = countOf(['unknown']);

  return [
    { value: branch, action: 'active branch' },
    { value: `${rows.length} tracked`, action: 'shown as abc…xyz snippets' },
    {
      value: localMode ? `${drift} uncommitted` : remoteAvailable ? `${drift} drift` : `${unknown} ?`,
      action: localMode ? 'changed since commit' : remoteAvailable ? 'changed local/remote' : 'remote unavailable',
    },
    {
      value: `${conflicts} conflicts`,
      action: unresolved > 0 ? 'need resolution' : conflicts > 0 ? 'all resolved' : 'all clear', // COPY-FLAG (all resolved)
    },
  ];
}

function buildTable(model: EditModel, width: number): string[] {
  // 4 columns: KEY, VALUE, STATUS, UPDATED. UPDATED absorbs slack so the
  // row fills the full width.
  const keyW = Math.max(12, Math.floor(width * 0.32));
  const valW = 14;
  const statusW = 18;
  const gap = '  ';
  const fixed = keyW + valW + statusW + gap.length * 3;
  const updatedW = Math.max(8, width - fixed);

  const headerRow = pad('KEY', keyW) + gap + pad('VALUE', valW) + gap + pad('STATUS', statusW) + gap + pad('UPDATED', updatedW);
  const rowLines = model.state.rows.map((row, i) => {
    const isSelected = i === model.cursorIndex;
    const pointer = isSelected ? '▶' : ' ';
    const line = pad(`${pointer} ${row.key}`, keyW) + gap + pad(maskedSnippet(row), valW) + gap + padVis(rowBadge(row), statusW) + gap + pad(row.updatedLabel, updatedW);
    return isSelected && !model.editing ? INVERSE + padVis(line, width) + RESET : line;
  });
  return [`${BOLD}Variables${RESET}`, DIM + headerRow + RESET, ...rowLines];
}

/** The value as one line of at most `width` visible chars, masked or (revealed) panned. Returns the pan actually used. */
function valueField(raw: string | undefined, revealed: boolean, width: number, pan: number, fallback: string): { text: string; pan: number } {
  if (!revealed) return { text: fallback, pan };
  if (raw === undefined) return { text: `${DIM}(no value)${RESET}`, pan };
  if (raw === '') return { text: `${DIM}(empty)${RESET}`, pan };
  // Collapse newlines/tabs so a revealed multi-line value (e.g. a PEM key)
  // stays on one row. renderInlineValue preserves length 1:1, so the panning
  // math below remains correct.
  const value = renderInlineValue(raw);
  if (value.length <= width) return { text: value, pan: 0 };

  // Need to pan. Reserve 2 cols on each side for indicators (or padding).
  const visibleWidth = Math.max(1, width - 4);
  const maxOffset = Math.max(0, value.length - visibleWidth);
  const offset = Math.min(Math.max(pan, 0), maxOffset);
  const leftIndicator = offset > 0 ? `${DIM}◂${RESET} ` : '  ';
  const rightIndicator = offset < maxOffset ? ` ${DIM}▸${RESET}` : '  ';
  return { text: leftIndicator + value.slice(offset, offset + visibleWidth) + rightIndicator, pan: offset };
}

const maskedOf = (value: string | undefined): string => (value === undefined || value === '' ? NO_VALUE : renderInlineValue(formatSnippet(value)));

/** Inline popup that splices into the table beneath the cursor row. Returns the pan offset it ended up using. */
function buildPopup(model: EditModel, width: number): { lines: string[]; pan: number } {
  const row = model.state.rows[model.cursorIndex];
  if (!row) return { lines: [], pan: model.popupPan };

  const indent = '  '; // popup is inset 2 cols from the table margin
  const inner = '   '; // content inside the popup is indented 3 more cols
  const ruleWidth = Math.max(10, width - indent.length);
  const rule = `${indent}${DIM}╶${'─'.repeat(ruleWidth - 2)}╴${RESET}`;

  // Width available for value content inside the popup
  const labelW = 9;
  const contentWidth = Math.max(20, ruleWidth - inner.length - 1);
  const valueContentWidth = Math.max(10, contentWidth - labelW);

  const head = [rule, '', `${indent}${inner}${BOLD}${truncate(row.key, contentWidth)}${RESET}`, ''];

  // Editing this row: the shared Old value / New value rows replace the details.
  if (model.editing && model.editing.key === row.key) {
    const rows = valueDialogRows({
      old: oldValueView(model.editing),
      revealed: model.editing.revealed,
      buffer: model.editing.buffer,
      width: ruleWidth - inner.length,
    });
    return { lines: [...head, ...rows.map((r) => `${indent}${inner}${r}`), '', rule], pan: model.popupPan };
  }

  const fieldVal = (label: string, value: string): string => `${indent}${inner}${DIM}${pad(label, labelW)}${RESET}${value}`;
  const revealed = model.revealed.has(row.key);
  // Value field — always rendered on a single line so mouse-select never captures a wrap-induced newline.
  const mine = valueField(row.localValue ?? row.remoteValue, revealed, valueContentWidth, model.popupPan, maskedSnippet(row));
  // A conflict shows both sides: the working value above, the server's under it (masked until revealed, like the first).
  const theirs =
    row.status === 'conflict'
      ? [fieldVal('theirs', valueField(row.remoteValue, revealed, valueContentWidth, mine.pan, maskedOf(row.remoteValue)).text)] // COPY-FLAG
      : [];

  return {
    lines: [...head, fieldVal('status', rowBadge(row)), fieldVal('updated', row.updatedLabel), '', fieldVal(row.status === 'conflict' ? 'yours' : 'value', mine.text), ...theirs, '', rule], // COPY-FLAG (yours)
    pan: mine.pan,
  };
}

function scrollFor(previous: number, cursorLine: number, bodyHeight: number, popupOpen: boolean, tableLength: number): number {
  const followed = cursorLine < previous ? cursorLine : cursorLine >= previous + bodyHeight ? cursorLine - bodyHeight + 1 : previous;
  if (!popupOpen) return Math.max(0, followed);
  // Pin cursor to near the top so the popup (which renders just below)
  // has room. If cursor is already higher up, leave it alone.
  const target = Math.max(0, cursorLine - 1);
  const popped = followed < target && cursorLine >= followed + 3 ? Math.min(target, Math.max(0, tableLength - bodyHeight)) : followed;
  return Math.max(0, popped);
}

const hint = (...pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.map(([key, what]) => `${BOLD}${key}${RESET}${DIM} ${what}${RESET}`).join(`${DIM} · ${RESET}`);

function footerOf(model: EditModel): string {
  const m = ' '.repeat(MARGIN);
  const dirty = dirtyKeys(model).length;
  const commitLabel = model.state.localMode ? 'commit' : 'commit & push';
  const dirtyHint = dirty > 0 ? `${DIM} · ${RESET}${BOLD}c${RESET}${DIM} ${commitLabel} (${dirty})${RESET}` : '';
  // On a conflict row, the two ways to settle it.
  const onConflict = model.state.rows[model.cursorIndex]?.status === 'conflict';
  const conflictHint = onConflict ? `${DIM} · ${RESET}${BOLD}m${RESET}${DIM} mine · ${RESET}${BOLD}t${RESET}${DIM} theirs${RESET}` : ''; // COPY-FLAG

  if (model.quitPrompt) {
    const n = dirty;
    return `${m}${YELLOW}${n} uncommitted change${n === 1 ? '' : 's'}.${RESET} ${BOLD}c${RESET}${DIM} ${commitLabel} · ${RESET}${BOLD}d${RESET}${DIM} discard · ${RESET}${BOLD}k${RESET}${DIM} keep working${RESET}`;
  }
  if (model.editing) {
    const revealHintText = canReveal(oldValueView(model.editing), model.editing.buffer)
      ? `${BOLD}ctrl+r${RESET}${DIM} ${model.editing.revealed ? 'hide' : 'reveal'} · ${RESET}`
      : ''; // COPY-FLAG
    return `${m}${DIM}Type new value · ${RESET}${revealHintText}${BOLD}Enter${RESET}${DIM} save · ${RESET}${BOLD}Esc${RESET}${DIM} cancel${RESET}`;
  }
  if (model.popupOpen) {
    const row = model.state.rows[model.cursorIndex];
    const isRevealed = row ? model.revealed.has(row.key) : false;
    const panHint = isRevealed ? `${DIM} · ${RESET}${BOLD}←/→${RESET}${DIM} pan${RESET}` : '';
    return `${m}${BOLD}r${RESET}${DIM} ${isRevealed ? 'hide' : 'reveal'} · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${conflictHint}${panHint}${dirtyHint}${DIM} · ${RESET}${BOLD}esc${RESET}${DIM} close${RESET}`;
  }
  return `${m}${DIM}↑↓ navigate · ${RESET}${BOLD}enter${RESET}${DIM} inspect · ${RESET}${BOLD}r${RESET}${DIM} reveal · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${conflictHint}${dirtyHint}${DIM} · ${RESET}${BOLD}q${RESET}${DIM} quit${RESET}`;
}

/** The frame for `termWidth` x `termHeight`, and the model with the scroll and pan this frame settled on. */
export function render(model: EditModel, termWidth: number, termHeight: number): { readonly text: string; readonly model: EditModel } {
  const m = ' '.repeat(MARGIN);
  const available = Math.max(40, termWidth - MARGIN * 2);

  const header = `${BOLD}capy edit${RESET}: ${model.state.projectName} ${DIM}(${model.state.branch})${RESET}`;

  // Top status cells — 4 cells, each exactly a quarter of the available width.
  // The last cell absorbs the remainder so the row fills exactly.
  const topCells = buildTopCells(model);
  const baseCellWidth = Math.floor(available / topCells.length);
  const cellWidth = (i: number): number => (i === topCells.length - 1 ? available - baseCellWidth * (topCells.length - 1) : baseCellWidth);
  const cellLine1 = topCells.map((c, i) => pad(c.value, cellWidth(i))).join('');
  const cellLine2 = topCells.map((c, i) => DIM + pad(c.action, cellWidth(i)) + RESET).join('');
  const headLines = [m + header, '', m + cellLine1, m + cellLine2, ''];

  // Build the single-column table. If the popup is open, splice it in after the cursor row.
  // Table layout: [0] "Variables", [1] column header, [2+] data rows.
  const table = buildTable(model, available);
  const cursorLine = 2 + model.cursorIndex;
  const popup = model.popupOpen && model.state.rows[model.cursorIndex] ? buildPopup(model, available) : undefined;
  const tableLines = popup === undefined ? table : [...table.slice(0, cursorLine + 1), ...popup.lines, ...table.slice(cursorLine + 1)];

  // Reserve space for header lines already pushed + footer (2) + status (1)
  const bodyHeight = Math.max(6, termHeight - (headLines.length + 3));
  const scrollOffset = scrollFor(model.scrollOffset, cursorLine, bodyHeight, model.popupOpen, tableLines.length);

  const body = tableLines.slice(scrollOffset, scrollOffset + bodyHeight).map((l) => m + l);
  const status = model.status ? [`${m}${model.status.isError ? RED : GREEN}${model.status.text}${RESET}`] : [];
  const lines = [...headLines, ...body, '', footerOf(model), ...status];

  return {
    text: lines.map((l) => l + CLEAR_EOL).join('\n'),
    model: { ...model, scrollOffset, popupPan: popup === undefined ? model.popupPan : popup.pan },
  };
}

// ── The shell ───────────────────────────────────────────────────────────────

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `reload`, or `undefined` when there is none or it fails (the save already happened; the rows are then updated from it). */
async function reloaded(ctx: EditContext): Promise<EditLoaded | undefined> {
  if (ctx.reload === undefined) return undefined;
  try {
    return await ctx.reload();
  } catch {
    return undefined;
  }
}

/**
 * Commits `request` through the context. Never rejects: a server that moved under a change is `conflict`
 * (decided by the error's code), with the rows re-read so the screen can show them as conflicts again.
 */
export async function saveOutcome(ctx: EditContext, request: EditCommitRequest): Promise<SaveResult> {
  try {
    const changedAt = await ctx.saveLocalEdits({ ...request.set }, { decisions: request.decisions, seen: request.seen });
    return { kind: 'saved', changedAt, loaded: await reloaded(ctx) };
  } catch (err) {
    return isSecretsConflict(err)
      ? { kind: 'conflict', message: messageOf(err), loaded: await reloaded(ctx) }
      : { kind: 'failed', message: messageOf(err) };
  }
}

function drawn(model: EditModel): EditModel {
  const frame = render(model, process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdout.write(CLEAR_SCREEN + MOVE_HOME + frame.text);
  return frame.model;
}

export class EditScreen {
  run(state: EditState, ctx: EditContext): Promise<void> {
    return new Promise<void>((resolve) => {
      // Every input (a key chunk, a resize, a save landing) is one action on one bus. The listener that is
      // attached holds the CURRENT model; handling an action detaches it and attaches one for the next model,
      // so no model is ever reassigned or modified.
      const bus = new EventEmitter();

      const onData = (data: Buffer): void => {
        bus.emit('action', { kind: 'data', data: data.toString() } satisfies EditAction);
      };
      const onResize = (): void => {
        bus.emit('redraw');
      };
      const onSignal = (): void => {
        bus.emit('action', { kind: 'data', data: '\x03' } satisfies EditAction);
      };

      const leave = (): void => {
        process.stdout.write(DISABLE_BRACKETED_PASTE + SHOW_CURSOR + EXIT_ALT_SCREEN);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.removeListener('SIGWINCH', onResize);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        bus.removeAllListeners();
        resolve();
      };

      const perform = (effect: EditEffect): void => {
        void saveOutcome(ctx, effect.request).then((result) => bus.emit('action', { kind: 'saved', result } satisfies EditAction));
      };

      const attach = (model: EditModel): void => {
        const onAction = (action: EditAction): void => {
          bus.removeListener('action', onAction);
          bus.removeListener('redraw', onRedraw);
          const outcome = reduce(model, action);
          if (outcome.done === true) return leave();
          attach(drawn(outcome.model));
          if (outcome.effect !== undefined) perform(outcome.effect);
        };
        const onRedraw = (): void => {
          bus.removeListener('action', onAction);
          bus.removeListener('redraw', onRedraw);
          attach(drawn(model));
        };
        bus.on('action', onAction);
        bus.on('redraw', onRedraw);
      };

      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_BRACKETED_PASTE);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();

      attach(drawn(initialModel(state)));

      process.stdin.on('data', onData);
      process.on('SIGWINCH', onResize);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });
  }
}
