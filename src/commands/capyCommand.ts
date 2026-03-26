import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { PromptEngine } from '../ui/promptEngine';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import inquirer from 'inquirer';
import {
  CliOptions,
  Organization,
  ProjectState,
  KeepFile,
  SyncState,
  CapyError,
  ERROR_CODES
} from '../types/index';

export class CapyCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private syncEngine: SyncEngine;
  private promptEngine: PromptEngine;
  private options: CliOptions;
  private devMode: boolean;

  constructor(options: CliOptions = {}, devMode: boolean = false) {
    this.options = options;
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);
    this.syncEngine = new SyncEngine();
    this.promptEngine = new PromptEngine();
  }

  async execute(): Promise<void> {
    try {
      // Detect project state
      const projectState = await this.projectManager.detectProjectState();

      if (!projectState.initialized) {
        // Automatically initialize if .keep doesn't exist
        await this.initializeProject();
      } else {
        await this.syncProject(projectState);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async initializeProject(): Promise<void> {
    console.log('⚠  No .keep file found - initializing project...');

    // Authenticate first
    const spinner = ora('🔐 Authenticating...').start();
    const authResult = await this.authService.authenticate();

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Welcome ${authResult.user_first_name || authResult.user_email}`);

    // Set token for service client
    const token = this.authService.getToken();
    if (token) {
      this.serviceClient.setToken(token);
      if (this.devMode) {
        console.log(`\n🔑 Bearer token (${authResult._auth_method || 'oauth'}):\n${token.access_token}\n`);
      }
    }

    // Resolve organization
    const orgs = authResult.organizations || [];
    let selectedOrg: Organization;
    const SWITCH_ORG = '__switch_org__';
    const CREATE_NEW_ORG = '__create_new__';
    // Refresh token: available from exchange (multi/no org) or from stored token (single org)
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;

    // Find the current org (the one the token is scoped to)
    const currentOrgId = authResult.organization_id;
    const currentOrg = orgs.find(o => o.id === currentOrgId);

    if (orgs.length === 0) {
      // No orgs — prompt to create one
      console.log('\n🏢 No organization found. Let\'s create one.');
      selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);
    } else if (currentOrg) {
      // Authenticated with an org — offer to use it, switch, or create new
      const { orgAction } = await inquirer.prompt([{
        type: 'list',
        name: 'orgAction',
        message: 'Select organization for project:',
        choices: [
          { name: currentOrg.name, value: currentOrg.id },
          { name: 'Switch to another organization', value: SWITCH_ORG },
          { name: 'Create new organization', value: CREATE_NEW_ORG },
        ],
      }]);

      if (orgAction === SWITCH_ORG) {
        // Clear token and re-auth so WorkOS prompts for org selection
        this.authService.clearToken();
        const orgSpinner = ora('Re-authenticating...').start();
        const freshAuth = await this.authService.authenticate();
        if (!freshAuth.success) {
          orgSpinner.fail('Authentication failed');
          throw new CapyError(
            freshAuth.error || 'Authentication failed',
            ERROR_CODES.AUTH_FAILED
          );
        }
        orgSpinner.succeed('Authenticated');
        // Recurse to re-show org selection with fresh auth
        return this.initializeProject();
      } else if (orgAction === CREATE_NEW_ORG) {
        selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);
      } else {
        selectedOrg = currentOrg;
      }
    } else {
      // Have orgs but no current org (multi-org, no token yet) — pick one
      const { orgId } = await inquirer.prompt([{
        type: 'list',
        name: 'orgId',
        message: 'Select organization for project:',
        choices: [
          ...orgs.map(o => ({ name: o.name, value: o.id })),
          new inquirer.Separator(),
          { name: 'Create new organization +', value: CREATE_NEW_ORG },
        ],
      }]);

      if (orgId === CREATE_NEW_ORG) {
        selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);
      } else {
        selectedOrg = orgs.find(o => o.id === orgId)!;

        // Use refresh token to get an org-scoped token
        const orgSpinner = ora('Authenticating with organization...').start();
        let scopedAuth = await this.authService.refreshWithCredentials(
          refreshToken!,
          selectedOrg.id,
          authResult.user_id,
        );
        if (!scopedAuth.success) {
          // Stale cache — clear token and re-auth from scratch
          orgSpinner.text = 'Re-authenticating...';
          this.authService.clearToken();
          scopedAuth = await this.authService.authenticate(selectedOrg.workos_org_id);
          if (!scopedAuth.success) {
            orgSpinner.fail('Failed to authenticate with organization');
            throw new CapyError(
              scopedAuth.error || 'Organization authentication failed',
              ERROR_CODES.AUTH_FAILED
            );
          }
        }
        orgSpinner.succeed(`Organization: ${selectedOrg.name}`);
      }
    }

    // Set token for service client (now valid for the selected org)
    const updatedToken = this.authService.getToken();
    if (updatedToken) {
      this.serviceClient.setToken(updatedToken);
    }

    // Prompt for project name
    const defaultName = this.projectManager.getDefaultProjectName();
    const projectName = await this.promptEngine.promptForProjectName(defaultName);

    // Initialize project on service
    const initSpinner = ora('Creating project...').start();
    const projectResult = await this.serviceClient.initializeProject(
      projectName,
      selectedOrg.id
    );
    initSpinner.succeed(`Project "${projectName}" created`);

    const keySpinner = ora('🔑 Generating encryption keys...').start();

    // Create keep file
    const keep: KeepFile = {
      version: '1.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
      created_at: new Date().toISOString(),
      last_sync: new Date().toISOString(),
      variables: {}
    };

    this.fileManager.writeKeepFile(keep);
    keySpinner.text = 'Created .keep configuration file';

    // Get decrypt data from service
    let remoteData = { env_content: '', decrypt_key: '', expires_at: '' };
    try {
      remoteData = await this.serviceClient.getDecryptData(projectResult.project_id);
    } catch {
      // Service unavailable
    }

    const encryptionKey = remoteData.decrypt_key;

    // Always write decrypt key file so sync can find it later
    const decryptKey = this.syncEngine.createDecryptKey(
      projectResult.org_id,
      projectResult.project_id,
      authResult.user_id!,
      encryptionKey,
      []
    );
    this.fileManager.writeDecryptKey(decryptKey);

    // If remote has existing variables, pull them
    if (remoteData.env_content) {
      const envVars = this.fileManager.parseEnvContent(remoteData.env_content);
      this.fileManager.writeEncryptedEnvFile(envVars, encryptionKey, undefined, keep);
      keySpinner.succeed(`Retrieved and encrypted ${Object.keys(envVars).length} variables`);
    } else {
      keySpinner.succeed('Project initialized');
    }

    // Update gitignore
    this.fileManager.ensureCapyGitignore();
    this.promptEngine.displaySuccess('Updated .gitignore to protect secrets');

    // Check if there's an existing .env file with variables to sync
    const localEnvPath = this.projectManager.getEnvPath(this.options.envPath);
    const hasLocalEnv = existsSync(localEnvPath);

    if (hasLocalEnv) {
      const localEnv = this.fileManager.readEnvFile(this.options.envPath);
      const localVarCount = Object.keys(localEnv).length;

      if (localVarCount > 0) {
        console.log(`\n📋 Found existing .env file with ${localVarCount} variable(s)`);
        const syncSpinner = ora('🔄 Syncing local variables to keep...').start();

        try {
          const pushResult = await this.serviceClient.pushVariables(
            projectResult.project_id,
            localEnv,
            keep
          );

          if (pushResult.success) {
            const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushResult.variables);
            this.fileManager.writeKeepFile(updatedKeep);
            this.fileManager.writeSyncState({
              last_sync: new Date().toISOString(),
              synced_variables: Object.keys(localEnv)
            });

            // Encrypt the local .env file
            this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, this.options.envPath, updatedKeep);

            // Update decrypt key with variable permissions
            const finalDecryptKey = this.syncEngine.createDecryptKey(
              projectResult.org_id,
              projectResult.project_id,
              authResult.user_id!,
              encryptionKey,
              Object.keys(localEnv)
            );
            this.fileManager.writeDecryptKey(finalDecryptKey);

            syncSpinner.succeed(`Synced and encrypted ${localVarCount} variable(s)`);

            // Show what was synced
            console.log('');
            for (const varName of Object.keys(localEnv)) {
              console.log(`  📤 ${varName}`);
            }

            console.log('\n✓ Ready to work!');
            await this.promptDeployOrContinue(Object.keys(localEnv));
          } else {
            syncSpinner.fail('Failed to sync variables');
          }
        } catch (syncError: any) {
          syncSpinner.fail(`Failed to sync variables: ${syncError.message}`);
          console.log('⚠️  You can run \'capy\' again to retry syncing');
        }
      }
    }

    console.log('\n✓ Ready to work!');
  }

  private async syncProject(projectState: ProjectState): Promise<void> {
    console.log(`📁 Project: ${projectState.projectName}`);

    // Authenticate
    const spinner = ora('🔐 Authenticating...').start();
    const authResult = await this.authService.authenticate(projectState.organizationId);

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Welcome ${authResult.user_first_name || authResult.user_email}`);

    // Set token for service client
    const token = this.authService.getToken();
    if (token) {
      this.serviceClient.setToken(token);
      if (this.devMode) {
        console.log(`\n🔑 Bearer token (${authResult._auth_method || 'oauth'}):\n${token.access_token}\n`);
      }
    }

    // Get remote environment
    const fetchSpinner = ora('Retrieving remote .env...').start();
    const decryptData = await this.serviceClient.getDecryptData(projectState.projectId!);
    const existingDecryptKey = this.projectManager.readDecryptKey();
    const encryptionKey = existingDecryptKey?.decryption_key ?? decryptData.decrypt_key;

    // Parse remote (encrypted) and decrypt for comparison
    let remoteEnvEncrypted: Record<string, string> = {};
    let remoteEnv: Record<string, string> = {};
    if (decryptData.env_content) {
      remoteEnvEncrypted = this.fileManager.parseEnvContent(decryptData.env_content);
      for (const [key, value] of Object.entries(remoteEnvEncrypted)) {
        try {
          remoteEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
        } catch {
          remoteEnv[key] = value;
        }
      }
    }

    fetchSpinner.succeed(`Retrieved remote .env (${Object.keys(remoteEnv).length} variables)`);

    if (this.devMode) {
      console.log('\n📦 Remote .env (dev mode):');
      if (Object.keys(remoteEnvEncrypted).length === 0) {
        console.log('  (empty)');
      } else {
        for (const [key, value] of Object.entries(remoteEnvEncrypted)) {
          console.log(`  ${key}=${value}`);
        }
      }
      console.log('');
    }

    // Get local environment — decrypt if encrypted, read as-is if plaintext
    let localEnv: Record<string, string> = {};
    try {
      const rawLocal = this.fileManager.readEnvFile(this.options.envPath);
      for (const [key, value] of Object.entries(rawLocal)) {
        if (value.startsWith('capy:')) {
          try {
            localEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
          } catch {
            localEnv[key] = value;
          }
        } else {
          localEnv[key] = value;
        }
      }
    } catch {
      console.warn('⚠️  Failed to read local .env');
      localEnv = {};
    }

    // Read sync state for deletion detection
    // BUT: if local .env is missing/empty, ignore sync state and pull everything from remote
    const localEnvExists = Object.keys(localEnv).length > 0;
    const syncState = localEnvExists ? this.projectManager.readSyncState() : null;

    // Compare decrypted plaintext values
    const changeSet = this.syncEngine.compareEnvironments(
      localEnv,
      remoteEnv,
      undefined,
      undefined,
      syncState
    );

    // Show summary
    const summary = this.syncEngine.formatSyncSummary(changeSet);
    if (summary) {
      console.log('\n' + summary);
    }

    // Check if any changes needed
    const hasChanges =
      changeSet.newLocal.length > 0 ||
      changeSet.newRemote.length > 0 ||
      changeSet.conflicts.length > 0 ||
      changeSet.deleted.length > 0 ||
      changeSet.deletedLocal.length > 0;

    if (!hasChanges) {
      this.promptEngine.displaySuccess('Everything is up to date!');

      // Always re-encrypt local .env (e.g. after `capy decrypt`)
      const finalKeep = this.projectManager.readKeepFile();
      this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, this.options.envPath, finalKeep);
      return;
    }

    // Prompt for decisions
    const decisions = await this.promptEngine.promptForChanges(changeSet);

    // Validate decisions
    const validationErrors = this.syncEngine.validateDecisions(decisions, changeSet);
    if (validationErrors.length > 0) {
      for (const error of validationErrors) {
        this.promptEngine.displayError(error);
      }
      throw new CapyError(
        'Invalid sync decisions',
        ERROR_CODES.CONFLICT_RESOLUTION
      );
    }

    // Confirm sync
    if (!await this.promptEngine.confirmSync(decisions)) {
      this.promptEngine.displayWarning('Sync cancelled');
      return;
    }

    // Perform sync operations
    const syncSpinner = ora('🔄 Syncing...').start();

    // Apply decisions to create final env (all variables, merged)
    const finalEnv = this.syncEngine.applyDecisions(localEnv, remoteEnv, decisions);

    // Push the full state to remote (replaces entire blob)
    const keep = this.projectManager.readKeepFile();
    const pushResult = await this.serviceClient.pushVariables(
      projectState.projectId!,
      finalEnv,
      keep
    );

    let finalKeep = keep;
    if (pushResult.success) {
      // Update keep with resource_ids from push
      finalKeep = this.syncEngine.mergeWithKeep(keep!, pushResult.variables);

      // Remove deleted variables from keep
      for (const varName of decisions.deleteRemote) {
        delete finalKeep.variables[varName];
      }

      finalKeep.last_sync = new Date().toISOString();
      this.fileManager.writeKeepFile(finalKeep);
    }

    // Write encrypted .env file
    this.fileManager.writeEncryptedEnvFile(finalEnv, encryptionKey, this.options.envPath, finalKeep);
    syncSpinner.text = `Updated encrypted .env with ${Object.keys(finalEnv).length} total variables`;

    // Update decrypt key
    const decryptKey = this.syncEngine.createDecryptKey(
      projectState.organizationId!,
      projectState.projectId!,
      authResult.user_id!,
      encryptionKey,
      Object.keys(finalEnv)
    );
    this.fileManager.writeDecryptKey(decryptKey);

    // Update sync state with current variables
    const newSyncState: SyncState = {
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(finalEnv)
    };
    this.fileManager.writeSyncState(newSyncState);

    syncSpinner.succeed('Sync completed successfully');

    // Generate result
    const result = this.syncEngine.generateSyncResult(changeSet, decisions);

    if (result.pushed.length > 0) {
      this.promptEngine.displaySuccess(`Pushed ${result.pushed.length} variable(s) to keep`);
    }
    if (result.pulled.length > 0) {
      this.promptEngine.displaySuccess(`Pulled ${result.pulled.length} variable(s) from keep`);
    }
    if (result.conflicts.length > 0) {
      this.promptEngine.displaySuccess(`Resolved ${result.conflicts.length} conflict(s)`);
    }

    console.log(`\n✓ Total: ${result.totalVariables} variables synchronized`);

    if (decisions.pushVariables.length > 0) {
      await this.promptDeployOrContinue(decisions.pushVariables);
    }
  }

  private async promptDeployOrContinue(syncedVars: string[]): Promise<void> {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Want to deploy your changes to an environment?',
      choices: [
        { name: 'Continue working', value: 'continue' },
        { name: 'Create a deployment PR', value: 'pr' },
      ],
    }]);

    if (action !== 'pr') return;

    await CapyCommand.createDeployPR(syncedVars);
  }

  /**
   * Create a deployment PR with the .keep file.
   * Can be called directly via `capy deploy` or after a sync.
   */
  static async createDeployPR(syncedVars?: string[]): Promise<void> {
    const { ProjectManager } = await import('../core/projectManager');
    const pm = new ProjectManager();
    const projectName = pm.getDefaultProjectName();
    const keepFile = pm.readKeepFile();

    if (!keepFile) {
      console.error('No .keep file found. Run capy first to initialize.');
      process.exit(1);
    }

    // If no vars specified, use all variables from .keep
    const vars = syncedVars || Object.keys(keepFile.variables);
    if (vars.length === 0) {
      console.error('No variables to deploy.');
      return;
    }

    const baseBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    const deployBranch = `capy/sync-${projectName}-${Date.now()}`;

    try {
      const prSpinner = ora('Creating PR...').start();

      execSync(`git checkout -b ${deployBranch}`, { stdio: 'pipe' });
      execSync('git add .keep', { stdio: 'pipe' });

      const title = `chore: sync ${vars.length} ${projectName} secret${vars.length === 1 ? '' : 's'} via capy`;
      const varList = vars.map(v => `- ${v}`).join('\n');
      const fullMessage = `${title}\n\nSynced variables:\n${varList}`;
      const { writeFileSync: writeTmp, unlinkSync: unlinkTmp } = require('fs');
      const { join: joinTmp } = require('path');
      const tmpMsg = joinTmp(require('os').tmpdir(), `capy-commit-msg-${Date.now()}`);
      writeTmp(tmpMsg, fullMessage, 'utf-8');
      execSync(`git commit -F "${tmpMsg}"`, { stdio: 'pipe' });
      unlinkTmp(tmpMsg);
      execSync(`git push -u origin ${deployBranch}`, { stdio: 'pipe' });

      // Switch back to original branch
      execSync(`git checkout ${baseBranch}`, { stdio: 'pipe' });

      // Build GitHub PR URL
      const remoteUrl = execSync('git remote get-url origin', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      const repoPath = remoteUrl
        .replace(/^git@github\.com:/, '')
        .replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '');

      const prUrl = `https://github.com/${repoPath}/compare/${baseBranch}...${deployBranch}?expand=1&title=${encodeURIComponent(title)}`;

      prSpinner.succeed('Branch pushed');
      console.log(`\nCreate PR: ${prUrl}`);
    } catch (error: any) {
      console.error(`Failed to create PR: ${error.message}`);
    }
  }

  private handleError(error: any): void {
    if (error instanceof CapyError) {
      this.promptEngine.displayError(error.message);

      if (error.code === ERROR_CODES.AUTH_FAILED) {
        console.log('\nPlease ensure:');
        console.log('1. You have internet connectivity');
        console.log('2. You have a Capy account');
      } else if (error.code === ERROR_CODES.PERMISSION_DENIED) {
        console.log('\nContact your administrator to grant access to this project.');
      } else if (error.code === ERROR_CODES.NETWORK_ERROR) {
        console.log('\nWorking offline with local .env file');
        console.log('Run \'capy\' again when connection is restored');
      }
    } else {
      this.promptEngine.displayError(error.message || 'An unexpected error occurred');

      if (this.options.verbose) {
        console.error(error);
      }
    }

    process.exit(1);
  }

  private async createNewOrganization(refreshToken: string, userId: string): Promise<Organization> {
    const { orgName } = await inquirer.prompt([{
      type: 'input',
      name: 'orgName',
      message: 'Organization name:',
      validate: (input: string) => input.trim().length > 0 || 'Organization name cannot be empty',
    }]);

    const orgSpinner = ora('Creating organization...').start();
    const org = await this.authService.createOrganization(orgName.trim(), refreshToken, userId);
    orgSpinner.succeed(`Organization "${org.name}" created`);
    return org;
  }
}