import { describe, expect, it, mock } from 'bun:test';
import { resolveListMetadata, requireListIdentity, type ListMetadataDependencies } from '../../src/commands/listMetadata';

const fixture = (overrides: Partial<ListMetadataDependencies> = {}) => ({
  authenticate: mock(async () => ({ success: true, user_id: 'user_test', organization_id: 'org_test' })),
  billing: mock(async () => ({ tier: 'free' })),
  projects: mock(async () => [{ id: 'project_test', name: 'default', organization_id: 'org_test' }]),
  snapshot: mock(async () => ({})),
  ...overrides,
});

describe('names-only metadata resolution', () => {
  it('resolves the authoritative free default without keys, env values, or writes', async () => {
    const deps = fixture();
    expect(await resolveListMetadata(deps, 'user_test')).toEqual({
      branch: 'development', keep: { version: '3.0', org_id: 'org_test', project_id: 'project_test', project_name: 'default', variables: {} },
    });
    expect(deps.snapshot).toHaveBeenCalledWith('project_test', 'development');
  });
  it('rejects missing or mismatched sessions before service access', async () => {
    for (const result of [{ success: false }, { success: true, user_id: 'someone_else' }]) {
      const deps = fixture({ authenticate: async () => result });
      await expect(resolveListMetadata(deps, 'user_test')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      expect(deps.billing).not.toHaveBeenCalled();
      expect(deps.snapshot).not.toHaveBeenCalled();
    }
  });
  it('does not guess attribution for paid or grandfathered accounts', async () => {
    for (const billing of [{ tier: 'business' }, { tier: 'free', grandfathered: true }]) {
      const deps = fixture({ billing: async () => billing });
      await expect(resolveListMetadata(deps)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      expect(deps.projects).not.toHaveBeenCalled();
    }
  });
  it('refuses missing, ambiguous, or cross-org defaults', async () => {
    for (const projects of [[], [{ id: 'other', name: 'default', organization_id: 'other' }],
      [{ id: 'a', name: 'default', organization_id: 'org_test' }, { id: 'b', name: 'default', organization_id: 'org_test' }]]) {
      const deps = fixture({ projects: async () => projects });
      await expect(resolveListMetadata(deps)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      expect(deps.snapshot).not.toHaveBeenCalled();
    }
  });
  it('rejects a snapshot belonging to another project', async () => {
    const deps = fixture({ snapshot: async () => ({ keep_file: JSON.stringify({ org_id: 'org_test', project_id: 'other' }) }) });
    await expect(resolveListMetadata(deps)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('passes the explicit lock organization to silent authentication', async () => {
    const deps = fixture();
    await requireListIdentity(deps, 'user_test', 'org_test');
    expect(deps.authenticate).toHaveBeenCalledWith('org_test');
  });
  it('propagates service failures instead of returning an empty successful list', async () => {
    const failure = new Error('unavailable');
    await expect(resolveListMetadata(fixture({ snapshot: async () => { throw failure; } }))).rejects.toBe(failure);
  });
});
