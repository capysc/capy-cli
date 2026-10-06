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

export interface DirtyBranchIssue {
  code: 'UNCOMMITTED_CHANGES' | 'UNPUSHED_CHANGES';
  branch: string;
  /** `UNCOMMITTED_CHANGES` only — the offending variable name. */
  varName?: string;
}

/**
 * The two guards `capy checkout` enforces before switching away from the
 * current branch — extracted (pure, no `process.exit`) so a caller that
 * isn't this command can run the SAME checks and decide for itself how to
 * report a dirty result, rather than a second copy of this logic. `capy
 * connect dokploy --discover` is exactly that caller: before its first
 * checkout in a folder, it needs to abort just THAT folder on a dirty
 * result, never the whole process (CAP-657 follow-up).
 *
 * Skipped entirely by the caller for `-b` (branch creation) — nothing on a
 * brand-new branch to lose yet.
 */
export function findDirtyBranchIssue(
  pm: ProjectManager,
  fm: FileManager,
  encryptionKey: string,
): DirtyBranchIssue | null {
  const keep = pm.readKeepFile();
  const currentBranch = pm.readActiveBranch();

  // The decrypted .env belongs to the branch recorded in its own header,
  // which can diverge from .capy/branch after an interrupted checkout
  // (CAP-215). Diff the uncommitted-changes check against the branch the
  // ciphertext was actually encrypted for — otherwise a value that simply
  // differs across branches reads as a phantom "uncommitted change",
  // deadlocking the very `capy checkout` the inconsistency error tells the
  // user to run. Fall back to the active branch only when there is no
  // header yet (first run); when the two agree, the header equals it anyway.
  const envHeaderBranch = fm.readEnvMeta().branch;
  const dirtyBranch = envHeaderBranch || currentBranch;
  if (!keep || !dirtyBranch) return null;

  // Check A: uncommitted changes (.env differs from keep.lock). An
  // unreadable/missing .env means there is nothing to compare — no
  // uncommitted change to worry about, same as the original inline guard.
  const tryReadLocalPlaintext = (): Record<string, string> | null => {
    try {
      return fm.readEncryptedEnvFile(encryptionKey);
    } catch {
      return null;
    }
  };
  const localPlaintext = tryReadLocalPlaintext();
  if (localPlaintext) {
    const uncommitted = findUncommittedEnvChange(localPlaintext, keep.variables, dirtyBranch);
    if (uncommitted != null) {
      return { code: 'UNCOMMITTED_CHANGES', branch: dirtyBranch, varName: uncommitted };
    }
  }

  // Check B: unpushed changes (keep.lock differs from last sync).
  const syncState = pm.readSyncState();
  const savedHash = getSyncKeepHash(syncState, dirtyBranch);
  const currentKeepHash = SyncEngine.computeKeepHash(keep, dirtyBranch);
  if (savedHash != null && savedHash !== currentKeepHash) {
    return { code: 'UNPUSHED_CHANGES', branch: dirtyBranch };
  }
  return null;
}

export interface CheckoutOptions {
  create?: boolean;
  /** Settled by `--protected` / `--no-protected`; undefined means ask. */
  protected?: boolean;
}

type DecryptData = Awaited<ReturnType<ServiceClient['getDecryptData']>>;

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

  async execute(branchName: string, options: CheckoutOptions = {}): Promise<void> {
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
      await displayErrorAndExit(error);
    }
  }

  /** Org-scoped silent session, then a plain silent one, then interactive: the last attempt's result. */
  private async authenticate(orgId: string | undefined) {
    const scoped = await this.authService.authenticateSilent(orgId);
    if (scoped.success) return scoped;
    const plain = await this.authService.authenticateSilent();
    if (plain.success) return plain;
    return this.authService.authenticate(orgId);
  }

  private async _execute(branchName: string, options: CheckoutOptions): Promise<void> {
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
    const authResult = await this.authenticate(projectState.organizationId);
    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
    }

    spinner.stop();

    const projectId = projectState.projectId!;
    const orgId = projectState.organizationId!;

    // Resolve encryption key from global keyring (requires server co-decrypt)
    const keyOps: KeyServiceOps = {
      coDecrypt: (oid, ct, transportId) => this.serviceClient.coDecrypt(oid, ct, undefined, transportId).then(r => r.plaintext),
      wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
    };
    const encryptionKey = await resolveProjectKey(orgId, projectId, authResult.user_id!, keyOps);

    // Guard: block checkout if working tree is dirty (skip for branch creation)
    if (!options.create) {
      const issue = findDirtyBranchIssue(this.projectManager, this.fileManager, encryptionKey);
      if (issue !== null && issue.code === 'UNCOMMITTED_CHANGES') {
        console.error(`You have uncommitted changes on "${issue.branch}" (${issue.varName}).`);
        console.error(`Run ${B('capy')} to commit before switching branches.`);
        process.exit(1);
      }
      if (issue !== null && issue.code === 'UNPUSHED_CHANGES') {
        console.error(`You have unpushed changes on "${issue.branch}".`);
        console.error(`Run ${B('capy push')} before switching branches.`);
        process.exit(1);
      }
    }

    if (options.create) {
      const created = await this.createBranch(projectId, branchName, options.protected);
      if (!created) {
        console.log('\nNo branch created.');
        return;
      }
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

    const decryptData = await this.fetchBranchSnapshot(projectId, branchName, syncSpinner);

    // Checkout is an explicit sync of the TARGET branch, so update that
    // branch's pins from the server — but only that branch's (CAP-303).
    // keep.lock holds all branches' metadata and is git-owned; the server's
    // copy is whatever the last pusher had and must not rewrite branches this
    // checkout didn't touch.
    const keepForWrite = this.adoptServerBranchPins(decryptData, branchName);

    // Write .env BEFORE switching .capy/branch. The .env header records which
    // branch its contents belong to, so if we fail between these writes we must
    // never leave .capy/branch pointing to a branch whose secrets aren't in
    // .env yet. Writing .env first means a crash here leaves us on the old
    // branch with .env already updated — detectable on next run via
    // capy-branch-header mismatch self-heal.
    const { varCount, seededFromCurrent } = this.writeBranchEnv(
      decryptData,
      options,
      encryptionKey,
      keepForWrite,
      branchName,
    );

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

  /** The branch's latest snapshot. A 403 and any other failure exit 1; a 404 is an empty branch. */
  private async fetchBranchSnapshot(
    projectId: string,
    branchName: string,
    syncSpinner: { stop: () => unknown },
  ): Promise<DecryptData> {
    try {
      return await this.serviceClient.getDecryptData(
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
        return { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
      }
      console.error(`Failed to sync secrets: ${error.message}`);
      process.exit(1);
    }
  }

  /** Splices the server's pins for `branchName` into keep.lock (writing it) when the server sent a copy. */
  private adoptServerBranchPins(decryptData: DecryptData, branchName: string): KeepFile {
    const localKeep = this.projectManager.readKeepFile()!;
    if (!decryptData.keep_file) return localKeep;
    const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
    const spliced = SyncEngine.spliceKeepBranch(localKeep, serverKeep, branchName);
    this.fileManager.writeKeepFile(spliced);
    return spliced;
  }

  /** The current .env's plaintext, or `{}` when it cannot be read. */
  private readCurrentEnv(encryptionKey: string): Record<string, string> {
    try {
      return this.fileManager.readEncryptedEnvFile(encryptionKey);
    } catch {
      // Unreadable current .env — fall through to empty-stamped file.
      return {};
    }
  }

  /** Writes the target branch's .env, reporting how many variables it holds and whether they were seeded from the current branch. */
  private writeBranchEnv(
    decryptData: DecryptData,
    options: CheckoutOptions,
    encryptionKey: string,
    keepForWrite: KeepFile,
    branchName: string,
  ): { varCount: number; seededFromCurrent: boolean } {
    if (decryptData.env_content) {
      const remoteEnv = this.fileManager.parseEnvContent(decryptData.env_content);
      const decrypted: Record<string, string> = Object.fromEntries(
        Object.entries(remoteEnv).flatMap(([key, value]) => {
          try {
            return [[key, this.fileManager.decryptValue(value, encryptionKey)] as const];
          } catch {
            return []; // Skip undecryptable
          }
        }),
      );
      this.fileManager.writeEncryptedEnvFile(decrypted, encryptionKey, undefined, keepForWrite, branchName);
      return { varCount: Object.keys(decrypted).length, seededFromCurrent: false };
    }
    if (options.create) {
      // `capy checkout -b <new>` with no remote snapshot: seed the new branch
      // from the current .env. Preserve the plaintext values and re-write them
      // under the new branch header (new resource_ids per (branch, key)), so
      // `capy` sees them as unpinned and offers to push them to <new>.
      const seed = this.readCurrentEnv(encryptionKey);
      this.fileManager.writeEncryptedEnvFile(seed, encryptionKey, undefined, keepForWrite, branchName);
      const varCount = Object.keys(seed).length;
      return { varCount, seededFromCurrent: varCount > 0 };
    }
    // Switching to an existing empty branch: overwrite .env with an empty
    // (but branch-stamped) file so the header matches the active branch.
    this.fileManager.writeEncryptedEnvFile({}, encryptionKey, undefined, keepForWrite, branchName);
    return { varCount: 0, seededFromCurrent: false };
  }

  /** Create the branch, asking about protection when argv did not settle it. */
  private async createBranch(
    projectId: string,
    branchName: string,
    isProtected: boolean | undefined,
  ): Promise<{ name: string } | null> {
    const protect = isProtected ?? (await this.askProtected(branchName));

    const branchSpinner = ora(`Creating branch ${branchName}...`).start();

    try {
      await this.serviceClient.createBranch(projectId, branchName, protect);
      branchSpinner.stop();
      console.log(`Branch "${branchName}" registered`);

      if (protect) {
        console.log(`\n"${branchName}" is a protected branch — access is invite-only`);
      }
      return { name: branchName };
    } catch (error: any) {
      branchSpinner.stop();
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
      return null;
    }
  }

  private async askProtected(branchName: string): Promise<boolean> {
    const { protect } = await inquirer.prompt([{
      type: 'confirm',
      name: 'protect',
      message: `Make "${branchName}" a protected branch? \x1b[90m(invite-only)\x1b[0m`,
      default: false,
    }]);
    return protect;
  }
}
