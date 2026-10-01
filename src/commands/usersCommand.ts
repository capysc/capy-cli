import { AuthService } from '../auth/authService';
import { ServiceClient, MemberDetail } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';
import { excludeSystemProject } from '../system/reservedProjectName';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { dryRunOk, dryRunExitCode, printDryRunResultHuman, printDryRunResultJson, type DryRunChange } from '../core/dryRun';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Pure JSON refusal on stdout — never on stderr, so `--json` output stays parseable. */
function refuseJson(code: string, error: string, exitCode: number): never {
  console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  process.exit(exitCode);
}

/** Prose refusal on stderr — human mode only. */
function refuseHuman(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function refuse(json: boolean, err: CapyError, exitCode: number = 1): never {
  if (json) refuseJson(err.code, err.message, exitCode);
  refuseHuman(err.message, exitCode);
}

/** `-y, --yes, --non-tty, --json` options shared by `grant-branch`/`revoke-branch`. */
export interface ProtectedBranchOpts {
  yes?: boolean;
  nonTty?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

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
  private async resolveContext(json: boolean): Promise<{
    orgId: string;
    serviceClient: ServiceClient;
  }> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      refuse(json, new CapyError(`No keep.lock file found. Run ${B('capy')} first to initialize.`, ERROR_CODES.NO_KEEP_FILE));
    }
    const orgId = projectState.organizationId;

    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    await this.authenticateOrRefuse(authService, orgId, json);

    return { orgId, serviceClient };
  }

  /** Silent (this org, then any cached session) before falling back to interactive OAuth. Refuses coded on failure. */
  private async authenticateOrRefuse(authService: AuthService, orgId: string, json: boolean): Promise<AuthResult> {
    const forThisOrg = await authService.authenticateSilent(orgId);
    if (forThisOrg.success) return forThisOrg;
    const anyCached = await authService.authenticateSilent();
    if (anyCached.success) return anyCached;
    const interactive = await authService.authenticate(orgId);
    if (interactive.success) return interactive;
    refuse(json, new CapyError('Authentication failed', ERROR_CODES.AUTH_FAILED));
  }

  /** `capy grant-branch <email> <project> <branch>` */
  async grantBranch(email: string, projectName: string, branchName: string, opts: ProtectedBranchOpts = {}): Promise<void> {
    await this.protectedBranchAction('grant', email, projectName, branchName, opts);
  }

  /** `capy revoke-branch <email> <project> <branch>` */
  async revokeBranch(email: string, projectName: string, branchName: string, opts: ProtectedBranchOpts = {}): Promise<void> {
    await this.protectedBranchAction('revoke', email, projectName, branchName, opts);
  }

  /** Shared by `grant-branch`/`revoke-branch`: resolve ids, preview or confirm, then call the one action that differs. */
  private async protectedBranchAction(
    kind: 'grant' | 'revoke',
    email: string,
    projectName: string,
    branchName: string,
    opts: ProtectedBranchOpts,
  ): Promise<void> {
    const json = opts.json === true;

    if (opts.dryRun) {
      const { orgId, serviceClient } = await this.resolveContext(json);
      // Resolved only for its refusal codes (unknown project/branch/member) —
      // the preview names what argv already said, not the ids.
      await this.resolveBranchGrantIds(orgId, serviceClient, email, projectName, branchName, json);
      const changes: DryRunChange[] = [
        {
          where: 'capy_service',
          action: kind === 'grant' ? 'grant protected-branch access' : 'revoke protected-branch access',
          target: `${email} → ${projectName}/${branchName}`,
          reversible: true,
        },
      ];
      const unanswered = opts.yes ? [] : [{ id: 'confirm', flag: '-y, --yes' }];
      const result = dryRunOk(kind === 'grant' ? 'grant-branch' : 'revoke-branch', changes, unanswered);
      if (json) printDryRunResultJson(result);
      else printDryRunResultHuman(result);
      process.exit(dryRunExitCode(result));
    }

    if (!opts.yes && !isInteractive(opts.nonTty)) {
      refuse(
        json,
        new CapyError(
          `\`capy ${kind}-branch\` needs confirmation — pass --yes or run this in a terminal.`, // COPY-FLAG
          ERROR_CODES.PROTECTED_BRANCH_NEEDS_TTY,
        ),
        EXIT_NEEDS_INPUT,
      );
    }

    const { orgId, serviceClient } = await this.resolveContext(json);
    const ids = await this.resolveBranchGrantIds(orgId, serviceClient, email, projectName, branchName, json);

    const confirmed = opts.yes || (await this.confirmProtectedBranchChange(kind, email, projectName, branchName));
    if (!confirmed) {
      if (json) {
        console.log(JSON.stringify({ ok: true, cancelled: true }, null, 2));
        return;
      }
      console.log('Cancelled.'); // COPY-FLAG
      return;
    }

    try {
      if (kind === 'grant') {
        await serviceClient.grantProtectedBranch(orgId, ids.projectId, ids.branchId, ids.userId);
      } else {
        await serviceClient.revokeProtectedBranch(orgId, ids.projectId, ids.branchId, ids.userId);
      }
    } catch (err: any) {
      refuse(json, new CapyError(err.message ?? String(err), ERROR_CODES.SERVICE_ERROR));
    }

    if (json) {
      console.log(JSON.stringify({ ok: true, email, project: projectName, branch: branchName }, null, 2));
      return;
    }
    console.log(
      kind === 'grant'
        ? `Granted ${email} access to ${projectName}/${branchName}`
        : `Revoked ${email}'s access to ${projectName}/${branchName}`,
    );
  }

  private async confirmProtectedBranchChange(
    kind: 'grant' | 'revoke',
    email: string,
    projectName: string,
    branchName: string,
  ): Promise<boolean> {
    const inquirer = (await import('inquirer')).default;
    const verb = kind === 'grant' ? 'Grant' : 'Revoke';
    const prep = kind === 'grant' ? 'to' : 'from';
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `${verb} ${email}'s wildcard access ${prep} ${projectName}/${branchName}?`, // COPY-FLAG
      default: false,
    }]);
    return confirmed === true;
  }

  private async resolveBranchGrantIds(
    orgId: string,
    serviceClient: ServiceClient,
    email: string,
    projectName: string,
    branchName: string,
    json: boolean,
  ): Promise<{ projectId: string; branchId: string; userId: string }> {
    const [rawProjects, memberDetails] = await Promise.all([
      serviceClient.listProjects(),
      serviceClient.listMemberDetails(orgId),
    ]);
    const projects = excludeSystemProject(rawProjects);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      refuse(json, new CapyError(`Project "${projectName}" not found in this organization.`, ERROR_CODES.PROJECT_NOT_FOUND));
    }
    const branches = await serviceClient.listBranches(project.id);
    const branch = branches.find((b) => b.name === branchName);
    if (!branch) {
      refuse(json, new CapyError(`Branch "${branchName}" not found in project "${projectName}".`, ERROR_CODES.BRANCH_NOT_FOUND));
    }
    const member = memberDetails.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
    if (!member) {
      refuse(json, new CapyError(`No member with email "${email}" in this organization.`, ERROR_CODES.MEMBER_NOT_FOUND));
    }
    return { projectId: project.id, branchId: branch.id, userId: member.userId };
  }

  /** Loads the member list + the caller's own role, reporting spinner success/failure. Refuses coded on failure. */
  private async loadMembersOrExit(
    serviceClient: ServiceClient,
    orgId: string,
    spinner: Spinner | null,
    json: boolean,
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
      refuse(json, new CapyError(err.message ?? String(err), ERROR_CODES.SERVICE_ERROR));
    }
  }

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const json = opts.json === true;
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      refuse(json, new CapyError(`No keep.lock file found. Run ${B('capy')} first to initialize.`, ERROR_CODES.NO_KEEP_FILE));
    }

    const orgId = projectState.organizationId;

    // Authenticate — silent first (cached / refresh for this org, then any
    // cached session) before falling back to interactive OAuth. Mirrors the
    // pattern in capyCommand so a stale per-org token doesn't trigger a relog
    // when another org's session is still valid.
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    await this.authenticateOrRefuse(authService, orgId, json);

    // Fetch member details. In --json mode emit NO progress at all so stdout stays
    // pure JSON even on a TTY (the Spinner already routes to stderr when piped; this
    // also covers an interactive run). CAP-273.
    const spinner = json ? null : new Spinner('Loading members...');
    spinner?.start();
    const { members, callerRole, currentUserId } = await this.loadMembersOrExit(serviceClient, orgId, spinner, json);

    if (json) {
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
