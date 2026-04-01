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

// Strip ANSI escape codes for assertion readability
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('InteractiveTable', () => {
  let table: InteractiveTable;

  beforeEach(() => {
    table = new InteractiveTable();
  });

  describe('computeColumnWidths', () => {
    it('shows Added column when terminal >= 60', () => {
      const result = table.computeColumnWidths(120);
      expect(result.showAdded).toBe(true);
      expect(result.widths).toHaveLength(4); // Email, Role, Added, Projects
    });

    it('hides Added column when terminal < 60', () => {
      const result = table.computeColumnWidths(50);
      expect(result.showAdded).toBe(false);
      expect(result.widths).toHaveLength(3); // Email, Role, Projects
    });

    it('flex column gets remaining space at 80 cols', () => {
      const result = table.computeColumnWidths(80);
      // Email (flex) should be larger than minWidth 20
      expect(result.widths[0]).toBeGreaterThan(20);
    });

    it('flex column is at least minWidth for very narrow terminals', () => {
      const result = table.computeColumnWidths(30);
      expect(result.widths[0]).toBeGreaterThanOrEqual(20);
    });
  });

  describe('renderRow', () => {
    it('renders selected row with pointer', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const output = table.renderRow(MEMBERS[0], 0, widths, showAdded);
      const plain = stripAnsi(output);
      expect(plain).toContain('▸');
      expect(plain).toContain('alice@acme.com');
      expect(plain).toContain('owner');
      expect(plain).toContain('2025-01-15');
    });

    it('renders non-selected row without pointer', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const output = table.renderRow(MEMBERS[1], 1, widths, showAdded);
      const plain = stripAnsi(output);
      expect(plain).not.toContain('▸');
      expect(plain).toContain('bob@acme.com');
      expect(plain).toContain('member');
    });
  });

  describe('renderExpandedDetail', () => {
    it('renders project/branch tree', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const lines = table.renderExpandedDetail(MEMBERS[0], widths, showAdded);
      const plain = lines.map(stripAnsi).join('\n');

      expect(plain).toContain('api-backend');
      expect(plain).toContain('web-frontend');
      expect(plain).toContain('main');
      expect(plain).toContain('staging');
    });

    it('shows "No project access" for empty projects', () => {
      const noAccess = makeMember({ projects: [] });
      const { widths, showAdded } = table.computeColumnWidths(120);
      const lines = table.renderExpandedDetail(noAccess, widths, showAdded);
      const plain = lines.map(stripAnsi).join('\n');

      expect(plain).toContain('No project access');
    });

    it('uses tree chars correctly', () => {
      const { widths, showAdded } = table.computeColumnWidths(120);
      const lines = table.renderExpandedDetail(MEMBERS[0], widths, showAdded);
      const plain = lines.map(stripAnsi).join('\n');

      // First project uses ├─, last project uses └─
      expect(plain).toContain('├─');
      expect(plain).toContain('└─');
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
