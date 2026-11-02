// How a secret's value is shown on screen: the one place the details view and the deploy
// flow (CAP-704) get their `value` line from. Pure: a value state in, one line out. The
// value is only ever drawn into a frame; it goes nowhere else.
//
// It lives apart from `secretsScreen.ts` so the deploy flow can use it without importing
// the screen (which imports the flow). `secretsScreen.ts` re-exports it, so nothing else
// changes.

import { renderInlineValue } from './valueDialog';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const RED = `${ESC}[31m`;

export type ValueState =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly value: string }
  | { readonly status: 'unavailable'; readonly code: string };

// ── Masking (security-critical — see secretsScreen.ts and CAP-675's spec) ───

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

/**
 * The `value` line: `loading…`, `unavailable (CODE)`, the masked value, or (revealed) the value on
 * one line. A revealed value wider than `width` shows a window of it, `panOffset` characters in,
 * with ◂ / ▸ where there is more.
 */
export function renderValueLine(value: ValueState, revealed: boolean, panOffset: number, width: number): string {
  if (value.status === 'loading') return `${DIM}loading…${RESET}`;
  if (value.status === 'unavailable') return `${RED}unavailable ${DIM}(${value.code})${RESET}`;

  const raw = value.value;
  if (!revealed) return maskSecretValue(raw);
  if (raw === '') return `${DIM}(empty)${RESET}`;

  const text = renderInlineValue(raw);
  if (text.length <= width) return text;

  const visibleWidth = Math.max(1, width - 4);
  const maxOffset = Math.max(0, text.length - visibleWidth);
  const offset = Math.min(Math.max(0, panOffset), maxOffset);
  const leftIndicator = offset > 0 ? `${DIM}◂${RESET} ` : '  ';
  const rightIndicator = offset < maxOffset ? ` ${DIM}▸${RESET}` : '  ';
  return leftIndicator + text.slice(offset, offset + visibleWidth) + rightIndicator;
}
