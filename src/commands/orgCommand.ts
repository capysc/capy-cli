import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { AuthResult, Organization, KeepFile, CapyError, ERROR_CODES } from '../types/index';
import { hasOrgKey, resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { createNewOrganization } from './orgCreation';
import { excludeSystemProject, assertProjectNameAllowed, isReservedProjectName, PROJECT_NAME_RESERVED_MESSAGE } from '../system/reservedProjectName';
import { execSync } from 'child_process';
import { ACCENT } from '../ui/colors';
import { orgProjectQuestion } from '../ui/projectQuestions';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * `_execute()`'s auth fallback chain: try the org-scoped silent session
 * first, then a plain silent session, then a full interactive
 * authentication — returning the first successful result, or the last
 * attempt's failure if none succeed. Pulled out into its own function
 * (rather than a reassigned `let`) so each attempt is a `return`, not a
 * mutation the reader has to track across three lines.
 */
async function resolveAuthResultWithFallback(authService: AuthService, currentOrgId: string | undefined): Promise<AuthResult> {
  const scopedSilent = await authService.authenticateSilent(currentOrgId);
  if (scopedSilent.success) return scopedSilent;
  const plainSilent = await authService.authenticateSilent();
  if (plainSilent.success) return plainSilent;
  return authService.authenticate(currentOrgId);
}

/** The branch a first project is bootstrapped with. */
const FIRST_BRANCH = 'development';

export class OrgCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(apiUrl, devMode);
    this.serviceClient = new ServiceClient(apiUrl, devMode);

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  async execute(): Promise<void> {
    try {
      await this._execute();
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') throw error;
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  private async _execute(): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();

    const hasProject = projectState.initialized && !!projectState.organizationId;
    const currentOrgId = projectState.organizationId || undefined;

    // Authenticate using cached session — AuthService auto-discovers session files
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }
    const authResult = await resolveAuthResultWithFallback(this.authService, currentOrgId);
    if (!authResult.success) {
      console.error('Authentication failed. Run `capy` to re-authenticate.');
      process.exit(1);
    }

    const orgs = authResult.organizations || [];
    const currentOrg = currentOrgId ? orgs.find(o => o.id === currentOrgId) : undefined;
    const CREATE_NEW_ORG = '__create_new__';

    console.log('');
    const { orgId } = await inquirer.prompt([{
      type: 'list',
      name: 'orgId',
      message: 'Switch organization:',
      choices: [
        ...orgs.map(o => ({
          name: o.id === currentOrgId ? `${o.name}  ${ACCENT}← current\x1b[0m` : o.name,
          value: o.id,
        })),
        { name: 'Create new organization +', value: CREATE_NEW_ORG },
      ],
      default: currentOrgId,
    }]);

    if (orgId === currentOrgId && currentOrg) {
      console.log(`Already on ${B(currentOrg.name)}.`);
      return;
    }

    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;
    if (!refreshToken) {
      console.error('No refresh token available. Run `capy` to re-authenticate.');
      process.exit(1);
    }

    // Two ways to land on the org this run switches into — creating a brand
    // new one, or re-scoping auth onto one already picked from the list —
    // each its own closure (rather than two `if`/`else` branches assigning
    // into one `let`) so the value IS the result of whichever path ran,
    // never a variable patched after the fact.
    const createSelectedOrg = async (): Promise<Organization> => {
      const org = await createNewOrganization(
        this.authService,
        this.serviceClient,
        refreshToken,
        authResult.user_id!,
      );
      const scopedAuth = await this.authService.refreshWithCredentials(
        refreshToken,
        org.id,
        authResult.user_id,
      );
      if (!scopedAuth.success) {
        throw new CapyError(
          scopedAuth.error || 'Organization switch failed',
          ERROR_CODES.AUTH_FAILED,
        );
      }
      return org;
    };

    const switchToSelectedOrg = async (): Promise<Organization> => {
      const org = orgs.find(o => o.id === orgId)!;
      const orgSpinner = ora('Switching organization...').start();
      const scopedAuth = await this.authService.refreshWithCredentials(
        refreshToken,
        org.id,
        authResult.user_id,
      );
      if (!scopedAuth.success) {
        orgSpinner.fail('Failed to switch organization');
        throw new CapyError(
          scopedAuth.error || 'Organization switch failed',
          ERROR_CODES.AUTH_FAILED,
        );
      }
      orgSpinner.succeed(`Organization: ${org.name}`);
      return org;
    };

    const selectedOrg: Organization = orgId === CREATE_NEW_ORG ? await createSelectedOrg() : await switchToSelectedOrg();

    // Check for org master key
    if (!hasOrgKey(selectedOrg.id, authResult.user_id!)) {
      throw new CapyError(
        `You have access to "${selectedOrg.name}" but no encryption key on this device.\n\n` +
        '  Ask your org owner for an invite code, then run:\n\n' +
        '    capy redeem <code>\n\n' +
        '  This will securely transfer the shared encryption key to your device.',
        ERROR_CODES.AUTH_FAILED
      );
    }

    // List projects in the new org. Belt-and-braces filter (CAP-664): the
    // service already hides the org's `_system` project from this listing.
    const projects = excludeSystemProject(await this.serviceClient.listProjects());
    const orgProjects = projects.filter(p => p.organization_id === selectedOrg.id);

    if (orgProjects.length === 0) {
      await this.createFirstProjectInOrg(selectedOrg, authResult.user_id!, hasProject);
      return;
    }

    // Let user pick a project
    const { projectId } = await inquirer.prompt([orgProjectQuestion(orgProjects)]);

    const selectedProject = orgProjects.find(p => p.id === projectId)!;
    this.bindToProject(selectedOrg, selectedProject, authResult.user_id, hasProject);
  }

  /** Point this directory at the chosen org+project and say so. */
  private bindToProject(
    selectedOrg: Organization,
    selectedProject: { id: string; name: string },
    userId: string | undefined,
    hasProject: boolean,
  ): void {
    if (hasProject) {
      // Update keep.lock with new org + project
      const keep: KeepFile = {
        version: '3.0',
        org_id: selectedOrg.id,
        project_id: selectedProject.id,
        project_name: selectedProject.name,
        variables: {},
      };
      this.fileManager.writeKeepFile(keep);

      // Reset sync-state for the new org+project context
      this.fileManager.writeSyncState({
        last_sync: '',
        synced_variables: [],
        user_id: userId,
        org_id: selectedOrg.id,
      });

      console.log(`\n  Switched to ${B(selectedOrg.name)} / ${B(selectedProject.name)}`);
      console.log(`  Run ${B('capy')} to sync secrets.\n`);
    } else {
      console.log(`\n  Switched to ${B(selectedOrg.name)} / ${B(selectedProject.name)}`);
      console.log(`  Run ${B('capy')} in a project directory to sync secrets.\n`);
    }
  }

  private keyServiceOps(): KeyServiceOps {
    return {
      coDecrypt: (orgId, ciphertext) =>
        this.serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
      wrapOuterLayer: (orgId, plaintext) =>
        this.serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
    };
  }

  /**
   * Bootstrap the first project in a freshly-created (or empty) org. Without
   * this, switching into an empty org leaves keep.lock pointed at the old org
   * — the user's next `capy` run silently resyncs the old project and the
   * "switch" appears to have no effect.
   */
  private async createFirstProjectInOrg(
    selectedOrg: Organization,
    userId: string,
    hasProject: boolean,
  ): Promise<void> {
    console.log(`\n  ${B(selectedOrg.name)} has no projects yet.`);

    const refusal = this.firstProjectRefusal(selectedOrg, hasProject);
    if (refusal) throw new CapyError(refusal, ERROR_CODES.INVALID_FORMAT);

    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `Create the first project in ${selectedOrg.name} here?`,
      default: true,
    }]);
    if (!confirmed) {
      console.log(`\n  Switch cancelled. Run ${B('capy')} in a fresh directory to create a project in ${B(selectedOrg.name)}.\n`);
      return;
    }

    const defaultName = this.projectManager.getDefaultProjectName();
    const { projectName } = await inquirer.prompt([{
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: defaultName,
      validate: (input: string) => {
        if (input.trim().length === 0) return 'Project name cannot be empty';
        // `_system` is reserved for the org's system store (CAP-664).
        if (isReservedProjectName(input)) return PROJECT_NAME_RESERVED_MESSAGE;
        return true;
      },
    }]);

    await this.bootstrapFirstProject(selectedOrg, userId, projectName);
  }

  /**
   * Why this directory cannot take the first project of another org, or null.
   *
   * A sentence rather than a throw; the caller raises it as a CapyError. The
   * condition is a .env holding values encrypted for the project this
   * directory is currently bound to, which rebinding keep.lock would orphan.
   */
  private firstProjectRefusal(selectedOrg: Organization, hasProject: boolean): string | null {
    if (!hasProject) return null;
    const localEnv = this.fileManager.readEnvFile();
    const encryptedEntries = Object.entries(localEnv)
      .filter(([_, v]) => v.startsWith('capy:'));
    if (encryptedEntries.length === 0) return null;
    return (
      `This directory is bound to another project and its .env contains ${encryptedEntries.length} encrypted value(s).\n\n` +
      `  Binding it to a project in ${B(selectedOrg.name)} would make those values unreadable.\n\n` +
      `  To create the first project in ${B(selectedOrg.name)}, run ${B('capy')} in a fresh directory.`
    );
  }

  /** Everything the first-project questions lead to, once they are answered. */
  private async bootstrapFirstProject(
    selectedOrg: Organization,
    userId: string,
    projectName: string,
  ): Promise<void> {
    // Choke point: the reserved name must never reach the service.
    assertProjectNameAllowed(projectName.trim());

    const initSpinner = ora('Creating project...').start();
    const projectResult = await this.serviceClient.initializeProject(
      projectName.trim(),
      selectedOrg.id,
    );
    initSpinner.succeed(`Project created: ${projectResult.project_name}`);

    const keySpinner = ora('Resolving project key...').start();
    await resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      userId,
      this.keyServiceOps(),
    );
    keySpinner.succeed('Project key ready');

    const branchName = FIRST_BRANCH;
    const branchSpinner = ora(`Creating branch ${branchName}...`).start();
    try {
      await this.serviceClient.createBranch(projectResult.project_id, branchName, false);
      branchSpinner.succeed(`Created branch ${branchName}`);
    } catch (err) {
      branchSpinner.fail(`Failed to create branch ${branchName}`);
      throw err;
    }

    const keep: KeepFile = {
      version: '3.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
      variables: {},
    };
    this.fileManager.writeKeepFile(keep);
    this.projectManager.writeActiveBranch(branchName);
    this.fileManager.writeSyncState({
      last_sync: '',
      synced_variables: [],
      user_id: userId,
      org_id: selectedOrg.id,
    });
    this.fileManager.ensureCapyGitignore();

    try {
      execSync('git add keep.lock', { stdio: 'pipe' });
    } catch {
      // not a git repo — fine
    }

    console.log(`\n  Switched to ${B(selectedOrg.name)} / ${B(projectResult.project_name)}`);
    console.log(`  Run ${B('capy')} to sync secrets.\n`);
  }
}
