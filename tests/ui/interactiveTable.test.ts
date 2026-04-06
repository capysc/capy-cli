import { InteractiveTable } from '../../src/ui/interactiveTable';
import { MemberDetail } from '../../src/service/serviceClient';

function makeMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    membershipId: 'mem-1',
    userId: 'user-1',
    email: 'alice@acme.com',
    role: 'owner',
    status: 'active',
    createdAt: '2025-01-15T00:00:00Z',
    projects: [
      { id: 'proj-1', name: 'api-backend', branches: ['main', 'staging'] },
      { id: 'proj-2', name: 'web-frontend', branches: ['main'] },
    ],
    ...overrides,
  };
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
      (table as any).expandedProjects.add('1-0');
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

  describe('buildNavItems', () => {
    it('returns only member items when nothing expanded', () => {
      (table as any).members = MEMBERS;
      const items = table.buildNavItems();
      expect(items).toHaveLength(3);
      expect(items.every(i => i.type === 'member')).toBe(true);
    });

    it('includes project items for expanded non-admin member', () => {
      (table as any).members = MEMBERS;
      (table as any).expandedMembers.add(1); // bob (member role)
      const items = table.buildNavItems();
      expect(items).toHaveLength(4); // 3 members + 1 project (api-backend)
      expect(items[2]).toEqual({ type: 'project', memberIndex: 1, projectIndex: 0 });
    });

    it('does not include project items for expanded owner/admin', () => {
      (table as any).members = MEMBERS;
      (table as any).expandedMembers.add(0); // alice (owner role)
      const items = table.buildNavItems();
      expect(items).toHaveLength(3); // just 3 members, no projects
    });

    it('skips projects with no branches', () => {
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
      (table as any).expandedMembers.add(0);
      const items = table.buildNavItems();
      expect(items).toHaveLength(2); // 1 member + 1 project (the one with branches)
      expect(items[1]).toEqual({ type: 'project', memberIndex: 0, projectIndex: 0 });
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
});
