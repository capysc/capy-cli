import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import inquirer from 'inquirer';
import { CapyError, ERROR_CODES } from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class CheckoutCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);

    this.serviceClient.setTokenRefresher(async () => {
      const refreshed = await this.authService.refreshToken();
      if (refreshed) {
        return this.authService.getToken();
      }
      return null;
    });
  }

  async execute(branchName: string, options: { create?: boolean; protected?: boolean } = {}): Promise<void> {
    try {
      await this._execute(branchName, options);
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  private async _execute(branchName: string, options: { create?: boolean; protected?: boolean }): Promise<void> {
    // Read keep.lock — must be initialized
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize the project.`);
      process.exit(1);
    }

    // Load user-scoped session
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
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

    // Resolve encryption key from global keyring (requires server co-decrypt)
    const keyOps: KeyServiceOps = {
      coDecrypt: (oid, ct) => this.serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
      wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
    };
    const encryptionKey = await resolveProjectKey(orgId, projectId, authResult.user_id!, keyOps);

    if (options.create) {
      await this.createBranch(projectId, branchName, encryptionKey, options.protected);
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
          const prod = b.is_protected ? ' \x1b[90m(protected)\x1b[0m' : '';
          console.log(`  ${label}${prod}`);
        }
        console.log(`\nCreate it with: ${B(`capy checkout -b ${branchName}`)}`);
        process.exit(1);
      }
      branchSpinner.stop();
    }

    // Save active branch to .capy/branch (local state, not committed)
    this.projectManager.writeActiveBranch(branchName);

    // Pull latest secrets for this branch from the server. Use the "no keep_hash"
    // path so the server resolves to the latest snapshot for the branch and
    // returns its keep_file — that lets us self-heal local keep.lock if it's
    // stale OR doesn't yet know about this branch (which is the common case
    // when switching to a branch that was created by a teammate).
    const syncSpinner = ora(`Syncing secrets for ${branchName}...`).start();

    try {
      const decryptData = await this.serviceClient.getDecryptData(
        projectId,
        branchName,
        undefined, // ask for latest
        true,
      );

      // Self-heal local keep.lock from server's keep_file if returned
      let keepForWrite = this.projectManager.readKeepFile()!;
      if (decryptData.keep_file) {
        const serverKeep = JSON.parse(decryptData.keep_file);
        this.fileManager.writeKeepFile(serverKeep);
        keepForWrite = serverKeep;
      }

      if (decryptData.env_content) {
        const remoteEnv = this.fileManager.parseEnvContent(decryptData.env_content);
        const decrypted: Record<string, string> = {};
        for (const [key, value] of Object.entries(remoteEnv)) {
          try {
            decrypted[key] = this.fileManager.decryptValue(value, encryptionKey);
          } catch {
            // Skip undecryptable
          }
        }
        this.fileManager.writeEncryptedEnvFile(decrypted, encryptionKey, undefined, keepForWrite, branchName);
        syncSpinner.stop();
        console.log(`Synced ${Object.keys(decrypted).length} variable(s) for ${branchName}`);
      } else {
        syncSpinner.stop();
        console.log(`No secrets yet for ${branchName}`);
      }
    } catch (error: any) {
      syncSpinner.stop();
      if (error?.details?.status === 404) {
        console.log(`No secrets yet for ${branchName}`);
      } else {
        console.log(`Failed to sync secrets: ${error.message}`);
      }
    }

    const displayName = branchName || 'no branch selected';
    console.log(`\nNow on branch: ${displayName}`);
  }

  private async createBranch(
    projectId: string,
    branchName: string,
    encryptionKey: string,
    isProtected?: boolean,
  ): Promise<void> {
    if (isProtected === undefined) {
      const { protect } = await inquirer.prompt([{
        type: 'confirm',
        name: 'protect',
        message: `Make "${branchName}" a protected branch? \x1b[90m(invite-only)\x1b[0m`,
        default: false,
      }]);
      isProtected = protect;
    }

    const branchSpinner = ora(`Creating branch ${branchName}...`).start();

    try {
      await this.serviceClient.createBranch(projectId, branchName, isProtected);
      branchSpinner.stop();
      console.log(`Branch "${branchName}" registered`);

      if (isProtected) {
        console.log(`\n"${branchName}" is a protected branch — access is invite-only`);
      }
    } catch (error: any) {
      branchSpinner.stop();
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}
