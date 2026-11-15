// The side effects of the Settings and Capy Branches tabs of `capy projects`:
// list and revoke deploy tokens, protect / unprotect / delete a branch, grant or
// revoke a member's access to a protected branch. The rules are the service's
// (project admins only; `development` is never protected or deleted); a
// refusal comes back coded and is shown in its words.
//
// Revoking a token does what `capy deploy revoke` does, from no folder: the
// revoke, then the keep-only upload that strips that deploy's records from the
// project's keep (on every branch that has them: the screen has no "active
// branch"). Each project folder's keep.lock picks the change up on its next sync.

import { CapyError, ERROR_CODES } from '../types/index';
import type { MemberDetail, ServiceClient } from '../service/serviceClient';
import { uploadKeepOnly } from '../sync/commit';
import { stripTargetsForDeployId } from '../deploy/targetsGate';
import type { BranchRef, ManageFinished, ManageProjectRef, ManageRefusal, TokenRow, AccessRow } from '../ui/projectManage';

/** What the two tabs need. No function ever rejects: a failure comes back as a coded refusal. */
export interface ProjectManageActions {
  readonly loadTokens: (project: ManageProjectRef) => Promise<{ readonly ok: true; readonly tokens: readonly TokenRow[] } | { readonly ok: false; readonly refusal: ManageRefusal }>;
  readonly revokeToken: (project: ManageProjectRef, token: TokenRow) => Promise<ManageFinished>;
  readonly setProtected: (project: ManageProjectRef, branch: BranchRef, protect: boolean) => Promise<ManageFinished>;
  readonly deleteBranch: (project: ManageProjectRef, branch: BranchRef) => Promise<ManageFinished>;
  readonly setAccess: (project: ManageProjectRef, branch: BranchRef, user: AccessRow, grant: boolean) => Promise<ManageFinished>;
}

type ManageServiceClient = Pick<
  ServiceClient,
  | 'listDeployTokens'
  | 'revokeDeployToken'
  | 'listMemberDetails'
  | 'listBranches'
  | 'setBranchProtected'
  | 'deleteBranch'
  | 'grantProtectedBranch'
  | 'revokeProtectedBranch'
  | 'getLatestSecrets'
  | 'pushSecrets'
>;

/** A failure as the screen shows it: its code (never parsed) and its message (shown, never parsed). */
function refusalOf(err: unknown): ManageRefusal {
  if (err instanceof CapyError) return { code: err.code, message: err.message };
  return { code: ERROR_CODES.SERVICE_ERROR, message: err instanceof Error ? err.message : String(err) };
}

export function createProjectManageActions(serviceClient: ManageServiceClient, orgId: string): ProjectManageActions {
  /** Who made each token: their email when the org's users can be read, else their user id. */
  const emailsById = async (): Promise<ReadonlyMap<string, string>> => {
    try {
      const { members } = await serviceClient.listMemberDetails(orgId);
      return new Map(members.map((m) => [m.userId, m.email] as const));
    } catch {
      return new Map();
    }
  };

  const liveTokens = async (projectId: string): Promise<readonly TokenRow[]> => {
    const [{ tokens }, emails] = await Promise.all([serviceClient.listDeployTokens(orgId, projectId), emailsById()]);
    return tokens
      .filter((t) => t.revoked_at === null)
      .map((t) => ({ deployId: t.deploy_id, label: t.label, createdBy: emails.get(t.created_by) ?? t.created_by, createdAt: t.created_at }));
  };

  const branchesOf = async (projectId: string): Promise<readonly BranchRef[]> =>
    (await serviceClient.listBranches(projectId)).map((b) => ({ id: b.id, name: b.name, protected: b.is_protected }));

  const membersOrUndefined = async (): Promise<readonly MemberDetail[] | undefined> => {
    try {
      return (await serviceClient.listMemberDetails(orgId)).members;
    } catch {
      return undefined;
    }
  };

  /** Runs `change`; any throw becomes the refusal. */
  const settle = async (change: () => Promise<ManageFinished>): Promise<ManageFinished> => {
    try {
      return await change();
    } catch (err) {
      return { ok: false, refusal: refusalOf(err) };
    }
  };

  /** Best effort, never failing the revoke: the deploy's records stripped from the keep on each branch that has them. */
  const stripRevoked = async (projectId: string, deployId: string): Promise<void> => {
    try {
      const branches = await branchesOf(projectId);
      await branches.reduce<Promise<void>>(
        (prev, b) => prev.then(async () => {
          await uploadKeepOnly(serviceClient, projectId, b.name, (keep) => stripTargetsForDeployId(keep, deployId));
        }),
        Promise.resolve(),
      );
    } catch {
      // The revoke itself already happened; a stale record only shows as a target until the next deploy.
    }
  };

  return {
    loadTokens: async (project) => {
      try {
        return { ok: true, tokens: await liveTokens(project.id) };
      } catch (err) {
        return { ok: false, refusal: refusalOf(err) };
      }
    },
    revokeToken: (project, token) =>
      settle(async () => {
        await serviceClient.revokeDeployToken(token.deployId);
        await stripRevoked(project.id, token.deployId);
        const tokens = await liveTokens(project.id).catch(() => undefined);
        return {
          ok: true,
          lines: [`Deploy token ${token.deployId.slice(0, 12)}... revoked.`], // reused from `capy deploy revoke`
          ...(tokens === undefined ? {} : { tokens }),
        };
      }),
    setProtected: (project, branch, protect) =>
      settle(async () => {
        await serviceClient.setBranchProtected(project.id, branch.id, protect);
        return {
          ok: true,
          lines: [protect ? `Protected ${branch.name}.` : `Unprotected ${branch.name}.`], // COPY-FLAG
          branches: await branchesOf(project.id),
        };
      }),
    deleteBranch: (project, branch) =>
      settle(async () => {
        await serviceClient.deleteBranch(project.id, branch.id);
        return { ok: true, lines: [`Deleted branch "${branch.name}"`], branches: await branchesOf(project.id) }; // reused from `capy branch -D`
      }),
    setAccess: (project, branch, user, grant) =>
      settle(async () => {
        if (grant) await serviceClient.grantProtectedBranch(orgId, project.id, branch.id, user.userId);
        else await serviceClient.revokeProtectedBranch(orgId, project.id, branch.id, user.userId);
        const members = await membersOrUndefined();
        return {
          ok: true,
          lines: [grant ? `${user.email} can now use ${branch.name}.` : `${user.email} can no longer use ${branch.name}.`], // COPY-FLAG
          ...(members === undefined ? {} : { members }),
        };
      }),
  };
}
