import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import inquirer from 'inquirer';
import { CapyError, ERROR_CODES, getSyncKeepHash, KeepFile } from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { SyncEngine } from '../sync/syncEngine';
import { hashValue } from './statusCommand';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * Pure dirty-check behind the checkout guard: does the decrypted .env differ
 * from what keep.lock pins for `branch`? Returns the first offending variable
 * name, or null when the working tree is clean.
 *
 * A variable is uncommitted when it is missing from .env (deletion), its hash
 * differs from the pin (edit), or it exists in .env without a pin (addition).
 * Presence is `=== undefined` deliberately: '' is a legitimate committed value
 * (its hash pins as e3b0c44298fc1c14), and a falsy check misreads every
 * empty-valued variable as a deletion — permanently blocking branch switches
 * on any branch that pins empty placeholders.
 */
export function findUncommittedEnvChange(
  localPlaintext: Record<string, string>,
  variables: KeepFile['variables'],
  branch: string,
): string | null {
  const pinnedKeys = new Set<string>();
  for (const [varName, entries] of Object.entries(variables)) {
    const entry = entries.find(e => e.branch === branch);
    if (!entry) continue;
    pinnedKeys.add(varName);
    const localValue = localPlaintext[varName];
    if (localValue === undefined) return varName; // uncommitted deletion
    if (hashValue(localValue) !== entry.value_hash) return varName; // uncommitted edit
  }
  for (const varName of Object.keys(localPlaintext)) {
    if (!pinnedKeys.has(varName)) return varName; // uncommitted addition
  }
  return null;
}

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

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  async execute(branchName: string, options: { create?: boolean; protected?: boolean } = {}): Promise<void> {
    try {
      await this._execute(branchName, options);
    } catch (error: any) {
      // In recovery mode, fall back to offline branch switch
      const { isRecoveryActive } = await import('../config/globalConfig');
      if (isRecoveryActive()) {
        this.projectManager.writeActiveBranch(branchName);
        console.log(`\nSwitched to branch "${branchName}" (offline — recovery mode)`);
        console.log(`Run ${B('capy decrypt')} to decrypt secrets for this branch.\n`);
        return;
      }
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
    let authResult = await this.authService.authenticateSilent(projectState.organizationId);
    if (!authResult.success) authResult = await this.authService.authenticateSilent();
    if (!authResult.success) authResult = await this.authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
    }

    spinner.stop();

    const projectId = projectState.projectId!;
    const orgId = projectState.organizationId!;

    // Resolve encryption key from global keyring (requires server co-decrypt)
    const keyOps: KeyServiceOps = {
      coDecrypt: (oid, ct) => this.serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
      wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
    };
    const encryptionKey = await resolveProjectKey(orgId, projectId, authResult.user_id!, keyOps);

    // Guard: block checkout if working tree is dirty (skip for branch creation)
    if (!options.create) {
      const keep = this.projectManager.readKeepFile();
      const currentBranch = this.projectManager.readActiveBranch();

      if (keep && currentBranch) {
        // Check A: uncommitted changes (.env differs from keep.lock)
        try {
          const localPlaintext = this.fileManager.readEncryptedEnvFile(encryptionKey);
          const uncommitted = findUncommittedEnvChange(localPlaintext, keep.variables, currentBranch);

          if (uncommitted != null) {
            console.error(`You have uncommitted changes on "${currentBranch}" (${uncommitted}).`);
            console.error(`Run ${B('capy')} to commit before switching branches.`);
            process.exit(1);
          }
        } catch {
          // If .env doesn't exist or can't be read, no uncommitted changes to worry about
        }

        // Check B: unpushed changes (keep.lock differs from last sync)
        const syncState = this.projectManager.readSyncState();
        const savedHash = getSyncKeepHash(syncState, currentBranch);
        const currentKeepHash = SyncEngine.computeKeepHash(keep, currentBranch);

        if (savedHash != null && savedHash !== currentKeepHash) {
          console.error(`You have unpushed changes on "${currentBranch}".`);
          console.error(`Run ${B('capy push')} before switching branches.`);
          process.exit(1);
        }
      }
    }

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
          const label = b.name;
          const prod = b.is_protected ? ' \x1b[90m(protected)\x1b[0m' : '';
          console.log(`  ${label}${prod}`);
        }
        console.log(`\nCreate it with: ${B(`capy checkout -b ${branchName}`)}`);
        process.exit(1);
      }
      branchSpinner.stop();
    }

    // Pull latest secrets for this branch from the server BEFORE switching
    // local state, so a 403 (protected branch / no access) leaves the user
    // on their current branch with their current .env intact.
    const syncSpinner = ora(`Syncing secrets for ${branchName}...`).start();

    let decryptData: Awaited<ReturnType<typeof this.serviceClient.getDecryptData>>;
    try {
      decryptData = await this.serviceClient.getDecryptData(
        projectId,
        branchName,
        undefined, // ask for latest
        true,
      );
    } catch (error: any) {
      syncSpinner.stop();
      const status = error?.details?.status;
      if (status === 403) {
        console.error(`You do not have access to branch "${branchName}".`);
        console.error(`Protected branches are invite-only — ask a project admin to grant access.`);
        process.exit(1);
      }
      if (status === 404) {
        // No snapshot yet for this branch — treat as empty and proceed to switch.
        decryptData = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
      } else {
        console.error(`Failed to sync secrets: ${error.message}`);
        process.exit(1);
      }
    }

    // Self-heal local keep.lock from server's keep_file if returned.
    // keep.lock holds all branches' metadata, so writing it is safe regardless
    // of which branch is active.
    let keepForWrite = this.projectManager.readKeepFile()!;
    if (decryptData.keep_file) {
      const serverKeep = JSON.parse(decryptData.keep_file);
      this.fileManager.writeKeepFile(serverKeep);
      keepForWrite = serverKeep;
    }

    // Write .env BEFORE switching .capy/branch. The .env header records which
    // branch its contents belong to, so if we fail between these writes we must
    // never leave .capy/branch pointing to a branch whose secrets aren't in
    // .env yet. Writing .env first means a crash here leaves us on the old
    // branch with .env already updated — detectable on next run via
    // capy-branch-header mismatch self-heal.
    let varCount = 0;
    let seededFromCurrent = false;
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
      varCount = Object.keys(decrypted).length;
    } else if (options.create) {
      // `capy checkout -b <new>` with no remote snapshot: seed the new branch
      // from the current .env. Preserve the plaintext values and re-write them
      // under the new branch header (new resource_ids per (branch, key)), so
      // `capy` sees them as unpinned and offers to push them to <new>.
      let seed: Record<string, string> = {};
      try {
        seed = this.fileManager.readEncryptedEnvFile(encryptionKey);
      } catch {
        // Unreadable current .env — fall through to empty-stamped file.
      }
      this.fileManager.writeEncryptedEnvFile(seed, encryptionKey, undefined, keepForWrite, branchName);
      varCount = Object.keys(seed).length;
      seededFromCurrent = varCount > 0;
    } else {
      // Switching to an existing empty branch: overwrite .env with an empty
      // (but branch-stamped) file so the header matches the active branch.
      this.fileManager.writeEncryptedEnvFile({}, encryptionKey, undefined, keepForWrite, branchName);
    }

    this.projectManager.writeActiveBranch(branchName);
    syncSpinner.stop();

    if (seededFromCurrent) {
      console.log(`Seeded ${varCount} variable(s) from current branch into ${branchName} (unpushed — run ${B('capy')} to push)`);
    } else if (varCount > 0) {
      console.log(`Synced ${varCount} variable(s) for ${branchName}`);
    } else {
      console.log(`No secrets yet for ${branchName}`);
    }

    console.log(`\nNow on branch: ${branchName}`);
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
