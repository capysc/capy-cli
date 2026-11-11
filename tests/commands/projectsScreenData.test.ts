import { describe, expect, test } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import type { ServiceClient } from '../../src/service/serviceClient';
import { loadScreenData } from '../../src/commands/projectsCommand';

/**
 * What the interactive `capy projects` screen reads, and what it hides: a read
 * the service refuses with 403 PERMISSION_DENIED becomes `null` (hidden), keyed
 * off the error's code — never its message. Anything else still fails.
 */

const forbidden = (): never => {
  throw new CapyError('any words at all', ERROR_CODES.PERMISSION_DENIED, { status: 403 });
};

interface FakeOpts {
  readonly index?: () => unknown;
  readonly me?: () => unknown;
  readonly members?: () => unknown;
  readonly repos?: () => unknown;
}

function fakeClient(opts: FakeOpts = {}): ServiceClient {
  return {
    listProjects: async () => [
      { id: 'p1', name: 'web', organization_id: 'o', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'api', organization_id: 'o' },
      { id: 'sys', name: '_system', organization_id: 'o' },
    ],
    listBranches: async (id: string) => [{ id: `${id}-b`, name: 'development', project_id: id, is_protected: id === 'p2' }],
    getOrgRepos: async () => (opts.repos ?? (() => ({
      org_id: 'o',
      repos: [
        { project_id: 'p1', project_name: 'web', host: 'github.com', owner: 'acme', name: 'web', path: '.', github_repo_id: 1, last_seen_at: 'x' },
        { project_id: 'p2', project_name: 'api', host: 'github.com', owner: 'acme', name: 'api', path: '.', github_repo_id: 2, last_seen_at: 'x' },
      ],
    })))(),
    getSecretIndex: async () => (opts.index ?? (() => ({ org_id: 'o', rows: [], skipped: [] })))(),
    getOrgMe: async () => (opts.me ?? (() => ({ user_id: 'u', role: 'owner', admin_projects: [{ id: 'p1', name: 'web' }, { id: 'p2', name: 'api' }] })))(),
    listMemberDetails: async () => (opts.members ?? (() => ({ members: [] })))(),
  } as unknown as ServiceClient;
}

describe('loadScreenData', () => {
  test('an owner gets everything: projects (no system store), branches, created_at, repos, index, members', async () => {
    const data = await loadScreenData(fakeClient(), 'o');
    expect(data.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(data.projects[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(data.projects[1].createdAt).toBeNull();
    expect(data.projects[1].branches).toEqual([{ name: 'development', protected: true }]);
    expect(data.projects[0].repos?.map((r) => r.name)).toEqual(['web']);
    expect(data.index).toEqual({ rows: [], skipped: [], coveredProjectIds: ['p1', 'p2'] });
    expect(data.members).toEqual([]);
    expect(data.reposShown).toBe(true);
  });

  test('a member: the index, repo links and member list answer 403, so each is null (hidden), not empty', async () => {
    const data = await loadScreenData(fakeClient({ index: forbidden, repos: forbidden, members: forbidden }), 'o');
    expect(data.index).toBeNull();
    expect(data.members).toBeNull();
    expect(data.reposShown).toBe(false);
    expect(data.projects.every((p) => p.repos === undefined)).toBe(true);
  });

  test('a project admin: repos are attached only to the projects they administer', async () => {
    const data = await loadScreenData(fakeClient({ me: () => ({ user_id: 'u', role: 'project-admin', admin_projects: [{ id: 'p1', name: 'web' }] }) }), 'o');
    expect(data.projects[0].repos).toBeDefined();
    expect(data.projects[1].repos).toBeUndefined();
    expect(data.index?.coveredProjectIds).toEqual(['p1']);
  });

  test('a failure that is not a 403 still fails the screen', async () => {
    const broken = (): never => {
      throw new CapyError('boom', ERROR_CODES.SERVICE_ERROR, { status: 500 });
    };
    await expect(loadScreenData(fakeClient({ index: broken }), 'o')).rejects.toBeInstanceOf(CapyError);
  });

  test('coverage unknown when /me cannot be read', async () => {
    const data = await loadScreenData(fakeClient({ me: forbidden }), 'o');
    expect(data.index?.coveredProjectIds).toBeNull();
  });
});
