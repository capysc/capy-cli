import { describe, expect, mock, test } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { createProjectDeleteActions } from '../../src/commands/projectDeleteActions';

/**
 * The delete side effects of the `capy projects` screen reuse `capy project
 * delete`: the same summary, a DELETE that is never forced, and the same coded
 * refusals (decided by code, never by message text).
 */

const ORG = { id: 'org_1', name: 'Acme' };
const WEB = { id: 'p1', name: 'web' };

interface FakeOpts {
  readonly deleteProject?: (orgId: string, projectId: string, force: boolean) => Promise<unknown>;
  readonly tokens?: () => Promise<unknown>;
}

function fakeClient(opts: FakeOpts = {}) {
  const deleteProject = mock(async (orgId: string, projectId: string, force: boolean) =>
    (opts.deleteProject ?? (async () => ({ ok: true, project: { id: projectId, name: 'web', deleted_at: 'x' }, live_deploy_tokens: [] })))(orgId, projectId, force));
  const client = {
    deleteProject,
    listDeployTokens: async () =>
      (opts.tokens ?? (async () => ({ tokens: [
        { deploy_id: 'dep_live', label: 'prod', created_by: 'u', created_at: '2026-01-01', revoked_at: null },
        { deploy_id: 'dep_old', label: null, created_by: 'u', created_at: '2026-01-01', revoked_at: '2026-02-01' },
      ] })))(),
    listBranches: async () => [{ id: 'b1', name: 'development' }],
    getLatestSecrets: async () => null,
  };
  return { client: client as never, calls: deleteProject.mock.calls };
}

describe('createProjectDeleteActions', () => {
  test('preview: capy project delete\'s summary — the project, the org, live tokens only', async () => {
    const { client } = fakeClient();
    const preview = await createProjectDeleteActions(client, ORG).preview(WEB);
    if (!preview.ok) throw new Error('expected the summary');
    const text = preview.lines.join('\n');
    expect(text).toContain('Project: web (p1)');
    expect(text).toContain('Organization: Acme');
    expect(text).toContain('Live deploy tokens: 1');
    expect(text).toContain('dep_live');
    expect(text).not.toContain('dep_old');
  });

  test('run: deletes without --force and says how to restore', async () => {
    const { client, calls } = fakeClient();
    const done = await createProjectDeleteActions(client, ORG).run(WEB);
    expect(calls).toEqual([['org_1', 'p1', false]]);
    expect(done).toEqual({ ok: true, lines: ['Deleted project web.', 'An owner can restore it with: capy project restore p1'] });
  });

  test('live deploy tokens: refused with the code, the tokens, and the exact --force command', async () => {
    const { client } = fakeClient({
      deleteProject: async () => {
        throw new CapyError('irrelevant words', ERROR_CODES.PROJECT_HAS_LIVE_DEPLOY_TOKENS, {
          status: 409,
          data: { live_deploy_tokens: [{ deploy_id: 'dep_live', label: 'prod', created_at: '2026-01-01' }] },
        });
      },
    });
    const done = await createProjectDeleteActions(client, ORG).run(WEB);
    if (done.ok) throw new Error('expected a refusal');
    expect(done.refusal.code).toBe('PROJECT_HAS_LIVE_DEPLOY_TOKENS');
    expect(done.refusal.message).toBe('This project has live deploy tokens.');
    expect(done.refusal.lines.join('\n')).toContain('dep_live');
    expect(done.refusal.lines.at(-1)).toBe('capy project delete p1 --force');
  });

  test('not an org owner: the service\'s owner-only code comes through', async () => {
    const { client } = fakeClient({
      deleteProject: async () => {
        throw new CapyError('Only an org owner can delete a project.', ERROR_CODES.PERMISSION_DENIED, { status: 403, code: 'PROJECT_DELETE_OWNER_ONLY' });
      },
    });
    const done = await createProjectDeleteActions(client, ORG).run(WEB);
    if (done.ok) throw new Error('expected a refusal');
    expect(done.refusal.code).toBe('PROJECT_DELETE_OWNER_ONLY');
    expect(done.refusal.lines).toEqual([]);
  });

  test('a summary that cannot be read comes back as a refusal, never a rejection', async () => {
    const { client } = fakeClient({ tokens: async () => { throw new CapyError('x', ERROR_CODES.PERMISSION_DENIED, { status: 403 }); } });
    const preview = await createProjectDeleteActions(client, ORG).preview(WEB);
    expect(preview.ok).toBe(false);
  });
});
