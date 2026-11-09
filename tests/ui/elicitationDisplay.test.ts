import { describe, expect, it } from 'bun:test';
import { createProjectDisplay, deleteProjectDisplay } from '../../src/ui/elicitationDisplay';

const base = {
  org: { id: 'org_1', name: 'Demos' },
  project: { id: 'proj_1', name: 'web' },
  branches: ['main', 'development'],
  variables: [
    { name: 'B_VAR', branches: ['main'] },
    { name: 'A_VAR', branches: ['main', 'development'] },
  ],
  liveDeployTokens: [],
  unavailable: [],
} as const;

describe('deleteProjectDisplay', () => {
  it('lists every variable, one row each, in the order given', () => {
    const out = deleteProjectDisplay(base);
    const rows = out.split('\n').filter((l) => l.startsWith('| ') && l.includes('_VAR'));
    expect(rows).toEqual(['| B_VAR | main |', '| A_VAR | main, development |']);
    expect(out).toContain('| Variables | 2 |');
    expect(out).toContain('| Project | web (proj_1) |');
    expect(out).toContain('| Live deploy tokens | none |');
  });

  it('never shortens a long list', () => {
    const variables = Array.from({ length: 45 }, (_, i) => ({ name: `V_${i}`, branches: ['development'] }));
    const out = deleteProjectDisplay({ ...base, variables });
    expect(variables.every((v) => out.includes(`| ${v.name} | development |`))).toBe(true);
  });

  it('says a part could not be read instead of calling it empty', () => {
    const out = deleteProjectDisplay({ ...base, unavailable: ['branches', 'variables'] });
    expect(out).toContain('| Branches | could not be read |');
    expect(out).toContain('Variables: could not be read');
    expect(out).not.toContain('B_VAR');
  });

  it('a pipe or line break in a label cannot break the table', () => {
    const out = deleteProjectDisplay({ ...base, liveDeployTokens: [{ deploy_id: 'dep_1', label: 'a|b\nc' }] });
    expect(out).toContain('| Live deploy tokens | dep_1 (a\\|b c) |');
  });
});

describe('createProjectDisplay', () => {
  const org = { id: 'org_1', name: 'Demos' };
  const branchDescription = 'A Capy branch is an independent set of values for the same project.';

  it('shows the org, what is still to choose, and what a branch is', () => {
    const out = createProjectDisplay({ org, branchDescription });
    expect(out).toContain('| Org | Demos |');
    expect(out).toContain('| Project | to choose |');
    expect(out).toContain('| First branch | to choose |');
    expect(out.endsWith(`\n\n${branchDescription}`)).toBe(true);
  });

  it('shows a name already given', () => {
    expect(createProjectDisplay({ org, name: 'web', branchDescription })).toContain('| Project | web |');
  });
});
