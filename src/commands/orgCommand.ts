import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { Organization, KeepFile, CapyError, ERROR_CODES } from '../types/index';
import { hasOrgKey, resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { createNewOrganization } from './orgCreation';
import { execSync } from 'child_process';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

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
      displayErrorAndExit(error);
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
    let authResult = await this.authService.authenticateSilent(currentOrgId);
    if (!authResult.success) authResult = await this.authService.authenticateSilent();
    if (!authResult.success) authResult = await this.authService.authenticate(currentOrgId);
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
          name: o.id === currentOrgId ? `${o.name}  \x1b[38;5;43m← current\x1b[0m` : o.name,
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

    let selectedOrg: Organization;
    if (orgId === CREATE_NEW_ORG) {
      selectedOrg = await createNewOrganization(
        this.authService,
        this.serviceClient,
        refreshToken,
        authResult.user_id!,
      );

      const scopedAuth = await this.authService.refreshWithCredentials(
        refreshToken,
        selectedOrg.id,
        authResult.user_id,
      );
      if (!scopedAuth.success) {
        throw new CapyError(
          scopedAuth.error || 'Organization switch failed',
          ERROR_CODES.AUTH_FAILED,
        );
      }
    } else {
      selectedOrg = orgs.find(o => o.id === orgId)!;

      const orgSpinner = ora('Switching organization...').start();
      const scopedAuth = await this.authService.refreshWithCredentials(
        refreshToken,
        selectedOrg.id,
        authResult.user_id,
      );

      if (!scopedAuth.success) {
        orgSpinner.fail('Failed to switch organization');
        throw new CapyError(
          scopedAuth.error || 'Organization switch failed',
          ERROR_CODES.AUTH_FAILED,
        );
      }
      orgSpinner.succeed(`Organization: ${selectedOrg.name}`);
    }

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

    // List projects in the new org
    const projects = await this.serviceClient.listProjects();
    const orgProjects = projects.filter(p => p.organization_id === selectedOrg.id);

    if (orgProjects.length === 0) {
      await this.createFirstProjectInOrg(selectedOrg, authResult.user_id!, hasProject);
      return;
    }

    // Let user pick a project
    const { projectId } = await inquirer.prompt([{
      type: 'list',
      name: 'projectId',
      message: 'Select project:',
      choices: orgProjects.map(p => ({
        name: p.name,
        value: p.id,
      })),
    }]);

    const selectedProject = orgProjects.find(p => p.id === projectId)!;

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
        user_id: authResult.user_id,
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

    // If the current directory is already bound to another project, its .env
    // holds values encrypted for that project's key. Overwriting keep.lock
    // here would orphan those secrets — refuse and point the user at a clean
    // directory.
    if (hasProject) {
      const localEnv = this.fileManager.readEnvFile();
      const encryptedEntries = Object.entries(localEnv)
        .filter(([_, v]) => v.startsWith('capy:'));
      if (encryptedEntries.length > 0) {
        throw new CapyError(
          `This directory is bound to another project and its .env contains ${encryptedEntries.length} encrypted value(s).\n\n` +
          `  Binding it to a project in ${B(selectedOrg.name)} would make those values unreadable.\n\n` +
          `  To create the first project in ${B(selectedOrg.name)}, run ${B('capy')} in a fresh directory.`,
          ERROR_CODES.INVALID_FORMAT,
        );
      }
    }

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
      validate: (input: string) => input.trim().length > 0 || 'Project name cannot be empty',
    }]);

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

    const branchName = 'development';
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
