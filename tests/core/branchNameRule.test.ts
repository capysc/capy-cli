import { describe, expect, it } from 'bun:test';
import { branchNameProblem, validateBranchNameInput } from '../../src/core/branchNameRule';

/** The service's rule (routes/projects.ts validateBranchName): the CLI must refuse exactly what the service refuses. */
describe('branchNameProblem', () => {
  it('accepts what the service accepts', () => {
    const ok = ['development', 'staging', 'production', 'main', 'v1.2', 'feature_x', 'a-b', '9lives', 'x'.repeat(128)];
    expect(ok.map((name) => [name, branchNameProblem(name)])).toEqual(ok.map((name) => [name, null]));
  });

  it('refuses what the service refuses, with BRANCH_NAME_INVALID', () => {
    const bad = ['', '-dev', '.dev', '_dev', 'a..b', 'has space', 'a/b', 'x'.repeat(129)];
    expect(bad.map((name) => branchNameProblem(name)?.code)).toEqual(bad.map(() => 'BRANCH_NAME_INVALID'));
  });

  it('the prompt validator trims, then answers true or the sentence', () => {
    expect(validateBranchNameInput('  staging  ')).toBe(true);
    expect(validateBranchNameInput('a..b')).toBe('Branch name cannot contain ".."');
  });
});
