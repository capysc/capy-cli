import { ServiceClient, MemberDetail } from '../service/serviceClient';
import { resolveOrgContext, type OrgContext } from '../core/orgContext';
import { exitOrgSelectionRequired, isOrgSelectionRequired } from '../core/orgSelection';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';
import { excludeSystemProject } from '../system/reservedProjectName';

export class UsersCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  /**
   * The org and a signed-in client for `capy grant-branch` / `capy revoke-branch`: the folder's own org when it
   * has a keep.lock, otherwise the only org or the one picked (`resolveOrgContext`). No project folder is needed:
   * the project and the branch are arguments.
   */
  private async resolveContext(): Promise<{
    orgId: string;
    serviceClient: ServiceClient;
  }> {
    const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
    return { orgId, serviceClient };
  }

  /** `capy grant-branch <email> <project> <branch>` */
  async grantBranch(email: string, projectName: string, branchName: string): Promise<void> {
    const { orgId, serviceClient } = await this.resolveContext();
    const ids = await this.resolveBranchGrantIds(orgId, serviceClient, email, projectName, branchName);
    await serviceClient.grantProtectedBranch(orgId, ids.projectId, ids.branchId, ids.userId);
    console.log(`Granted ${email} access to ${projectName}/${branchName}`);
  }

  /** `capy revoke-branch <email> <project> <branch>` */
  async revokeBranch(email: string, projectName: string, branchName: string): Promise<void> {
    const { orgId, serviceClient } = await this.resolveContext();
    const ids = await this.resolveBranchGrantIds(orgId, serviceClient, email, projectName, branchName);
    await serviceClient.revokeProtectedBranch(orgId, ids.projectId, ids.branchId, ids.userId);
    console.log(`Revoked ${email}'s access to ${projectName}/${branchName}`);
  }

  private async resolveBranchGrantIds(
    orgId: string,
    serviceClient: ServiceClient,
    email: string,
    projectName: string,
    branchName: string,
  ): Promise<{ projectId: string; branchId: string; userId: string }> {
    const [rawProjects, memberDetails] = await Promise.all([
      serviceClient.listProjects(),
      serviceClient.listMemberDetails(orgId),
    ]);
    const projects = excludeSystemProject(rawProjects);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      console.error(`Project "${projectName}" not found in this organization.`);
      process.exit(1);
    }
    const branches = await serviceClient.listBranches(project.id);
    const branch = branches.find((b: any) => b.name === branchName);
    if (!branch) {
      console.error(`Branch "${branchName}" not found in project "${projectName}".`);
      process.exit(1);
    }
    const member = memberDetails.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
    if (!member) {
      console.error(`No user with email "${email}" in this organization.`); // COPY-FLAG: was "member"
      process.exit(1);
    }
    return { projectId: project.id, branchId: (branch as any).id, userId: member.userId };
  }

  /**
   * The org for `capy users`. With `--json` nothing is ever asked: when this folder names no org and the person
   * belongs to several, the refusal is JSON on stdout with the code, the orgs and the pick as a form, and the exit code is 3.
   */
  private async orgContextOrExit(json: boolean): Promise<OrgContext> {
    try {
      return await resolveOrgContext(this.apiUrl, this.devMode, { promptForOrg: !json });
    } catch (err) {
      if (!json || !isOrgSelectionRequired(err)) throw err;
      return exitOrgSelectionRequired(err);
    }
  }

  /**
   * Loads the org's users + the caller's own role. The spinner clears on success (the table that follows
   * says how many there are); on failure it says so. Exits on failure.
   */
  private async loadMembersOrExit(
    serviceClient: ServiceClient,
    orgId: string,
    spinner: Spinner | null,
  ): Promise<{ members: MemberDetail[]; callerRole: string; currentUserId: string }> {
    try {
      const [result, me] = await Promise.all([
        serviceClient.listMemberDetails(orgId),
        serviceClient.getOrgMe(orgId),
      ]);
      spinner?.stop();
      return { members: result.members, callerRole: me.role, currentUserId: me.user_id };
    } catch (err: any) {
      spinner?.fail('Failed to load users'); // COPY-FLAG: was "members" ("member" is only the role)
      console.error(`  ${err.message}`);
      process.exit(1);
    }
  }

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    // The users are the organization's, not a project's: the folder's own org when it has a keep.lock, otherwise
    // the only org or the one picked. No project folder is needed.
    const { orgId, serviceClient } = await this.orgContextOrExit(opts.json === true);

    // Fetch the users. In --json mode emit NO progress at all so stdout stays
    // pure JSON even on a TTY (the Spinner already routes to stderr when piped; this
    // also covers an interactive run). CAP-273.
    const spinner = opts.json ? null : new Spinner('Loading users...'); // COPY-FLAG: was "members"
    spinner?.start();
    const { members, callerRole, currentUserId } = await this.loadMembersOrExit(serviceClient, orgId, spinner);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            // `users`: "member" names only the role (`role: "member"`).
            users: members.map((m: any) => ({
              membershipId: m.membershipId,
              userId: m.userId,
              email: m.email,
              role: m.role,
              status: m.status,
              joinedAt: m.createdAt,
              projects: (m.projects || []).map((p: any) => ({
                id: p.id,
                name: p.name,
                role: p.role ?? null,
                branches: (p.branches || []).map((b: any) => ({
                  id: b.id,
                  name: b.name,
                  isProtected: b.isProtected,
                  hasAccess: b.hasAccess,
                })),
              })),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (members.length === 0) {
      console.log('\n  No users found.\n'); // COPY-FLAG: was "members"
      return;
    }

    // Launch TUI or static fallback
    const table = new InteractiveTable();
    if (process.stdin.isTTY) {
      await table.run(members, {
        callerRole,
        currentUserId,
        listProjects: async () => {
          const projects = excludeSystemProject(await serviceClient.listProjects());
          return projects.map((p) => ({ id: p.id, name: p.name }));
        },
        changeRole: async (userId, newRole, projectId) => {
          await serviceClient.changeRole(orgId, userId, newRole, projectId);
        },
        assignProjectRole: async (projectId, email, role) => {
          await serviceClient.inviteToProject(orgId, projectId, email, role);
        },
        removeProjectRole: async (projectId, userId) => {
          await serviceClient.kickFromProject(orgId, projectId, userId);
        },
        grantProtectedBranch: async (projectId, branchId, userId) => {
          await serviceClient.grantProtectedBranch(orgId, projectId, branchId, userId);
        },
        revokeProtectedBranch: async (projectId, branchId, userId) => {
          await serviceClient.revokeProtectedBranch(orgId, projectId, branchId, userId);
        },
        reload: async () => {
          const result = await serviceClient.listMemberDetails(orgId);
          return result.members;
        },
      });
    } else {
      console.log(table.renderStatic(members));
    }
  }
}
