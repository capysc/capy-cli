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
import {
  generateSeedPhrase,
  validateSeedPhrase,
  seedPhraseToMasterKey,
  encryptMasterKey,
  deriveWrappingKey,
} from '../crypto/keyManager';
import {
  resolveProjectKey,
  hasOrgKey,
} from '../crypto/keyResolver';
import { saveMasterKey } from '../config/globalConfig';

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

    // Auto-refresh token on 401
    this.serviceClient.setTokenRefresher(async () => {
      const refreshed = await this.authService.refreshToken();
      if (refreshed) {
        return this.authService.getToken();
      }
      return null;
    });
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
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') {
        process.exit(0);
      }
      this.handleError(error);
    }
  }

  private async initializeProject(): Promise<void> {
    console.log('No .keep file found - initializing project...');

    // Authenticate first
    const spinner = ora('Authenticating...').start();
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
        console.log(`\nBearer token (${authResult._auth_method || 'oauth'}):\n${token.access_token}\n`);
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
      console.log('\nNo organization found. Let\'s create one.');
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

    // Ensure org has a master key — generate seed phrase if first time
    const currentToken = this.authService.getToken();
    if (!hasOrgKey(selectedOrg.id)) {
      const seedPhrase = generateSeedPhrase();

      const rose = (s: string) => `\x1b[38;2;160;107;107m${s}\x1b[0m`;
      const red = (s: string) => `\x1b[1;31m${s}\x1b[0m`;

      console.log('');
      console.log(red('SAVE YOUR RECOVERY PHRASE'));
      console.log('');
      console.log(seedPhrase);
      console.log('');

      const boxLines = [
        'This recovery phrase is your master key to this',
        'project. This key, and all other keys derived from',
        'it only exists here and now, and cannot be retrieved',
        'when lost.',
        '',
        'Capy is a ZERO TRUST secrets platform, which means',
        'we do not store, and cannot decode your secrets for',
        'you. IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU',
        'RECOVER YOUR SECRETS.',
      ];

      const maxLen = Math.max(50, ...boxLines.map(l => l.length + 2));

      console.log(rose('┌' + '─'.repeat(maxLen) + '┐'));
      for (const line of boxLines) {
        const pad = maxLen - line.length - 1;
        console.log(`${rose('│')} ${rose(line)}${' '.repeat(Math.max(0, pad))}${rose('│')}`);
      }
      console.log(rose('└' + '─'.repeat(maxLen) + '┘'));
      console.log('');

      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: 'I have saved my recovery phrase',
        default: false,
      }]);

      if (!confirmed) {
        throw new CapyError(
          'You must save your recovery phrase before continuing.',
          ERROR_CODES.AUTH_FAILED
        );
      }

      const masterKey = seedPhraseToMasterKey(seedPhrase);
      const wrappingKey = deriveWrappingKey(currentToken!.access_token);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(selectedOrg.id, encryptedM);
    }

    const keySpinner = ora('Generating encryption keys...').start();

    // Derive project encryption key from master key
    const encryptionKey = resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      currentToken!.access_token,
    );

    // Create keep file (v2 format)
    const keep: KeepFile = {
      version: '2.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
      created_at: new Date().toISOString(),
      last_sync: new Date().toISOString(),
      variables: {}
    };

    this.fileManager.writeKeepFile(keep);
    keySpinner.text = 'Created .keep configuration file';

    // Get remote data (for existing variables, not for key)
    let remoteData = { env_content: '', decrypt_key: '', expires_at: '' };
    try {
      remoteData = await this.serviceClient.getDecryptData(projectResult.project_id);
    } catch {
      // Service unavailable
    }

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
        // Cross-org exfiltration guard: if .env has encrypted values, verify they
        // belong to this project's key. This catches the attack where a rogue user
        // deletes .keep/.capy and re-initializes to a different org. But if the user
        // lost their metadata and re-inits to the SAME org/project, the key matches
        // and their secrets are recoverable.
        const encryptedEntries = Object.entries(localEnv)
          .filter(([_, value]) => value.startsWith('capy:'));

        if (encryptedEntries.length > 0) {
          const foreignKeys: string[] = [];
          for (const [key, value] of encryptedEntries) {
            try {
              this.fileManager.decryptValue(value, encryptionKey);
            } catch {
              foreignKeys.push(key);
            }
          }

          if (foreignKeys.length > 0) {
            console.error(`\nCannot initialize: .env contains ${foreignKeys.length} value(s) encrypted with a different project's key:`);
            for (const key of foreignKeys) {
              console.error(`  ${key}`);
            }
            console.error('\nTo fix: delete the .env file or replace encrypted values with plaintext before initializing a new project.');
            throw new CapyError(
              'Cannot push secrets encrypted with a different project\'s key to a new org',
              ERROR_CODES.PERMISSION_DENIED,
              { foreignKeys }
            );
          }

          // Values are encrypted but belong to this project — decrypt them for push
          for (const [key, value] of encryptedEntries) {
            localEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
          }
        }

        console.log(`\nFound existing .env file with ${localVarCount} variable(s)`);
        const syncSpinner = ora('Syncing local variables to keep...').start();

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

            syncSpinner.succeed(`Synced and encrypted ${localVarCount} variable(s)`);

            // Show what was synced
            console.log('');
            for (const varName of Object.keys(localEnv)) {
              console.log(`  ${varName}`);
            }

            console.log('\nReady to work!');
            await this.promptDeployOrContinue(Object.keys(localEnv));
          } else {
            syncSpinner.fail('Failed to sync variables');
          }
        } catch (syncError: any) {
          syncSpinner.fail(`Failed to sync variables: ${syncError.message}`);
          console.log('You can run \'capy\' again to retry syncing');
        }
      }
    }

    console.log('\nReady to work!');
  }

  private async syncProject(projectState: ProjectState): Promise<void> {
    console.log(`Project: ${projectState.projectName}`);

    // Authenticate
    const spinner = ora('Authenticating...').start();
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
        console.log(`\nBearer token (${authResult._auth_method || 'oauth'}):\n${token.access_token}\n`);
      }
    }

    // Get remote environment (branch-aware)
    let activeBranch = projectState.activeBranch;
    const fetchSpinner = ora(activeBranch ? `Retrieving remote .env (${activeBranch})...` : 'Retrieving remote .env...').start();

    let decryptData;
    try {
      decryptData = await this.serviceClient.getDecryptData(projectState.projectId!, activeBranch);
    } catch (error: any) {
      if (error instanceof CapyError && error.details?.status === 404) {
        fetchSpinner.stop();
        const { recreate } = await inquirer.prompt([{
          type: 'confirm',
          name: 'recreate',
          message: 'Project not found — create a new one and re-sync?',
          default: true,
        }]);

        if (!recreate) {
          console.log('Run capy again after resolving the issue.');
          return;
        }

        // Re-create the project
        const projectName = projectState.projectName || this.projectManager.getDefaultProjectName();
        const initSpinner = ora('Re-creating project...').start();
        const projectResult = await this.serviceClient.initializeProject(
          projectName,
          authResult.organization_id || projectState.organizationId!
        );
        initSpinner.succeed(`Project "${projectName}" re-created`);

        // Update .keep with new project ID
        const keep = this.projectManager.readKeepFile()!;
        keep.project_id = projectResult.project_id;
        keep.org_id = projectResult.org_id;
        this.fileManager.writeKeepFile(keep);

        // Retry with new project ID
        decryptData = await this.serviceClient.getDecryptData(projectResult.project_id, activeBranch);
        // Update projectState for the rest of the flow
        projectState.projectId = projectResult.project_id;
      } else {
        throw error;
      }
    }
    const encryptionKey = resolveProjectKey(
      projectState.organizationId!,
      projectState.projectId!,
      token!.access_token,
    );

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

    const branchLabel = activeBranch ? ` (${activeBranch})` : '';
    fetchSpinner.succeed(`Retrieved remote .env${branchLabel} (${Object.keys(remoteEnv).length} variables)`);

    if (this.devMode) {
      console.log(`\nRemote .env${branchLabel} (dev mode):`);
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
            // Value is encrypted with a different project's key — reject
            throw new CapyError(
              `"${key}" is encrypted with a different project's key and cannot be used in this project. ` +
              `This can happen if you reset project metadata (.keep/.capy) without clearing the .env file.`,
              ERROR_CODES.PERMISSION_DENIED,
              { variable: key }
            );
          }
        } else {
          localEnv[key] = value;
        }
      }
    } catch (error: any) {
      if (error instanceof CapyError) throw error;
      console.warn('Failed to read local .env');
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
      this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, this.options.envPath, finalKeep, activeBranch);
      return;
    }

    // Prompt for decisions
    const decisions = await this.promptEngine.promptForChanges(changeSet, activeBranch);

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
    const syncSpinner = ora('Syncing...').start();

    // Apply decisions to create final env (all variables, merged)
    const finalEnv = this.syncEngine.applyDecisions(localEnv, remoteEnv, decisions);

    // Push the full state to remote (branch-aware, replaces entire blob)
    const keep = this.projectManager.readKeepFile();
    const pushResult = await this.serviceClient.pushVariables(
      projectState.projectId!,
      finalEnv,
      keep,
      activeBranch
    );

    let finalKeep = keep;
    if (pushResult.success) {
      // Update keep with resource_ids from push
      finalKeep = this.syncEngine.mergeWithKeep(keep!, pushResult.variables, activeBranch);

      // Remove deleted variables from keep
      for (const varName of decisions.deleteRemote) {
        delete finalKeep.variables[varName];
      }

      finalKeep.last_sync = new Date().toISOString();
      this.fileManager.writeKeepFile(finalKeep);
    }

    // Write encrypted .env file
    this.fileManager.writeEncryptedEnvFile(finalEnv, encryptionKey, this.options.envPath, finalKeep, activeBranch);
    syncSpinner.text = `Updated encrypted .env${branchLabel} with ${Object.keys(finalEnv).length} total variables`;

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

    console.log(`\nTotal: ${result.totalVariables} variables synchronized`);

    const changedVars = [...decisions.pushVariables, ...decisions.deleteRemote];
    if (changedVars.length > 0) {
      await this.promptDeployOrContinue(changedVars, activeBranch);
    }
  }

  private async promptDeployOrContinue(syncedVars: string[], branch?: string): Promise<void> {
    const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    const targetLabel = branch || gitBranch;
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Want to deploy your changes to an environment?',
      choices: [
        { name: 'No  - Continue working', value: 'continue' },
        { name: `Yes - Create a deployment PR → "${targetLabel}"`, value: 'pr' },
      ],
    }]);

    if (action !== 'pr') return;

    await CapyCommand.createDeployPR(syncedVars, true);
  }

  /**
   * Create a deployment PR with the .keep file.
   * Can be called directly via `capy deploy` or after a sync.
   * @param skipConfirm - skip the branch confirmation prompt (already confirmed by caller)
   */
  static async createDeployPR(syncedVars?: string[], skipConfirm: boolean = false): Promise<void> {
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
    const targetBranch = pm.readActiveBranch() || baseBranch;

    // Confirmation prompt (only when called directly via `capy deploy`)
    if (!skipConfirm) {
      const { confirm } = await inquirer.prompt([{
        type: 'list',
        name: 'confirm',
        message: `Deploy your secrets to a git branch?`,
        choices: [
          { name: `Create a deployment PR → "${targetBranch}"`, value: 'deploy' },
          { name: 'Another git branch', value: 'other' },
        ],
      }]);

      if (confirm === 'other') {
        console.log('');
        console.log('  To deploy to a different branch:');
        console.log('');
        console.log('    1. Switch branches:  capy checkout -b <branch-name>');
        console.log('    2. Deploy:           capy deploy');
        console.log('');
        return;
      }
    }

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
      if (error?.name === 'ExitPromptError') {
        process.exit(0);
      }
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