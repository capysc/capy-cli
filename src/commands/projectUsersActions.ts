// The side effects of the Users tab of `capy projects`: invite by email,
// change a project role, remove from the project. The rules are the
// service's: it refuses anyone without admin access to the project, the
// owner's role, and a change to your own role; a refusal comes back coded and
// is shown in its words.
//
// Invite by email: someone already in the org is added to the project at once
// (`POST /orgs/:orgId/projects/:projectId/members`). Someone new gets `capy
// invite`'s invite (the same `wrapAndCreateInvite`), scoped to this project:
// the org key wrapped for them, and the redeem command to send them. Adding a
// new person through the project route instead would make them a member with
// no key, so it is never used for one.

import { hasOrgKey } from '../config/globalConfig';
import { CapyError, ERROR_CODES } from '../types/index';
import type { MemberDetail, ServiceClient } from '../service/serviceClient';
import { PROJECT_ROLE_LABELS, type ProjectRole, type UserTarget, type UsersFinished, type UsersProjectRef } from '../ui/projectUsers';
import { defaultInviteNotAfter, unwrapInviterKey, wrapAndCreateInvite } from './inviteCommand';

/** What the Users tab needs. No function ever rejects: a failure comes back as a coded refusal. */
export interface ProjectUsersActions {
  readonly invite: (project: UsersProjectRef, email: string, role: ProjectRole) => Promise<UsersFinished>;
  readonly changeRole: (project: UsersProjectRef, target: UserTarget, role: ProjectRole) => Promise<UsersFinished>;
  readonly remove: (project: UsersProjectRef, target: UserTarget) => Promise<UsersFinished>;
}

type UsersServiceClient = Pick<
  ServiceClient,
  'listMemberDetails' | 'inviteToProject' | 'changeRole' | 'kickFromProject' | 'createInvite' | 'wrapOuterLayer' | 'coDecrypt'
>;

/** A failure as the screen shows it: its code (never parsed) and its message (shown, never parsed). */
function refusalOf(err: unknown): UsersFinished {
  if (err instanceof CapyError) return { ok: false, refusal: { code: err.code, message: err.message } };
  return { ok: false, refusal: { code: ERROR_CODES.SERVICE_ERROR, message: err instanceof Error ? err.message : String(err) } };
}

export function createProjectUsersActions(serviceClient: UsersServiceClient, orgId: string, userId: string): ProjectUsersActions {
  /** The org's users read again after a change; `null` when that read fails (the screen keeps what it had). */
  const reload = async (): Promise<readonly MemberDetail[] | null> => {
    try {
      return (await serviceClient.listMemberDetails(orgId)).members;
    } catch {
      return null;
    }
  };

  /** Runs `change`, then reads the users again: the finished result, or the refusal. */
  const settle = async (change: () => Promise<{ lines: readonly string[]; redeemCommand?: string }>): Promise<UsersFinished> => {
    try {
      const done = await change();
      return { ok: true, lines: done.lines, members: await reload(), ...(done.redeemCommand === undefined ? {} : { redeemCommand: done.redeemCommand }) };
    } catch (err) {
      return refusalOf(err);
    }
  };

  /** Someone new: `capy invite`'s invite, scoped to this project. */
  const inviteNewPerson = async (project: UsersProjectRef, email: string, role: ProjectRole): Promise<{ lines: readonly string[]; redeemCommand: string }> => {
    if (!hasOrgKey(orgId, userId)) {
      throw new CapyError('No master key found for this organization. Only the org owner can invite.', ERROR_CODES.PERMISSION_DENIED); // reused from `capy invite`
    }
    const masterKey = await unwrapInviterKey(orgId, userId, serviceClient);
    const notAfter = defaultInviteNotAfter();
    const { redeemCode } = await wrapAndCreateInvite({ orgId, email, role, projectId: project.id, masterKey, notAfter, serviceClient });
    return {
      lines: [
        `Invite created for ${email} as ${PROJECT_ROLE_LABELS[role]}`, // reused from `capy invite`
        `Expires ${new Date(notAfter).toISOString()}.`, // reused from `capy invite`
      ],
      redeemCommand: `capy redeem ${redeemCode}`,
    };
  };

  return {
    invite: (project, email, role) =>
      settle(async () => {
        const { members } = await serviceClient.listMemberDetails(orgId);
        const existing = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
        if (existing === undefined) return inviteNewPerson(project, email, role);
        await serviceClient.inviteToProject(orgId, project.id, email, role);
        return { lines: [`Added ${email} to ${project.name} as ${PROJECT_ROLE_LABELS[role]}.`] }; // COPY-FLAG
      }),
    changeRole: (project, target, role) =>
      settle(async () => {
        await serviceClient.changeRole(orgId, target.userId, role, project.id);
        return { lines: [`Changed ${target.email} to ${PROJECT_ROLE_LABELS[role]} in ${project.name}.`] }; // COPY-FLAG
      }),
    remove: (project, target) =>
      settle(async () => {
        await serviceClient.kickFromProject(orgId, project.id, target.userId);
        return { lines: [`Removed ${target.email} from ${project.name}.`] }; // COPY-FLAG
      }),
  };
}
