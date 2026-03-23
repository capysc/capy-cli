import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { PromptEngine } from '../ui/promptEngine';
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
    const spinner = ora('🔐 Authenticating with WorkOS...').start();
    const authResult = await this.authService.authenticate();

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Authenticated as ${authResult.userEmail}`);

    // Set token for service client
    const token = this.authService.getToken();
    if (token) {
      this.serviceClient.setToken(token);
      if (this.devMode) {
        console.log(`\n🔑 Bearer token (dev mode):\n${token.access_token}\n`);
      }
    }

    // Resolve organization
    const orgs = authResult.organizations || [];
    let selectedOrg: Organization;

    if (orgs.length === 0) {
      // No orgs — prompt to create one
      console.log('\n🏢 No organization found. Let\'s create one.');
      const { orgName } = await inquirer.prompt([{
        type: 'input',
        name: 'orgName',
        message: 'Organization name:',
        validate: (input: string) => input.trim().length > 0 || 'Organization name cannot be empty',
      }]);

      const orgSpinner = ora('Creating organization...').start();
      selectedOrg = await this.authService.createOrganization(orgName.trim(), authResult._refreshToken!, authResult.userId!);
      orgSpinner.succeed(`Organization "${selectedOrg.name}" created`);
    } else if (orgs.length === 1) {
      // Single org — auto-select
      selectedOrg = orgs[0];
      console.log(`🏢 Organization: ${selectedOrg.name}`);
    } else {
      // Multiple orgs — prompt to pick, then re-authenticate scoped to that org.
      // Passing the WorkOS org ID to /auth/initiate lets AuthKit handle org selection,
      // so the exchange comes back with a single org and mints a JWT immediately.
      const { orgId } = await inquirer.prompt([{
        type: 'list',
        name: 'orgId',
        message: 'Select an organization:',
        choices: orgs.map(o => ({ name: o.name, value: o.id })),
      }]);
      selectedOrg = orgs.find(o => o.id === orgId)!;

      const orgSpinner = ora('Authenticating with organization...').start();
      const scopedAuth = await this.authService.authenticate(selectedOrg.workos_org_id);
      if (!scopedAuth.success) {
        orgSpinner.fail('Failed to authenticate with organization');
        throw new CapyError(
          scopedAuth.error || 'Organization authentication failed',
          ERROR_CODES.AUTH_FAILED
        );
      }
      orgSpinner.succeed(`Organization: ${selectedOrg.name}`);
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

    // Generate master key and create keep
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

    // Get initial decrypt data from service
    try {
      const decryptData = await this.serviceClient.getDecryptData(projectResult.project_id);

      // Create decrypt key
      const decryptKey = this.syncEngine.createDecryptKey(
        projectResult.org_id,
        projectResult.project_id,
        authResult.userId!,
        decryptData.decrypt_key,
        []
      );

      this.fileManager.writeDecryptKey(decryptKey);
      keySpinner.text = 'Generated your personal .decrypt key';

      // Parse and write encrypted env file if content exists
      if (decryptData.env_content) {
        const envVars = this.fileManager.parseEnvContent(decryptData.env_content);
        this.fileManager.writeEncryptedEnvFile(envVars, decryptData.decrypt_key, undefined, keep);
        keySpinner.succeed(`Retrieved and encrypted ${Object.keys(envVars).length} variables`);
      } else {
        keySpinner.succeed('No existing variables found');
      }
    } catch {
      // No existing data, that's ok for new project
      keySpinner.succeed('Project initialized');
    }

    // Update gitignore
    this.fileManager.ensureCapyGitignore();
    this.promptEngine.displaySuccess('Updated .gitignore to protect secrets');

    // Check if there's an existing .env file with variables to sync
    try {
      const localEnvPath = this.projectManager.getEnvPath(this.options.envPath);
      const existsEnv = require('fs').existsSync(localEnvPath);
      
      if (existsEnv) {
        const localEnv = this.fileManager.readEnvFile(this.options.envPath);
        const localVarCount = Object.keys(localEnv).length;
        
        if (localVarCount > 0) {
          console.log(`\n📋 Found existing .env file with ${localVarCount} variable(s)`);
          
          // Get decrypt data for syncing
          const decryptData = await this.serviceClient.getDecryptData(projectResult.project_id);
          
          // Automatically sync since this is a new project with no remote variables
          // No conflicts possible, so no need to prompt
          const syncSpinner = ora('🔄 Syncing local variables to keep...').start();
          
          try {
            // Push all local variables
            const pushResult = await this.serviceClient.pushVariables(
              projectResult.project_id,
              localEnv,
              keep
            );

            if (pushResult.success) {
              // Update keep file with variable metadata
              const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushResult.variables);
              this.fileManager.writeKeepFile(updatedKeep);

              // Write encrypted .env file
              this.fileManager.writeEncryptedEnvFile(localEnv, decryptData.decrypt_key, this.options.envPath, updatedKeep);
              
              // Update decrypt key with variable permissions
              const decryptKey = this.syncEngine.createDecryptKey(
                projectResult.org_id,
                projectResult.project_id,
                authResult.userId!,
                decryptData.decrypt_key,
                Object.keys(localEnv)
              );
              this.fileManager.writeDecryptKey(decryptKey);
              
              // Write initial sync state
              const initialSyncState: SyncState = {
                last_sync: new Date().toISOString(),
                synced_variables: Object.keys(localEnv)
              };
              this.fileManager.writeSyncState(initialSyncState);
              
              syncSpinner.succeed(`Synced ${localVarCount} variable(s) to keep`);
            } else {
              syncSpinner.fail('Failed to sync variables');
            }
          } catch (syncError) {
            syncSpinner.fail('Failed to sync variables');
            console.log('⚠️  You can run \'capy\' again to retry syncing');
          }
        }
      }
    } catch (error) {
      // Don't fail initialization if sync check fails
      if (this.options.verbose) {
        console.error('Error checking for .env file:', error);
      }
    }

    console.log('\n✓ Ready to work!');
  }

  private async syncProject(projectState: ProjectState): Promise<void> {
    console.log(`📁 Project: ${projectState.projectName}`);

    // Authenticate
    const spinner = ora('🔐 Authenticating with WorkOS...').start();
    const authResult = await this.authService.authenticate(projectState.organizationId);

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Authenticated as ${authResult.userEmail}`);

    // Set token for service client
    const token = this.authService.getToken();
    if (token) {
      this.serviceClient.setToken(token);
      if (this.devMode) {
        console.log(`\n🔑 Bearer token (dev mode):\n${token.access_token}\n`);
      }
    }

    // Get remote environment
    const fetchSpinner = ora('Retrieving remote .env...').start();
    const decryptData = await this.serviceClient.getDecryptData(projectState.projectId!);
    
    // Get remote environment - both encrypted (for resource_id) and decrypted (for comparison)
    let remoteEnvEncrypted: Record<string, string> = {};
    let remoteEnv: Record<string, string> = {};
    if (decryptData.env_content) {
      remoteEnvEncrypted = this.fileManager.parseEnvContent(decryptData.env_content);
      
      // Decrypt remote values for actual comparison
      for (const [key, value] of Object.entries(remoteEnvEncrypted)) {
        if (this.fileManager.isSnippetEncrypted(value) || this.fileManager.isEncrypted(value)) {
          try {
            remoteEnv[key] = this.fileManager.decryptValue(value, decryptData.decrypt_key);
          } catch (decryptError) {
            // If we can't decrypt, use the encrypted value
            remoteEnv[key] = value;
          }
        } else {
          remoteEnv[key] = value;
        }
      }
    }
    
    fetchSpinner.succeed(`Retrieved remote .env (${Object.keys(remoteEnv).length} variables)`);

    // Get local environment - both encrypted (for resource_id) and decrypted (for comparison)
    let localEnvEncrypted: Record<string, string> = {};
    let localEnv: Record<string, string> = {};
    const existingDecryptKey = this.projectManager.readDecryptKey();
    
    try {
      if (existingDecryptKey) {
        try {
          // Read encrypted to get resource_ids
          localEnvEncrypted = this.fileManager.readEnvFile(this.options.envPath);
          // Decrypt for actual comparison
          localEnv = this.fileManager.readEncryptedEnvFile(
            existingDecryptKey.decryption_key,
            this.options.envPath
          );
        } catch (error) {
          console.warn('⚠️  Failed to decrypt local .env, reading as plain text');
          localEnv = this.fileManager.readEnvFile(this.options.envPath);
          localEnvEncrypted = localEnv;
        }
      } else {
        localEnv = this.fileManager.readEnvFile(this.options.envPath);
        localEnvEncrypted = localEnv;
      }
    } catch (readError) {
      console.warn('⚠️  Failed to read local .env');
      localEnv = {};
      localEnvEncrypted = {};
    }

    // Read sync state for deletion detection
    // BUT: if local .env is missing/empty, ignore sync state and pull everything from remote
    const localEnvExists = Object.keys(localEnv).length > 0;
    const syncState = localEnvExists ? this.projectManager.readSyncState() : null;

    // Compare environments (use decrypted for actual comparison, encrypted for resource_id checking)
    const changeSet = this.syncEngine.compareEnvironments(
      localEnv, 
      remoteEnv, 
      localEnvEncrypted, 
      remoteEnvEncrypted,
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

    // Push variables to keep
    if (decisions.pushVariables.length > 0) {
      const pushVars: Record<string, string> = {};
      for (const varName of decisions.pushVariables) {
        pushVars[varName] = localEnv[varName];
      }

      // Get keep to retrieve existing resource_ids
      const keep = this.projectManager.readKeepFile();

      const pushResult = await this.serviceClient.pushVariables(
        projectState.projectId!,
        pushVars,
        keep
      );

      if (pushResult.success) {
        syncSpinner.text = `Pushed ${decisions.pushVariables.length} variables`;

        // Update keep file
        const keep = this.projectManager.readKeepFile()!;
        const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushResult.variables);
        this.fileManager.writeKeepFile(updatedKeep);
      }
    }

    // Push deletions to remote
    if (decisions.deleteRemote.length > 0) {
      const deleteVars: Record<string, string> = {};
      for (const varName of decisions.deleteRemote) {
        // Mark as deleted
        deleteVars[varName] = 'capy:deleted';
      }

      // Get keep to retrieve existing resource_ids
      const keep = this.projectManager.readKeepFile();

      const pushResult = await this.serviceClient.pushVariables(
        projectState.projectId!,
        deleteVars,
        keep
      );

      if (pushResult.success) {
        syncSpinner.text = `Deleted ${decisions.deleteRemote.length} variables from remote`;

        // Remove from keep file
        const keep = this.projectManager.readKeepFile()!;
        for (const varName of decisions.deleteRemote) {
          delete keep.variables[varName];
        }
        keep.last_sync = new Date().toISOString();
        this.fileManager.writeKeepFile(keep);
      }
    }

    // Apply decisions to create final env
    const finalEnv = this.syncEngine.applyDecisions(localEnv, remoteEnv, decisions);
    
    // Get updated keep after push and clean it up
    let finalKeep = this.projectManager.readKeepFile();

    // Update keep with resource_ids from pulled/restored variables
    if (finalKeep && (decisions.pullVariables.length > 0 || decisions.keepRemote.length > 0)) {
      const pulledVars = [...decisions.pullVariables, ...decisions.keepRemote];
      let keepUpdated = false;

      for (const varName of pulledVars) {
        // Extract resource_id from remoteEnvEncrypted
        const encryptedValue = remoteEnvEncrypted[varName];
        if (encryptedValue && encryptedValue.startsWith('capy:')) {
          const parts = encryptedValue.split(':');
          if (parts.length >= 3) {
            const resourceId = parts[1];
            const now = new Date().toISOString();

            if (!finalKeep.variables[varName]) {
              // New variable pulled from remote
              finalKeep.variables[varName] = {
                resource_id: resourceId,
                created_at: now,
                updated_at: now
              };
              keepUpdated = true;
            } else if (finalKeep.variables[varName].resource_id !== resourceId) {
              // Existing variable but resource_id changed
              finalKeep.variables[varName].resource_id = resourceId;
              finalKeep.variables[varName].updated_at = now;
              keepUpdated = true;
            }
          }
        }
      }

      if (keepUpdated) {
        finalKeep.last_sync = new Date().toISOString();
        this.fileManager.writeKeepFile(finalKeep);
      }
    }

    // Clean up keep: remove variables that no longer exist in finalEnv
    if (finalKeep) {
      const finalEnvKeys = new Set(Object.keys(finalEnv));
      const keepKeys = Object.keys(finalKeep.variables);
      let removedFromKeep = 0;

      for (const keepKey of keepKeys) {
        if (!finalEnvKeys.has(keepKey)) {
          delete finalKeep.variables[keepKey];
          removedFromKeep++;
        }
      }

      if (removedFromKeep > 0) {
        finalKeep.last_sync = new Date().toISOString();
        this.fileManager.writeKeepFile(finalKeep);
      }
    }

    // Write encrypted .env file using the decryption key
    this.fileManager.writeEncryptedEnvFile(finalEnv, decryptData.decrypt_key, this.options.envPath, finalKeep);
    syncSpinner.text = `Updated encrypted .env with ${Object.keys(finalEnv).length} total variables`;

    // Update decrypt key
    const decryptKey = this.syncEngine.createDecryptKey(
      projectState.organizationId!,
      projectState.projectId!,
      authResult.userId!,
      decryptData.decrypt_key,
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
}