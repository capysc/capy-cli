// A checkbox list drawn as a table with headings, for the `capy secrets` edit
// flow's location and repo pickers:
//
//        REPO                                        PROJECTS                     BASE
//   ❯ ◉  SlideSpeak/slidespeak-monorepo              backend, worker (3 changes)  main
//     ◯  SlideSpeak/pdf-to-docx-server               pdf-to-docx (1 change)       main
//
// The checkbox column comes first and is the CLI's standard one: the glyphs and
// cursor are `CHECKBOX_THEME` / `CHECKBOX_CURSOR` (ui/promptStyle.ts), the same
// ones `searchableCheckbox` draws. Headings are dim like the other tables in the
// CLI, and column widths fit the content. When the terminal is narrow the columns
// marked `shrink` give up width first, cut with `…`. The key handling is not here:
// it is `stepCheckboxKey` (ui/searchableCheckbox.ts), so the keys are the deploy
// picker's. Pure: state in, lines out; no line is ever wider than `maxWidth`.

import { CheckboxState, visibleIndices } from './searchableCheckbox';
import { CHECKBOX_CURSOR, CHECKBOX_THEME } from './promptStyle';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const INVERSE = `${ESC}[7m`;

/** The checkbox cell: the cursor (or a space) then the theme's icon, e.g. `❯ ◉` and `  ◯`. */
export const checkboxCell = (active: boolean, checked: boolean): string =>
  `${active ? CHECKBOX_CURSOR : ' '}${checked ? CHECKBOX_THEME.icon.checked : CHECKBOX_THEME.icon.unchecked}`;

/** Its width in characters (the heading is indented by this much). */
const BOX_WIDTH = Array.from(checkboxCell(false, true)).length;
const GAP = '  ';
const MIN_SHRUNK = 8;

export interface TableColumn {
  readonly heading: string;
  /** May be cut with `…` when the terminal is narrow. */
  readonly shrink: boolean;
}

/** `text` cut to `width` visible characters, ending in `…` when something was cut. */
export function truncateCell(text: string, width: number): string {
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/**
 * Takes `excess` characters off the widest shrinkable columns (never below
 * `MIN_SHRUNK`), one column at a time. Returns the widths unchanged when nothing
 * can shrink any further.
 */
export function shrinkWidths(
  widths: readonly number[],
  shrinkable: readonly boolean[],
  excess: number,
): readonly number[] {
  if (excess <= 0) return widths;
  const candidates = widths.map((w, i) => ({ w, i })).filter(({ w, i }) => shrinkable[i] && w > MIN_SHRUNK);
  if (candidates.length === 0) return widths;
  const widest = candidates.reduce((a, b) => (b.w > a.w ? b : a));
  // Bring the widest down to the runner-up (or by what is left to remove), then go again.
  const others = candidates.filter((c) => c.i !== widest.i);
  const floor = Math.max(MIN_SHRUNK, others.length === 0 ? MIN_SHRUNK : Math.max(...others.map((c) => c.w)));
  const take = Math.min(excess, Math.max(1, widest.w - floor));
  return shrinkWidths(widths.map((w, i) => (i === widest.i ? w - take : w)), shrinkable, excess - take);
}

/** Column widths: each fits its widest cell (heading included), then shrinkable ones give way to fit `available`. */
export function columnWidths(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  available: number,
): readonly number[] {
  const natural = columns.map((c, i) => Math.max(Array.from(c.heading).length, ...rows.map((r) => Array.from(r[i] ?? '').length)));
  const total = BOX_WIDTH + GAP.length + natural.reduce((a, b) => a + b, 0) + GAP.length * (columns.length - 1);
  return shrinkWidths(natural, columns.map((c) => c.shrink), total - available);
}

const padCell = (text: string, width: number): string => {
  const cell = truncateCell(text, width);
  return cell + ' '.repeat(Math.max(0, width - Array.from(cell).length));
};

/**
 * `line` cut to `width` visible characters. Colour codes are kept (and so are
 * their resets) but cost nothing; when text is cut the last visible character
 * becomes `…`. Used on every line the edit flow draws.
 */
export function clipLine(line: string, width: number): string {
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  const folded = parts.reduce<{ readonly out: string; readonly used: number; readonly cut: boolean }>(
    (acc, part) => {
      if (/^\x1b\[[0-9;]*m$/.test(part)) return { ...acc, out: acc.out + part };
      if (acc.cut || part === '') return acc;
      const chars = Array.from(part);
      const room = width - acc.used;
      if (chars.length <= room) return { out: acc.out + part, used: acc.used + chars.length, cut: false };
      return { out: `${acc.out}${chars.slice(0, Math.max(0, room - 1)).join('')}${room > 0 ? '…' : ''}`, used: width, cut: true };
    },
    { out: '', used: 0, cut: false },
  );
  return folded.cut ? `${folded.out}${RESET}` : folded.out;
}

export interface PickerTable {
  readonly columns: readonly TableColumn[];
  /** The cells of EVERY choice (also those the filter hides), one row per choice. */
  readonly rows: readonly (readonly string[])[];
  /** What the filter matches, per choice. */
  readonly labels: readonly string[];
  readonly box: CheckboxState;
  /** How many choice rows to show at once. */
  readonly size: number;
  /** No line is wider than this. */
  readonly maxWidth: number;
}

function pageOf(count: number, active: number, size: number): readonly [number, number] {
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), count - size));
  return [start, Math.min(count, start + size)];
}

/** The filter line (while searching), the headings and the visible rows. */
export function pickerTableLines(t: PickerTable): readonly string[] {
  const widths = columnWidths(t.columns, t.rows, t.maxWidth);
  const line = (box: string, cells: readonly string[]): string =>
    `${box}${GAP}${cells.map((c, i) => padCell(c, widths[i])).join(GAP)}`.trimEnd();

  const visible = visibleIndices(t.labels, t.box.query);
  const [from, to] = pageOf(visible.length, t.box.active, t.size);
  const body = visible.slice(from, to).map((index, i) => {
    const active = from + i === t.box.active;
    const text = clipLine(line(checkboxCell(active, t.box.checked.includes(index)), t.rows[index]), t.maxWidth);
    return active ? `${INVERSE}${text}${RESET}` : text;
  });
  const heading = `${DIM}${clipLine(line(' '.repeat(BOX_WIDTH), t.columns.map((c) => c.heading)), t.maxWidth)}${RESET}`;
  const search = t.box.searching ? [`${DIM}search:${RESET} ${t.box.query}▏`] : [];
  return [...search, heading, ...(body.length === 0 ? [`${DIM}No matches.${RESET}`] : body)];
}
