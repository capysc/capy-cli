import { describe, it, expect, spyOn, mock, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `capy users`, `capy grant-branch` and `capy revoke-branch` in a folder with no keep.lock.
 *
 * They act on the organization, so they resolve it the way `capy kick` and `capy invite` do (`resolveOrgContext`)
 * and never refuse for a missing keep.lock. Only org resolution is replaced; the service client is a fake.
 * `mock.module()` is process-wide: tests/run-tests.sh runs this file isolated.
 */

import { CapyError, ERROR_CODES } from '../../src/types/index';

const member = { membershipId: 'm_1', userId: 'u_1', email: 'dev@x.co', role: 'member', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', projects: [] };

const serviceClient = {
  listMemberDetails: mock(async () => ({ members: [member] })),
  getOrgMe: mock(async () => ({ role: 'owner', user_id: 'u_owner' })),
  listProjects: mock(async () => [{ id: 'p1', name: 'web', organization_id: 'org_1' }]),
  listBranches: mock(async () => [{ id: 'b1', name: 'prod' }]),
  grantProtectedBranch: mock(async () => ({})),
  revokeProtectedBranch: mock(async () => ({})),
};

const resolveOrgContext = mock(async (..._args: unknown[]): Promise<unknown> => ({ orgId: 'org_1', orgName: 'Acme', userId: 'u_owner', authService: {}, serviceClient }));
mock.module('../../src/core/orgContext', () => ({ resolveOrgContext }));

afterAll(() => {
  mock.restore();
});

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(fn: () => Promise<void>): Promise<Captured> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);
  const stdout = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode: thrown instanceof ExitSignal ? thrown.code : undefined, stdout, stderr };
}

const home = process.cwd();

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'capy-users-nofolder-')));
  resolveOrgContext.mockClear();
  serviceClient.grantProtectedBranch.mockClear();
  serviceClient.revokeProtectedBranch.mockClear();
});

afterEach(() => {
  const folder = process.cwd();
  process.chdir(home);
  rmSync(folder, { recursive: true, force: true });
});

describe('in a folder with no keep.lock', () => {
  it('capy users --json lists the org users', async () => {
    expect(existsSync('keep.lock')).toBe(false);
    const { UsersCommand } = await import('../../src/commands/usersCommand');
    const out = await capture(() => new UsersCommand().execute({ json: true }));
    expect(out.exitCode).toBeUndefined();
    expect(JSON.parse(out.stdout).users.map((u: { email: string }) => u.email)).toEqual(['dev@x.co']);
    expect(out.stderr).toBe('');
    // --json never opens the org picker.
    expect(resolveOrgContext.mock.calls[0][2]).toEqual({ promptForOrg: false });
  });

  it('capy users --json with several orgs and none named refuses with the code and the orgs', async () => {
    const orgs = [{ id: 'org_1', name: 'Acme' }, { id: 'org_2', name: 'Other' }];
    resolveOrgContext.mockImplementationOnce(async () => {
      throw new CapyError('pick one', ERROR_CODES.ORG_SELECTION_REQUIRED, { orgs });
    });
    const { UsersCommand } = await import('../../src/commands/usersCommand');
    const out = await capture(() => new UsersCommand().execute({ json: true }));
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'ORG_SELECTION_REQUIRED', orgs });
  });

  it('capy grant-branch grants by email, project name and branch name', async () => {
    const { UsersCommand } = await import('../../src/commands/usersCommand');
    const out = await capture(() => new UsersCommand().grantBranch('dev@x.co', 'web', 'prod'));
    expect(out.exitCode).toBeUndefined();
    expect(serviceClient.grantProtectedBranch.mock.calls).toEqual([['org_1', 'p1', 'b1', 'u_1']] as never);
  });

  it('capy revoke-branch revokes by email, project name and branch name', async () => {
    const { UsersCommand } = await import('../../src/commands/usersCommand');
    const out = await capture(() => new UsersCommand().revokeBranch('dev@x.co', 'web', 'prod'));
    expect(out.exitCode).toBeUndefined();
    expect(serviceClient.revokeProtectedBranch.mock.calls).toEqual([['org_1', 'p1', 'b1', 'u_1']] as never);
  });
});
