import { AuthService } from '../auth/authService';
import { ServiceClient, MemberDetail } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';
import { excludeSystemProject } from '../system/reservedProjectName';
import { AuthResult } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class UsersCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  /**
   * Non-interactive helper: resolve org, authenticate, and invoke the same
   * service-client methods the interactive TUI dispatches to. Used by the
   * `capy grant-branch` / `capy revoke-branch` subcommands so CI and the E2E
   * harness can exercise the protected-branch grant flow without a TTY.
   */
  private async resolveContext(): Promise<{
    orgId: string;
    serviceClient: ServiceClient;
  }> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }
    const orgId = projectState.organizationId;

    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    let authResult = await authService.authenticateSilent(orgId);
    if (!authResult.success) authResult = await authService.authenticateSilent();
    if (!authResult.success) authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }

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
      console.error(`No member with email "${email}" in this organization.`);
      process.exit(1);
    }
    return { projectId: project.id, branchId: (branch as any).id, userId: member.userId };
  }

  /** Silent (this org, then any cached session) before falling back to interactive OAuth. Exits on failure. */
  private async authenticateForUsersOrExit(authService: AuthService, orgId: string): Promise<AuthResult> {
    const forThisOrg = await authService.authenticateSilent(orgId);
    if (forThisOrg.success) return forThisOrg;
    const anyCached = await authService.authenticateSilent();
    if (anyCached.success) return anyCached;
    const interactive = await authService.authenticate(orgId);
    if (interactive.success) return interactive;
    console.error('Authentication failed');
    process.exit(1);
  }

  /** Loads the member list + the caller's own role, reporting spinner success/failure. Exits on failure. */
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
      spinner?.succeed(`${result.members.length} member${result.members.length !== 1 ? 's' : ''}`);
      return { members: result.members, callerRole: me.role, currentUserId: me.user_id };
    } catch (err: any) {
      spinner?.fail('Failed to load members');
      console.error(`  ${err.message}`);
      process.exit(1);
    }
  }

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }

    const orgId = projectState.organizationId;

    // Authenticate — silent first (cached / refresh for this org, then any
    // cached session) before falling back to interactive OAuth. Mirrors the
    // pattern in capyCommand so a stale per-org token doesn't trigger a relog
    // when another org's session is still valid.
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    await this.authenticateForUsersOrExit(authService, orgId);

    // Fetch member details. In --json mode emit NO progress at all so stdout stays
    // pure JSON even on a TTY (the Spinner already routes to stderr when piped; this
    // also covers an interactive run). CAP-273.
    const spinner = opts.json ? null : new Spinner('Loading members...');
    spinner?.start();
    const { members, callerRole, currentUserId } = await this.loadMembersOrExit(serviceClient, orgId, spinner);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            members: members.map((m: any) => ({
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
      console.log('\n  No members found.\n');
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
