/**
 * Interactive arrow-key table for individually resolving secret values.
 *
 * Up/Down: move between rows
 * Left/Right: select which column's value to use
 * Enter: confirm current row's selection
 * q/Ctrl+C: cancel
 *
 * Each row can have up to 3 options: pinned, local, remote (plus "delete").
 * "-" means the value doesn't exist in that source.
 */

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J`;
const MOVE_HOME = `${ESC}[H`;
const CLEAR_EOL = `${ESC}[K`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const INVERSE = `${ESC}[7m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;

export interface ResolveRow {
  variable: string;
  /** Snippet display for each column. null = value doesn't exist in that source. */
  pinned: string | null;
  local: string | null;
  remote: string | null;
}

export interface ResolveResult {
  /** Map of variable name -> chosen source ('pinned' | 'local' | 'remote' | 'delete') */
  choices: Record<string, 'pinned' | 'local' | 'remote' | 'delete'>;
  cancelled: boolean;
}

type ColumnKey = 'pinned' | 'local' | 'remote' | 'delete';

export class ResolveTable {
  private rows: ResolveRow[];
  private showLocal: boolean;
  private showRemote: boolean;
  private rowIndex = 0;
  private colIndex = 0; // index into the available columns for current row
  private confirmed: Set<number> = new Set();
  private selections: ColumnKey[];
  private cleanedUp = false;

  constructor(rows: ResolveRow[], showLocal: boolean, showRemote: boolean) {
    this.rows = rows;
    this.showLocal = showLocal;
    this.showRemote = showRemote;
    // Default selection: first available column per row
    this.selections = rows.map(row => this.getAvailableColumns(row)[0]);
  }

  private getAvailableColumns(row: ResolveRow): ColumnKey[] {
    const cols: ColumnKey[] = [];
    if (row.pinned !== null) cols.push('pinned');
    if (this.showLocal && row.local !== null) cols.push('local');
    if (this.showRemote && row.remote !== null) cols.push('remote');
    cols.push('delete');
    return cols;
  }

  private getVisibleColumns(): string[] {
    const cols = ['Variable', 'Pinned'];
    if (this.showLocal) cols.push('Local');
    if (this.showRemote) cols.push('Remote');
    return cols;
  }

  run(): Promise<ResolveResult> {
    return new Promise<ResolveResult>((resolve) => {
      if (!process.stdin.isTTY) {
        // Non-interactive: use defaults
        const choices: Record<string, ColumnKey> = {};
        for (let i = 0; i < this.rows.length; i++) {
          choices[this.rows[i].variable] = this.selections[i];
        }
        resolve({ choices, cancelled: false });
        return;
      }

      process.stdout.write(HIDE_CURSOR);
      process.stdin.setRawMode(true);
      process.stdin.resume();

      this.draw();

      const onData = (data: Buffer) => {
        const key = data.toString();

        // Ctrl+C or q = cancel
        if (key === '\x03' || key === 'q') {
          this.cleanup(onData);
          resolve({ choices: {}, cancelled: true });
          return;
        }

        const availCols = this.getAvailableColumns(this.rows[this.rowIndex]);

        // Arrow up
        if (key === `${ESC}[A`) {
          if (this.rowIndex > 0) {
            this.rowIndex--;
            // Reset col index to match current selection
            const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
            this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
            if (this.colIndex < 0) this.colIndex = 0;
            this.draw();
          }
          return;
        }

        // Arrow down
        if (key === `${ESC}[B`) {
          if (this.rowIndex < this.rows.length - 1) {
            this.rowIndex++;
            const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
            this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
            if (this.colIndex < 0) this.colIndex = 0;
            this.draw();
          }
          return;
        }

        // Arrow left
        if (key === `${ESC}[D`) {
          if (!this.confirmed.has(this.rowIndex) && this.colIndex > 0) {
            this.colIndex--;
            this.selections[this.rowIndex] = availCols[this.colIndex];
            this.draw();
          }
          return;
        }

        // Arrow right
        if (key === `${ESC}[C`) {
          if (!this.confirmed.has(this.rowIndex) && this.colIndex < availCols.length - 1) {
            this.colIndex++;
            this.selections[this.rowIndex] = availCols[this.colIndex];
            this.draw();
          }
          return;
        }

        // Enter = confirm row
        if (key === '\r' || key === '\n') {
          this.confirmed.add(this.rowIndex);

          // Check if all confirmed
          if (this.confirmed.size === this.rows.length) {
            this.cleanup(onData);
            const choices: Record<string, ColumnKey> = {};
            for (let i = 0; i < this.rows.length; i++) {
              choices[this.rows[i].variable] = this.selections[i];
            }
            resolve({ choices, cancelled: false });
            return;
          }

          // Move to next unconfirmed row
          for (let i = this.rowIndex + 1; i < this.rows.length; i++) {
            if (!this.confirmed.has(i)) {
              this.rowIndex = i;
              const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
              this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
              if (this.colIndex < 0) this.colIndex = 0;
              break;
            }
          }
          this.draw();
          return;
        }
      };

      process.stdin.on('data', onData);
    });
  }

  private draw(): void {
    const visibleCols = this.getVisibleColumns();
    const m = '  ';

    // Calculate column widths
    const colWidths: number[] = visibleCols.map(h => h.length);
    for (const row of this.rows) {
      colWidths[0] = Math.max(colWidths[0], row.variable.length);
      colWidths[1] = Math.max(colWidths[1], (row.pinned || '-').length + 2); // +2 for brackets
      let ci = 2;
      if (this.showLocal) {
        colWidths[ci] = Math.max(colWidths[ci] || 0, (row.local || '-').length + 2);
        ci++;
      }
      if (this.showRemote) {
        colWidths[ci] = Math.max(colWidths[ci] || 0, (row.remote || '-').length + 2);
      }
    }
    colWidths.forEach((w, i) => { colWidths[i] = w + 2; });

    const lines: string[] = [];

    // Header
    const header = visibleCols.map((h, i) => this.pad(h, colWidths[i])).join('');
    lines.push(m + header);
    lines.push(m + '-'.repeat(colWidths.reduce((a, b) => a + b, 0)));

    // Rows
    for (let ri = 0; ri < this.rows.length; ri++) {
      const row = this.rows[ri];
      const isActive = ri === this.rowIndex;
      const isConfirmed = this.confirmed.has(ri);
      const selection = this.selections[ri];

      // Build cell values
      const cells: string[] = [row.variable];
      const cellKeys: (ColumnKey | null)[] = [null]; // variable name has no key

      cells.push(row.pinned || '-');
      cellKeys.push('pinned');

      if (this.showLocal) {
        cells.push(row.local || '-');
        cellKeys.push('local');
      }
      if (this.showRemote) {
        cells.push(row.remote || '-');
        cellKeys.push('remote');
      }

      // Format each cell
      const formatted = cells.map((cell, ci) => {
        const key = cellKeys[ci];
        const width = colWidths[ci];

        if (ci === 0) {
          // Variable name column
          if (isActive) return CYAN + this.pad(cell, width) + RESET;
          if (isConfirmed) return GREEN + this.pad(cell, width) + RESET;
          return this.pad(cell, width);
        }

        if (key === null) return this.pad(cell, width);

        const isSelected = key === selection;
        const val = cell;

        if (isConfirmed && isSelected) {
          return GREEN + this.pad(`[${val}]`, width) + RESET;
        }
        if (isActive && isSelected) {
          return INVERSE + this.pad(`[${val}]`, width) + RESET;
        }
        if (isConfirmed) {
          return DIM + this.pad(val, width) + RESET;
        }
        return this.pad(val, width);
      });

      lines.push(m + formatted.join(''));

      // Show arrow indicator on active row
      if (isActive && !isConfirmed) {
        // Find the position of the selected cell
        let offset = colWidths[0]; // skip variable name column
        for (let ci = 1; ci < cells.length; ci++) {
          if (cellKeys[ci] === selection) break;
          offset += colWidths[ci];
        }
        const selectedWidth = cells[cells.findIndex((_, i) => cellKeys[i] === selection)].length + 2;
        const arrowLine = ' '.repeat(offset) + '<' + ' '.repeat(Math.max(0, selectedWidth - 2)) + '>';
        lines.push(m + DIM + arrowLine + RESET);
      } else {
        lines.push(''); // blank spacer
      }
    }

    // Footer
    lines.push('');
    lines.push(m + DIM + 'Use <- -> to select value. Up/Down to move between rows.' + RESET);
    lines.push(m + DIM + 'Enter to confirm. Delete = remove this secret.' + RESET);
    lines.push('');
    lines.push(m + `Resolved: ${this.confirmed.size}/${this.rows.length}`);

    const output = CLEAR_SCREEN + MOVE_HOME + lines.map(l => l + CLEAR_EOL).join('\n');
    process.stdout.write(output);
  }

  private cleanup(onData: (data: Buffer) => void): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    process.stdout.write(SHOW_CURSOR);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdin.removeListener('data', onData);
    // Clear the table output
    process.stdout.write(CLEAR_SCREEN + MOVE_HOME);
  }

  private pad(str: string, width: number): string {
    const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
    if (clean.length >= width) return str;
    return str + ' '.repeat(width - clean.length);
  }
}
