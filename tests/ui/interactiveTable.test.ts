import { InteractiveTable } from '../../src/ui/interactiveTable';
import { MemberDetail, MemberProjectBranch } from '../../src/service/serviceClient';

function branch(name: string, isProtected = false, hasAccess = true): MemberProjectBranch {
  return { id: `branch-${name}`, name, isProtected, hasAccess };
}

function makeMember(overrides: any = {}): MemberDetail {
  // Tests historically pass branches as string[]. Normalize to the new object
  // shape so individual test cases stay concise.
  const normalizeProjects = (projects: any[]) =>
    projects.map((p) => ({
      ...p,
      branches: (p.branches || []).map((b: any) =>
        typeof b === 'string' ? branch(b) : b,
      ),
    }));

  const base: MemberDetail = {
    membershipId: 'mem-1',
    userId: 'user-1',
    email: 'alice@acme.com',
    role: 'owner',
    status: 'active',
    createdAt: '2025-01-15T00:00:00Z',
    projects: [
      { id: 'proj-1', name: 'api-backend', branches: [branch('main'), branch('staging')] },
      { id: 'proj-2', name: 'web-frontend', branches: [branch('main')] },
    ],
  };
  const merged: MemberDetail = { ...base, ...overrides };
  if (overrides.projects) {
    merged.projects = normalizeProjects(overrides.projects);
  }
  return merged;
}

const MEMBERS: MemberDetail[] = [
  makeMember(),
  makeMember({
    membershipId: 'mem-2',
    userId: 'user-2',
    email: 'bob@acme.com',
    role: 'member',
    createdAt: '2025-02-03T00:00:00Z',
    projects: [{ id: 'proj-1', name: 'api-backend', branches: ['main'] }],
  }),
  makeMember({
    membershipId: 'mem-3',
    userId: 'user-3',
    email: 'carol@acme.com',
    role: 'admin',
    createdAt: '2025-03-10T00:00:00Z',
    projects: [
      { id: 'proj-1', name: 'api-backend', branches: ['main'] },
      { id: 'proj-2', name: 'web-frontend', branches: ['main'] },
    ],
  }),
];

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[mKJH]/g, '');
}

describe('InteractiveTable', () => {
  let table: InteractiveTable;

  beforeEach(() => {
    table = new InteractiveTable();
  });

  describe('computeColumnWidths', () => {
    it('shows Added column when terminal >= 60 (accounting for margin)', () => {
      const result = table.computeColumnWidths(120);
      expect(result.showAdded).toBe(true);
      expect(result.widths).toHaveLength(4);
    });

    it('hides Added column when effective width < 60', () => {
      const result = table.computeColumnWidths(50);
      expect(result.showAdded).toBe(false);
      expect(result.widths).toHaveLength(3);
    });

    it('flex column gets remaining space at 80 cols', () => {
      const result = table.computeColumnWidths(80);
      expect(result.widths[0]).toBeGreaterThan(20);
    });

    it('flex column is at least minWidth for very narrow terminals', () => {
      const result = table.computeColumnWidths(30);
      expect(result.widths[0]).toBeGreaterThanOrEqual(20);
    });
  });

  describe('renderMemberRow', () => {
    it('renders selected row with pointer', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const totalWidth = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
      const output = table.renderMemberRow(MEMBERS[0], true, false, widths, showAdded, totalWidth);
      const plain = stripAnsi(output);
      expect(plain).toContain('▸');
      expect(plain).toContain('alice@acme.com');
      expect(plain).toContain('owner');
      expect(plain).toContain('2025-01-15');
    });

    it('renders non-selected row without pointer', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const totalWidth = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
      const output = table.renderMemberRow(MEMBERS[1], false, false, widths, showAdded, totalWidth);
      const plain = stripAnsi(output);
      expect(plain).not.toContain('▸');
      expect(plain).toContain('bob@acme.com');
      expect(plain).toContain('member');
    });

    it('renders green indicator space for owner/admin roles', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const totalWidth = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
      const output = table.renderMemberRow(MEMBERS[0], false, false, widths, showAdded, totalWidth);
      // Green space before "owner": 2 gap spaces + GREEN + space + owner
      expect(output).toContain('\x1b[32m owner');
    });

    it('does not render green indicator for non-admin roles', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const totalWidth = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
      const output = table.renderMemberRow(MEMBERS[1], false, false, widths, showAdded, totalWidth);
      expect(output).not.toContain('\x1b[32m');
    });

    it('has no vertical border characters', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const totalWidth = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
      const output = table.renderMemberRow(MEMBERS[0], false, false, widths, showAdded, totalWidth);
      const plain = stripAnsi(output);
      expect(plain).not.toContain('│');
    });
  });

  describe('renderExpandedDetail', () => {
    it('shows "Access to all branches" for owner role', () => {
      const lines = table.renderExpandedDetail(MEMBERS[0], 0, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('Access to all branches');
      expect(plain).not.toContain('api-backend');
    });

    it('shows "Access to all branches" for admin role', () => {
      const lines = table.renderExpandedDetail(MEMBERS[2], 2, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('Access to all branches');
    });

    it('shows collapsible projects for member role', () => {
      const lines = table.renderExpandedDetail(MEMBERS[1], 1, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('▸');
      expect(plain).toContain('api-backend');
    });

    it('shows "No project access" for empty projects', () => {
      const noAccess = makeMember({ role: 'member', projects: [] });
      const lines = table.renderExpandedDetail(noAccess, 0, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('No project access');
    });

    it('shows branchless projects as plain text (not collapsible)', () => {
      const mixed = makeMember({
        role: 'member',
        projects: [
          { id: 'proj-1', name: 'has-branches', branches: ['main'] },
          { id: 'proj-2', name: 'no-branches', branches: [] },
        ],
      });
      const lines = table.renderExpandedDetail(mixed, 0, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('has-branches');
      expect(plain).toContain('no-branches');
      // has-branches should have a collapsible pointer, no-branches should not
      const hasBranchesLine = lines.find(l => stripAnsi(l).includes('has-branches'))!;
      const noBranchesLine = lines.find(l => stripAnsi(l).includes('no-branches'))!;
      expect(stripAnsi(hasBranchesLine)).toContain('▸');
      expect(stripAnsi(noBranchesLine)).not.toMatch(/[▸▾]/);
    });

    it('shows branches when project is expanded', () => {
      // Expansion state is keyed by `${userId}:${projectId}` (stable IDs, not
      // array indices) so it survives reloads that reorder members.
      (table as any).expandedProjects.add(`${MEMBERS[1].userId}:${MEMBERS[1].projects[0].id}`);
      const lines = table.renderExpandedDetail(MEMBERS[1], 1, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('▾');
      expect(plain).toContain('api-backend');
      expect(plain).toContain('main');
    });

    it('does not show branches when project is collapsed', () => {
      const lines = table.renderExpandedDetail(MEMBERS[1], 1, 100, null);
      const plain = lines.map(stripAnsi).join('\n');
      expect(plain).toContain('▸');
      expect(plain).toContain('api-backend');
      expect(plain).not.toContain('main');
    });
  });

  describe('renderTable', () => {
    it('includes header row with column labels', () => {
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('Email');
      expect(plain).toContain('Role');
      expect(plain).toContain('Added');
      expect(plain).toContain('Projects');
    });

    it('shows member count in title', () => {
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('Organization Members (3 users)');
    });

    it('omits Added column in narrow terminal', () => {
      const output = table.renderTable(MEMBERS, 50, 30);
      const plain = stripAnsi(output);
      expect(plain).not.toContain('Added');
      expect(plain).toContain('Email');
      expect(plain).toContain('Role');
    });

    it('shows footer hint', () => {
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('navigate');
      expect(plain).toContain('expand/collapse');
      expect(plain).toContain('q quit');
    });

    it('singular "user" for single member', () => {
      const output = table.renderTable([MEMBERS[0]], 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('Organization Members (1 user)');
      expect(plain).not.toContain('1 users');
    });

    it('uses horizontal rules instead of box borders', () => {
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('─');
      expect(plain).not.toContain('┌');
      expect(plain).not.toContain('┐');
      expect(plain).not.toContain('└');
      expect(plain).not.toContain('┘');
      expect(plain).not.toContain('│');
    });

    it('has left margin on all content lines', () => {
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      const contentLines = plain.split('\n').filter(l => l.trim().length > 0);
      for (const line of contentLines) {
        expect(line).toMatch(/^\s{2}/);
      }
    });
  });

  describe('project picker rendering', () => {
    function openPicker(projects: Array<{ id: string; name: string }>) {
      (table as any).projectPicker = {
        projects,
        cursor: 0,
        selected: new Set<string>(),
        resolve: () => {},
        prompt: 'Assign project-admin on which projects?',
      };
    }

    it('renders the hint line just above the menu rows (not in the main footer)', () => {
      openPicker([{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }]);
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      const lines = plain.split('\n');

      const hintIdx = lines.findIndex(l => l.includes('Space select'));
      const promptIdx = lines.findIndex(l => l.includes('Assign project-admin on which projects?'));
      const firstMenuIdx = lines.findIndex(l => l.includes('[ ] alpha'));

      expect(promptIdx).toBeGreaterThan(-1);
      expect(hintIdx).toBeGreaterThan(-1);
      expect(firstMenuIdx).toBeGreaterThan(-1);
      // prompt → hint → menu rows, contiguous with no intervening blank line
      expect(hintIdx).toBe(promptIdx + 1);
      expect(firstMenuIdx).toBe(hintIdx + 1);
    });

    it('suppresses the main-table footer while the picker is open', () => {
      openPicker([{ id: 'p1', name: 'alpha' }]);
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      // 'expand/collapse' belongs to the main-mode footer; it must not show
      // while the picker is active, so the only hint shown is the picker's own.
      expect(plain).not.toContain('expand/collapse');
    });

    it('prompt is indented the same amount as the picker hint (3 spaces, not 2)', () => {
      openPicker([{ id: 'p1', name: 'alpha' }]);
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      const lines = plain.split('\n');
      const promptLine = lines.find(l => l.includes('Assign project-admin on which projects?'))!;
      const hintLine = lines.find(l => l.includes('Space select'))!;
      // Both must start with exactly 3 spaces
      expect(promptLine).toMatch(/^ {3}\S/);
      expect(hintLine).toMatch(/^ {3}\S/);
    });

    it('renders [x] for selected rows and [ ] for unselected', () => {
      (table as any).projectPicker = {
        projects: [{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }],
        cursor: 1,
        selected: new Set<string>(['p1']),
        resolve: () => {},
        prompt: 'Assign project-admin on which projects?',
      };
      const output = table.renderTable(MEMBERS, 120, 30);
      const plain = stripAnsi(output);
      expect(plain).toContain('[x] alpha');
      expect(plain).toContain('[ ] beta');
    });
  });

  describe('buildNavItems', () => {
    it('returns only member items when nothing expanded', () => {
      (table as any).members = MEMBERS;
      const items = table.buildNavItems();
      expect(items).toHaveLength(3);
      expect(items.every(i => i.type === 'member')).toBe(true);
    });

    it('includes project items for expanded non-admin member', () => {
      (table as any).members = MEMBERS;
      (table as any).expandedMembers.add(MEMBERS[1].userId); // bob (member role)
      const items = table.buildNavItems();
      expect(items).toHaveLength(4); // 3 members + 1 project (api-backend)
      expect(items[2]).toEqual({ type: 'project', memberIndex: 1, projectIndex: 0 });
    });

    it('does not include project items for expanded owner/admin', () => {
      (table as any).members = MEMBERS;
      (table as any).expandedMembers.add(MEMBERS[0].userId); // alice (owner role)
      const items = table.buildNavItems();
      expect(items).toHaveLength(3); // just 3 members, no projects
    });

    it('lists every project even when the user has no branch access', () => {
      const membersWithEmpty = [
        makeMember({
          role: 'member',
          projects: [
            { id: 'p1', name: 'has-branches', branches: ['main'] },
            { id: 'p2', name: 'no-branches', branches: [] },
          ],
        }),
      ];
      (table as any).members = membersWithEmpty;
      (table as any).expandedMembers.add(membersWithEmpty[0].userId);
      const items = table.buildNavItems();
      expect(items).toHaveLength(3); // 1 member + 2 projects (all projects surface)
      expect(items[1]).toEqual({ type: 'project', memberIndex: 0, projectIndex: 0 });
      expect(items[2]).toEqual({ type: 'project', memberIndex: 0, projectIndex: 1 });
    });
  });

  describe('renderStatic', () => {
    it('omits footer hint and selection pointer', () => {
      const output = table.renderStatic(MEMBERS);
      const plain = stripAnsi(output);
      expect(plain).not.toContain('navigate');
      expect(plain).toContain('alice@acme.com');
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard-driven mutations
  //
  // Drive the private handlers with synthetic key buffers + a fully-mocked
  // TableContext. `draw()` is stubbed so there's no stdout noise; every
  // mutation is asserted by inspecting the recorded ctx calls and the
  // internal editing/picker state.
  // ---------------------------------------------------------------------------
  describe('keyboard-driven mutations', () => {
    const ESC = '\x1b';
    const ARROW_UP = `${ESC}[A`;
    const ARROW_DOWN = `${ESC}[B`;
    const ENTER = '\r';

    interface CtxCalls {
      changeRole: Array<{ userId: string; role: string; projectId?: string }>;
      assignProjectRole: Array<{ projectId: string; email: string; role: string }>;
      removeProjectRole: Array<{ projectId: string; userId: string }>;
      grantProtectedBranch: Array<{ projectId: string; branchId: string; userId: string }>;
      revokeProtectedBranch: Array<{ projectId: string; branchId: string; userId: string }>;
      reloadCount: number;
      listProjectsCount: number;
    }

    function makeTable(callerRole = 'owner', members: MemberDetail[] = MEMBERS, projects: Array<{ id: string; name: string }> = [], currentUserId = 'user-999') {
      const calls: CtxCalls = {
        changeRole: [],
        assignProjectRole: [],
        removeProjectRole: [],
        grantProtectedBranch: [],
        revokeProtectedBranch: [],
        reloadCount: 0,
        listProjectsCount: 0,
      };
      const t = new InteractiveTable();
      const ctx = {
        callerRole,
        currentUserId,
        listProjects: async () => { calls.listProjectsCount++; return projects; },
        changeRole: async (userId: string, role: string, projectId?: string) => {
          calls.changeRole.push({ userId, role, projectId });
        },
        reload: async () => { calls.reloadCount++; return members; },
        assignProjectRole: async (projectId: string, email: string, role: 'project-admin' | 'member') => {
          calls.assignProjectRole.push({ projectId, email, role });
        },
        removeProjectRole: async (projectId: string, userId: string) => {
          calls.removeProjectRole.push({ projectId, userId });
        },
        grantProtectedBranch: async (projectId: string, branchId: string, userId: string) => {
          calls.grantProtectedBranch.push({ projectId, branchId, userId });
        },
        revokeProtectedBranch: async (projectId: string, branchId: string, userId: string) => {
          calls.revokeProtectedBranch.push({ projectId, branchId, userId });
        },
      };
      (t as any).members = members;
      (t as any).ctx = ctx;
      (t as any).draw = () => {}; // suppress stdout writes
      return { table: t, ctx, calls };
    }

    function press(t: InteractiveTable, key: string) {
      (t as any).handleKeypress(Buffer.from(key), () => {});
    }

    // -------------------------------------------------------------------------
    // `r` on member row
    // -------------------------------------------------------------------------
    describe('r on member row', () => {
      it('enters edit mode when caller is owner and target is a non-owner', () => {
        const { table } = makeTable('owner');
        (table as any).cursorIndex = 1; // bob (member)
        press(table, 'r');
        expect((table as any).editingMemberIndex).toBe(1);
      });

      it('refuses to edit the owner', () => {
        const { table } = makeTable('owner');
        (table as any).cursorIndex = 0; // alice (owner)
        press(table, 'r');
        expect((table as any).editingMemberIndex).toBeNull();
        expect((table as any).statusMessage?.isError).toBe(true);
        expect((table as any).statusMessage?.text).toMatch(/owner/i);
      });

      it('refuses when caller lacks role permissions', () => {
        const { table } = makeTable('member');
        (table as any).cursorIndex = 1;
        press(table, 'r');
        expect((table as any).editingMemberIndex).toBeNull();
        expect((table as any).statusMessage?.isError).toBe(true);
      });

      it('refuses self-edit on the member row', () => {
        // bob is user-2; set that as the caller's own id
        const { table } = makeTable('admin', MEMBERS, [], 'user-2');
        (table as any).cursorIndex = 1; // bob
        press(table, 'r');
        expect((table as any).editingMemberIndex).toBeNull();
        expect((table as any).statusMessage?.isError).toBe(true);
        expect((table as any).statusMessage?.text).toMatch(/your own role/i);
      });

      it('refuses self-edit on an expanded project row', () => {
        const { table } = makeTable('admin', MEMBERS, [], 'user-2');
        // expand bob so his project row shows up as a nav item
        (table as any).expandedMembers.add('user-2');
        // rebuild nav items and find the project row for bob
        const navItems = (table as any).buildNavItems();
        const projIdx = navItems.findIndex(
          (n: any) => n.type === 'project' && n.memberIndex === 1,
        );
        expect(projIdx).toBeGreaterThan(-1);
        (table as any).cursorIndex = projIdx;
        press(table, 'r');
        expect((table as any).editingProjectRef).toBeNull();
        expect((table as any).statusMessage?.isError).toBe(true);
        expect((table as any).statusMessage?.text).toMatch(/your own project role/i);
      });
    });

    // -------------------------------------------------------------------------
    // Arrow keys while editing a member row
    // -------------------------------------------------------------------------
    describe('arrow keys during member role edit', () => {
      it('cycle editingRoleIndex down and up', () => {
        const { table } = makeTable('owner');
        (table as any).cursorIndex = 1;
        press(table, 'r');
        const initial = (table as any).editingRoleIndex;
        press(table, ARROW_DOWN);
        expect((table as any).editingRoleIndex).not.toBe(initial);
        press(table, ARROW_UP);
        expect((table as any).editingRoleIndex).toBe(initial);
      });

      it('Esc cancels and clears editingMemberIndex', () => {
        const { table } = makeTable('owner');
        (table as any).cursorIndex = 1;
        press(table, 'r');
        expect((table as any).editingMemberIndex).toBe(1);
        press(table, ESC);
        expect((table as any).editingMemberIndex).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // commitRoleChange fan-out
    // -------------------------------------------------------------------------
    describe('commitRoleChange', () => {
      it('promoting member → admin calls changeRole with no project_id and no fan-out', async () => {
        const { table, calls } = makeTable('owner');
        (table as any).editingMemberIndex = 1; // bob (member)
        // Position the editor on 'admin'.
        const assignable: string[] = (table as any).assignableRoles('member');
        (table as any).editingRoleIndex = assignable.indexOf('admin');

        await (table as any).commitRoleChange();

        expect(calls.changeRole).toHaveLength(1);
        expect(calls.changeRole[0]).toEqual({
          userId: 'user-2',
          role: 'admin',
          projectId: undefined,
        });
        expect(calls.assignProjectRole).toHaveLength(0);
        expect(calls.removeProjectRole).toHaveLength(0);
        expect(calls.reloadCount).toBe(1);
      });

      it('cycling admin→member pre-checks no projects, opens multi-select, adds the chosen projects', async () => {
        const adminWithNone = {
          ...MEMBERS[2],
          projects: [], // admin → no scoped memberships
        };
        const projects = [
          { id: 'pA', name: 'api-backend' },
          { id: 'pB', name: 'web-frontend' },
        ];
        const { table, calls } = makeTable('owner', [MEMBERS[0], MEMBERS[1], adminWithNone], projects);
        (table as any).editingMemberIndex = 2;
        const assignable: string[] = (table as any).assignableRoles('admin');
        (table as any).editingRoleIndex = assignable.indexOf('member');

        // commitRoleChange will open the picker — resolve it synchronously
        // with the user's desired selection.
        setTimeout(() => {
          const pp = (table as any).projectPicker;
          if (pp) {
            pp.selected = new Set(['pA', 'pB']);
            pp.resolve(Array.from(pp.selected));
            (table as any).projectPicker = null;
          }
        }, 0);

        await (table as any).commitRoleChange();

        // First-project is folded into the WorkOS role flip; the remainder is
        // fanned out via assignProjectRole.
        expect(calls.changeRole).toHaveLength(1);
        expect(calls.changeRole[0].role).toBe('member');
        expect(typeof calls.changeRole[0].projectId).toBe('string');
        expect(['pA', 'pB']).toContain(calls.changeRole[0].projectId);

        expect(calls.assignProjectRole).toHaveLength(1);
        expect(['pA', 'pB']).toContain(calls.assignProjectRole[0].projectId);
        expect(calls.assignProjectRole[0].role).toBe('member');
        expect(calls.removeProjectRole).toHaveLength(0);
      });

      it('re-picking same scoped role with existing memberships diffs selection — adds new, removes deselected', async () => {
        // bob is currently member of proj-1 (per MEMBERS[1]).
        const bobWithExisting = {
          ...MEMBERS[1],
          projects: [
            { id: 'p-current', name: 'current', role: 'member' as const, branches: [] },
          ],
        };
        const projects = [
          { id: 'p-current', name: 'current' },
          { id: 'p-new', name: 'new' },
        ];
        const { table, calls } = makeTable('owner', [MEMBERS[0], bobWithExisting, MEMBERS[2]], projects);
        (table as any).editingMemberIndex = 1;
        const assignable: string[] = (table as any).assignableRoles('member');
        (table as any).editingRoleIndex = assignable.indexOf('member');

        setTimeout(() => {
          const pp = (table as any).projectPicker;
          if (pp) {
            // Pre-checked p-current — user unchecks it, checks p-new.
            pp.selected = new Set(['p-new']);
            pp.resolve(Array.from(pp.selected));
            (table as any).projectPicker = null;
          }
        }, 0);

        await (table as any).commitRoleChange();

        // No WorkOS role flip needed (already member), so no changeRole call.
        expect(calls.changeRole).toHaveLength(0);
        expect(calls.assignProjectRole).toEqual([
          { projectId: 'p-new', email: bobWithExisting.email, role: 'member' },
        ]);
        expect(calls.removeProjectRole).toEqual([
          { projectId: 'p-current', userId: bobWithExisting.userId },
        ]);
      });

      it('cancelling the picker leaves state untouched and sets a Cancelled status', async () => {
        const adminWithNone = { ...MEMBERS[2], projects: [] };
        const projects = [{ id: 'pA', name: 'api-backend' }];
        const { table, calls } = makeTable('owner', [MEMBERS[0], MEMBERS[1], adminWithNone], projects);
        (table as any).editingMemberIndex = 2;
        const assignable: string[] = (table as any).assignableRoles('admin');
        (table as any).editingRoleIndex = assignable.indexOf('member');

        setTimeout(() => {
          const pp = (table as any).projectPicker;
          if (pp) {
            pp.resolve(null);
            (table as any).projectPicker = null;
          }
        }, 0);

        await (table as any).commitRoleChange();

        expect(calls.changeRole).toHaveLength(0);
        expect(calls.assignProjectRole).toHaveLength(0);
        expect(calls.removeProjectRole).toHaveLength(0);
        expect((table as any).statusMessage?.text).toMatch(/Cancelled/i);
      });
    });

    // -------------------------------------------------------------------------
    // `r` on an expanded project row (Flow C)
    // -------------------------------------------------------------------------
    describe('r on project row (Flow C)', () => {
      it('enters project edit state preselecting current role', () => {
        const { table } = makeTable('owner');
        // Expansion state is keyed by stable IDs now; look up bob's userId.
        const bob = (table as any).members[1];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).cursorIndex = 2; // project row under bob

        // Give bob a known per-project role.
        bob.projects[0].role = 'member';

        press(table, 'r');
        const ref = (table as any).editingProjectRef;
        expect(ref).toEqual({ memberIndex: 1, projectIndex: 0 });
        // PROJECT_ROLE_CHOICES = ['project-admin', 'member', 'none']
        expect((table as any).editingProjectRoleIndex).toBe(1);
      });

      it('commit with "none" calls removeProjectRole', async () => {
        const { table, calls } = makeTable('owner');
        (table as any).editingProjectRef = { memberIndex: 1, projectIndex: 0 };
        (table as any).editingProjectRoleIndex = 2; // none

        await (table as any).commitProjectRoleChange();

        expect(calls.removeProjectRole).toEqual([
          { projectId: 'proj-1', userId: 'user-2' },
        ]);
        expect(calls.assignProjectRole).toHaveLength(0);
      });

      it('commit with "project-admin" calls assignProjectRole with admin', async () => {
        const { table, calls } = makeTable('owner');
        (table as any).editingProjectRef = { memberIndex: 1, projectIndex: 0 };
        (table as any).editingProjectRoleIndex = 0; // project-admin

        await (table as any).commitProjectRoleChange();

        expect(calls.assignProjectRole).toEqual([
          { projectId: 'proj-1', email: 'bob@acme.com', role: 'project-admin' },
        ]);
        expect(calls.removeProjectRole).toHaveLength(0);
      });

      it('commit with the unchanged role is a no-op (no ctx call)', async () => {
        const { table, calls } = makeTable('owner');
        const m = (table as any).members[1];
        m.projects[0].role = 'member';
        (table as any).editingProjectRef = { memberIndex: 1, projectIndex: 0 };
        (table as any).editingProjectRoleIndex = 1; // member — same as current

        await (table as any).commitProjectRoleChange();

        expect(calls.assignProjectRole).toHaveLength(0);
        expect(calls.removeProjectRole).toHaveLength(0);
      });
    });

    // -------------------------------------------------------------------------
    // Multi-select project picker key handling
    // -------------------------------------------------------------------------
    describe('multi-select picker key handling', () => {
      function openPicker(table: InteractiveTable, initial: Set<string> = new Set()) {
        let resolvedWith: string[] | null | undefined = undefined;
        (table as any).projectPicker = {
          projects: [
            { id: 'p1', name: 'alpha' },
            { id: 'p2', name: 'beta' },
            { id: 'p3', name: 'gamma' },
          ],
          cursor: 0,
          selected: initial,
          resolve: (v: string[] | null) => { resolvedWith = v; },
          prompt: 'Pick',
        };
        return () => resolvedWith;
      }

      it('Space toggles selection on highlighted row', () => {
        const { table } = makeTable('owner');
        openPicker(table);
        press(table, ' ');
        expect((table as any).projectPicker.selected.has('p1')).toBe(true);
        press(table, ' ');
        expect((table as any).projectPicker.selected.has('p1')).toBe(false);
      });

      it('Arrow keys move the cursor', () => {
        const { table } = makeTable('owner');
        openPicker(table);
        press(table, ARROW_DOWN);
        expect((table as any).projectPicker.cursor).toBe(1);
        press(table, ARROW_UP);
        expect((table as any).projectPicker.cursor).toBe(0);
      });

      it('Enter resolves with the selected id array and closes the picker', () => {
        const { table } = makeTable('owner');
        const getResolved = openPicker(table, new Set(['p2']));
        press(table, ARROW_DOWN); // cursor→p2
        press(table, ' ');        // toggle p2 off
        press(table, ARROW_DOWN); // cursor→p3
        press(table, ' ');        // add p3
        press(table, ENTER);
        expect((table as any).projectPicker).toBeNull();
        expect(getResolved()).toEqual(['p3']);
      });

      it('Esc resolves with null', () => {
        const { table } = makeTable('owner');
        const getResolved = openPicker(table, new Set(['p1', 'p2']));
        press(table, ESC);
        expect((table as any).projectPicker).toBeNull();
        expect(getResolved()).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // `g` on a branch row (Flow E)
    // -------------------------------------------------------------------------
    describe('g on protected branch row (Flow E)', () => {
      function memberWithBranches(): MemberDetail {
        return {
          membershipId: 'mem-bob',
          userId: 'user-bob',
          email: 'bob@acme.com',
          role: 'member',
          status: 'active',
          createdAt: '2025-02-01T00:00:00Z',
          projects: [
            {
              id: 'proj-1',
              name: 'backend',
              role: 'member',
              branches: [
                { id: 'b-main', name: 'main', isProtected: false, hasAccess: true },
                { id: 'b-prod', name: 'prod', isProtected: true, hasAccess: false },
                { id: 'b-rel', name: 'release', isProtected: true, hasAccess: true },
              ],
            },
          ],
        };
      }

      it('shows denied protected branches to managers so they can grant', async () => {
        const { table } = makeTable('owner', [memberWithBranches()]);
        const bob = (table as any).members[0];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).expandedProjects.add(`${bob.userId}:${bob.projects[0].id}`);
        const nav = (table as any).buildNavItems();
        const deniedBranchNav = nav.find(
          (n: any) => n.type === 'branch' && n.branchIndex === 1, // b-prod (denied)
        );
        expect(deniedBranchNav).toBeDefined();
      });

      it('grants a protected branch when `g` is pressed on a denied row', async () => {
        const { table, calls } = makeTable('owner', [memberWithBranches()]);
        const bob = (table as any).members[0];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).expandedProjects.add(`${bob.userId}:${bob.projects[0].id}`);
        const nav = (table as any).buildNavItems();
        const idx = nav.findIndex((n: any) => n.type === 'branch' && n.branchIndex === 1);
        (table as any).cursorIndex = idx;

        press(table, 'g');
        await new Promise((r) => setTimeout(r, 0));

        expect(calls.grantProtectedBranch).toEqual([
          { projectId: 'proj-1', branchId: 'b-prod', userId: 'user-bob' },
        ]);
        expect(calls.revokeProtectedBranch).toHaveLength(0);
      });

      it('hides denied protected branches from viewers who cannot manage access', async () => {
        const { table } = makeTable('member', [memberWithBranches()]);
        const bob = (table as any).members[0];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).expandedProjects.add(`${bob.userId}:${bob.projects[0].id}`);
        const nav = (table as any).buildNavItems();
        const deniedBranchNav = nav.find(
          (n: any) => n.type === 'branch' && n.branchIndex === 1, // b-prod (denied)
        );
        expect(deniedBranchNav).toBeUndefined();
      });

      it('revokes when branch is protected + granted', async () => {
        const { table, calls } = makeTable('owner', [memberWithBranches()]);
        const bob = (table as any).members[0];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).expandedProjects.add(`${bob.userId}:${bob.projects[0].id}`);
        const nav = (table as any).buildNavItems();
        const idx = nav.findIndex((n: any) => n.type === 'branch' && n.branchIndex === 2);
        (table as any).cursorIndex = idx;

        press(table, 'g');
        await new Promise((r) => setTimeout(r, 0));

        expect(calls.revokeProtectedBranch).toEqual([
          { projectId: 'proj-1', branchId: 'b-rel', userId: 'user-bob' },
        ]);
        expect(calls.grantProtectedBranch).toHaveLength(0);
      });

      it('is a no-op on a non-protected branch', async () => {
        const { table, calls } = makeTable('owner', [memberWithBranches()]);
        const bob = (table as any).members[0];
        (table as any).expandedMembers.add(bob.userId);
        (table as any).expandedProjects.add(`${bob.userId}:${bob.projects[0].id}`);
        const nav = (table as any).buildNavItems();
        const idx = nav.findIndex((n: any) => n.type === 'branch' && n.branchIndex === 0);
        (table as any).cursorIndex = idx;

        press(table, 'g');
        await new Promise((r) => setTimeout(r, 0));

        expect(calls.grantProtectedBranch).toHaveLength(0);
        expect(calls.revokeProtectedBranch).toHaveLength(0);
      });

      it('is a no-op when the project role is project-admin (inherent access)', async () => {
        const m = memberWithBranches();
        m.projects[0].role = 'project-admin';
        const { table, calls } = makeTable('owner', [m]);
        (table as any).expandedMembers.add(m.userId);
        (table as any).expandedProjects.add(`${m.userId}:${m.projects[0].id}`);
        // project-admin projects don't spawn branch nav items, so attempting
        // to hit `g` on the project row itself is a no-op.
        (table as any).cursorIndex = 1; // project row
        press(table, 'g');
        await new Promise((r) => setTimeout(r, 0));
        expect(calls.grantProtectedBranch).toHaveLength(0);
        expect(calls.revokeProtectedBranch).toHaveLength(0);
      });
    });
  });
});
