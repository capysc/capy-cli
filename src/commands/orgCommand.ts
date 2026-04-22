import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { Organization, KeepFile, CapyError, ERROR_CODES } from '../types/index';
import { hasOrgKey } from '../crypto/keyResolver';

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

    this.serviceClient.setTokenRefresher(async () => {
      const refreshed = await this.authService.refreshToken();
      return refreshed ? this.authService.getToken() : null;
    });
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

    const token = this.authService.getToken();
    if (token) this.serviceClient.setToken(token);

    const orgs = authResult.organizations || [];
    const currentOrg = currentOrgId ? orgs.find(o => o.id === currentOrgId) : undefined;

    if (orgs.length <= 1) {
      const orgName = currentOrg?.name || orgs[0]?.name || currentOrgId || 'unknown';
      console.log(`\n  Organization: ${B(orgName)}`);
      console.log('  No other organizations available.\n');
      return;
    }

    // Show org list and let user pick
    console.log('');
    const { orgId } = await inquirer.prompt([{
      type: 'list',
      name: 'orgId',
      message: 'Switch organization:',
      choices: orgs.map(o => ({
        name: o.id === currentOrgId ? `${o.name}  \x1b[38;5;43m← current\x1b[0m` : o.name,
        value: o.id,
      })),
      default: currentOrgId,
    }]);

    if (orgId === currentOrgId && currentOrg) {
      console.log(`Already on ${B(currentOrg.name)}.`);
      return;
    }

    const selectedOrg = orgs.find(o => o.id === orgId)!;

    // Switch to the selected org using refresh token — no re-auth
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;

    if (!refreshToken) {
      console.error('No refresh token available. Run `capy` to re-authenticate.');
      process.exit(1);
    }

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

    // Update token for service client
    const updatedToken = this.authService.getToken();
    if (updatedToken) this.serviceClient.setToken(updatedToken);

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
      console.log(`\n  No projects found in ${B(selectedOrg.name)}.`);
      console.log(`  Run ${B('capy')} to create one.\n`);
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
}
