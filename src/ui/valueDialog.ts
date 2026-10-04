// The value dialog shared by `capy edit` (ui/editScreen.ts) and the `capy secrets`
// edit flow (ui/secretsEditFlow.ts): two rows, labels in one column, both values
// starting at the same column.
//
//   Old value   ••••••••••••••••  ctrl+r reveal
//   New value   new value
//
// Row 1 is the CURRENT value, masked by default. Row 2 is the input: a dim
// placeholder while empty, masked dots once typing starts. Ctrl+R is ONE toggle
// for both rows: revealed, the old value (when it could be read) and the typed
// text both show in plain form (line breaks as ↵, tabs as spaces), on screen
// only. There is no box and no border. Pure: state in, lines out. The typing rule
// is in ./editBuffer.
//
// Both values are plaintext here and go nowhere but into a frame: callers pass
// them in, this module never logs them, and the post-exit text of both screens is
// built from names and counts, never from them.

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;

/** Where the values start on both rows. */
export const LABEL_COLUMN = 12;
const OLD_LABEL = 'Old value'; // COPY-FLAG
const NEW_LABEL = 'New value'; // COPY-FLAG
const PLACEHOLDER = 'new value'; // COPY-FLAG
const NO_OLD_VALUE = '(none)'; // COPY-FLAG
const MASK_WIDTH = 16;
/** The typed value is masked with one dot per character, up to this many. */
const MASK_CAP = 32;

/** What the old-value row can say. */
export type OldValueView =
  /** Being fetched. */
  | { readonly kind: 'loading' }
  /** The current value (plaintext, for on-screen reveal only). */
  | { readonly kind: 'value'; readonly value: string }
  /** A new variable: there is no old value. */
  | { readonly kind: 'none' }
  /** It could not be read; `code` is a machine code, never a message. */
  | { readonly kind: 'unavailable'; readonly code: string };

export interface ValueDialogInput {
  readonly old: OldValueView;
  readonly revealed: boolean;
  /** What has been typed (never drawn as is). */
  readonly buffer: string;
  readonly width: number;
}

/** One line for a value that may hold line breaks and tabs; length is preserved. */
export function renderInlineValue(value: string): string {
  return value.replace(/\n/g, '↵').replace(/\t/g, ' ');
}

const pad = (s: string, width: number): string => (s.length >= width ? s : s + ' '.repeat(width - s.length));
const clip = (s: string, width: number): string => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

/** Whether Ctrl+R does anything: there is something to show (a readable old value, or typed text). */
export const canReveal = (old: OldValueView, buffer: string): boolean => old.kind === 'value' || buffer !== '';

/** The hint for the reveal key, which says what pressing it does now. Empty when there is nothing to reveal. */
export function revealHint(old: OldValueView, revealed: boolean, buffer: string): string {
  return canReveal(old, buffer) ? `ctrl+r ${revealed ? 'hide' : 'reveal'}` : ''; // COPY-FLAG
}

function oldText(old: OldValueView, revealed: boolean, textWidth: number): string {
  if (old.kind === 'loading') return `${DIM}loading…${RESET}`; // COPY-FLAG
  if (old.kind === 'none') return `${DIM}${NO_OLD_VALUE}${RESET}`;
  if (old.kind === 'unavailable') return `${DIM}unavailable (${old.code})${RESET}`; // COPY-FLAG
  if (old.value === '') return `${DIM}(empty)${RESET}`; // COPY-FLAG
  return revealed ? clip(renderInlineValue(old.value), textWidth) : '•'.repeat(MASK_WIDTH);
}

/** Visible length (colour codes removed). */
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** The two rows, without any margin. */
export function valueDialogRows(input: ValueDialogInput): readonly [string, string] {
  const textWidth = Math.min(40, Math.max(MASK_WIDTH, input.width - LABEL_COLUMN - 14 - 2));
  const oldCell = oldText(input.old, input.revealed, textWidth);
  const hint = revealHint(input.old, input.revealed, input.buffer);
  const oldRow = `${pad(OLD_LABEL, LABEL_COLUMN)}${oldCell}${hint === '' ? '' : `${' '.repeat(Math.max(2, textWidth - visible(oldCell) + 2))}${DIM}${hint}${RESET}`}`;

  const count = `${DIM}(${input.buffer.length} characters)${RESET}`; // COPY-FLAG
  const typedText = input.revealed
    ? clip(renderInlineValue(input.buffer), textWidth)
    : '•'.repeat(Math.min(input.buffer.length, MASK_CAP));
  const newCell = input.buffer.length === 0 ? `${DIM}${PLACEHOLDER}${RESET}` : `${typedText}  ${count}`;
  return [oldRow, `${pad(NEW_LABEL, LABEL_COLUMN)}${newCell}`];
}
