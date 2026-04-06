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
  KeepVariableEntry,
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
        // Check if .env has metadata we can recover from (e.g. .keep was deleted)
        const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
        if (envMeta.org_id && envMeta.project_id) {
          projectState.initialized = true;
          projectState.organizationId = envMeta.org_id;
          projectState.projectId = envMeta.project_id;
          projectState.activeBranch = envMeta.branch;
        } else {
          await this.initializeProject();
          return;
        }
      }
      await this.syncProject(projectState);
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
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
    if (!hasOrgKey(selectedOrg.id, authResult.user_id!)) {
      const seedPhrase = generateSeedPhrase();

      const warn = (s: string) => `\x1b[38;2;235;90;120m${s}\x1b[0m`;

      const boxLines = [
        'This recovery phrase generates the master key for',
        'all projects in this organization.',
        '',
        '1) As its owner, only you have it',
        '2) It only exists here and now, and cannot be',
        '   retrieved when lost',
        '',
        'Capy is a ZERO TRUST secrets platform, which means',
        'we do not store and cannot decode your secrets for',
        'you. IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU!',
        '',
        'To learn more about zero-trust:',
        'https://capy.sc/zero-trust',
      ];

      const maxLen = Math.max(50, ...boxLines.map(l => l.length + 2));
      const title = '!!!IMPORTANT!!! - SAVE THIS RECOVERY PHRASE';
      const titlePad = Math.max(0, maxLen - title.length);
      const titleLeft = Math.floor(titlePad / 2);
      const titleRight = titlePad - titleLeft;

      console.log('');
      console.log(warn('─'.repeat(maxLen + 2)));
      console.log(warn(' '.repeat(titleLeft + 1) + title + ' '.repeat(titleRight + 1)));
      console.log(warn('─'.repeat(maxLen + 2)));
      console.log('');
      console.log('');
      console.log('');
      console.log(seedPhrase);
      console.log('');
      console.log('');
      console.log('');

      console.log(warn('┌' + '─'.repeat(maxLen) + '┐'));
      for (const line of boxLines) {
        const pad = maxLen - line.length - 1;
        console.log(`${warn('│')} ${warn(line)}${' '.repeat(Math.max(0, pad))}${warn('│')}`);
      }
      console.log(warn('└' + '─'.repeat(maxLen) + '┘'));
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
      const wrappingKey = deriveWrappingKey(authResult.user_id!, selectedOrg.id);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(selectedOrg.id, encryptedM, authResult.user_id!);
    }

    const keySpinner = ora('Generating encryption keys...').start();

    // Derive project encryption key from master key
    const encryptionKey = resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      authResult.user_id!,
    );

    // Create keep file (v3 format — deterministic, no timestamps)
    const keep: KeepFile = {
      version: '3.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
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

    // Stage .keep in git so collaborators don't hit "untracked file" errors on pull
    try {
      execSync('git add .keep', { stdio: 'pipe' });
    } catch {
      // Not a git repo — fine
    }

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
            keep,
            undefined,
            encryptionKey
          );

          if (pushResult.success) {
            const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushResult.variables);
            this.fileManager.writeKeepFile(updatedKeep);
            this.fileManager.writeSyncState({
              last_sync: new Date().toISOString(),
              synced_variables: Object.keys(localEnv),
              user_id: authResult.user_id,
            });

            // Backup plaintext .env before encrypting
            this.fileManager.backupPlaintextEnv(this.options.envPath);

            // Encrypt the local .env file
            this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, this.options.envPath, updatedKeep);

            syncSpinner.succeed(`Synced and encrypted ${localVarCount} variable(s)`);

            // Show what was synced
            console.log('');
            for (const varName of Object.keys(localEnv)) {
              console.log(`  ${varName}`);
            }

            console.log('\nReady to work!');
            await CapyCommand.createDeployPR(Object.keys(localEnv), this.serviceClient);
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

  /**
   * Prompt the user to switch branches when their active branch no longer exists.
   * Returns the selected branch name ('' for default/no branch, or a named branch).
   */
  private async promptBranchSwitch(projectId: string, missingBranch: string): Promise<string | undefined> {
    const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;

    console.log(`\n  Branch "${missingBranch}" cannot be found on Capy.\n`);

    let branches;
    try {
      branches = await this.serviceClient.listBranches(projectId);
    } catch {
      console.log('  Could not retrieve branches. Falling back to default.');
      this.projectManager.writeActiveBranch(undefined);
      return undefined;
    }

    if (branches.length === 0) {
      console.log('  No branches found. Using default.');
      this.projectManager.writeActiveBranch(undefined);
      return undefined;
    }

    // Show tree view
    console.log(`  Available branches:`);
    branches.forEach((b, i) => {
      const isLast = i === branches.length - 1;
      const connector = isLast ? '└──' : '├──';
      const name = b.name || 'no branch';
      const prot = b.is_protected ? `  ${grey('(protected)')}` : '';
      console.log(`  ${connector} ${name}${prot}`);
    });
    console.log('');

    const choices = branches.map(b => ({
      name: b.name || 'no branch',
      value: b.name,
    }));

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: 'Switch to:',
      choices,
    }]);

    this.projectManager.writeActiveBranch(selected || undefined);
    return selected || undefined;
  }

  private displayHeader(projectName: string, orgName: string, userName: string, branch?: string): void {
    const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

    // Shimmer effect: continuous gradient matching Capy brand
    // #3a5555 → #688795 → #a06b6b → #b1aa92 → #3a5555
    const shimmer = (s: string) => {
      const stops = [
        [58, 85, 85],    // #3a5555
        [104, 135, 149], // #688795
        [160, 107, 107], // #a06b6b
        [177, 170, 146], // #b1aa92
        [58, 85, 85],    // #3a5555
      ];
      const len = s.replace(/ /g, '').length;
      let charIdx = 0;
      return s.split('').map((ch) => {
        if (ch === ' ') return ch;
        const t = len > 1 ? charIdx / (len - 1) : 0;
        // Interpolate between gradient stops
        const segment = t * (stops.length - 1);
        const i = Math.floor(segment);
        const f = segment - i;
        const a = stops[Math.min(i, stops.length - 1)];
        const b = stops[Math.min(i + 1, stops.length - 1)];
        const r = Math.round(a[0] + (b[0] - a[0]) * f);
        const g = Math.round(a[1] + (b[1] - a[1]) * f);
        const bl = Math.round(a[2] + (b[2] - a[2]) * f);
        charIdx++;
        return `\x1b[38;2;${r};${g};${bl}m${ch}\x1b[0m`;
      }).join('');
    };

    const notCreated = grey('not yet created');
    const content = [
      `Project:      ${projectName === 'not yet created' ? notCreated : bold(projectName)}`,
      `Organization: ${orgName === 'not yet created' ? notCreated : orgName}`,
      `Branch:       ${branch || grey('none')}`,
      '',
      shimmer(`Welcome ${userName}`),
    ];

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const maxLen = Math.max(40, ...content.map(l => stripAnsi(l).length + 2));

    console.log('');
    console.log(grey('Capy CLI'));
    console.log(grey('┌' + '─'.repeat(maxLen) + '┐'));
    for (const line of content) {
      const pad = maxLen - stripAnsi(line).length - 1;
      console.log(`${grey('│')} ${line}${' '.repeat(Math.max(0, pad))}${grey('│')}`);
    }
    console.log(grey('└' + '─'.repeat(maxLen) + '┘'));
    console.log('');
  }

  private async syncProject(projectState: ProjectState): Promise<void> {
    // Load user-scoped session if we know who last synced this project
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }

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

    // Persist user ID to sync state immediately so future runs load the right session
    if (authResult.user_id) {
      this.projectManager.writeSyncStateUserId(authResult.user_id);
    }

    spinner.stop();

    const orgName = authResult.organization_name
      || authResult.organizations?.find(o => o.id === authResult.organization_id)?.name
      || (authResult.organizations?.length === 0 ? 'not yet created' : authResult.organization_id)
      || 'not yet created';

    this.displayHeader(
      projectState.projectName || 'not yet created',
      orgName,
      authResult.user_first_name || authResult.user_email || '',
      projectState.activeBranch,
    );

    // Set token for service client
    const token = this.authService.getToken();

    if (token) {
      this.serviceClient.setToken(token);
      if (this.devMode) {
        console.log(`\nBearer token (${authResult._auth_method || 'oauth'}):\n${token.access_token}\n`);
      }
    }

    if (!token) {
      throw new CapyError(
        'You do not have access to this project\'s organization.\n\n' +
        'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
        ERROR_CODES.PERMISSION_DENIED
      );
    }

    // Get remote environment (branch-aware, pinned to .keep version)
    let activeBranch = projectState.activeBranch;
    const fetchSpinner = ora(activeBranch ? `Retrieving remote .env (${activeBranch})...` : 'Retrieving remote .env...').start();

    // Compute keepHash if .keep has variables (version pinning)
    const currentKeep = this.projectManager.readKeepFile();
    const hasVariables = currentKeep && Object.keys(currentKeep.variables).length > 0;
    const keepHash = hasVariables
      ? SyncEngine.computeKeepHash(currentKeep!, activeBranch)
      : undefined;

    let decryptData;
    try {
      decryptData = await this.serviceClient.getDecryptData(
        projectState.projectId!,
        activeBranch,
        keepHash,
        keepHash ? true : false, // include_latest_hash when pinning
      );
    } catch (error: any) {
      if (error instanceof CapyError && error.details?.status === 404) {
        const errorMsg = error.message || '';
        fetchSpinner.stop();

        // Snapshot not found — fall back to latest
        if (errorMsg.includes('Snapshot not found')) {
          console.log('\n  Pinned version no longer exists in S3. Fetching latest...');
          decryptData = await this.serviceClient.getDecryptData(projectState.projectId!, activeBranch);
        }
        // Branch not found — prompt to switch
        else if (errorMsg.includes('Branch') || (errorMsg.includes('not found') && activeBranch)) {
          activeBranch = await this.promptBranchSwitch(projectState.projectId!, activeBranch!);
          decryptData = await this.serviceClient.getDecryptData(projectState.projectId!, activeBranch || undefined);
        }
        // Project or branch not found — do not recreate during sync
        else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Check if newer versions are available
    if (keepHash && decryptData.latest_keep_hash && keepHash !== decryptData.latest_keep_hash) {
      fetchSpinner.stop();
      const { pullLatest } = await inquirer.prompt([{
        type: 'confirm',
        name: 'pullLatest',
        message: 'Newer secret versions are available. Pull latest?',
        default: true,
      }]);

      if (pullLatest) {
        const latestSpinner = ora('Fetching latest...').start();
        decryptData = await this.serviceClient.getDecryptData(projectState.projectId!, activeBranch);
        latestSpinner.succeed('Fetched latest');
      }
    }
    const encryptionKey = resolveProjectKey(
      projectState.organizationId!,
      projectState.projectId!,
      authResult.user_id!,
    );

    // Parse remote (encrypted) and decrypt for comparison
    let remoteEnvEncrypted: Record<string, string> = {};
    let remoteEnv: Record<string, string> = {};
    if (decryptData.env_content) {
      remoteEnvEncrypted = this.fileManager.parseEnvContent(decryptData.env_content);
      for (const [key, value] of Object.entries(remoteEnvEncrypted)) {
        remoteEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
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
      activeBranch,
      encryptionKey
    );

    let finalKeep = keep;
    if (pushResult.success) {
      // Update keep with resource_ids from push
      finalKeep = this.syncEngine.mergeWithKeep(keep!, pushResult.variables, activeBranch);

      // Remove deleted variables from keep
      for (const varName of decisions.deleteRemote) {
        delete finalKeep.variables[varName];
      }

      this.fileManager.writeKeepFile(finalKeep);
    }

    // Write encrypted .env file
    this.fileManager.writeEncryptedEnvFile(finalEnv, encryptionKey, this.options.envPath, finalKeep, activeBranch);
    syncSpinner.text = `Updated encrypted .env${branchLabel} with ${Object.keys(finalEnv).length} total variables`;

    // Update sync state with current variables
    const newSyncState: SyncState = {
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(finalEnv),
      user_id: authResult.user_id,
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
      await CapyCommand.createDeployPR(changedVars, this.serviceClient);
    }
  }

  /**
   * Create a deployment PR with the .keep file.
   * Can be called directly via `capy deploy` or after a sync.
   * When deploying, the .keep entries are targeted to a Capy branch matching
   * the current git branch name. If that Capy branch doesn't exist, it is
   * auto-created with secrets copied from the active Capy branch.
   */
  static async createDeployPR(syncedVars?: string[], client?: ServiceClient): Promise<void> {
    const { ProjectManager } = await import('../core/projectManager');
    const { FileManager } = await import('../files/fileManager');
    const pm = new ProjectManager();
    const fm = new FileManager();
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

    const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    const capyBranch = gitBranch; // Deploy always targets a Capy branch matching the git branch

    const { confirm } = await inquirer.prompt([{
      type: 'list',
      name: 'confirm',
      message: `Deploy secrets to Capy branch "${capyBranch}" on git branch "${gitBranch}"?`,
      choices: [
        { name: `Push directly to "${gitBranch}"`, value: 'push' },
        { name: `Create a deployment PR → "${gitBranch}"`, value: 'deploy' },
        { name: 'Continue working', value: 'cancel' },
      ],
    }]);

    if (confirm === 'cancel') return;

    // Ensure we have an authenticated service client for branch operations
    if (!client) {
      const { AuthService } = await import('../auth/authService');
      const authService = new AuthService();
      client = new ServiceClient();

      // Load user-scoped session if available
      const syncState = pm.readSyncState();
      if (syncState?.user_id) {
        authService.setSessionUserId(syncState.user_id);
      }

      const authSpinner = ora('Authenticating...').start();
      const authResult = await authService.authenticate(keepFile.org_id);
      if (!authResult.success) {
        authSpinner.fail('Authentication failed');
        console.error('Cannot deploy without authentication.');
        return;
      }
      authSpinner.succeed('Authenticated');

      const token = authService.getToken();
      if (token) {
        client.setToken(token);
        client.setTokenRefresher(async () => {
          const refreshed = await authService.refreshToken();
          return refreshed ? authService.getToken() : null;
        });
      }
    }

    // Ensure the Capy branch exists, auto-create if needed
    const branchSpinner = ora(`Checking Capy branch "${capyBranch}"...`).start();
    try {
      const branches = await client.listBranches(keepFile.project_id);
      const branchExists = branches.some(b => b.name === capyBranch);

      if (!branchExists) {
        branchSpinner.text = `Creating Capy branch "${capyBranch}"...`;
        await client.createBranch(keepFile.project_id, capyBranch);

        // Copy secrets from the active Capy branch to the new one
        const activeBranch = pm.readActiveBranch();
        try {
          const currentData = await client.getDecryptData(keepFile.project_id, activeBranch);
          if (currentData.env_content) {
            const syncState = pm.readSyncState();
            const encryptionKey = resolveProjectKey(keepFile.org_id, keepFile.project_id, syncState?.user_id || '');
            const currentEnv = fm.parseEnvContent(currentData.env_content);
            const decrypted: Record<string, string> = {};
            for (const [key, value] of Object.entries(currentEnv)) {
              decrypted[key] = fm.decryptValue(value, encryptionKey);
            }
            await client.pushVariables(keepFile.project_id, decrypted, keepFile, capyBranch, encryptionKey);
            branchSpinner.succeed(`Created Capy branch "${capyBranch}" with ${Object.keys(decrypted).length} variable(s) copied`);
          } else {
            branchSpinner.succeed(`Created Capy branch "${capyBranch}" (empty)`);
          }
        } catch {
          branchSpinner.succeed(`Created Capy branch "${capyBranch}" (no secrets to copy)`);
        }
      } else {
        branchSpinner.succeed(`Capy branch "${capyBranch}" exists`);
      }
    } catch (error: any) {
      branchSpinner.fail(`Failed to verify Capy branch: ${error.message}`);
      return;
    }

    // Update .keep entries to reference the deploy Capy branch
    const deployKeep = { ...keepFile, variables: { ...keepFile.variables } };
    for (const varName of Object.keys(deployKeep.variables)) {
      const entries = deployKeep.variables[varName];
      if (!entries || entries.length === 0) continue;

      // Find the entry for the active Capy branch (or default) and retarget it
      const activeBranch = pm.readActiveBranch();
      const sourceEntry = entries.find(e =>
        activeBranch ? e.branch === activeBranch : !e.branch
      ) || entries[0];

      // Replace with an entry targeting the deploy branch
      const deployEntry: KeepVariableEntry = {
        resource_id: sourceEntry.resource_id,
        branch: capyBranch,
        value_hash: sourceEntry.value_hash,
      };

      // Keep other branch entries, replace/add the one for capyBranch
      const otherEntries = entries.filter(e => e.branch !== capyBranch);
      deployKeep.variables[varName] = [...otherEntries, deployEntry];
    }

    const title = `chore: sync ${vars.length} ${projectName} secret${vars.length === 1 ? '' : 's'} via capy`;
    const varList = vars.map(v => `- ${v}`).join('\n');
    const fullMessage = `${title}\n\nSynced variables:\n${varList}`;
    const { writeFileSync: writeTmp, unlinkSync: unlinkTmp } = require('fs');
    const { join: joinTmp } = require('path');
    const tmpMsg = joinTmp(require('os').tmpdir(), `capy-commit-msg-${Date.now()}`);
    writeTmp(tmpMsg, fullMessage, 'utf-8');

    // Write the deploy-targeted .keep before committing
    fm.writeKeepFile(deployKeep);

    // Direct push: commit .keep and push to git branch
    if (confirm === 'push') {
      const pushSpinner = ora(`Pushing to ${gitBranch}...`).start();
      try {
        execSync('git add .keep', { stdio: 'pipe' });
        execSync(`git commit -F "${tmpMsg}"`, { stdio: 'pipe' });
        unlinkTmp(tmpMsg);
        execSync(`git push origin HEAD:${gitBranch}`, { stdio: 'pipe' });
        pushSpinner.succeed(`Pushed .keep to ${gitBranch}`);
        return;
      } catch (pushErr: any) {
        unlinkTmp(tmpMsg);
        // Undo the local commit so the working tree is clean
        try { execSync('git reset HEAD~1', { stdio: 'pipe' }); } catch {}
        // Restore original .keep
        fm.writeKeepFile(keepFile);
        pushSpinner.fail(`Cannot push directly to "${gitBranch}" (likely protected)`);
        console.log('  Creating a deployment PR instead...\n');
        // Re-write deploy keep for PR path
        fm.writeKeepFile(deployKeep);
        // Fall through to PR path
      }
    }

    // PR path: create a deploy branch, commit .keep, push, switch back
    const deployGitBranch = `capy/sync-${projectName}-${Date.now()}`;

    try {
      const prSpinner = ora('Creating PR...').start();

      execSync(`git checkout -b ${deployGitBranch}`, { stdio: 'pipe' });
      execSync('git add .keep', { stdio: 'pipe' });

      writeTmp(tmpMsg, fullMessage, 'utf-8');
      execSync(`git commit -F "${tmpMsg}"`, { stdio: 'pipe' });
      unlinkTmp(tmpMsg);
      execSync(`git push -u origin ${deployGitBranch}`, { stdio: 'pipe' });

      // Switch back to original branch and restore original .keep
      execSync(`git checkout ${gitBranch}`, { stdio: 'pipe' });
      fm.writeKeepFile(keepFile);

      // Build GitHub PR URL
      const remoteUrl = execSync('git remote get-url origin', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      const repoPath = remoteUrl
        .replace(/^git@github\.com:/, '')
        .replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '');

      const prUrl = `https://github.com/${repoPath}/compare/${gitBranch}...${deployGitBranch}?expand=1&title=${encodeURIComponent(title)}`;

      prSpinner.succeed('Branch pushed');
      console.log(`\nCreate PR: ${prUrl}`);

      const open = (await import('open')).default;
      open(prUrl).catch(() => {});
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') process.exit(0);
      // Ensure we're back on gitBranch and original .keep is restored
      try { execSync(`git checkout ${gitBranch}`, { stdio: 'pipe' }); } catch {}
      fm.writeKeepFile(keepFile);
      console.log(`Failed to create PR: ${error.message}`);
    }
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