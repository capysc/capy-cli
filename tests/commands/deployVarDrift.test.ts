import { describe, it, expect } from 'bun:test';
import { applyVarDrift } from '../../src/commands/deployCommand';
import type { TargetConfig } from '../../src/deploy/adapter';

// When a project's variables change, `capy deploy` asks only about the new
// variables; every other saved setting of the target must survive untouched.
const target: TargetConfig = {
  name: 'aws-prod',
  kind: 'aws-ssm',
  branch: 'prod',
  vars: ['DATABASE_URL', 'WORKOS_API_KEY', 'OLD_VAR'],
  knownVars: ['DATABASE_URL', 'WORKOS_API_KEY', 'OLD_VAR', 'SKIPPED_VAR'],
  options: { region: 'us-east-1', pathPrefix: '/capy/production/', naming: 'kebab' },
  mode: 'direct',
  gitBaseBranch: 'main',
};

describe('applyVarDrift', () => {
  const current = ['ADMIN_REDIRECT_HOSTS', 'DATABASE_URL', 'SKIPPED_VAR', 'WORKOS_API_KEY'];

  it('adds the chosen new vars, drops removed ones, keeps every other setting', () => {
    const next = applyVarDrift(target, current, ['ADMIN_REDIRECT_HOSTS']);
    expect(next.vars).toEqual(['ADMIN_REDIRECT_HOSTS', 'DATABASE_URL', 'WORKOS_API_KEY']);
    expect(next.knownVars).toEqual(current);
    expect({ ...next, vars: target.vars, knownVars: target.knownVars }).toEqual(target);
  });

  it('a new var left unticked stays out, and is not asked about again', () => {
    const next = applyVarDrift(target, current, []);
    expect(next.vars).toEqual(['DATABASE_URL', 'WORKOS_API_KEY']);
    expect(next.knownVars).toContain('ADMIN_REDIRECT_HOSTS');
  });

  it('a var the target deliberately skipped stays skipped', () => {
    const next = applyVarDrift(target, current, ['ADMIN_REDIRECT_HOSTS']);
    expect(next.vars).not.toContain('SKIPPED_VAR');
  });

  it('does not modify the target it was given', () => {
    const before = JSON.stringify(target);
    applyVarDrift(target, current, ['ADMIN_REDIRECT_HOSTS']);
    expect(JSON.stringify(target)).toBe(before);
  });
});
