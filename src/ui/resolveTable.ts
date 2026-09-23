/**
 * Interactive arrow-key table for individually resolving secret values.
 *
 * Each row can choose a concrete pinned, local, or remote source, or delete.
 * A rest control applies one source to every row that has not already been
 * individually confirmed.
 */

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_EOL = `${ESC}[K`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const GREEN = `${ESC}[32m`;
const BG_SELECT = `${ESC}[47m${ESC}[30m`;

export interface ResolveRow {
  readonly variable: string;
  /** Snippet display for each column. null = value does not exist in that source. */
  readonly pinned: string | null;
  /** The prior pin exists but no concrete value can be reconstructed. */
  readonly pinnedUnresolvable?: boolean;
  readonly local: string | null;
  readonly remote: string | null;
}

export type ResolveOutcome = 'resolved' | 'cancelled' | 'needs-input';

export interface ResolveResult {
  readonly choices: Record<string, ColumnKey>;
  readonly outcome: ResolveOutcome;
}

export type ColumnKey = 'pinned' | 'local' | 'remote' | 'delete';

type ResolverState = Readonly<{
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly selections: readonly ColumnKey[];
  readonly confirmed: readonly number[];
  readonly totalLines: number;
}>;

type Resolution = Readonly<{
  readonly outcome: 'resolved';
  readonly state: ResolverState;
  readonly choices: Record<string, ColumnKey>;
}> | Readonly<{
  readonly outcome: 'cancelled';
}> | Readonly<{
  readonly outcome: 'continue';
  readonly state: ResolverState;
}>;

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (value: string, width: number): string => {
  const clean = stripAnsi(value);
  return clean.length >= width ? value : value + ' '.repeat(width - clean.length);
};
const indices = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index);

/** The terminal counterpart of the Kit resolver table. */
export class ResolveTable {
  private readonly rows: readonly ResolveRow[];
  private readonly showLocal: boolean;
  private readonly showRemote: boolean;
  /** Kept for the non-TTY safety test: these are the untouched initial choices. */
  private readonly selections: readonly ColumnKey[];

  constructor(
    rows: readonly ResolveRow[],
    showLocal: boolean,
    showRemote: boolean,
    defaults: readonly ColumnKey[] = [],
  ) {
    this.rows = rows;
    this.showLocal = showLocal;
    this.showRemote = showRemote;
    this.selections = rows.map((row, index) => {
      const available = this.available(row);
      const wanted = defaults[index];
      return wanted !== undefined && available.includes(wanted) ? wanted : available[0];
    });
  }

  private available(row: ResolveRow): readonly ColumnKey[] {
    return [
      ...(row.pinnedUnresolvable ? [] : ['pinned' as const]),
      ...(this.showLocal && row.local !== null ? ['local' as const] : []),
      ...(this.showRemote && row.remote !== null ? ['remote' as const] : []),
      'delete',
    ];
  }

  private visibleColumns(): readonly string[] {
    return [
      'Variable',
      'Pinned',
      ...(this.showLocal ? ['Local'] : []),
      ...(this.showRemote ? ['Remote'] : []),
      'Choice',
    ];
  }

  private initialState(): ResolverState {
    const row = this.rows[0];
    const available = row === undefined ? [] : this.available(row);
    return {
      rowIndex: 0,
      colIndex: Math.max(0, available.indexOf(this.selections[0])),
      selections: this.selections,
      confirmed: [],
      totalLines: 0,
    };
  }

  private choices(state: ResolverState): Record<string, ColumnKey> {
    return Object.fromEntries(this.rows.map((row, index) => [row.variable, state.selections[index]]));
  }

  private stateForRow(state: ResolverState, rowIndex: number): ResolverState {
    const available = this.available(this.rows[rowIndex]);
    return {
      ...state,
      rowIndex,
      colIndex: Math.max(0, available.indexOf(state.selections[rowIndex])),
    };
  }

  private moveRow(state: ResolverState, offset: -1 | 1): ResolverState {
    const nextIndex = Math.max(0, Math.min(this.rows.length - 1, state.rowIndex + offset));
    return nextIndex === state.rowIndex ? state : this.stateForRow(state, nextIndex);
  }

  private selectColumn(state: ResolverState, offset: -1 | 1): ResolverState {
    const available = this.available(this.rows[state.rowIndex]);
    const colIndex = Math.max(0, Math.min(available.length - 1, state.colIndex + offset));
    return {
      ...state,
      colIndex,
      selections: state.selections.map((selection, index) => index === state.rowIndex ? available[colIndex] : selection),
      confirmed: state.confirmed.filter((index) => index !== state.rowIndex),
    };
  }

  private confirm(state: ResolverState): Resolution {
    const confirmed = state.confirmed.includes(state.rowIndex) ? state.confirmed : [...state.confirmed, state.rowIndex];
    const completed = confirmed.length === this.rows.length;
    const confirmedState = { ...state, confirmed };
    if (completed) return { outcome: 'resolved', state: confirmedState, choices: this.choices(confirmedState) };
    const nextRow = indices(this.rows.length).map((offset) => (state.rowIndex + offset + 1) % this.rows.length).find((index) => !confirmed.includes(index));
    return { outcome: 'continue', state: nextRow === undefined ? confirmedState : this.stateForRow(confirmedState, nextRow) };
  }

  private applyRest(state: ResolverState, source: Exclude<ColumnKey, 'delete'>): Resolution {
    const selections = state.selections.map((selection, index) => state.confirmed.includes(index)
      ? selection
      : this.available(this.rows[index]).includes(source) ? source : selection);
    const completedState: ResolverState = { ...state, selections, confirmed: indices(this.rows.length) };
    return { outcome: 'resolved', state: completedState, choices: this.choices(completedState) };
  }

  private transition(state: ResolverState, key: string): Resolution {
    if (key === '\x03' || key === 'q') return { outcome: 'cancelled' };
    if (key === 'p' || key === 'P') return this.applyRest(state, 'pinned');
    if (key === 'l' || key === 'L') return this.applyRest(state, 'local');
    if (key === 'r' || key === 'R') return this.applyRest(state, 'remote');
    if (key === `${ESC}[A`) return { outcome: 'continue', state: this.moveRow(state, -1) };
    if (key === `${ESC}[B`) return { outcome: 'continue', state: this.moveRow(state, 1) };
    if (key === `${ESC}[D`) return { outcome: 'continue', state: this.selectColumn(state, -1) };
    if (key === `${ESC}[C`) return { outcome: 'continue', state: this.selectColumn(state, 1) };
    if (key === '\r' || key === '\n') return this.confirm(state);
    return { outcome: 'continue', state };
  }

  private draw(state: ResolverState): ResolverState {
    if (state.totalLines > 0) process.stdout.write(`${ESC}[${state.totalLines}A`);
    const visibleColumns = this.visibleColumns();
    const widths = visibleColumns.map((header, column) => Math.max(header.length, ...this.rows.map((row) => {
      const values = [row.variable, row.pinned ?? '-', ...(this.showLocal ? [row.local ?? '-'] : []), ...(this.showRemote ? [row.remote ?? '-'] : []), 'remote'];
      return stripAnsi(values[column]).length;
    })) + 2);
    const prefix = '  ';
    const lines = [
      prefix + DIM + '← → select value   ↑ ↓ move between rows   Enter confirm   p rest pinned   l rest local   r rest remote   q cancel' + RESET,
      prefix + `Resolved: ${state.confirmed.length}/${this.rows.length}`,
      '',
      prefix + visibleColumns.map((column, index) => pad(column, widths[index])).join(''),
      prefix + '─'.repeat(widths.reduce((total, width) => total + width, 0)),
      ...this.rows.map((row, rowIndex) => {
        const active = rowIndex === state.rowIndex;
        const confirmed = state.confirmed.includes(rowIndex);
        const selection = state.selections[rowIndex];
        const values = [row.variable, row.pinned ?? '-', ...(this.showLocal ? [row.local ?? '-'] : []), ...(this.showRemote ? [row.remote ?? '-'] : []), confirmed || active ? selection : ''];
        const keys: readonly (ColumnKey | null)[] = [null, 'pinned', ...(this.showLocal ? ['local' as const] : []), ...(this.showRemote ? ['remote' as const] : []), null];
        const choiceColumn = values.length - 1;
        const formatted = values.map((value, column) => {
          const key = keys[column];
          const width = widths[column];
          if (column === choiceColumn) return confirmed && !active ? GREEN + pad(value, width) + RESET : active ? DIM + pad(value, width) + RESET : pad(value, width);
          if (column === 0) return confirmed && !active ? GREEN + pad(value, width) + RESET : pad(value, width);
          if (key === null) return pad(value, width);
          if (active && key === selection) return BG_SELECT + pad(value, width) + RESET;
          if (active) return pad(value, width);
          if (confirmed && key === selection) return GREEN + pad(value, width) + RESET;
          return confirmed ? DIM + pad(value, width) + RESET : pad(value, width);
        });
        return prefix + formatted.join('');
      }),
    ];
    process.stdout.write(lines.map((line) => line + CLEAR_EOL).join('\n') + '\n');
    return { ...state, totalLines: lines.length };
  }

  private cleanup(onData: (data: Buffer) => void): void {
    process.stdout.write(SHOW_CURSOR);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeListener('data', onData);
  }

  run(): Promise<ResolveResult> {
    if (!process.stdin.isTTY) return Promise.resolve({ choices: {}, outcome: 'needs-input' });
    return new Promise<ResolveResult>((resolve) => {
      process.stdout.write(HIDE_CURSOR);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const listen = (state: ResolverState): void => {
        const drawn = this.draw(state);
        const onData = (data: Buffer): void => {
          const result = this.transition(drawn, data.toString());
          process.stdin.removeListener('data', onData);
          if (result.outcome === 'cancelled') {
            this.cleanup(onData);
            resolve({ choices: {}, outcome: 'cancelled' });
            return;
          }
          if (result.outcome === 'resolved') {
            this.draw(result.state);
            this.cleanup(onData);
            resolve({ choices: result.choices, outcome: 'resolved' });
            return;
          }
          listen(result.state);
        };
        process.stdin.on('data', onData);
      };
      listen(this.initialState());
    });
  }
}
