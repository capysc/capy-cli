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
  ERROR_CODES,
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
    console.log('Welcome to Capy\n');

    // Authenticate first
    const spinner = ora('Logging in...').start();
    const authResult = await this.authService.authenticate();

    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(
        authResult.error || 'Authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }

    spinner.succeed(`Authenticated as ${authResult.user_email || authResult.user_first_name} (${authResult._auth_method || 'oauth'})`);

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

    // Ensure org has a master key — generate seed phrase if first time
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

    // Derive project encryption key from master key
    const encryptionKey = resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      authResult.user_id!,
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

        let initBranch: string | undefined;
        if (initChoice === 'other') {
          const { branchName } = await inquirer.prompt([{
            type: 'input',
            name: 'branchName',
            message: 'Branch name:',
            validate: (input: string) => input.trim().length > 0 || 'Branch name cannot be empty',
          }]);
          initBranch = branchName.trim();

          await this.serviceClient.createBranch(projectResult.project_id, initBranch!);
          this.projectManager.writeActiveBranch(initBranch);
        }

        const syncSpinner = ora('Syncing local variables...').start();

        try {
          const { createHash } = await import('crypto');
          const { deriveResourceId } = await import('../crypto/resourceId');
          const { Encryptor } = await import('../crypto/encryptor');

          // Build encrypted env blob and keep.lock hashes
          const encrypted: Record<string, string> = {};
          const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
          for (const [key, value] of Object.entries(localEnv)) {
            const resourceId = deriveResourceId(initBranch || '', key);
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
          );

          this.fileManager.writeKeepFile(updatedKeep);
          this.fileManager.writeSyncState({
            last_sync: new Date().toISOString(),
            synced_variables: Object.keys(localEnv),
            user_id: authResult.user_id,
          });

          // Backup plaintext .env before encrypting
          this.fileManager.backupPlaintextEnv(this.options.envPath);

          // Encrypt the local .env file
          this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, undefined, updatedKeep, initBranch);

          const branchLabel = initBranch || 'development';
          syncSpinner.succeed(`keep.lock created (pinned to ${branchLabel}, ${localVarCount} secrets)`);

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
    const capy = [
      '     \u2588\u2584 ',
      '   \u2584\u2588\u2588\u2580\u2580\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584',
      '   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
      '  \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
      '  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2580\u2580',
      ' \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584',
    ];

    const info = [
      `Project:      ${projectName === 'not yet created' ? notCreated : bold(projectName)}`,
      `Organization: ${orgName === 'not yet created' ? notCreated : orgName}`,
      `Branch:       ${branch || grey('none')}`,
      '',
      shimmer(`Welcome ${userName}`),
    ];

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const capyWidth = Math.max(...capy.map(l => l.length));
    const infoWidth = Math.max(...info.map(l => stripAnsi(l).length));
    const gap = 3;
    const maxLen = capyWidth + gap + infoWidth + 2;

    console.log('');
    console.log(grey('Capy CLI'));
    console.log(grey('\u250c' + '\u2500'.repeat(maxLen) + '\u2510'));

    const totalRows = Math.max(info.length, capy.length);
    for (let i = 0; i < totalRows; i++) {
      const left = i < capy.length ? capy[i] : '';
      const right = i < info.length ? info[i] : '';
      const leftPad = capyWidth - left.length;
      const rightPad = infoWidth - stripAnsi(right).length;
      console.log(`${grey('\u2502')}${grey(left)}${' '.repeat(leftPad)}${' '.repeat(gap)}${right}${' '.repeat(rightPad + 2)}${grey('\u2502')}`);
    }

    console.log(grey('\u2514' + '\u2500'.repeat(maxLen) + '\u2518'));
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

    const encryptionKey = resolveProjectKey(
      projectState.organizationId!,
      projectState.projectId!,
      authResult.user_id!,
    );

    // Read keep.lock
    const currentKeep = this.projectManager.readKeepFile();

    // Build pinned hashes from keep.lock for active branch
    const pinned: Record<string, string> = {};
    if (currentKeep) {
      for (const [varName, entries] of Object.entries(currentKeep.variables)) {
        const entry = entries.find(e => branch ? e.branch === branch : !e.branch);
        if (entry) {
          pinned[varName] = entry.value_hash;
        }
      }
    }

    // Read local .env and compute hashes
    const localPlaintext: Record<string, string> = {};
    const localHashes: Record<string, string> = {};
    try {
      const rawLocal = this.fileManager.readEnvFile(this.options.envPath);
      for (const [key, value] of Object.entries(rawLocal)) {
        let plaintext = value;
        if (value.startsWith('capy:')) {
          try {
            plaintext = this.fileManager.decryptValue(value, encryptionKey);
          } catch {
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
    } catch (error: any) {
      if (error instanceof CapyError) throw error;
      // No .env or unreadable
    }

    // Fetch remote secrets
    const fetchSpinner = ora('Fetching remote secrets...').start();
    const remotePlaintext: Record<string, string> = {};
    const remoteHashes: Record<string, string> = {};
    let networkAvailable = true;

    try {
      const hasVariables = currentKeep && Object.keys(currentKeep.variables).length > 0;
      if (hasVariables) {
        const keepHash = SyncEngine.computeKeepHash(currentKeep!, branch);
        const blob = await this.serviceClient.getSecrets(
          projectState.projectId!,
          keepHash,
        );
        if (blob?.env_file) {
          const encrypted = this.fileManager.parseEnvContent(blob.env_file);
          for (const [key, value] of Object.entries(encrypted)) {
            try {
              const plaintext = this.fileManager.decryptValue(value, encryptionKey);
              remotePlaintext[key] = plaintext;
              remoteHashes[key] = hashValue(plaintext);
            } catch {
              // Skip undecryptable
            }
          }
        }
      }
      fetchSpinner.stop();
    } catch {
      networkAvailable = false;
      fetchSpinner.fail('Cannot reach remote. Showing local changes only.');
    }

    // 3-way comparison
    const hasRemote = Object.keys(remotePlaintext).length > 0;
    const { diffs, showLocal, showRemote } = compareSecrets(
      pinned,
      localHashes,
      networkAvailable ? remoteHashes : {}, // If offline, pass empty so compareSecrets treats as matching pinned
    );

    if (diffs.length === 0) {
      console.log('Everything is up to date!');
      // Always re-encrypt local .env
      const finalKeep = this.projectManager.readKeepFile();
      this.fileManager.writeEncryptedEnvFile(localPlaintext, encryptionKey, undefined, finalKeep, branch);
      this.installGitHooks();
      return;
    }

    const DIM = '\x1b[90m';
    const RST = '\x1b[0m';

    console.log(`  ${diffs.length} difference${diffs.length !== 1 ? 's' : ''} found.\n`);

    // Display comparison table
    this.displayComparisonTable(diffs, showLocal, showRemote, pinned, localHashes, remoteHashes, localPlaintext, remotePlaintext);

    console.log(`\n  ${DIM}← → select value   ↑ ↓ move between rows   Enter confirm   q cancel${RST}\n`);

    // Build menu options based on what columns are visible
    const menuChoices: { name: string; value: string }[] = [];
    const hasPinned = Object.keys(pinned).length > 0;

    if (!hasPinned) {
      // No pinned values — only offer commit or skip
      menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
    } else if (!hasRemote) {
      // No remote values — local vs pinned only
      menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else if (showLocal && !showRemote) {
      // Local differs from pinned, remote matches pinned
      menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else if (!showLocal && showRemote) {
      // Remote differs from pinned, local matches pinned
      menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else {
      // Both differ — show all 4 options
      menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
      menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      menuChoices.push({ name: 'Commit all local values', value: 'commit_local' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    }

    menuChoices.push({ name: 'Continue working', value: 'skip' });

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: ' ',
      choices: menuChoices,
    }]);

    // Apply the chosen action
    let finalEnv: Record<string, string>;

    if (action === 'retrieve_pinned') {
      // Fetch pinned values from S3
      finalEnv = { ...localPlaintext };
      if (currentKeep && Object.keys(pinned).length > 0) {
        const keepHash = SyncEngine.computeKeepHash(currentKeep, branch);
        try {
          const blob = await this.serviceClient.getSecrets(
            projectState.projectId!,
            keepHash,
          );
          if (blob?.env_file) {
            const encrypted = this.fileManager.parseEnvContent(blob.env_file);
            finalEnv = {};
            for (const [key, value] of Object.entries(encrypted)) {
              try {
                finalEnv[key] = this.fileManager.decryptValue(value, encryptionKey);
              } catch {
                // Skip
              }
            }
          }
        } catch {
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
      const resolved = await this.resolveIndividually(diffs, showLocal, showRemote, pinned, localPlaintext, remotePlaintext);
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
        resource_id: deriveResourceId(branch || '', key),
        value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
      };
    }

    const finalKeep = this.syncEngine.mergeWithKeep(keep, pushedVars, branch);

    // Remove variables not in finalEnv from keep (for this branch)
    for (const varName of Object.keys(finalKeep.variables)) {
      if (!(varName in finalEnv)) {
        const entries = finalKeep.variables[varName].filter(e =>
          branch ? e.branch !== branch : !!e.branch
        );
        if (entries.length > 0) {
          finalKeep.variables[varName] = entries;
        } else {
          delete finalKeep.variables[varName];
        }
      }
    }

    this.fileManager.writeKeepFile(finalKeep);

    // Encrypt and write .env
    this.fileManager.writeEncryptedEnvFile(finalEnv, encryptionKey, undefined, finalKeep, branch);

    // Update sync state
    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(finalEnv),
      user_id: authResult.user_id,
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
  ): void {
    const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const padCell = (s: string, width: number) => {
      const visible = stripAnsi(s).length;
      return visible >= width ? s : s + ' '.repeat(width - visible);
    };

    const pinnedSnippetFor = (variable: string): string => {
      if (!pinned[variable]) return '-';
      const resolved = this.getSnippetForHash(variable, pinned, localPlaintext, remotePlaintext);
      return resolved.includes('unresolvable') ? resolved : formatSnippet(resolved);
    };

    // Check if any pinned value can be resolved to plaintext
    const showPinned = diffs.some(diff => {
      if (!pinned[diff.variable]) return false;
      const snippet = this.getSnippetForHash(diff.variable, pinned, localPlaintext, remotePlaintext);
      return !snippet.includes('unresolvable');
    });

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
        const pinnedVal = pinned[diff.variable]
          ? formatSnippet(this.getSnippetForHash(diff.variable, pinned, localPlaintext, remotePlaintext))
          : '-';
        cols.push(pinnedVal);
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

  /**
   * Get a snippet value for a pinned hash by finding the matching plaintext.
   */
  private getSnippetForHash(
    variable: string,
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
  ): string {
    const pinnedHash = pinned[variable];
    // Check if local matches pinned
    if (localPlaintext[variable] && hashValue(localPlaintext[variable]) === pinnedHash) {
      return localPlaintext[variable];
    }
    // Check if remote matches pinned
    if (remotePlaintext[variable] && hashValue(remotePlaintext[variable]) === pinnedHash) {
      return remotePlaintext[variable];
    }
    // Can't resolve plaintext — no source has the matching value
    return '\x1b[3munresolvable\x1b[0m';
  }

  private async resolveIndividually(
    diffs: { variable: string; type: string; pinned?: string; local?: string; remote?: string }[],
    showLocal: boolean,
    showRemote: boolean,
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
  ): Promise<Record<string, string> | null> {
    const { ResolveTable } = await import('../ui/resolveTable');
    type Row = import('../ui/resolveTable').ResolveRow;

    const pinnedSnippetFor = (variable: string): string | null => {
      if (!pinned[variable]) return null;
      const resolved = this.getSnippetForHash(variable, pinned, localPlaintext, remotePlaintext);
      return resolved.includes('unresolvable') ? resolved : formatSnippet(resolved);
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

    const orgSpinner = ora('Creating organization...').start();
    const org = await this.authService.createOrganization(orgName.trim(), refreshToken, userId);
    orgSpinner.succeed(`Organization "${org.name}" created`);
    return org;
  }
}
