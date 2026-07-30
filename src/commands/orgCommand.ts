import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { AuthResult, Organization, KeepFile, CapyError, ERROR_CODES } from '../types/index';
import { hasOrgKey, resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { createNewOrganization } from './orgCreation';
import { execSync } from 'child_process';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * The branch a first project is bootstrapped with.
 *
 * Named rather than inline so the browser can state it before the project is
 * created. The terminal only mentions it as a spinner line that has already
 * scrolled past by the time anyone looks.
 */
const FIRST_BRANCH = 'development';

export interface OrgCommandOptions {
  /**
   * Serve the three questions as browser screens instead of inquirer prompts.
   *
   * Agent-only. `src/index.ts` does not yet read the root program's global
   * `--web` for `org`, so this is live and tested but not reachable from argv;
   * that wiring belongs with whoever owns index.ts.
   */
  web?: boolean;
}

export class OrgCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private web: boolean;

  constructor(apiUrl?: string, devMode: boolean = false, options: OrgCommandOptions = {}) {
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(apiUrl, devMode);
    this.serviceClient = new ServiceClient(apiUrl, devMode);
    this.web = options.web === true;

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

    if (this.web) {
      // No TTY under --web (this is driven through the MCP): an inquirer list
      // here would hang forever with nothing on screen and no URL to hand
      // anybody. Same three questions, same order, served as screens.
      await this._executeWeb(authResult, orgs, currentOrgId, hasProject);
      return;
    }

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

  /**
   * The same three questions, served as screens.
   *
   * The order is the terminal's — organization, then project — and so is
   * everything between them: the session is re-scoped, the device's key for the
   * org is checked, the project list is fetched. Two things the terminal cannot
   * do come for free from doing that work where the picker can hear the answer:
   * an org this device holds no key for is refused in its own row rather than
   * after a switch the CLI has already announced, and a failed re-scope leaves
   * the list on screen with the reason attached instead of ending the run.
   */
  private async _executeWeb(
    authResult: AuthResult,
    orgs: Organization[],
    currentOrgId: string | undefined,
    hasProject: boolean,
  ): Promise<void> {
    const userId = authResult.user_id!;
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;
    if (!refreshToken) {
      console.error('No refresh token available. Run `capy` to re-authenticate.');
      process.exit(1);
    }

    const { switchOrganizationInBrowser, nameFirstProjectInBrowser } = await import('../ui/selectWeb');

    const facts = {
      signedInAs: authResult.user_email,
      currentOrgId,
      // The one fact the terminal picker does not carry. `hasOrgKey` is what
      // the CLI checks AFTER announcing the switch; shipping it with the list
      // is what lets the screen refuse the row instead.
      orgs: orgs.map(o => ({ id: o.id, name: o.name, hasLocalKey: hasOrgKey(o.id, userId) })),
      hasKeepLock: hasProject,
      defaultProjectName: this.projectManager.getDefaultProjectName(),
      firstBranchName: FIRST_BRANCH,
    };

    let switchedTo: Organization | undefined;
    const picked = await switchOrganizationInBrowser({
      ...facts,
      onOrgChosen: async (orgId: string) => {
        const org = orgs.find(o => o.id === orgId)!;
        const scopedAuth = await this.authService.refreshWithCredentials(
          refreshToken,
          org.id,
          userId,
        );
        if (!scopedAuth.success) {
          return { ok: false as const, reason: scopedAuth.error || 'Organization switch failed' };
        }
        switchedTo = org;
        const projects = await this.serviceClient.listProjects();
        const orgProjects = projects.filter(p => p.organization_id === org.id);
        if (orgProjects.length === 0) {
          const refusal = this.firstProjectRefusal(org, hasProject);
          if (refusal) return { ok: false as const, reason: refusal };
        }
        return {
          ok: true as const,
          projects: orgProjects.map(p => ({ id: p.id, name: p.name })),
        };
      },
      open: !process.env.CAPY_WEB_NO_OPEN,
    });

    if (picked.action === 'cancel') {
      console.log('\n  Switch cancelled.\n');
      return;
    }

    if (picked.action === 'create') {
      const created = await createNewOrganization(
        this.authService,
        this.serviceClient,
        refreshToken,
        userId,
        true,
      );
      const scopedAuth = await this.authService.refreshWithCredentials(
        refreshToken,
        created.id,
        userId,
      );
      if (!scopedAuth.success) {
        throw new CapyError(
          scopedAuth.error || 'Organization switch failed',
          ERROR_CODES.AUTH_FAILED,
        );
      }
      // A brand-new org has no projects, so the only route on is the first one.
      console.log(`\n  ${B(created.name)} has no projects yet.`);
      const refusal = this.firstProjectRefusal(created, hasProject);
      if (refusal) throw new CapyError(refusal, ERROR_CODES.INVALID_FORMAT);
      const name = await nameFirstProjectInBrowser({
        ...facts,
        orgs: [{ id: created.id, name: created.name, hasLocalKey: true }],
        currentOrgId: undefined,
        orgId: created.id,
        open: !process.env.CAPY_WEB_NO_OPEN,
      });
      if (name === null) {
        console.log(`\n  Switch cancelled. Run ${B('capy')} in a fresh directory to create a project in ${B(created.name)}.\n`);
        return;
      }
      await this.bootstrapFirstProject(created, userId, name);
      return;
    }

    const selectedOrg = switchedTo!;
    if (!hasOrgKey(selectedOrg.id, userId)) {
      // Unreachable through the screen, which disables a row with no key —
      // and still checked, because the throw is what stops a switch this
      // device cannot decrypt anything in.
      throw new CapyError(
        `You have access to "${selectedOrg.name}" but no encryption key on this device.\n\n` +
        '  Ask your org owner for an invite code, then run:\n\n' +
        '    capy redeem <code>\n\n' +
        '  This will securely transfer the shared encryption key to your device.',
        ERROR_CODES.AUTH_FAILED,
      );
    }

    if (picked.action === 'create-project') {
      await this.bootstrapFirstProject(selectedOrg, userId, picked.projectName);
      return;
    }

    const projects = await this.serviceClient.listProjects();
    const selectedProject = projects.find(p => p.id === picked.projectId)!;
    this.bindToProject(selectedOrg, selectedProject, userId, hasProject);
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
      validate: (input: string) => input.trim().length > 0 || 'Project name cannot be empty',
    }]);

    await this.bootstrapFirstProject(selectedOrg, userId, projectName);
  }

  /**
   * Why this directory cannot take the first project of another org, or null.
   *
   * A sentence rather than a throw so both surfaces can use it: the terminal
   * raises it as a CapyError and ends the run, and the browser hands it back as
   * a refusal on the organization list, where the user still has other rows to
   * pick. The condition is the same one either way — a .env holding values
   * encrypted for the project this directory is currently bound to, which
   * rebinding keep.lock would orphan.
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
