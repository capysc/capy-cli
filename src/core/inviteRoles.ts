/**
 * The roles an invite can grant, with the name each picker shows and one short line on what the role can
 * access. One place, so `capy invite` and the Users tab of `capy projects` cannot say different things.
 *
 * The values are the service's own (`--role` takes them). Nothing here decides who may grant what: the
 * pickers filter by the caller's role, and the service is the judge.
 */

/** A role an invite can grant (the service's own values). */
export type InviteRole = 'member' | 'project-admin' | 'admin';

/** Names as the pickers and the result lines show them. */
export const INVITE_ROLE_LABELS: Readonly<Record<InviteRole, string>> = {
  member: 'Member',
  'project-admin': 'Project Admin',
  admin: 'Admin',
};

/** What each role can access, in a few words (approved wording). */
export const INVITE_ROLE_DESCRIPTIONS: Readonly<Record<InviteRole, string>> = {
  member: 'no access to protected branches',
  'project-admin': 'access to all branches, invite users to project',
  admin: 'access to all projects',
};

/** What sits between a role's name and its description. */
export const INVITE_ROLE_SEPARATOR = ' - ';

const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

/** What goes beside a role's name: the separator and the description, in grey. */
export function inviteRoleAbout(role: InviteRole): string {
  return `${GREY}${INVITE_ROLE_SEPARATOR}${INVITE_ROLE_DESCRIPTIONS[role]}${RESET}`;
}

/** A picker line for `role`: its name, then its description in grey. */
export function inviteRoleChoiceText(role: InviteRole): string {
  return `${INVITE_ROLE_LABELS[role]}${inviteRoleAbout(role)}`;
}

/** Org roles that may grant `admin` (the service's own role values). */
const ADMIN_GRANTING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Whether a caller with org role `callerRole` may invite an org admin. */
export const mayInviteAdmin = (callerRole: string | undefined): boolean =>
  callerRole !== undefined && ADMIN_GRANTING_ROLES.has(callerRole);
