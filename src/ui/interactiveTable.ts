import { MemberDetail, MemberProject } from '../service/serviceClient';

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
const BOLD_WHITE = `${ESC}[1;97m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;

const ROLE_CHOICES = [
  { label: 'admin', value: 'admin' },
  { label: 'project-admin', value: 'project-admin' },
  { label: 'member', value: 'member' },
] as const;

type RoleValue = typeof ROLE_CHOICES[number]['value'];

// Which target roles each caller role may assign. Owner is never assignable
// here (single-owner invariant); the server enforces the same matrix.
const ASSIGNABLE_BY_CALLER: Record<string, ReadonlyArray<RoleValue>> = {
  owner: ['admin', 'project-admin', 'member'],
  admin: ['admin', 'project-admin', 'member'],
  'project-admin': ['project-admin', 'member'],
};

export interface ProjectChoice {
  id: string;
  name: string;
}

export interface TableContext {
  callerRole: string;
  listProjects: () => Promise<ProjectChoice[]>;
  changeRole: (userId: string, newRole: RoleValue, projectId?: string) => Promise<void>;
  reload: () => Promise<MemberDetail[]>;
  // Per-project role management (Flow B, Flow C).
  assignProjectRole: (projectId: string, email: string, role: 'project-admin' | 'member') => Promise<void>;
  removeProjectRole: (projectId: string, userId: string) => Promise<void>;
  // Per-branch protected-branch grants for member-scoped users (Flow E).
  grantProtectedBranch: (projectId: string, branchId: string, userId: string) => Promise<void>;
  revokeProtectedBranch: (projectId: string, branchId: string, userId: string) => Promise<void>;
}

// Options for the per-project-row in-cell editor (Flow C).
const PROJECT_ROLE_CHOICES: ReadonlyArray<'project-admin' | 'member' | 'none'> = [
  'project-admin',
  'member',
  'none',
];

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
  { label: 'Role', minWidth: 16 },
  { label: 'Added', minWidth: 12 },
  { label: 'Projects', minWidth: 8 },
];

export interface NavItem {
  type: 'member' | 'project' | 'branch';
  memberIndex: number;
  projectIndex?: number;
  branchIndex?: number;
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
  private ctx: TableContext | null = null;
  private editingMemberIndex: number | null = null;
  private editingRoleIndex = 0;
  // Flow C: editing a per-project role tag on an expanded project row.
  private editingProjectRef: { memberIndex: number; projectIndex: number } | null = null;
  private editingProjectRoleIndex = 0;
  private statusMessage: { text: string; isError: boolean } | null = null;
  // In-TUI multi-select project picker (Flow B).
  private projectPicker: {
    projects: ProjectChoice[];
    cursor: number;
    selected: Set<string>;
    resolve: (ids: string[] | null) => void;
    prompt: string;
  } | null = null;

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
            const project = member.projects[pi];
            if (project.branches.length > 0) {
              items.push({ type: 'project', memberIndex: mi, projectIndex: pi });
              // Branch rows are navigable when the project is expanded AND
              // the user holds the 'member' role on that project — that's the
              // only case 'g' (protected-branch grant) is meaningful on.
              const projKey = `${mi}-${pi}`;
              if (this.expandedProjects.has(projKey) && project.role === 'member') {
                for (let bi = 0; bi < project.branches.length; bi++) {
                  items.push({ type: 'branch', memberIndex: mi, projectIndex: pi, branchIndex: bi });
                }
              }
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
    memberIndex: number,
  ): string {
    const pointer = isExpanded ? '▾' : '▸';
    const prefix = isSelected ? pointer : ' ';
    const email = this.truncate(`${prefix} ${member.email}`, widths[0]);

    const isGreenRole = ALL_ACCESS_ROLES.includes(member.role);
    const isYellowRole = member.role === 'project-admin';
    const isEditing = this.editingMemberIndex === memberIndex;

    let row = this.pad(email, widths[0]);

    if (isEditing) {
      const choices = this.assignableRoles(member.role);
      const editingRole = choices[this.editingRoleIndex] ?? member.role;
      row += GAP + INVERSE + this.pad(`◆ ${editingRole}`, widths[1]) + RESET;
    } else if (isGreenRole) {
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
    selectedBranchRef: { projectIndex: number; branchIndex: number } | null = null,
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
      const roleTag = this.formatProjectRoleTag(memberIndex, pi, project);

      if (hasBranches) {
        const projKey = `${memberIndex}-${pi}`;
        const isExpanded = this.expandedProjects.has(projKey);
        const isSelected = selectedProjectOrigIdx === pi;
        const pointer = isExpanded ? '▾' : '▸';
        const projLine = `    ${pointer} ${project.name}${roleTag}`;

        if (isSelected) {
          lines.push(`${INVERSE}${this.padToWidth(projLine, totalWidth)}${RESET}`);
        } else {
          lines.push(projLine);
        }

        if (isExpanded) {
          for (let bi = 0; bi < project.branches.length; bi++) {
            const branch = project.branches[bi];
            const suffix = this.branchSuffix(branch, project.role);
            const branchLine = `        ${branch.name}${suffix}`;
            const isBranchSelected =
              selectedBranchRef !== null &&
              selectedBranchRef.projectIndex === pi &&
              selectedBranchRef.branchIndex === bi;
            if (isBranchSelected) {
              lines.push(`${INVERSE}${this.padToWidth(branchLine, totalWidth)}${RESET}`);
            } else {
              lines.push(`${DIM}${branchLine}${RESET}`);
            }
          }
        }
      } else {
        lines.push(`    ${DIM}${project.name}${roleTag}${RESET}`);
      }
    }

    return lines;
  }

  private formatProjectRoleTag(
    memberIndex: number,
    projectIndex: number,
    project: MemberProject,
  ): string {
    const isEditingThis =
      this.editingProjectRef !== null &&
      this.editingProjectRef.memberIndex === memberIndex &&
      this.editingProjectRef.projectIndex === projectIndex;
    if (isEditingThis) {
      const value = PROJECT_ROLE_CHOICES[this.editingProjectRoleIndex];
      return `  ${INVERSE}◆ ${value}${RESET}`;
    }
    if (project.role === 'project-admin') return '  project-admin';
    if (project.role === 'member') return '  member';
    return '';
  }

  private branchSuffix(
    branch: { isProtected: boolean; hasAccess: boolean },
    projectRole: MemberProject['role'],
  ): string {
    if (!branch.isProtected) return '';
    // Only 'member'-role projects surface the granular grant status; admins
    // always have access to every branch.
    if (projectRole === 'project-admin') return ' (protected)';
    return branch.hasAccess ? ' (protected)' : ' (protected, no access)';
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

      allLines.push(this.renderMemberRow(member, isSelected, isExpanded, widths, showAdded, totalWidth, mi));

      if (isExpanded) {
        // Find if cursor is on a project or branch row under this member.
        let selectedProjOrigIdx: number | null = null;
        let selectedBranchRef: { projectIndex: number; branchIndex: number } | null = null;
        const curNav = navItems[this.cursorIndex];
        if (curNav?.type === 'project' && curNav.memberIndex === mi) {
          selectedProjOrigIdx = curNav.projectIndex!;
        } else if (curNav?.type === 'branch' && curNav.memberIndex === mi) {
          selectedBranchRef = { projectIndex: curNav.projectIndex!, branchIndex: curNav.branchIndex! };
        }

        if (selectedProjOrigIdx !== null || selectedBranchRef !== null) {
          // Compute the visible-line offset that matches renderExpandedDetail's output.
          let lineOffset = 0;
          for (let pi = 0; pi < member.projects.length; pi++) {
            const proj = member.projects[pi];
            if (selectedProjOrigIdx === pi) {
              cursorLineIndex = allLines.length + lineOffset;
              break;
            }
            lineOffset++; // project line (both branched and branchless emit one line)
            const pExpanded = proj.branches.length > 0 && this.expandedProjects.has(`${mi}-${pi}`);
            if (selectedBranchRef !== null && selectedBranchRef.projectIndex === pi) {
              cursorLineIndex = allLines.length + lineOffset + selectedBranchRef.branchIndex;
              break;
            }
            if (pExpanded) {
              lineOffset += proj.branches.length;
            }
          }
        }

        allLines.push(...this.renderExpandedDetail(member, mi, totalWidth, selectedProjOrigIdx, selectedBranchRef));
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
    let footer: string;
    if (this.projectPicker) {
      footer = `${DIM}↑↓ navigate  ${RESET}${BOLD_WHITE}Space${RESET}${DIM} select  ${RESET}${BOLD_WHITE}Enter${RESET}${DIM} confirm  ${RESET}${BOLD_WHITE}Esc${RESET}${DIM} cancel${RESET}`;
    } else if (this.editingMemberIndex !== null || this.editingProjectRef !== null) {
      footer = `${DIM}↑↓ pick role  ${RESET}${BOLD_WHITE}Enter${RESET}${DIM} confirm  ${RESET}${BOLD_WHITE}Esc${RESET}${DIM} cancel${RESET}`;
    } else {
      footer = `${DIM}↑↓ navigate  Enter expand/collapse  ${RESET}${BOLD_WHITE}r${RESET}${DIM} change role  ${RESET}${BOLD_WHITE}g${RESET}${DIM} grant protected  ${RESET}${BOLD_WHITE}q${RESET}${DIM} quit${RESET}`;
    }
    output.push(`${m} ${footer}`);
    if (this.statusMessage) {
      const color = this.statusMessage.isError ? RED : GREEN;
      output.push(`${m} ${color}${this.statusMessage.text}${RESET}`);
    }

    if (this.projectPicker) {
      output.push('');
      output.push(`${m}${this.projectPicker.prompt}`);
      for (let i = 0; i < this.projectPicker.projects.length; i++) {
        const p = this.projectPicker.projects[i];
        const atCursor = i === this.projectPicker.cursor;
        const checked = this.projectPicker.selected.has(p.id);
        const mark = checked ? '[x]' : '[ ]';
        const line = `${m}  ${mark} ${p.name}`;
        output.push(atCursor ? `${INVERSE}${this.padToWidth(line, totalWidth)}${RESET}` : line);
      }
    }

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

  run(members: MemberDetail[], ctx?: TableContext): Promise<void> {
    this.members = members;
    this.ctx = ctx ?? null;
    this.cursorIndex = 0;
    this.expandedMembers.clear();
    this.expandedProjects.clear();
    this.scrollOffset = 0;
    this.running = true;
    this.cleanedUp = false;
    this.editingMemberIndex = null;
    this.editingProjectRef = null;
    this.editingProjectRoleIndex = 0;
    this.statusMessage = null;

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

    // Project picker has highest priority — absorbs all keys while open.
    if (this.projectPicker) {
      this.handleProjectPickerKey(key);
      return;
    }

    // Role editor mode takes priority over the table navigation.
    if (this.editingMemberIndex !== null) {
      this.handleEditorKey(key);
      return;
    }
    if (this.editingProjectRef !== null) {
      this.handleProjectEditorKey(key);
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

    // 'r' — enter role editor. Member row edits WorkOS role; project row
    // (Flow C) edits the per-project membership role.
    if (key === 'r' || key === 'R') {
      const item = navItems[this.cursorIndex];
      if (!item || !this.ctx) return;
      if (item.type === 'member') {
        const target = this.members[item.memberIndex];
        const callerRole = this.ctx.callerRole;
        if (!ASSIGNABLE_BY_CALLER[callerRole]) {
          this.statusMessage = { text: 'You do not have permission to change roles', isError: true };
          this.draw();
          return;
        }
        if (target.role === 'owner') {
          this.statusMessage = { text: "The owner's role cannot be changed", isError: true };
          this.draw();
          return;
        }
        if (this.assignableRoles(target.role).length === 0) {
          this.statusMessage = {
            text: `You cannot change ${target.email}'s role (${target.role})`,
            isError: true,
          };
          this.draw();
          return;
        }
        this.editingMemberIndex = item.memberIndex;
        this.editingRoleIndex = this.roleIndexFor(target.role, this.assignableRoles(target.role));
        this.statusMessage = null;
        this.draw();
        return;
      }
      if (item.type === 'project') {
        const project = this.members[item.memberIndex].projects[item.projectIndex!];
        this.editingProjectRef = { memberIndex: item.memberIndex, projectIndex: item.projectIndex! };
        const currentIdx = PROJECT_ROLE_CHOICES.indexOf(
          (project.role as 'project-admin' | 'member') ?? 'none',
        );
        this.editingProjectRoleIndex = currentIdx >= 0 ? currentIdx : 0;
        this.statusMessage = null;
        this.draw();
        return;
      }
    }

    // 'g' — toggle protected-branch grant on a branch row (Flow E).
    if (key === 'g' || key === 'G') {
      const item = navItems[this.cursorIndex];
      if (!item || item.type !== 'branch' || !this.ctx) return;
      void this.toggleBranchGrant(item.memberIndex, item.projectIndex!, item.branchIndex!);
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

  private assignableRoles(targetRole?: string): ReadonlyArray<RoleValue> {
    const callerRole = this.ctx?.callerRole ?? '';
    const base = ASSIGNABLE_BY_CALLER[callerRole] ?? [];
    if (!targetRole) return base;
    // Project-admins cannot act on org-level admins or the owner.
    if (callerRole === 'project-admin' && (targetRole === 'admin' || targetRole === 'owner')) {
      return [];
    }
    // Nobody changes the owner via this endpoint (server enforces too).
    if (targetRole === 'owner') return [];
    return base;
  }

  private roleIndexFor(role: string, choices: ReadonlyArray<RoleValue>): number {
    const idx = choices.indexOf(role as RoleValue);
    return idx >= 0 ? idx : 0;
  }

  private handleEditorKey(key: string): void {
    const target = this.editingMemberIndex !== null ? this.members[this.editingMemberIndex] : null;
    const choices = this.assignableRoles(target?.role);
    if (choices.length === 0) return;
    if (key === `${ESC}[A`) {
      this.editingRoleIndex = (this.editingRoleIndex - 1 + choices.length) % choices.length;
      this.draw();
      return;
    }
    if (key === `${ESC}[B`) {
      this.editingRoleIndex = (this.editingRoleIndex + 1) % choices.length;
      this.draw();
      return;
    }
    // Esc (raw) — cancel
    if (key === ESC || key === `${ESC}\x1b`) {
      this.editingMemberIndex = null;
      this.draw();
      return;
    }
    if (key === '\r' || key === '\n') {
      void this.commitRoleChange();
    }
  }

  private handleProjectPickerKey(key: string): void {
    if (!this.projectPicker) return;
    const { projects } = this.projectPicker;
    if (key === `${ESC}[A`) {
      this.projectPicker.cursor = (this.projectPicker.cursor - 1 + projects.length) % projects.length;
      this.draw();
      return;
    }
    if (key === `${ESC}[B`) {
      this.projectPicker.cursor = (this.projectPicker.cursor + 1) % projects.length;
      this.draw();
      return;
    }
    if (key === ' ') {
      const current = projects[this.projectPicker.cursor];
      if (current) {
        if (this.projectPicker.selected.has(current.id)) {
          this.projectPicker.selected.delete(current.id);
        } else {
          this.projectPicker.selected.add(current.id);
        }
      }
      this.draw();
      return;
    }
    if (key === ESC || key === `${ESC}\x1b`) {
      const { resolve } = this.projectPicker;
      this.projectPicker = null;
      resolve(null);
      this.draw();
      return;
    }
    if (key === '\r' || key === '\n') {
      const { resolve, selected } = this.projectPicker;
      const chosen = Array.from(selected);
      this.projectPicker = null;
      resolve(chosen);
      this.draw();
    }
  }

  private async pickProjectsInline(
    prompt: string,
    initialSelected: Set<string> = new Set(),
  ): Promise<string[] | null> {
    if (!this.ctx) return null;
    const projects = await this.ctx.listProjects();
    if (projects.length === 0) {
      throw new Error('No projects exist in this organization — create one before assigning a scoped role.');
    }
    return new Promise<string[] | null>((resolve) => {
      this.projectPicker = {
        projects,
        cursor: 0,
        selected: new Set(initialSelected),
        resolve,
        prompt,
      };
      this.draw();
    });
  }

  private async commitRoleChange(): Promise<void> {
    if (this.editingMemberIndex === null || !this.ctx) return;
    const member = this.members[this.editingMemberIndex];
    const choices = this.assignableRoles(member.role);
    if (choices.length === 0) return;
    const newRole = choices[this.editingRoleIndex] as RoleValue;
    const isScoped = newRole === 'project-admin' || newRole === 'member';

    this.editingMemberIndex = null;
    this.statusMessage = { text: `Updating ${member.email}…`, isError: false };
    this.draw();

    // Non-scoped role change (admin): single-shot.
    if (!isScoped) {
      if (newRole === member.role) {
        this.statusMessage = null;
        this.draw();
        return;
      }
      try {
        await this.ctx.changeRole(member.userId, newRole);
        await this.refreshAfterMutation(member.userId);
        this.statusMessage = { text: `${member.email} → ${newRole}`, isError: false };
      } catch (err: any) {
        this.statusMessage = { text: `Error: ${err.message || err}`, isError: true };
      }
      this.draw();
      return;
    }

    // Scoped role change: multi-select picker. Pre-check projects already at
    // this target role for this user.
    const existingAtTarget = new Set(
      member.projects
        .filter((p) => p.role === newRole)
        .map((p) => p.id),
    );

    let chosen: string[] | null;
    try {
      chosen = await this.pickProjectsInline(
        `Assign ${newRole} on which projects?`,
        existingAtTarget,
      );
    } catch (err: any) {
      this.statusMessage = { text: `Error: ${err.message || err}`, isError: true };
      this.draw();
      return;
    }
    if (!chosen) {
      this.statusMessage = { text: 'Cancelled', isError: false };
      this.draw();
      return;
    }

    const chosenSet = new Set(chosen);
    const toAdd = chosen.filter((pid) => !existingAtTarget.has(pid));
    const toRemove = Array.from(existingAtTarget).filter((pid) => !chosenSet.has(pid));

    if (toAdd.length === 0 && toRemove.length === 0 && newRole === member.role) {
      this.statusMessage = null;
      this.draw();
      return;
    }

    // If the user's current role is not the target scoped role (e.g. admin →
    // member), or there are no existing memberships, we have to call changeRole
    // at least once to flip the WorkOS role. Pair it with the first add if we
    // have one; otherwise drop through and just call changeRole with the first
    // remaining project (if any).
    const errors: string[] = [];
    let successCount = 0;
    const workosRoleNeedsFlip = member.role !== newRole;

    try {
      if (workosRoleNeedsFlip) {
        const firstProject = toAdd.shift() ?? Array.from(chosenSet)[0];
        if (!firstProject) {
          throw new Error('Pick at least one project');
        }
        await this.ctx.changeRole(member.userId, newRole, firstProject);
        successCount++;
      }
    } catch (err: any) {
      errors.push(err.message || String(err));
    }

    for (const pid of toAdd) {
      try {
        await this.ctx.assignProjectRole(pid, member.email, newRole);
        successCount++;
      } catch (err: any) {
        errors.push(err.message || String(err));
      }
    }

    for (const pid of toRemove) {
      try {
        await this.ctx.removeProjectRole(pid, member.userId);
        successCount++;
      } catch (err: any) {
        errors.push(err.message || String(err));
      }
    }

    await this.refreshAfterMutation(member.userId);

    if (errors.length === 0) {
      const total = successCount;
      this.statusMessage = { text: `Updated ${total} project${total === 1 ? '' : 's'} for ${member.email}`, isError: false };
    } else if (successCount === 0) {
      this.statusMessage = { text: `Error: ${errors[errors.length - 1]}`, isError: true };
    } else {
      this.statusMessage = {
        text: `${errors.length} of ${successCount + errors.length} updates failed: ${errors[errors.length - 1]}`,
        isError: true,
      };
    }
    this.draw();
  }

  private handleProjectEditorKey(key: string): void {
    if (this.editingProjectRef === null) return;
    if (key === `${ESC}[A`) {
      this.editingProjectRoleIndex =
        (this.editingProjectRoleIndex - 1 + PROJECT_ROLE_CHOICES.length) % PROJECT_ROLE_CHOICES.length;
      this.draw();
      return;
    }
    if (key === `${ESC}[B`) {
      this.editingProjectRoleIndex = (this.editingProjectRoleIndex + 1) % PROJECT_ROLE_CHOICES.length;
      this.draw();
      return;
    }
    if (key === ESC || key === `${ESC}\x1b`) {
      this.editingProjectRef = null;
      this.draw();
      return;
    }
    if (key === '\r' || key === '\n') {
      void this.commitProjectRoleChange();
    }
  }

  private async commitProjectRoleChange(): Promise<void> {
    if (this.editingProjectRef === null || !this.ctx) return;
    const { memberIndex, projectIndex } = this.editingProjectRef;
    const member = this.members[memberIndex];
    const project = member.projects[projectIndex];
    const newChoice = PROJECT_ROLE_CHOICES[this.editingProjectRoleIndex];

    this.editingProjectRef = null;
    this.statusMessage = { text: `Updating ${member.email} on ${project.name}…`, isError: false };
    this.draw();

    try {
      if (newChoice === 'none') {
        await this.ctx.removeProjectRole(project.id, member.userId);
      } else if (newChoice === project.role) {
        // No-op: keep current role.
      } else {
        await this.ctx.assignProjectRole(project.id, member.email, newChoice);
      }
      await this.refreshAfterMutation(member.userId);
      this.statusMessage = {
        text: `${member.email} on ${project.name} → ${newChoice}`,
        isError: false,
      };
    } catch (err: any) {
      this.statusMessage = { text: `Error: ${err.message || err}`, isError: true };
    }
    this.draw();
  }

  private async toggleBranchGrant(
    memberIndex: number,
    projectIndex: number,
    branchIndex: number,
  ): Promise<void> {
    if (!this.ctx) return;
    const member = this.members[memberIndex];
    const project = member.projects[projectIndex];
    const branch = project.branches[branchIndex];
    if (project.role !== 'member' || !branch.isProtected) {
      return; // silent no-op
    }
    // Branch id is not in the client payload; derive via project+branch name:
    // the server endpoint takes branch id, which we don't have on the client
    // today. MemberDetail.projects[].branches only carries name. We need to
    // look up the branch id via a service call.
    this.statusMessage = {
      text: branch.hasAccess
        ? `Revoking ${member.email} from ${project.name}/${branch.name}…`
        : `Granting ${member.email} on ${project.name}/${branch.name}…`,
      isError: false,
    };
    this.draw();

    try {
      if (branch.hasAccess) {
        await this.ctx.revokeProtectedBranch(project.id, branch.id, member.userId);
      } else {
        await this.ctx.grantProtectedBranch(project.id, branch.id, member.userId);
      }
      await this.refreshAfterMutation(member.userId);
      this.statusMessage = {
        text: `${member.email}: ${project.name}/${branch.name} ${branch.hasAccess ? 'revoked' : 'granted'}`,
        isError: false,
      };
    } catch (err: any) {
      this.statusMessage = { text: `Error: ${err.message || err}`, isError: true };
    }
    this.draw();
  }

  private async refreshAfterMutation(userId: string): Promise<void> {
    if (!this.ctx) return;
    const refreshed = await this.ctx.reload();
    this.members = refreshed;
    const newIdx = refreshed.findIndex((m) => m.userId === userId);
    if (newIdx >= 0) {
      const navItems = this.buildNavItems();
      const navPos = navItems.findIndex((n) => n.type === 'member' && n.memberIndex === newIdx);
      if (navPos >= 0) this.cursorIndex = navPos;
    } else {
      this.cursorIndex = Math.min(this.cursorIndex, this.buildNavItems().length - 1);
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
