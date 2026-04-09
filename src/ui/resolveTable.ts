/**
 * Interactive arrow-key table for individually resolving secret values.
 *
 * Each row can have up to 3 options: pinned, local, remote (plus "delete").
 * "-" means the value doesn't exist in that source.
 */

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_EOL = `${ESC}[K`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const GREEN = `${ESC}[32m`;
// White background selection box
const BG_SELECT = `${ESC}[47m${ESC}[30m`; // white bg + black text

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
  private colIndex = 0;
  private confirmed: Set<number> = new Set();
  private selections: ColumnKey[];
  private cleanedUp = false;
  private totalLines = 0;

  constructor(rows: ResolveRow[], showLocal: boolean, showRemote: boolean) {
    this.rows = rows;
    this.showLocal = showLocal;
    this.showRemote = showRemote;
    this.selections = rows.map(row => this.getAvailableColumns(row)[0]);
  }

  private getAvailableColumns(_row: ResolveRow): ColumnKey[] {
    const cols: ColumnKey[] = ['pinned'];
    if (this.showLocal) cols.push('local');
    if (this.showRemote) cols.push('remote');
    cols.push('delete');
    return cols;
  }

  private getVisibleColumns(): string[] {
    const cols = ['Variable', 'Pinned'];
    if (this.showLocal) cols.push('Local');
    if (this.showRemote) cols.push('Remote');
    cols.push('Choice');
    return cols;
  }

  run(): Promise<ResolveResult> {
    return new Promise<ResolveResult>((resolve) => {
      if (!process.stdin.isTTY) {
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

        if (key === '\x03' || key === 'q') {
          this.cleanup(onData);
          resolve({ choices: {}, cancelled: true });
          return;
        }

        const availCols = this.getAvailableColumns(this.rows[this.rowIndex]);

        if (key === `${ESC}[A`) {
          if (this.rowIndex > 0) {
            this.rowIndex--;
            const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
            this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
            this.colIndex = Math.max(0, Math.min(this.colIndex, newAvail.length - 1));
            this.draw();
          }
          return;
        }

        if (key === `${ESC}[B`) {
          if (this.rowIndex < this.rows.length - 1) {
            this.rowIndex++;
            const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
            this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
            this.colIndex = Math.max(0, Math.min(this.colIndex, newAvail.length - 1));
            this.draw();
          }
          return;
        }

        if (key === `${ESC}[D`) {
          this.confirmed.delete(this.rowIndex);
          this.colIndex = Math.max(0, this.colIndex - 1);
          this.selections[this.rowIndex] = availCols[this.colIndex];
          this.draw();
          return;
        }

        if (key === `${ESC}[C`) {
          this.confirmed.delete(this.rowIndex);
          this.colIndex = Math.min(availCols.length - 1, this.colIndex + 1);
          this.selections[this.rowIndex] = availCols[this.colIndex];
          this.draw();
          return;
        }

        if (key === '\r' || key === '\n') {
          this.confirmed.add(this.rowIndex);

          if (this.confirmed.size === this.rows.length) {
            this.cleanup(onData);
            const choices: Record<string, ColumnKey> = {};
            for (let i = 0; i < this.rows.length; i++) {
              choices[this.rows[i].variable] = this.selections[i];
            }
            resolve({ choices, cancelled: false });
            return;
          }

          for (let i = this.rowIndex + 1; i < this.rows.length; i++) {
            if (!this.confirmed.has(i)) {
              this.rowIndex = i;
              const newAvail = this.getAvailableColumns(this.rows[this.rowIndex]);
              this.colIndex = newAvail.indexOf(this.selections[this.rowIndex]);
              this.colIndex = Math.max(0, Math.min(this.colIndex, newAvail.length - 1));
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
    // Move cursor up to overwrite previous output
    if (this.totalLines > 0) {
      process.stdout.write(`${ESC}[${this.totalLines}A`);
    }

    const visibleCols = this.getVisibleColumns();
    const m = '  ';

    // Calculate column widths
    const colWidths: number[] = visibleCols.map(h => h.length);
    for (const row of this.rows) {
      colWidths[0] = Math.max(colWidths[0], row.variable.length);
      colWidths[1] = Math.max(colWidths[1], (row.pinned || '-').length);
      let ci = 2;
      if (this.showLocal) {
        colWidths[ci] = Math.max(colWidths[ci] || 0, (row.local || '-').length);
        ci++;
      }
      if (this.showRemote) {
        colWidths[ci] = Math.max(colWidths[ci] || 0, (row.remote || '-').length);
        ci++;
      }
      // Choice column
      colWidths[ci] = Math.max(colWidths[ci] || 0, 8); // "remote" is longest at 6, pad a bit
    }
    colWidths.forEach((w, i) => { colWidths[i] = w + 2; });

    const lines: string[] = [];

    // Instructions above the table
    lines.push(m + DIM + '← → select value   ↑ ↓ move between rows   Enter confirm   q cancel' + RESET);
    lines.push(m + `Resolved: ${this.confirmed.size}/${this.rows.length}`);
    lines.push('');

    // Header
    const header = visibleCols.map((h, i) => this.pad(h, colWidths[i])).join('');
    lines.push(m + header);
    lines.push(m + '─'.repeat(colWidths.reduce((a, b) => a + b, 0)));

    // Rows
    for (let ri = 0; ri < this.rows.length; ri++) {
      const row = this.rows[ri];
      const isActive = ri === this.rowIndex;
      const isConfirmed = this.confirmed.has(ri);
      const selection = this.selections[ri];

      // Build cell values
      const cells: string[] = [row.variable];
      const cellKeys: (ColumnKey | null)[] = [null];

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

      // Choice column
      const choiceLabel = isConfirmed ? selection : (isActive ? selection : '');
      cells.push(choiceLabel);
      cellKeys.push(null);
      const choiceColIdx = cells.length - 1;

      // Format each cell — active row always shows selection box, even if confirmed
      const formatted = cells.map((cell, ci) => {
        const key = cellKeys[ci];
        const width = colWidths[ci];

        // Choice column
        if (ci === choiceColIdx) {
          if (isConfirmed && !isActive) return GREEN + this.pad(cell, width) + RESET;
          if (isActive) return DIM + this.pad(cell, width) + RESET;
          return this.pad(cell, width);
        }

        // Variable name column
        if (ci === 0) {
          if (isConfirmed && !isActive) return GREEN + this.pad(cell, width) + RESET;
          return this.pad(cell, width);
        }

        if (key === null) return this.pad(cell, width);

        const isSelected = key === selection;

        if (isActive && isSelected) {
          return BG_SELECT + this.pad(cell, width) + RESET;
        }
        if (isActive) {
          return this.pad(cell, width);
        }
        if (isConfirmed && isSelected) {
          return GREEN + this.pad(cell, width) + RESET;
        }
        if (isConfirmed) {
          return DIM + this.pad(cell, width) + RESET;
        }
        return this.pad(cell, width);
      });

      lines.push(m + formatted.join(''));
    }

    // Write all lines, clearing to end of each line
    const output = lines.map(l => l + CLEAR_EOL).join('\n') + '\n';
    process.stdout.write(output);
    this.totalLines = lines.length;
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
  }

  private pad(str: string, width: number): string {
    const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
    if (clean.length >= width) return str;
    return str + ' '.repeat(width - clean.length);
  }
}
