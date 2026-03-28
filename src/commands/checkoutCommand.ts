import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import inquirer from 'inquirer';
import { CapyError, ERROR_CODES } from '../types/index';
import { resolveProjectKey } from '../crypto/keyResolver';

export class CheckoutCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private syncEngine: SyncEngine;
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);
    this.syncEngine = new SyncEngine();

    this.serviceClient.setTokenRefresher(async () => {
      const refreshed = await this.authService.refreshToken();
      if (refreshed) {
        return this.authService.getToken();
      }
      return null;
    });
  }

  async execute(branchName: string, options: { create?: boolean; production?: boolean } = {}): Promise<void> {
    try {
      await this._execute(branchName, options);
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') {
        process.exit(0);
      }
      throw error;
    }
  }

  private async _execute(branchName: string, options: { create?: boolean; production?: boolean }): Promise<void> {
    // Read .keep — must be initialized
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      console.error('No .keep file found. Run capy first to initialize the project.');
      process.exit(1);
    }

    // Authenticate
    const spinner = ora('Authenticating...').start();
    const authResult = await this.authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
    }

    const token = this.authService.getToken();
    if (token) this.serviceClient.setToken(token);
    spinner.stop();

    const projectId = projectState.projectId!;
    const orgId = projectState.organizationId!;

    // Resolve encryption key from global keyring
    const encryptionKey = resolveProjectKey(orgId, projectId, authResult.user_id!);

    if (options.create) {
      await this.createBranch(projectId, branchName, encryptionKey, options.production);
    } else {
      // Verify the branch exists
      const branchSpinner = ora(`Switching to ${branchName}...`).start();
      const branches = await this.serviceClient.listBranches(projectId);
      const branch = branches.find(b => b.name === branchName);
      if (!branch) {
        branchSpinner.stop();
        console.log(`Branch "${branchName}" not found\n`);
        console.log('Available branches:');
        for (const b of branches) {
          const label = b.name || 'no branch';
          const prod = b.is_production ? ' \x1b[90m(protected)\x1b[0m' : '';
          console.log(`  ${label}${prod}`);
        }
        console.log(`\nCreate it with: capy checkout -b ${branchName}`);
        process.exit(1);
      }
      branchSpinner.stop();
    }

    // Save active branch to .capy/branch (local state, not committed)
    this.projectManager.writeActiveBranch(branchName);
    const keep = this.projectManager.readKeepFile()!;

    // Pull secrets for the branch
    const pullSpinner = ora(`Pulling secrets for ${branchName}...`).start();

    try {
      const decryptData = await this.serviceClient.getDecryptData(projectId, branchName);
      if (decryptData.env_content) {
        const remoteEnv = this.fileManager.parseEnvContent(decryptData.env_content);
        // Decrypt remote values — fail loudly on wrong key
        const decrypted: Record<string, string> = {};
        for (const [key, value] of Object.entries(remoteEnv)) {
          decrypted[key] = this.fileManager.decryptValue(value, encryptionKey);
        }
        // Re-encrypt locally for this branch
        this.fileManager.writeEncryptedEnvFile(decrypted, encryptionKey, undefined, keep, branchName);
        pullSpinner.stop();
        console.log(`Pulled ${Object.keys(decrypted).length} variable(s) for ${branchName}`);
      } else {
        pullSpinner.stop();
        console.log(`No secrets yet for ${branchName}`);
      }
    } catch (error: any) {
      pullSpinner.stop();
      if (error?.details?.status === 404) {
        console.log(`No secrets yet for ${branchName}`);
      } else {
        console.log(`Failed to pull secrets: ${error.message}`);
      }
    }

    const displayName = branchName || 'no branch selected';
    console.log(`\nNow on branch: ${displayName}`);
  }

  private async createBranch(
    projectId: string,
    branchName: string,
    encryptionKey: string,
    isProduction?: boolean,
  ): Promise<void> {
    // Ask about production if not specified
    if (isProduction === undefined) {
      const { production } = await inquirer.prompt([{
        type: 'confirm',
        name: 'production',
        message: `Make "${branchName}" a protected branch? \x1b[90m(invite-only)\x1b[0m`,
        default: false,
      }]);
      isProduction = production;
    }

    const branchSpinner = ora(`Creating branch ${branchName}...`).start();

    try {
      await this.serviceClient.createBranch(projectId, branchName, isProduction);

      // Copy secrets from current branch
      const keep = this.projectManager.readKeepFile()!;
      const currentBranch = this.projectManager.readActiveBranch();

      try {
        const currentData = await this.serviceClient.getDecryptData(projectId, currentBranch);
        if (currentData.env_content) {
          // Push current secrets to the new branch
          const currentEnv = this.fileManager.parseEnvContent(currentData.env_content);
          const decrypted: Record<string, string> = {};
          for (const [key, value] of Object.entries(currentEnv)) {
            decrypted[key] = this.fileManager.decryptValue(value, encryptionKey);
          }
          await this.serviceClient.pushVariables(projectId, decrypted, keep, branchName, encryptionKey);
          branchSpinner.stop();
          console.log(`Branch "${branchName}" created with ${Object.keys(decrypted).length} variable(s) copied`);
        } else {
          branchSpinner.stop();
          console.log(`Branch "${branchName}" created (empty)`);
        }
      } catch {
        branchSpinner.stop();
        console.log(`Branch "${branchName}" created (no secrets to copy)`);
      }

      if (isProduction) {
        console.log(`\n"${branchName}" is a production branch — access is invite-only`);
      }
    } catch (error: any) {
      branchSpinner.stop();
      const detail = error?.details?.data?.error || error?.message || 'Unknown error';
      console.log(`Failed to create branch: ${detail}`);
      process.exit(1);
    }
  }
}
