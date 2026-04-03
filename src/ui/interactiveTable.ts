import { MemberDetail } from '../service/serviceClient';

// ANSI escape codes
const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const MOVE_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[J`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;

// Box-drawing chars
const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  tDown: '┬', tUp: '┴', tRight: '├', tLeft: '┤',
  cross: '┼',
};

// Tree chars for expanded details
const TREE = {
  branch: '├─', last: '└─', pipe: '│ ', space: '  ',
  childBranch: '├──', childLast: '└──',
};

interface ColumnConfig {
  label: string;
  minWidth: number;
  flex?: boolean; // Gets remaining space
}

const COLUMNS: ColumnConfig[] = [
  { label: 'Email', minWidth: 20, flex: true },
  { label: 'Role', minWidth: 8 },
  { label: 'Added', minWidth: 12 },
  { label: 'Projects', minWidth: 8 },
];

export class InteractiveTable {
  private members: MemberDetail[] = [];
  private selectedIndex = 0;
  private expandedIndices = new Set<number>();
  private scrollOffset = 0;
  private running = false;
  private onDataHandler: ((data: Buffer) => void) | null = null;
  private onResizeHandler: (() => void) | null = null;
  private cleanedUp = false;

  /**
   * Compute column widths based on terminal width.
   * Returns widths array parallel to COLUMNS, or null if terminal is too narrow for the "Added" column.
   */
  computeColumnWidths(termWidth: number): { widths: number[]; showAdded: boolean } {
    termWidth = Math.min(termWidth, 130);
    const padding = 3; // "│ " prefix + " " suffix per cell
    const showAdded = termWidth >= 60;
    const cols = showAdded ? COLUMNS : COLUMNS.filter(c => c.label !== 'Added');

    const fixedTotal = cols
      .filter(c => !c.flex)
      .reduce((sum, c) => sum + c.minWidth + padding, 0);

    const flexCol = cols.find(c => c.flex);
    const flexWidth = Math.max(
      flexCol?.minWidth || 20,
      termWidth - fixedTotal - padding - 1, // -1 for trailing │
    );

    return {
      widths: cols.map(c => c.flex ? flexWidth : c.minWidth),
      showAdded,
    };
  }

  /**
   * Render a single member row (collapsed).
   */
  renderRow(member: MemberDetail, index: number, widths: number[], showAdded: boolean): string {
    const isSelected = index === this.selectedIndex;
    const isExpanded = this.expandedIndices.has(index);
    const pointer = isExpanded ? '▾' : '▸';
    const prefix = isSelected ? pointer : ' ';

    const email = this.truncate(`${prefix} ${member.email}`, widths[0]);
    const roleColor = ['owner', 'admin'].includes(member.role) ? GREEN
      : member.role === 'project-admin' ? YELLOW
      : '';
    const roleReset = roleColor ? RESET : '';
    const role = this.pad(member.role, widths[1]);
    const projCount = this.pad(String(member.projects.length), showAdded ? widths[3] : widths[2]);

    let cells = `${BOX.v} ${this.pad(email, widths[0])} ${BOX.v} ${roleColor}${role}${roleReset}`;
    if (showAdded) {
      const added = this.pad(this.formatDate(member.createdAt), widths[2]);
      cells += ` ${BOX.v} ${added}`;
    }
    cells += ` ${BOX.v} ${projCount} ${BOX.v}`;

    if (isSelected) {
      return `${INVERSE}${cells}${RESET}`;
    }
    return cells;
  }

  /**
   * Render the expanded detail lines for a member (project + branch tree).
   */
  renderExpandedDetail(member: MemberDetail, widths: number[], showAdded: boolean): string[] {
    if (member.projects.length === 0) {
      const totalWidth = this.totalRowWidth(widths, showAdded);
      const line = `${BOX.v}   ${DIM}No project access${RESET}`;
      return [line + ' '.repeat(Math.max(0, totalWidth - this.visLen(line) - 2)) + ` ${BOX.v}`];
    }

    const totalWidth = this.totalRowWidth(widths, showAdded);
    const lines: string[] = [];

    for (let pi = 0; pi < member.projects.length; pi++) {
      const project = member.projects[pi];
      const isLastProject = pi === member.projects.length - 1;
      const projPrefix = isLastProject ? TREE.last : TREE.branch;
      const projLine = `${BOX.v}   ${projPrefix} ${project.name}`;
      lines.push(projLine + ' '.repeat(Math.max(0, totalWidth - this.visLen(projLine) - 2)) + ` ${BOX.v}`);

      const childPipe = isLastProject ? TREE.space : TREE.pipe;
      for (let bi = 0; bi < project.branches.length; bi++) {
        const branch = project.branches[bi];
        const isLastBranch = bi === project.branches.length - 1;
        const branchPrefix = isLastBranch ? TREE.childLast : TREE.childBranch;
        const branchLine = `${BOX.v}   ${childPipe} ${branchPrefix} ${DIM}${branch}${RESET}`;
        lines.push(branchLine + ' '.repeat(Math.max(0, totalWidth - this.visLen(branchLine) - 2)) + ` ${BOX.v}`);
      }
    }

    return lines;
  }

  /**
   * Render the full table to a string (for testing and display).
   */
  renderTable(members: MemberDetail[], termWidth: number, termHeight: number): string {
    const { widths, showAdded } = this.computeColumnWidths(termWidth);
    const totalWidth = this.totalRowWidth(widths, showAdded);
    const visibleRows = termHeight - 6; // title + header + separator + footer + padding

    // Build all visual lines
    const allLines: string[] = [];
    for (let i = 0; i < members.length; i++) {
      allLines.push(this.renderRow(members[i], i, widths, showAdded));
      if (this.expandedIndices.has(i)) {
        allLines.push(...this.renderExpandedDetail(members[i], widths, showAdded));
      }
    }

    // Find the line index where the selected member's row starts
    let selectedLine = 0;
    for (let i = 0; i < this.selectedIndex; i++) {
      selectedLine++;
      if (this.expandedIndices.has(i)) {
        selectedLine += this.renderExpandedDetail(members[i], widths, showAdded).length;
      }
    }

    // Adjust scroll to keep selection visible
    if (selectedLine < this.scrollOffset) {
      this.scrollOffset = selectedLine;
    } else if (selectedLine >= this.scrollOffset + visibleRows) {
      this.scrollOffset = selectedLine - visibleRows + 1;
    }

    const visibleLines = allLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    // Build table
    const output: string[] = [];
    output.push('');
    output.push(`  Organization Members (${members.length} user${members.length !== 1 ? 's' : ''})`);
    output.push('');

    // Header
    const activeCols = showAdded ? COLUMNS : COLUMNS.filter(c => c.label !== 'Added');
    let headerTop = BOX.tl;
    let headerRow = BOX.v;
    let headerSep = BOX.tRight;
    for (let ci = 0; ci < activeCols.length; ci++) {
      const w = widths[ci];
      headerTop += BOX.h.repeat(w + 2) + (ci < activeCols.length - 1 ? BOX.tDown : BOX.tr);
      headerRow += ` ${this.pad(activeCols[ci].label, w)} ${BOX.v}`;
      headerSep += BOX.h.repeat(w + 2) + (ci < activeCols.length - 1 ? BOX.cross : BOX.tLeft);
    }
    output.push(headerTop);
    output.push(headerRow);
    output.push(headerSep);

    // Body
    for (const line of visibleLines) {
      output.push(line);
    }

    // Footer
    let footerRow = BOX.bl;
    for (let ci = 0; ci < activeCols.length; ci++) {
      const w = widths[ci];
      footerRow += BOX.h.repeat(w + 2) + (ci < activeCols.length - 1 ? BOX.tUp : BOX.br);
    }
    output.push(footerRow);
    output.push('');
    output.push(`  ${DIM}↑↓ navigate  Enter expand/collapse  q quit${RESET}`);

    return output.join('\n');
  }

  /**
   * Render a static (non-interactive) table for piped output.
   */
  renderStatic(members: MemberDetail[]): string {
    const termWidth = process.stdout.columns || 80;
    // Temporarily set no selection
    const savedIndex = this.selectedIndex;
    this.selectedIndex = -1;
    const table = this.renderTable(members, termWidth, members.length + 10);
    this.selectedIndex = savedIndex;
    // Remove the footer hint line
    const lines = table.split('\n');
    return lines.filter(l => !l.includes('navigate')).join('\n');
  }

  /**
   * Run the interactive TUI. Returns a promise that resolves when the user quits.
   */
  run(members: MemberDetail[]): Promise<void> {
    this.members = members;
    this.selectedIndex = 0;
    this.expandedIndices.clear();
    this.scrollOffset = 0;
    this.running = true;
    this.cleanedUp = false;

    return new Promise<void>((resolve) => {
      // Enter raw mode
      process.stdout.write(HIDE_CURSOR);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      this.draw();

      this.onDataHandler = (data: Buffer) => {
        this.handleKeypress(data, resolve);
      };
      process.stdin.on('data', this.onDataHandler);

      this.onResizeHandler = () => {
        this.draw();
      };
      process.on('SIGWINCH', this.onResizeHandler);

      // Cleanup handlers
      const exitHandler = () => {
        this.cleanup();
        resolve();
      };
      process.on('SIGINT', exitHandler);
      process.on('SIGTERM', exitHandler);
    });
  }

  private draw(): void {
    const termWidth = process.stdout.columns || 80;
    const termHeight = process.stdout.rows || 24;
    const output = this.renderTable(this.members, termWidth, termHeight);
    process.stdout.write(MOVE_HOME + CLEAR_BELOW + output);
  }

  private handleKeypress(data: Buffer, resolve: () => void): void {
    const key = data.toString();

    // Ctrl+C
    if (key === '\x03') {
      this.cleanup();
      resolve();
      return;
    }

    // q
    if (key === 'q' || key === 'Q') {
      this.cleanup();
      resolve();
      return;
    }

    // Arrow up
    if (key === `${ESC}[A`) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.draw();
      }
      return;
    }

    // Arrow down
    if (key === `${ESC}[B`) {
      if (this.selectedIndex < this.members.length - 1) {
        this.selectedIndex++;
        this.draw();
      }
      return;
    }

    // Enter — toggle expand/collapse
    if (key === '\r' || key === '\n') {
      if (this.expandedIndices.has(this.selectedIndex)) {
        this.expandedIndices.delete(this.selectedIndex);
      } else {
        this.expandedIndices.add(this.selectedIndex);
      }
      this.draw();
      return;
    }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.running = false;

    process.stdout.write(SHOW_CURSOR);
    process.stdout.write('\n');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    if (this.onDataHandler) {
      process.stdin.removeListener('data', this.onDataHandler);
    }
    if (this.onResizeHandler) {
      process.removeListener('SIGWINCH', this.onResizeHandler);
    }
  }

  // --- Helpers ---

  private totalRowWidth(widths: number[], showAdded: boolean): number {
    // Each cell: "│ " + content + " " = width + 3 per cell, plus final "│"
    const cols = showAdded ? widths.length : widths.length;
    return widths.reduce((sum, w) => sum + w + 3, 0) + 1;
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
  }

  private pad(str: string, width: number): string {
    if (str.length >= width) return str.slice(0, width);
    return str + ' '.repeat(width - str.length);
  }

  private formatDate(isoDate: string): string {
    if (!isoDate) return '—';
    try {
      const d = new Date(isoDate);
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    } catch {
      return '—';
    }
  }

  /** Visual length of a string (strips ANSI escape codes). */
  private visLen(str: string): number {
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }
}
