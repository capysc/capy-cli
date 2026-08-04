import { describe, test, expect } from 'bun:test';
import { countVariablesPerBranch, findUncommittedEnvChange } from '../../src/commands/checkoutCommand';
import { hashValue } from '../../src/commands/statusCommand';
import { KeepFile } from '../../src/types/index';

const BRANCH = 'local';

function keepVars(entries: Record<string, string>): KeepFile['variables'] {
  const variables: KeepFile['variables'] = {};
  for (const [name, value] of Object.entries(entries)) {
    variables[name] = [{ resource_id: `rid-${name}`, branch: BRANCH, value_hash: hashValue(value) }];
  }
  return variables;
}

describe('findUncommittedEnvChange (checkout dirty guard)', () => {
  test('clean tree with non-empty values → null', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123', MODE: 'production' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123', MODE: 'production' }, vars, BRANCH)).toBeNull();
  });

  test('REGRESSION: empty value present and pinned empty → clean, not a deletion', () => {
    // A branch full of empty placeholders (e.g. the monorepo "local" branch)
    // must not read as dirty: '' is present, decrypts, and hash-matches the
    // pin. The old falsy `!localValue` check flagged every empty variable as
    // an uncommitted deletion, permanently blocking branch switches.
    const vars = keepVars({ POLAR_ORG_KEY: '', AWS_REGION: '', DATABASE_URL: '' });
    const local = { POLAR_ORG_KEY: '', AWS_REGION: '', DATABASE_URL: '' };
    expect(findUncommittedEnvChange(local, vars, BRANCH)).toBeNull();
  });

  test('pinned variable missing from .env → uncommitted deletion', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123', MODE: 'production' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123' }, vars, BRANCH)).toBe('MODE');
  });

  test('value edited (including empty → non-empty) → uncommitted edit', () => {
    const vars = keepVars({ POLAR_ORG_KEY: '' });
    expect(findUncommittedEnvChange({ POLAR_ORG_KEY: 'now-filled-in' }, vars, BRANCH)).toBe('POLAR_ORG_KEY');
  });

  test('value edited (non-empty → empty) → uncommitted edit', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123' });
    expect(findUncommittedEnvChange({ API_KEY: '' }, vars, BRANCH)).toBe('API_KEY');
  });

  test('variable in .env but not pinned → uncommitted addition', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123', NEW_VAR: 'x' }, vars, BRANCH)).toBe('NEW_VAR');
  });

  test('pins on other branches are ignored', () => {
    const variables: KeepFile['variables'] = {
      PROD_ONLY: [{ resource_id: 'rid-p', branch: 'prod', value_hash: hashValue('prod-value') }],
    };
    expect(findUncommittedEnvChange({}, variables, BRANCH)).toBeNull();
  });
});

describe('countVariablesPerBranch (branch list counts)', () => {
  test('counts each branch\'s pinned variables, and no other branch\'s', () => {
    const variables: KeepFile['variables'] = {
      API_KEY: [
        { resource_id: 'r1', branch: 'development', value_hash: 'h' },
        { resource_id: 'r2', branch: 'production', value_hash: 'h' },
      ],
      DB_URL: [{ resource_id: 'r3', branch: 'development', value_hash: 'h' }],
    };
    expect(countVariablesPerBranch({ variables } as KeepFile)).toEqual({
      development: 2,
      production: 1,
    });
  });

  test('one variable pinned twice on a branch is still one variable', () => {
    // The screen prints "14 variables", not "14 pins", so the count is per
    // variable — otherwise a duplicate entry inflates what the branch holds.
    const variables: KeepFile['variables'] = {
      API_KEY: [
        { resource_id: 'r1', branch: 'development', value_hash: 'h' },
        { resource_id: 'r2', branch: 'development', value_hash: 'h' },
      ],
    };
    expect(countVariablesPerBranch({ variables } as KeepFile)).toEqual({ development: 1 });
  });

  test('no keep.lock is no counts, never zeroes', () => {
    // A branch absent from the map renders without a count; a zero would claim
    // this directory knows the branch is empty.
    expect(countVariablesPerBranch(null)).toEqual({});
  });
});
