/** The pure decisions of bare `capy` setup (`core/initPlan.ts`). */
import { describe, test, expect } from 'bun:test';
import { answerProblem, chooseOrg, chooseProject, newProjectGaps, hasGaps } from '../../src/core/initPlan';

const ACME = { id: 'org-1', name: 'Acme' };
const OTHER = { id: 'org-2', name: 'Other' };
const WEB = { id: 'p-1', name: 'web' };
const API = { id: 'p-2', name: 'api' };

describe('chooseOrg', () => {
  test('the only organization is not asked about', () => {
    expect(chooseOrg([ACME], undefined)).toEqual({ kind: 'picked', org: ACME });
  });
  test('several are asked', () => {
    expect(chooseOrg([ACME, OTHER], undefined)).toEqual({ kind: 'ask', orgs: [ACME, OTHER] });
  });
  test('--org picks by id, by name, or by name ignoring case; the id wins', () => {
    expect(chooseOrg([ACME, OTHER], 'org-2')).toEqual({ kind: 'picked', org: OTHER });
    expect(chooseOrg([ACME, OTHER], 'Acme')).toEqual({ kind: 'picked', org: ACME });
    expect(chooseOrg([ACME, OTHER], 'acme')).toEqual({ kind: 'picked', org: ACME });
    expect(chooseOrg([{ id: 'Acme', name: 'x' }, ACME], 'Acme')).toEqual({ kind: 'picked', org: { id: 'Acme', name: 'x' } });
  });
  test('an organization nobody has, none at all, and a name two share', () => {
    expect(chooseOrg([ACME], 'nope')).toEqual({ kind: 'unknown', typed: 'nope' });
    expect(chooseOrg([], undefined)).toEqual({ kind: 'none' });
    expect(chooseOrg([ACME, { id: 'org-3', name: 'Acme' }], 'Acme').kind).toBe('ambiguous');
  });
});

describe('chooseProject', () => {
  test('no projects: a new one, nothing to ask', () => {
    expect(chooseProject([], {})).toEqual({ kind: 'new' });
  });
  test('projects and no answer: asked', () => {
    expect(chooseProject([WEB, API], {})).toEqual({ kind: 'ask', projects: [WEB, API] });
  });
  test('--name or --project new means a new one; --project names an existing one', () => {
    expect(chooseProject([WEB], { name: 'demo' })).toEqual({ kind: 'new' });
    expect(chooseProject([WEB], { project: 'new' })).toEqual({ kind: 'new' });
    expect(chooseProject([WEB, API], { project: 'api' })).toEqual({ kind: 'existing', project: API });
    expect(chooseProject([WEB, API], { project: 'p-1' })).toEqual({ kind: 'existing', project: WEB });
    expect(chooseProject([WEB], { project: 'zzz' })).toEqual({ kind: 'unknown', typed: 'zzz' });
  });
  test('--project beats --name: an existing project is linked, the name is not used', () => {
    expect(chooseProject([WEB], { project: 'web', name: 'other' })).toEqual({ kind: 'existing', project: WEB });
  });
});

describe('answerProblem', () => {
  test('a good set of answers has no problem', () => {
    expect(answerProblem({ name: 'demo', branch: 'main', protectedAnswer: 'yes' })).toBeNull();
    expect(answerProblem({})).toBeNull();
  });
  test('each broken rule has its own code', () => {
    expect(answerProblem({ name: 'has space' })?.code).toBe('PROJECT_NAME_INVALID');
    expect(answerProblem({ name: '_system' })?.code).toBe('PROJECT_NAME_RESERVED');
    expect(answerProblem({ branch: '-x' })?.code).toBe('BRANCH_NAME_INVALID');
    expect(answerProblem({ protectedAnswer: 'maybe' })?.code).toBe('BRANCH_PROTECTION_INVALID');
  });
  test('with an existing project named, the answers that cannot apply are not checked', () => {
    expect(answerProblem({ project: 'web', name: 'has space', protectedAnswer: 'maybe' })).toBeNull();
    expect(answerProblem({ project: 'web', branch: '-x' })?.code).toBe('BRANCH_NAME_INVALID');
  });
});

describe('gaps', () => {
  test('only the answers not typed are gaps', () => {
    expect(newProjectGaps({ name: 'demo' })).toEqual({ name: false, branch: true, isProtected: false });
    expect(hasGaps(newProjectGaps({ name: 'demo', branch: 'main', protectedAnswer: 'no' }))).toBe(false);
    // Protection is never a gap: setup does not ask it, as the terminal (Vincent, 2026-11-27).
    expect(hasGaps(newProjectGaps({ name: 'demo', branch: 'main' }))).toBe(false);
  });
});
