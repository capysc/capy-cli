import { MemberDetail } from '../service/serviceClient';

// ANSI escape codes
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
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;

const MARGIN = 2;
const GAP = '   ';
const ALL_ACCESS_ROLES = ['owner', 'admin', 'org-admin'];

interface ColumnConfig {
  label: string;
  minWidth: number;
  flex?: boolean;
}

const COLUMNS: ColumnConfig[] = [
  { label: 'Email', minWidth: 20, flex: true },
  { label: 'Role', minWidth: 8 },
  { label: 'Added', minWidth: 12 },
  { label: 'Projects', minWidth: 8 },
];

export interface NavItem {
  type: 'member' | 'project';
  memberIndex: number;
  projectIndex?: number;
}

export class InteractiveTable {
  private members: MemberDetail[] = [];
  private cursorIndex = 0;
  private expandedMembers = new Set<number>();
  private expandedProjects = new Set<string>();
  private scrollOffset = 0;
  private running = false;
  private onDataHandler: ((data: Buffer) => void) | null = null;
  private onResizeHandler: (() => void) | null = null;
  private cleanedUp = false;

  computeColumnWidths(termWidth: number): { widths: number[]; showAdded: boolean } {
    const available = Math.min(termWidth, 130) - MARGIN * 2;
    const showAdded = available >= 60;
    const cols = showAdded ? COLUMNS : COLUMNS.filter(c => c.label !== 'Added');

    const fixedTotal = cols.filter(c => !c.flex).reduce((sum, c) => sum + c.minWidth, 0);
    const gapTotal = (cols.length - 1) * GAP.length;

    const flexWidth = Math.max(
      cols.find(c => c.flex)?.minWidth || 20,
      available - fixedTotal - gapTotal,
    );

    return {
      widths: cols.map(c => c.flex ? flexWidth : c.minWidth),
      showAdded,
    };
  }

  buildNavItems(): NavItem[] {
    const items: NavItem[] = [];
    for (let mi = 0; mi < this.members.length; mi++) {
      items.push({ type: 'member', memberIndex: mi });
      if (this.expandedMembers.has(mi)) {
        const member = this.members[mi];
        if (!ALL_ACCESS_ROLES.includes(member.role)) {
          for (let pi = 0; pi < member.projects.length; pi++) {
            if (member.projects[pi].branches.length > 0) {
              items.push({ type: 'project', memberIndex: mi, projectIndex: pi });
            }
          }
        }
      }
    }
    return items;
  }

  renderMemberRow(
    member: MemberDetail,
    isSelected: boolean,
    isExpanded: boolean,
    widths: number[],
    showAdded: boolean,
    totalWidth: number,
  ): string {
    const pointer = isExpanded ? '▾' : '▸';
    const prefix = isSelected ? pointer : ' ';
    const email = this.truncate(`${prefix} ${member.email}`, widths[0]);

    const isGreenRole = ALL_ACCESS_ROLES.includes(member.role);
    const isYellowRole = member.role === 'project-admin';

    let row = this.pad(email, widths[0]);

    if (isGreenRole) {
      row += '  ' + GREEN + ' ' + this.pad(member.role, widths[1]) + RESET;
    } else if (isYellowRole) {
      row += GAP + YELLOW + this.pad(member.role, widths[1]) + RESET;
    } else {
      row += GAP + this.pad(member.role, widths[1]);
    }

    if (showAdded) {
      row += GAP + this.pad(this.formatDate(member.createdAt), widths[2]);
    }

    const projIdx = showAdded ? 3 : 2;
    row += GAP + this.pad(String(member.projects.length), widths[projIdx]);

    if (isSelected) {
      return `${INVERSE}${this.padToWidth(row, totalWidth)}${RESET}`;
    }
    return row;
  }

  renderExpandedDetail(
    member: MemberDetail,
    memberIndex: number,
    totalWidth: number,
    selectedProjectOrigIdx: number | null,
  ): string[] {
    const lines: string[] = [];

    if (ALL_ACCESS_ROLES.includes(member.role)) {
      lines.push(`    ${DIM}Access to all branches${RESET}`);
      return lines;
    }

    if (member.projects.length === 0) {
      lines.push(`    ${DIM}No project access${RESET}`);
      return lines;
    }

    for (let pi = 0; pi < member.projects.length; pi++) {
      const project = member.projects[pi];
      const hasBranches = project.branches.length > 0;

      if (hasBranches) {
        const projKey = `${memberIndex}-${pi}`;
        const isExpanded = this.expandedProjects.has(projKey);
        const isSelected = selectedProjectOrigIdx === pi;
        const pointer = isExpanded ? '▾' : '▸';
        const projLine = `    ${pointer} ${project.name}`;

        if (isSelected) {
          lines.push(`${INVERSE}${this.padToWidth(projLine, totalWidth)}${RESET}`);
        } else {
          lines.push(projLine);
        }

        if (isExpanded) {
          for (const branch of project.branches) {
            lines.push(`        ${DIM}${branch}${RESET}`);
          }
        }
      } else {
        lines.push(`    ${DIM}${project.name}${RESET}`);
      }
    }

    return lines;
  }

  renderTable(members: MemberDetail[], termWidth: number, termHeight: number): string {
    const { widths, showAdded } = this.computeColumnWidths(termWidth);
    const activeCols = showAdded ? COLUMNS : COLUMNS.filter(c => c.label !== 'Added');
    const totalWidth = widths.reduce((sum, w) => sum + w, 0) + (activeCols.length - 1) * GAP.length;
    const visibleRows = termHeight - 6;

    const navItems = this.buildNavItems();

    // Build all visual lines
    const allLines: string[] = [];
    let cursorLineIndex = 0;

    for (let mi = 0; mi < members.length; mi++) {
      const member = members[mi];
      const memberNavIdx = navItems.findIndex(n => n.type === 'member' && n.memberIndex === mi);
      const isSelected = memberNavIdx === this.cursorIndex;
      const isExpanded = this.expandedMembers.has(mi);

      if (isSelected) cursorLineIndex = allLines.length;

      allLines.push(this.renderMemberRow(member, isSelected, isExpanded, widths, showAdded, totalWidth));

      if (isExpanded) {
        // Find if cursor is on a project under this member
        let selectedProjOrigIdx: number | null = null;
        const curNav = navItems[this.cursorIndex];
        if (curNav?.type === 'project' && curNav.memberIndex === mi) {
          selectedProjOrigIdx = curNav.projectIndex!;
          // Find line index for this project, matching renderExpandedDetail output order
          let lineOffset = 0;
          for (let pi = 0; pi < member.projects.length; pi++) {
            const proj = member.projects[pi];
            if (pi === selectedProjOrigIdx) {
              cursorLineIndex = allLines.length + lineOffset;
              break;
            }
            lineOffset++; // project line (both branched and branchless emit one line)
            if (proj.branches.length > 0 && this.expandedProjects.has(`${mi}-${pi}`)) {
              lineOffset += proj.branches.length;
            }
          }
        }

        allLines.push(...this.renderExpandedDetail(member, mi, totalWidth, selectedProjOrigIdx));
      }
    }

    // Adjust scroll to keep selection visible
    if (cursorLineIndex < this.scrollOffset) {
      this.scrollOffset = cursorLineIndex;
    } else if (cursorLineIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = cursorLineIndex - visibleRows + 1;
    }

    const visibleLines = allLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    // Build output
    const m = ' '.repeat(MARGIN);
    const rule = '─'.repeat(totalWidth);
    const output: string[] = [];
    output.push('');
    output.push(`${m}Organization Members (${members.length} user${members.length !== 1 ? 's' : ''})`);
    output.push('');

    // Header
    let headerRow = '';
    for (let ci = 0; ci < activeCols.length; ci++) {
      if (ci > 0) headerRow += GAP;
      headerRow += this.pad(activeCols[ci].label, widths[ci]);
    }
    output.push(m + headerRow);
    output.push(m + rule);

    // Body
    for (const line of visibleLines) {
      output.push(m + line);
    }

    // Footer
    output.push(m + rule);
    output.push('');
    output.push(`${m} ${DIM}↑↓ navigate  Enter expand/collapse  q quit${RESET}`);

    return output.map(line => line + CLEAR_EOL).join('\n');
  }

  renderStatic(members: MemberDetail[]): string {
    const termWidth = process.stdout.columns || 80;
    const savedCursor = this.cursorIndex;
    this.cursorIndex = -1;
    const table = this.renderTable(members, termWidth, members.length + 20);
    this.cursorIndex = savedCursor;
    const lines = table.split('\n');
    return lines.filter(l => !l.includes('navigate')).join('\n');
  }

  run(members: MemberDetail[]): Promise<void> {
    this.members = members;
    this.cursorIndex = 0;
    this.expandedMembers.clear();
    this.expandedProjects.clear();
    this.scrollOffset = 0;
    this.running = true;
    this.cleanedUp = false;

    return new Promise<void>((resolve) => {
      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
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
    process.stdout.write(CLEAR_SCREEN + MOVE_HOME + output);
  }

  private handleKeypress(data: Buffer, resolve: () => void): void {
    const key = data.toString();

    if (key === '\x03') {
      this.cleanup();
      resolve();
      return;
    }

    if (key === 'q' || key === 'Q') {
      this.cleanup();
      resolve();
      return;
    }

    const navItems = this.buildNavItems();

    // Arrow up
    if (key === `${ESC}[A`) {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
        this.draw();
      }
      return;
    }

    // Arrow down
    if (key === `${ESC}[B`) {
      if (this.cursorIndex < navItems.length - 1) {
        this.cursorIndex++;
        this.draw();
      }
      return;
    }

    // Enter — toggle expand/collapse
    if (key === '\r' || key === '\n') {
      const item = navItems[this.cursorIndex];
      if (!item) return;

      if (item.type === 'member') {
        if (this.expandedMembers.has(item.memberIndex)) {
          this.expandedMembers.delete(item.memberIndex);
          // Clean up any expanded projects under this member
          for (const key of this.expandedProjects) {
            if (key.startsWith(`${item.memberIndex}-`)) {
              this.expandedProjects.delete(key);
            }
          }
        } else {
          this.expandedMembers.add(item.memberIndex);
        }
      } else if (item.type === 'project') {
        const projKey = `${item.memberIndex}-${item.projectIndex}`;
        if (this.expandedProjects.has(projKey)) {
          this.expandedProjects.delete(projKey);
        } else {
          this.expandedProjects.add(projKey);
        }
      }

      // Clamp cursor after nav items change
      const newNavItems = this.buildNavItems();
      this.cursorIndex = Math.min(this.cursorIndex, newNavItems.length - 1);

      this.draw();
      return;
    }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.running = false;

    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
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

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
  }

  private pad(str: string, width: number): string {
    if (str.length >= width) return str.slice(0, width);
    return str + ' '.repeat(width - str.length);
  }

  private padToWidth(str: string, totalWidth: number): string {
    const vis = this.visLen(str);
    if (vis >= totalWidth) return str;
    return str + ' '.repeat(totalWidth - vis);
  }

  private formatDate(isoDate: string): string {
    if (!isoDate) return '—';
    try {
      const d = new Date(isoDate);
      return d.toISOString().slice(0, 10);
    } catch {
      return '—';
    }
  }

  private visLen(str: string): number {
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }
}
