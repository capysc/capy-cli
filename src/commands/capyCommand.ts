import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { PromptEngine } from '../ui/promptEngine';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
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
  ERROR_CODES,
  getSyncKeepHash,
  setSyncKeepHash,
} from '../types/index';
import {
  generateSeedPhrase,
  validateSeedPhrase,
  seedPhraseToMasterKey,
} from '../crypto/keyManager';
import {
  resolveProjectKey,
  wrapAndSaveMasterKey,
  hasOrgKey,
  KeyServiceOps,
} from '../crypto/keyResolver';
import { writeKeepCache, fetchSecretsWithCache } from '../config/globalConfig';
import { compareSecrets, hashValue, formatSnippet } from './statusCommand';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

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

  /**
   * Bridge ServiceClient to the KeyServiceOps interface for key resolution.
   */
  private keyServiceOps(): KeyServiceOps {
    return {
      coDecrypt: (orgId, ciphertext) => this.serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
      wrapOuterLayer: (orgId, plaintext) => this.serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
    };
  }

  /**
   * Emit a dev-mode debug line to stderr. Active whenever the CLI is run
   * via `capy-dev` (devMode=true). Safe to sprinkle throughout the sync
   * flow — silent in production.
   */
  private debug(msg: string, data?: unknown): void {
    if (!this.devMode) return;
    const ts = new Date().toISOString();
    const prefix = `\x1b[90m[debug ${ts}]\x1b[0m`;
    if (data !== undefined) {
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      console.error(`${prefix} ${msg} ${serialized}`);
    } else {
      console.error(`${prefix} ${msg}`);
    }
  }

  /** Format any caught error for debug output, preserving stack and CapyError details. */
  private debugError(label: string, err: unknown): void {
    if (!this.devMode) return;
    if (err instanceof CapyError) {
      this.debug(`${label}: CapyError`, {
        message: err.message,
        code: err.code,
        details: err.details,
        stack: err.stack,
      });
    } else if (err instanceof Error) {
      this.debug(`${label}: ${err.name}`, {
        message: err.message,
        stack: err.stack,
      });
    } else {
      this.debug(`${label}: unknown`, String(err));
    }
  }

  async execute(): Promise<void> {
    try {
      // Detect project state
      const projectState = await this.projectManager.detectProjectState();

      if (!projectState.initialized) {
        // Check if .env has metadata we can recover from (e.g. keep.lock was deleted)
        const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
        if (envMeta.org_id && envMeta.project_id) {
          projectState.initialized = true;
          projectState.organizationId = envMeta.org_id;
          projectState.projectId = envMeta.project_id;
          projectState.activeBranch = envMeta.branch || 'development';
        } else {
          await this.initializeProject();
          return;
        }
      }
      await this.syncProject(projectState);
    } catch (error: any) {
      this.debugError('execute caught error', error);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  private async initializeProject(): Promise<void> {
    this.debug('initializeProject start', { cwd: process.cwd() });
    console.log('Welcome to Capy\n');

    // Check if sync-state has an org hint (e.g. from a recent `capy redeem`)
    const syncState = this.projectManager.readSyncState();
    const orgHint = syncState?.org_id;

    // Authenticate — pass org hint so session scopes to the right org
    const spinner = ora('Logging in...').start();
    const authResult = await this.authService.authenticate(orgHint);
    this.debug('init authResult', {
      success: authResult.success,
      user_id: authResult.user_id,
      organization_id: authResult.organization_id,
      orgCount: authResult.organizations?.length || 0,
      _auth_method: authResult._auth_method,
      error: authResult.error,
    });

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Authenticated as ${authResult.user_email || authResult.user_first_name} (${authResult._auth_method || 'oauth'})`);

    // Persist user ID to sync state immediately so the next `capy` run can find
    // the user-scoped session file at ~/.capy/auth/sessions/{userId}.json.
    // Without this, sync-state has no user_id, detectProjectState returns
    // undefined, AuthService loads from the unscoped path and finds nothing,
    // and the user is sent through OAuth again.
    if (authResult.user_id) {
      this.projectManager.writeSyncStateUserId(authResult.user_id);
    }

    // Set token for service client
    const token = this.authService.getToken();
    if (token) {
      this.serviceClient.setToken(token);
    }

    // Resolve organization
    const orgs = authResult.organizations || [];
    let selectedOrg: Organization;
    const SWITCH_ORG = '__switch_org__';
    const CREATE_NEW_ORG = '__create_new__';
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;

    const currentOrgId = authResult.organization_id;
    const currentOrg = orgs.find(o => o.id === currentOrgId);

    if (orgs.length === 0) {
      console.log('\nNo organization found. Let\'s create one.');
      selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);

    } else if (currentOrg) {
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
        return this.initializeProject();
      } else if (orgAction === CREATE_NEW_ORG) {
        selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);
  
      } else {
        selectedOrg = currentOrg;
      }
    } else {
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

        const orgSpinner = ora('Authenticating with organization...').start();
        let scopedAuth = await this.authService.refreshWithCredentials(
          refreshToken!,
          selectedOrg.id,
          authResult.user_id,
        );
        if (!scopedAuth.success) {
          orgSpinner.text = 'Re-authenticating...';
          this.authService.clearToken();
          scopedAuth = await this.authService.authenticate(selectedOrg.id);
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

    // User has access to an existing org but no local key — they were invited
    // and need to redeem their invite code to receive the shared master key.
    if (!hasOrgKey(selectedOrg.id, authResult.user_id!)) {
      throw new CapyError(
        `You have access to "${selectedOrg.name}" but no encryption key on this device.\n\n` +
        '  Ask your org owner for an invite code, then run:\n\n' +
        '    capy redeem <code>\n\n' +
        '  This will securely transfer the shared encryption key to your device.',
        ERROR_CODES.AUTH_FAILED
      );
    }

    // Discover existing projects in the org. If any exist, give the user the
    // choice to bootstrap one of them OR create a new project. This is the path
    // a teammate hits when cloning a repo with no committed keep.lock.
    const CREATE_NEW_PROJECT = '__create_new_project__';
    let existingProjects: Array<{ id: string; name: string; organization_id: string }> = [];
    try {
      const listSpinner = ora('Looking for existing projects...').start();
      existingProjects = await this.serviceClient.listProjects();
      listSpinner.stop();
      this.debug('listProjects response', existingProjects);
    } catch (err) {
      this.debugError('listProjects failed', err);
      // Network or auth issue — fall through to new-project flow
      existingProjects = [];
    }

    if (existingProjects.length > 0) {
      const choices = [
        ...existingProjects.map(p => ({
          name: `Sync existing: ${p.name}`,
          value: p.id,
        })),
        new inquirer.Separator(),
        { name: 'Create a new project', value: CREATE_NEW_PROJECT },
      ];

      const { projectChoice } = await inquirer.prompt([{
        type: 'list',
        name: 'projectChoice',
        message: 'Which project do you want to use?',
        choices,
      }]);

      if (projectChoice !== CREATE_NEW_PROJECT) {
        const picked = existingProjects.find(p => p.id === projectChoice)!;
        await this.bootstrapExistingProject(
          picked,
          selectedOrg.id,
          authResult.user_id!,
        );
        return;
      }
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
    initSpinner.succeed(`Project created: ${projectName} (development)`);

    const keySpinner = ora('Generating encryption keys...').start();

    // Derive project encryption key from master key (requires server co-decrypt)
    const encryptionKey = await resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      authResult.user_id!,
      this.keyServiceOps(),
    );

    // Create keep file (v3 format)
    const keep: KeepFile = {
      version: '3.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
      variables: {}
    };

    this.fileManager.writeKeepFile(keep);

    // Create the default development branch on the service
    await this.serviceClient.createBranch(projectResult.project_id, 'development');

    keySpinner.succeed('keep.lock created (pinned to development, 0 secrets)');

    // Update gitignore
    this.fileManager.ensureCapyGitignore();
    console.log('> .gitignore updated (added .env, .capy/)');

    // Stage keep.lock in git so collaborators don't hit "untracked file" errors on pull
    try {
      execSync('git add keep.lock', { stdio: 'pipe' });
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
        // Cross-org exfiltration guard
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

        // Show found variables (max 5 names, "etc." for 6+)
        const varNames = Object.keys(localEnv);
        const displayNames = varNames.length > 5
          ? varNames.slice(0, 5).join(', ') + ', etc.'
          : varNames.join(', ');
        console.log(`\nFound .env with ${localVarCount} secrets:`);
        console.log(`  ${displayNames}`);

        // First-run flow: commit to development or another branch
        const { initChoice } = await inquirer.prompt([{
          type: 'list',
          name: 'initChoice',
          message: '',
          choices: [
            { name: 'Commit all to development (default)', value: 'development' },
            { name: 'Commit all to another branch', value: 'other' },
          ],
        }]);

        let initBranch: string;
        if (initChoice === 'other') {
          const { branchName } = await inquirer.prompt([{
            type: 'input',
            name: 'branchName',
            message: 'Branch name:',
            validate: (input: string) => input.trim().length > 0 || 'Branch name cannot be empty',
          }]);
          initBranch = branchName.trim();
          await this.serviceClient.createBranch(projectResult.project_id, initBranch);
        } else {
          initBranch = 'development';
        }
        this.projectManager.writeActiveBranch(initBranch);

        const syncSpinner = ora('Syncing local variables...').start();

        try {
          const { createHash } = await import('crypto');
          const { deriveResourceId } = await import('../crypto/resourceId');
          const { Encryptor } = await import('../crypto/encryptor');

          // Build encrypted env blob and keep.lock hashes
          const encrypted: Record<string, string> = {};
          const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
          for (const [key, value] of Object.entries(localEnv)) {
            const resourceId = deriveResourceId(initBranch, key);
            const enc = Encryptor.encrypt(value, encryptionKey);
            encrypted[key] = `capy:${resourceId}:${enc}`;
            pushedVars[key] = {
              resource_id: resourceId,
              value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
            };
          }

          const envBlob = Object.entries(encrypted)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

          const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushedVars, initBranch);
          const keepJson = JSON.stringify(updatedKeep);

          await this.serviceClient.pushSecrets(
            projectResult.project_id,
            keepJson,
            envBlob,
            initBranch,
          );

          this.fileManager.writeKeepFile(updatedKeep);

          // Cache encrypted blob locally
          const initKeepHash = SyncEngine.computeKeepHash(updatedKeep, initBranch);
          writeKeepCache(initKeepHash, envBlob);

          this.fileManager.writeSyncState({
            last_sync: new Date().toISOString(),
            synced_variables: Object.keys(localEnv),
            user_id: authResult.user_id,
            keep_hash: setSyncKeepHash(null, initBranch, initKeepHash),
          });

          // Backup plaintext .env before encrypting
          this.fileManager.backupPlaintextEnv(this.options.envPath);

          // Encrypt the local .env file
          this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, undefined, updatedKeep, initBranch);

          syncSpinner.succeed(`keep.lock created (pinned to ${initBranch}, ${localVarCount} secrets)`);

          // Install git hooks
          this.installGitHooks();

          console.log(`\nRun ${B('capy push')} to share your secrets with teammates.`);
        } catch (syncError: any) {
          syncSpinner.fail(`Failed to sync variables: ${syncError.message}`);
          console.log(`You can run ${B('capy')} again to retry syncing`);
        }
      } else {
        console.log(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
        console.log('to share them with your team.');

        // Install git hooks
        this.installGitHooks();
      }
    } else {
      console.log(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
      console.log('to share them with your team.');

      // Install git hooks
      this.installGitHooks();
    }
  }

  /**
   * Bootstrap an existing project into the current directory.
   *
   * Used when the user lands in a directory with no keep.lock and picks an
   * existing project from the org's project list. Pulls the latest keep.json
   * + env_blob for the development branch from the server, decrypts each
   * variable, writes keep.lock + encrypted .env. After this returns, the
   * directory looks identical to one that did `capy push` from scratch.
   */
  private async bootstrapExistingProject(
    project: { id: string; name: string; organization_id: string },
    orgId: string,
    userId: string,
  ): Promise<void> {
    const branch = 'development';
    const encryptionKey = await resolveProjectKey(orgId, project.id, userId, this.keyServiceOps());

    const fetchSpinner = ora(`Pulling ${project.name} (${branch})...`).start();

    let decryptData;
    try {
      decryptData = await this.serviceClient.getDecryptData(
        project.id,
        branch,
        undefined, // ask for latest
        true,
      );
    } catch (err: any) {
      // 404 with "No secrets" → empty project, write a stub keep.lock and exit
      if (err instanceof CapyError && err.details?.status === 404 && /No secrets/i.test(err.message)) {
        fetchSpinner.stop();
        const stub: KeepFile = {
          version: '3.0',
          org_id: orgId,
          project_id: project.id,
          project_name: project.name,
          variables: {},
        };
        this.fileManager.writeKeepFile(stub);
        this.projectManager.writeActiveBranch(branch);
        this.fileManager.ensureCapyGitignore();
        console.log(`\n${B(project.name)} has no secrets yet.`);
        console.log(`Add secrets to .env, then run ${B('capy push')}.`);
        this.installGitHooks();
        return;
      }
      fetchSpinner.fail(`Failed to pull from ${B(project.name)}.`);
      throw err;
    }

    if (!decryptData.keep_file) {
      // No keep_file means the project exists but has never been pushed to.
      // Treat it like an empty project — write a stub keep.lock.
      fetchSpinner.stop();
      const stub: KeepFile = {
        version: '3.0',
        org_id: orgId,
        project_id: project.id,
        project_name: project.name,
        variables: {},
      };
      this.fileManager.writeKeepFile(stub);
      this.projectManager.writeActiveBranch(branch);
      this.fileManager.ensureCapyGitignore();
      console.log(`\n${B(project.name)} has no secrets yet.`);
      console.log(`Add secrets to .env, then run ${B('capy push')}.`);
      this.installGitHooks();
      return;
    }

    // Parse the keep.json the server sent us
    const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
    // Make sure project metadata is consistent (server's keep.json may have
    // been written before project_name existed in the schema)
    serverKeep.org_id = orgId;
    serverKeep.project_id = project.id;
    serverKeep.project_name = project.name;

    // Decrypt the env blob into plaintext
    const plaintext: Record<string, string> = {};
    if (decryptData.env_content) {
      const encrypted = this.fileManager.parseEnvContent(decryptData.env_content);
      for (const [key, value] of Object.entries(encrypted)) {
        try {
          plaintext[key] = this.fileManager.decryptValue(value, encryptionKey);
        } catch {
          // Skip undecryptable (user lacks variable-level permission)
        }
      }
    }

    // Write keep.lock + encrypted .env locally
    this.fileManager.writeKeepFile(serverKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();
    this.fileManager.writeEncryptedEnvFile(plaintext, encryptionKey, undefined, serverKeep, branch);

    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(plaintext),
      user_id: userId,
      keep_hash: setSyncKeepHash(null, branch, SyncEngine.computeKeepHash(serverKeep, branch)),
    });

    fetchSpinner.succeed(
      `Pulled ${Object.keys(plaintext).length} secret(s) from ${B(project.name)} (${branch})`,
    );

    // Stage keep.lock so the user can commit it for the rest of the team
    try {
      execSync('git add keep.lock', { stdio: 'pipe' });
    } catch {
      // Not a git repo — fine
    }

    this.installGitHooks();
  }

  /**
   * Install git hooks (post-checkout, post-merge).
   * Idempotent: checks for existing marker before appending.
   * No pre-push hook.
   */
  private installGitHooks(): void {
    try {
      const gitDir = execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      const hooksDir = `${gitDir}/hooks`;
      const { mkdirSync, readFileSync: readFs, writeFileSync: writeFs, chmodSync } = require('fs');
      const { existsSync: exists } = require('fs');

      if (!exists(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
      }

      const MARKER = '# --- capy auto-sync (do not remove) ---';
      const END_MARKER = '# --- end capy ---';
      const escMarker = MARKER.replace(/[()]/g, '\\$&');
      const escEnd = END_MARKER.replace(/[()]/g, '\\$&');
      const cmd = this.devMode ? 'capy-dev' : 'capy';

      const hooks: Record<string, string> = {
        'post-checkout': [
          MARKER,
          'if [ "$3" = "1" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-merge" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-apply" ]; then',
          `  command -v ${cmd} >/dev/null 2>&1 && ${cmd} status`,
          'fi',
          END_MARKER,
        ].join('\n'),
        'post-merge': [
          MARKER,
          `command -v ${cmd} >/dev/null 2>&1 && ${cmd} status`,
          END_MARKER,
        ].join('\n'),
      };

      // Remove pre-push capy block if it exists
      const prePushPath = `${hooksDir}/pre-push`;
      if (exists(prePushPath)) {
        const prePushContent = readFs(prePushPath, 'utf-8');
        if (prePushContent.includes(MARKER)) {
          const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
          const updated = prePushContent.replace(re, '');
          writeFs(prePushPath, updated, 'utf-8');
        }
      }

      for (const [hookName, content] of Object.entries(hooks)) {
        const hookPath = `${hooksDir}/${hookName}`;
        let existing = '';
        if (exists(hookPath)) {
          existing = readFs(hookPath, 'utf-8');
          if (existing.includes(MARKER)) {
            // Replace existing capy block (e.g. switching between capy/capy-dev)
            const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
            const updated = existing.replace(re, `${content}\n`);
            if (updated !== existing) {
              writeFs(hookPath, updated, 'utf-8');
            }
            continue;
          }
        }

        const shebang = existing ? '' : '#!/bin/sh\n';
        const separator = existing && !existing.endsWith('\n') ? '\n' : '';
        writeFs(hookPath, `${existing}${separator}${shebang}${content}\n`, 'utf-8');
        chmodSync(hookPath, 0o755);
      }
    } catch {
      // Not a git repo or hooks dir inaccessible — silently skip
    }
  }

  /**
   * Prompt the user to switch branches when their active branch no longer exists.
   */
  private async promptBranchSwitch(projectId: string, missingBranch: string): Promise<string | undefined> {
    const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;

    console.log(`\n  Branch "${missingBranch}" cannot be found on Capy.\n`);

    let branches;
    try {
      branches = await this.serviceClient.listBranches(projectId);
    } catch (err) {
      this.debugError('listBranches failed', err);
      console.log('  Could not retrieve branches. Falling back to default.');
      this.projectManager.writeActiveBranch(undefined);
      return undefined;
    }

    if (branches.length === 0) {
      console.log('  No branches found. Using default.');
      this.projectManager.writeActiveBranch(undefined);
      return undefined;
    }

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

  /**
   * Remove local data for an org the user no longer has access to.
   * Called on 403 during sync (user was kicked). Does NOT touch session
   * data for other orgs or the refresh token — only the revoked org.
   */
  private cleanupOrgData(orgId: string, userId?: string): void {
    // Delete org master key
    try {
      const { getOrgKeyPath } = require('../config/globalConfig');
      const keyPath = getOrgKeyPath(orgId, userId);
      if (existsSync(keyPath)) {
        unlinkSync(keyPath);
        console.log('  Removed local encryption key for this organization.');
      }
    } catch {}

    // Delete keep.lock — it points to an org the user can't access
    const keepPath = join(process.cwd(), 'keep.lock');
    if (existsSync(keepPath)) {
      try {
        unlinkSync(keepPath);
        console.log('  Removed keep.lock (no longer a member).');
      } catch {}
    }

    // Clear project key cache for this org
    try {
      const { getGlobalCapyDir } = require('../config/globalConfig');
      const orgDir = join(getGlobalCapyDir(), 'orgs', orgId);
      if (existsSync(orgDir)) {
        rmSync(orgDir, { recursive: true });
      }
    } catch {}
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
    const capy = [
      '   █▄▄▅▅▅▄▄█',
      '   ▅▅█████▅▅',
      '  ▟█████████▙',
      ' ▟█████ █████▙',
      '▐█████▄█▄█████▌',
    ];

    const info = [
      `Project:      ${projectName === 'not yet created' ? notCreated : bold(projectName)}`,
      `Organization: ${orgName === 'not yet created' ? notCreated : orgName}`,
      `Branch:       ${branch}`,
      '',
      shimmer(`Welcome ${userName}`),
    ];

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const capyWidth = Math.max(...capy.map(l => l.length));
    const infoWidth = Math.max(...info.map(l => stripAnsi(l).length));
    const gap = 3;
    const maxLen = infoWidth + gap + capyWidth + 2;

    console.log('');
    console.log(grey('Capy CLI'));
    console.log(grey('\u250c' + '\u2500'.repeat(maxLen) + '\u2510'));

    const totalRows = Math.max(info.length, capy.length);
    for (let i = 0; i < totalRows; i++) {
      const left = i < info.length ? info[i] : '';
      const right = i < capy.length ? capy[i] : '';
      const leftPad = infoWidth - stripAnsi(left).length;
      const rightPad = capyWidth - right.length;
      // Per-character brown variation for fur texture
      const furry = (s: string) => s.split('').map((ch) => {
        if (ch === ' ') return ch;
        const v = Math.random() * 40 - 20; // ±20 variation
        const r = Math.round(150 + v);
        const g = Math.round(115 + v * 0.7);
        const b = Math.round(80 + v * 0.5);
        return `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
      }).join('');
      console.log(`${grey('\u2502')} ${left}${' '.repeat(leftPad)}${' '.repeat(gap)}${furry(right)}${' '.repeat(rightPad + 1)}${grey('\u2502')}`);
    }

    console.log(grey('\u2514' + '\u2500'.repeat(maxLen) + '\u2518'));
    console.log('');
  }

  private async syncProject(projectState: ProjectState): Promise<void> {
    this.debug('syncProject start', {
      initialized: projectState.initialized,
      organizationId: projectState.organizationId,
      projectId: projectState.projectId,
      projectName: projectState.projectName,
      activeBranch: projectState.activeBranch,
      userId: projectState.userId,
      cwd: process.cwd(),
    });

    // Load user-scoped session if we know who last synced this project
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }

    // Authenticate — try silent first, then interactive if needed.
    const spinner = ora('Authenticating...').start();
    let authResult = await this.authService.authenticateSilent(projectState.organizationId);

    // If silent auth failed, try without a specific org to use any valid session
    if (!authResult.success) {
      authResult = await this.authService.authenticateSilent();
    }

    // If still no session, fall through to interactive auth
    if (!authResult.success) {
      authResult = await this.authService.authenticate(projectState.organizationId);
    }

    this.debug('authResult', {
      success: authResult.success,
      user_id: authResult.user_id,
      organization_id: authResult.organization_id,
      _auth_method: authResult._auth_method,
      error: authResult.error,
    });

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    // Persist user ID to sync state immediately
    if (authResult.user_id) {
      this.projectManager.writeSyncStateUserId(authResult.user_id);
    }

    spinner.succeed(`Authenticated as ${authResult.user_email || authResult.user_first_name} (${authResult._auth_method || 'oauth'})`);

    const orgName = authResult.organization_name
      || authResult.organizations?.find(o => o.id === authResult.organization_id)?.name
      || (authResult.organizations?.length === 0 ? 'not yet created' : authResult.organization_id)
      || 'not yet created';

    const branch = projectState.activeBranch;

    this.displayHeader(
      projectState.projectName || 'not yet created',
      orgName,
      authResult.user_first_name || authResult.user_email || '',
      branch,
    );

    // Set token for service client
    const token = this.authService.getToken();

    if (token) {
      this.serviceClient.setToken(token);
    }

    if (!token) {
      throw new CapyError(
        'You do not have access to this project\'s organization.\n\n' +
        'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
        ERROR_CODES.PERMISSION_DENIED
      );
    }

    let encryptionKey: string;
    try {
      encryptionKey = await resolveProjectKey(
        projectState.organizationId!,
        projectState.projectId!,
        authResult.user_id!,
        this.keyServiceOps(),
      );
    } catch (err: any) {
      // Only clean up local state on a confirmed server 403 (user was kicked).
      // Network errors and other failures must NOT delete keys — a transient
      // outage should never permanently lock out a legitimate user.
      if (err instanceof CapyError && err.code === ERROR_CODES.PERMISSION_DENIED && err.details?.status === 403) {
        this.cleanupOrgData(projectState.organizationId!, projectState.userId);
      }
      throw err;
    }

    // Read keep.lock. currentKeep is mutable because the remote fetch may
    // self-heal a stale local keep.lock — but `pinned` and `originalKeep` are
    // FROZEN at the pre-self-heal values so the diff table reflects what was
    // actually pinned on this machine and "Retrieve all pinned values"
    // actually fetches the value shown in the Pinned column.
    let currentKeep = this.projectManager.readKeepFile();
    const originalKeep = currentKeep ? JSON.parse(JSON.stringify(currentKeep)) as KeepFile : null;
    this.debug('keep.lock', currentKeep ? {
      version: currentKeep.version,
      org_id: currentKeep.org_id,
      project_id: currentKeep.project_id,
      variableCount: Object.keys(currentKeep.variables).length,
      variables: Object.keys(currentKeep.variables),
    } : 'NOT FOUND');

    const rebuildPinned = (keep: KeepFile | null) => {
      const next: Record<string, string> = {};
      if (keep) {
        for (const [varName, entries] of Object.entries(keep.variables)) {
          const entry = entries.find(e => e.branch === branch);
          if (entry) {
            next[varName] = entry.value_hash;
          }
        }
      }
      return next;
    };
    const pinned = rebuildPinned(currentKeep);
    this.debug('pinned (pre-self-heal)', pinned);

    // Read local .env and compute hashes
    const localPlaintext: Record<string, string> = {};
    const localHashes: Record<string, string> = {};
    try {
      const rawLocal = this.fileManager.readEnvFile(this.options.envPath);
      this.debug('.env keys', Object.keys(rawLocal));
      for (const [key, value] of Object.entries(rawLocal)) {
        let plaintext = value;
        if (value.startsWith('capy:')) {
          try {
            plaintext = this.fileManager.decryptValue(value, encryptionKey);
          } catch (decryptErr) {
            this.debugError(`decrypt failed for ${key}`, decryptErr);
            throw new CapyError(
              `"${key}" is encrypted with a different project's key and cannot be used in this project.`,
              ERROR_CODES.PERMISSION_DENIED,
              { variable: key }
            );
          }
        }
        localPlaintext[key] = plaintext;
        localHashes[key] = hashValue(plaintext);
      }
      this.debug('local hashes', localHashes);
    } catch (error: any) {
      if (error instanceof CapyError) throw error;
      this.debugError('.env read failed', error);
    }

    // Fetch remote secrets
    const fetchSpinner = ora('Fetching remote secrets...').start();
    const remotePlaintext: Record<string, string> = {};
    const remoteHashes: Record<string, string> = {};
    let networkAvailable = true;

    try {
      // Always ask for the latest remote blob for this branch (no keep_hash).
      // The server returns the env_blob AND the latest keep.json — the client
      // uses keep.json to self-heal a stale local keep.lock.
      this.debug('getDecryptData request', {
        projectId: projectState.projectId,
        branch,
        keepHash: undefined,
        includeLatestHash: true,
      });
      const decryptData = await this.serviceClient.getDecryptData(
        projectState.projectId!,
        branch,
        undefined, // no keep_hash — get latest for this branch
        true,      // includeLatestHash
      );
      this.debug('getDecryptData response', {
        hasEnvContent: !!decryptData.env_content,
        envContentLength: decryptData.env_content?.length || 0,
        keepHash: decryptData.keep_hash,
        hasKeepFile: !!decryptData.keep_file,
      });

      if (decryptData.env_content) {
        const encrypted = this.fileManager.parseEnvContent(decryptData.env_content);
        for (const [key, value] of Object.entries(encrypted)) {
          try {
            const plaintext = this.fileManager.decryptValue(value, encryptionKey);
            remotePlaintext[key] = plaintext;
            remoteHashes[key] = hashValue(plaintext);
          } catch (decryptErr) {
            this.debugError(`remote decrypt failed for ${key}`, decryptErr);
          }
        }
      }
      this.debug('remote hashes', remoteHashes);

      // Self-heal: if the server returned a keep_file and it differs from local,
      // overwrite local keep.lock with the server's version and use it as the
      // base for the post-resolution merge. We DO NOT touch `pinned` here —
      // the diff table needs to show the user's pre-self-heal pinned values
      // so that "Pinned vs Local vs Remote" is a true three-way comparison.
      if (decryptData.keep_file) {
        const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
        const localSerialized = currentKeep ? JSON.stringify(currentKeep) : '';
        const serverSerialized = JSON.stringify(serverKeep);
        if (localSerialized !== serverSerialized) {
          this.debug('self-heal: local keep.lock differs from server, overwriting');
          this.fileManager.writeKeepFile(serverKeep);
          currentKeep = serverKeep;
        } else {
          this.debug('self-heal: local keep.lock matches server, no change');
        }
      }
      fetchSpinner.stop();
    } catch (err: any) {
      this.debugError('remote fetch failed', err);
      // Auth/permission errors are hard failures (e.g. user was kicked from org).
      // Network errors fall back to local-only mode.
      if (err instanceof CapyError) {
        const status = err.details?.status;
        if (status === 403) {
          // User was kicked — clean up local state for this org so stale
          // keys and session data don't linger.
          fetchSpinner.fail('Access denied — you may have been removed from this organization.');
          this.cleanupOrgData(projectState.organizationId!, projectState.userId);
          throw err;
        }
        if (status === 401) {
          fetchSpinner.fail(err.message);
          throw err;
        }
      }
      networkAvailable = false;
      fetchSpinner.fail('Cannot reach remote. Showing local changes only.');
    }

    // 3-way comparison
    const hasRemote = Object.keys(remotePlaintext).length > 0;
    this.debug('compareSecrets inputs', {
      networkAvailable,
      hasRemote,
      pinnedKeys: Object.keys(pinned),
      localKeys: Object.keys(localHashes),
      remoteKeys: Object.keys(remoteHashes),
    });
    const { diffs, showLocal, showRemote } = compareSecrets(
      pinned,
      localHashes,
      networkAvailable ? remoteHashes : {}, // If offline, pass empty so compareSecrets treats as matching pinned
    );
    this.debug('compareSecrets result', {
      diffCount: diffs.length,
      showLocal,
      showRemote,
      diffs,
    });

    if (diffs.length === 0) {
      console.log('Everything is up to date!');
      // Always re-encrypt local .env
      const finalKeep = this.projectManager.readKeepFile();
      this.fileManager.writeEncryptedEnvFile(localPlaintext, encryptionKey, undefined, finalKeep, branch);
      this.installGitHooks();
      return;
    }

    // Onboarding detection: local .env is empty (or belongs to a different project)
    // and remote has values — the user has no local changes to commit or resolve.
    let isOnboarding = false;
    if (Object.keys(localHashes).length === 0 && Object.keys(remotePlaintext).length > 0) {
      const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
      isOnboarding = !(envMeta.org_id === projectState.organizationId
        && envMeta.project_id === projectState.projectId);
    }

    // Hide local column for onboarding — it's all "-" and adds noise
    const effectiveShowLocal = isOnboarding ? false : showLocal;

    // Resolve pinned plaintext for display. Try local first, then fetch from S3.
    const pinnedPlaintext: Record<string, string> = {};
    let needsFetch = false;
    for (const variable of Object.keys(pinned)) {
      if (localPlaintext[variable] && hashValue(localPlaintext[variable]) === pinned[variable]) {
        pinnedPlaintext[variable] = localPlaintext[variable];
      } else {
        needsFetch = true;
      }
    }
    if (needsFetch && originalKeep && Object.keys(pinned).length > 0) {
      try {
        const keepHash = SyncEngine.computeKeepHash(originalKeep, branch);
        const blob = await fetchSecretsWithCache(
          this.serviceClient,
          projectState.projectId!,
          keepHash,
        );
        if (blob?.env_file) {
          const encrypted = this.fileManager.parseEnvContent(blob.env_file);
          for (const [key, value] of Object.entries(encrypted)) {
            if (pinned[key] && !pinnedPlaintext[key]) {
              try {
                pinnedPlaintext[key] = this.fileManager.decryptValue(value, encryptionKey);
              } catch (decryptErr) {
                this.debugError(`pinned decrypt failed for ${key}`, decryptErr);
              }
            }
          }
        }
      } catch (err) {
        this.debugError('pinned fetch failed', err);
      }
    }

    const DIM = '\x1b[90m';
    const RST = '\x1b[0m';

    console.log(`  You have unsynced environment variables (${diffs.length} difference${diffs.length !== 1 ? 's' : ''} found).\n`);

    // Display comparison table
    this.displayComparisonTable(diffs, effectiveShowLocal, showRemote, pinned, localHashes, remoteHashes, localPlaintext, remotePlaintext, pinnedPlaintext);

    console.log(`\n  ${DIM}← → select value   ↑ ↓ move between rows   Enter confirm   q cancel${RST}\n`);

    // Build menu options based on what columns are visible
    const menuChoices: { name: string; value: string }[] = [];
    const hasPinned = Object.keys(pinned).length > 0;

    // Direction detection: compare sync-state keep_hash to current keep.lock
    const syncState = this.projectManager.readSyncState();
    const currentKeepHash = currentKeep ? SyncEngine.computeKeepHash(currentKeep, branch) : null;
    const savedHash = getSyncKeepHash(syncState, branch);
    const isBehind = savedHash != null
      && currentKeepHash != null
      && savedHash !== currentKeepHash;

    if (isOnboarding) {
      // Onboarding: local .env is empty/foreign — only offer retrieve options
      if (!showRemote) {
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      } else {
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      }
    } else if (!hasPinned) {
      // State 6: No pinned values — only offer commit or skip
      menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
    } else if (!hasRemote) {
      // State 5: No remote values — local vs pinned only
      menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else if (showLocal && !showRemote) {
      // State 2: Local differs from pinned, remote matches pinned
      if (isBehind) {
        // 2b: keep.lock changed via git pull → user is behind
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      } else {
        // 2a: user edited .env locally → user is ahead
        menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      }
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else if (!showLocal && showRemote) {
      // State 3: Remote differs from pinned, local matches pinned
      menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else {
      // State 4: Both differ
      if (isBehind) {
        // 4b: keep.lock changed + another push happened → retrieve remote first
        menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      } else {
        // 4a: user edited .env + teammate pushed
        menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      }
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    }

    menuChoices.push({ name: 'Continue working', value: 'skip' });

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: menuChoices,
    }]);

    // Apply the chosen action
    let finalEnv: Record<string, string>;

    if (action === 'retrieve_pinned') {
      // Fetch the user's *original* pinned snapshot — the one displayed in the
      // Pinned column of the diff table. We use originalKeep (pre-self-heal),
      // not currentKeep, because currentKeep may have been overwritten with
      // the server's latest. The original snapshot is still in S3 because
      // env blobs are content-addressed and immutable.
      finalEnv = { ...localPlaintext };
      if (originalKeep && Object.keys(pinned).length > 0) {
        const keepHash = SyncEngine.computeKeepHash(originalKeep, branch);
        try {
          const blob = await fetchSecretsWithCache(
            this.serviceClient,
            projectState.projectId!,
            keepHash,
          );
          if (blob?.env_file) {
            const encrypted = this.fileManager.parseEnvContent(blob.env_file);
            finalEnv = {};
            for (const [key, value] of Object.entries(encrypted)) {
              try {
                finalEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
              } catch (decryptErr) {
                this.debugError(`retrieve_pinned decrypt failed for ${key}`, decryptErr);
              }
            }
          }
        } catch (err) {
          this.debugError('retrieve_pinned fetch failed', err);
          console.log('Could not fetch pinned values from remote.');
          return;
        }
      }
    } else if (action === 'retrieve_remote') {
      finalEnv = { ...remotePlaintext };
    } else if (action === 'commit_local') {
      finalEnv = { ...localPlaintext };
    } else if (action === 'skip') {
      return;
    } else {
      // Individual resolution
      const resolved = await this.resolveIndividually(diffs, showLocal, showRemote, pinned, localPlaintext, remotePlaintext, pinnedPlaintext);
      if (!resolved) return; // Cancelled
      finalEnv = resolved;
    }

    // Update keep.lock
    const { createHash } = await import('crypto');
    const { deriveResourceId } = await import('../crypto/resourceId');

    const keep = currentKeep || {
      version: '3.0',
      org_id: projectState.organizationId!,
      project_id: projectState.projectId!,
      project_name: projectState.projectName!,
      variables: {},
    };

    const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
    for (const [key, value] of Object.entries(finalEnv)) {
      pushedVars[key] = {
        resource_id: deriveResourceId(branch, key),
        value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
      };
    }

    const finalKeep = this.syncEngine.mergeWithKeep(keep, pushedVars, branch);

    // Remove variables not in finalEnv from keep (for this branch)
    for (const varName of Object.keys(finalKeep.variables)) {
      if (!(varName in finalEnv)) {
        const entries = finalKeep.variables[varName].filter(e =>
          e.branch !== branch
        );
        if (entries.length > 0) {
          finalKeep.variables[varName] = entries;
        } else {
          delete finalKeep.variables[varName];
        }
      }
    }

    this.fileManager.writeKeepFile(finalKeep);

    // Cache encrypted blob locally
    {
      const { Encryptor } = await import('../crypto/encryptor');
      const cacheKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
      const cacheBlob = Object.entries(finalEnv)
        .map(([k, v]) => {
          const resourceId = deriveResourceId(branch, k);
          const enc = Encryptor.encrypt(v, encryptionKey);
          return `${k}=capy:${resourceId}:${enc}`;
        })
        .join('\n');
      writeKeepCache(cacheKeepHash, cacheBlob);
    }

    // Encrypt and write .env
    this.fileManager.writeEncryptedEnvFile(finalEnv, encryptionKey, undefined, finalKeep, branch);

    // Update sync state
    const existingSyncState = this.projectManager.readSyncState();
    this.fileManager.writeSyncState({
      ...existingSyncState,
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(finalEnv),
      user_id: authResult.user_id,
      keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
    });

    const changeCount = Object.keys(pushedVars).length;
    console.log(`\n> keep.lock updated (${diffs.length} changes)`);

    if (action === 'commit_local') {
      console.log(`\nRun ${B('capy push')} to share your changes with teammates.`);
    }

    // Install hooks on every run (idempotent)
    this.installGitHooks();
  }

  private displayComparisonTable(
    diffs: { variable: string; type: string; pinned?: string; local?: string; remote?: string }[],
    showLocal: boolean,
    showRemote: boolean,
    pinned: Record<string, string>,
    localHashes: Record<string, string>,
    remoteHashes: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
    pinnedPlaintext: Record<string, string> = {},
  ): void {
    const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const padCell = (s: string, width: number) => {
      const visible = stripAnsi(s).length;
      return visible >= width ? s : s + ' '.repeat(width - visible);
    };

    const pinnedSnippetFor = (variable: string): string => {
      if (!pinned[variable]) return '-';
      if (pinnedPlaintext[variable]) return formatSnippet(pinnedPlaintext[variable]);
      return '\x1b[3munresolvable\x1b[0m';
    };

    // Show pinned column if any pinned value can be resolved
    const showPinned = diffs.some(diff => pinned[diff.variable] && pinnedPlaintext[diff.variable]);

    // Build header
    const headers: string[] = ['Variable'];
    if (showPinned) headers.push('Pinned');
    if (showLocal) headers.push('Local');
    if (showRemote) headers.push('Remote');

    // Calculate column widths
    const colWidths = headers.map(h => h.length);
    for (const diff of diffs) {
      const cols = [diff.variable];
      if (showPinned) {
        const pinnedSnippet = pinnedSnippetFor(diff.variable);
        cols.push(pinnedSnippet);
      }
      if (showLocal) {
        cols.push(localPlaintext[diff.variable] ? formatSnippet(localPlaintext[diff.variable]) : '-');
      }
      if (showRemote) {
        cols.push(remotePlaintext[diff.variable] ? formatSnippet(remotePlaintext[diff.variable]) : '-');
      }
      cols.forEach((c, i) => {
        colWidths[i] = Math.max(colWidths[i] || 0, stripAnsi(c).length);
      });
    }

    // Add padding
    colWidths.forEach((w, i) => { colWidths[i] = w + 2; });

    // Print header
    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('');
    console.log(`  ${headerLine}`);
    console.log(`  ${'─'.repeat(colWidths.reduce((a, b) => a + b, 0))}`);

    // Print rows
    for (const diff of diffs) {
      const cols = [diff.variable];
      if (showPinned) {
        cols.push(pinnedSnippetFor(diff.variable));
      }
      if (showLocal) {
        cols.push(localPlaintext[diff.variable] ? formatSnippet(localPlaintext[diff.variable]) : '-');
      }
      if (showRemote) {
        cols.push(remotePlaintext[diff.variable] ? formatSnippet(remotePlaintext[diff.variable]) : '-');
      }
      const row = cols.map((c, i) => padCell(c, colWidths[i])).join('');
      console.log(`  ${row}`);
    }
  }

  private async resolveIndividually(
    diffs: { variable: string; type: string; pinned?: string; local?: string; remote?: string }[],
    showLocal: boolean,
    showRemote: boolean,
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
    pinnedPlaintext: Record<string, string> = {},
  ): Promise<Record<string, string> | null> {
    const { ResolveTable } = await import('../ui/resolveTable');
    type Row = import('../ui/resolveTable').ResolveRow;

    const pinnedSnippetFor = (variable: string): string | null => {
      if (!pinned[variable]) return null;
      if (pinnedPlaintext[variable]) return formatSnippet(pinnedPlaintext[variable]);
      return '\x1b[3munresolvable\x1b[0m';
    };

    const rows: Row[] = diffs.map(diff => ({
      variable: diff.variable,
      pinned: pinnedSnippetFor(diff.variable),
        local: localPlaintext[diff.variable]
          ? formatSnippet(localPlaintext[diff.variable])
          : null,
        remote: remotePlaintext[diff.variable]
          ? formatSnippet(remotePlaintext[diff.variable])
          : null,
    }));

    const table = new ResolveTable(rows, showLocal, showRemote);
    const { choices, cancelled } = await table.run();

    if (cancelled) {
      return null;
    }

    const result: Record<string, string> = {};

    for (const [variable, choice] of Object.entries(choices)) {
      if (choice === 'pinned') {
        const pinnedHash = pinned[variable];
        if (localPlaintext[variable] && hashValue(localPlaintext[variable]) === pinnedHash) {
          result[variable] = localPlaintext[variable];
        } else if (remotePlaintext[variable] && hashValue(remotePlaintext[variable]) === pinnedHash) {
          result[variable] = remotePlaintext[variable];
        }
      } else if (choice === 'local' && localPlaintext[variable] !== undefined) {
        result[variable] = localPlaintext[variable];
      } else if (choice === 'remote' && remotePlaintext[variable] !== undefined) {
        result[variable] = remotePlaintext[variable];
      }
      // 'delete' — don't add to result
    }

    // Add unchanged variables from local
    for (const [key, value] of Object.entries(localPlaintext)) {
      if (!(key in result) && !diffs.some(d => d.variable === key)) {
        result[key] = value;
      }
    }

    return result;
  }

  private async createNewOrganization(refreshToken: string, userId: string): Promise<Organization> {
    const { orgName } = await inquirer.prompt([{
      type: 'input',
      name: 'orgName',
      message: 'Organization name:',
      validate: (input: string) => input.trim().length > 0 || 'Organization name cannot be empty',
    }]);

    // Generate seed phrase and get confirmation BEFORE creating the org.
    // This keeps org creation and key generation atomic — if the user
    // declines, no org is created and they can retry cleanly.
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

    // Seed phrase confirmed — now create the org and save the key
    const orgSpinner = ora('Creating organization...').start();
    const org = await this.authService.createOrganization(orgName.trim(), refreshToken, userId);
    orgSpinner.succeed(`Organization "${org.name}" created`);

    const masterKey = seedPhraseToMasterKey(seedPhrase);
    await wrapAndSaveMasterKey(masterKey, org.id, userId, this.keyServiceOps());

    return org;
  }
}
