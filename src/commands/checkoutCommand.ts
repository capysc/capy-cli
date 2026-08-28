import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import inquirer from 'inquirer';
import { Branch, CapyError, ERROR_CODES, getSyncKeepHash, KeepFile, setSyncKeepHash } from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { SyncEngine } from '../sync/syncEngine';
import { hashValue } from './statusCommand';
import { branchCreatePlan, unansweredStops } from '../core/branchCreatePlan';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * How many variables each branch pins, from keep.lock alone.
 *
 * Feeds the branch list's per-row count. Local knowledge deliberately: the
 * server's branch list carries no counts, and keep.lock is the file this
 * directory already trusts for what a branch holds. A branch this checkout has
 * never touched is simply absent from the map, which the screen renders as no
 * count rather than as zero.
 */
export function countVariablesPerBranch(keep: KeepFile | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entries of Object.values(keep?.variables ?? {})) {
    // Per VARIABLE, not per entry: the number the screen prints is "variables
    // held on this branch", and a variable with two entries pinned to one
    // branch is still one variable.
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry?.branch || seen.has(entry.branch)) continue;
      seen.add(entry.branch);
      counts[entry.branch] = (counts[entry.branch] ?? 0) + 1;
    }
  }
  return counts;
}

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

/**
 * The pure "sync + write" tail of a branch switch — everything `_execute`
 * does once it already knows which branch it is switching to (found, or just
 * created), extracted so `capy flow run`'s `switch_branch` executor
 * (flowRunCommand.ts) can perform the SAME switch without this class's own
 * spinner/console/process.exit UI. `_execute` below calls this and renders
 * its own byte-identical output from the returned outcome — a pure refactor,
 * no behavior change for the existing `capy checkout` command.
 *
 * Never prints, never calls `process.exit`: every branch that used to do
 * either is instead a `BranchSyncOutcome` variant for the caller to render.
 */
export interface BranchSyncOutcome {
  kind: 'forbidden' | 'sync_error' | 'ok';
  /** Only on `sync_error` — the original error's message, for the TTY caller's existing print. */
  errorMessage?: string;
  varCount: number;
  seededFromCurrent: boolean;
}

export interface BranchSyncDeps {
  serviceClient: ServiceClient;
  projectManager: ProjectManager;
  fileManager: FileManager;
}

export async function syncAndWriteBranch(
  deps: BranchSyncDeps,
  projectId: string,
  branchName: string,
  encryptionKey: string,
  isCreate: boolean,
  pinnedKeepHash?: string,
): Promise<BranchSyncOutcome> {
  const fetched = await (async (): Promise<
    { ok: true; data: Awaited<ReturnType<ServiceClient['getDecryptData']>> } | { ok: false; outcome: BranchSyncOutcome }
  > => {
    try {
      return {
        ok: true,
        data: await deps.serviceClient.getDecryptData(projectId, branchName, pinnedKeepHash, true),
      };
    } catch (error: any) {
      const status = error?.details?.status;
      if (status === 403) {
        return { ok: false, outcome: { kind: 'forbidden', varCount: 0, seededFromCurrent: false } };
      }
      if (status === 404) {
        if (pinnedKeepHash) {
          return {
            ok: false,
            outcome: {
              kind: 'sync_error',
              errorMessage: 'The snapshot pinned by the current keep.lock is unavailable.',
              varCount: 0,
              seededFromCurrent: false,
            },
          };
        }
        // No snapshot yet for this branch — treat as empty and proceed to switch.
        return {
          ok: true,
          data: { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() },
        };
      }
      return {
        ok: false,
        outcome: { kind: 'sync_error', errorMessage: error.message, varCount: 0, seededFromCurrent: false },
      };
    }
  })();
  if (!fetched.ok) return fetched.outcome;
  const decryptData = fetched.data;

  // Checkout is an explicit sync of the TARGET branch, so update that
  // branch's pins from the server — but only that branch's (CAP-303).
  // keep.lock holds all branches' metadata and is git-owned; the server's
  // copy is whatever the last pusher had and must not rewrite branches this
  // checkout didn't touch.
  const keepForWrite = ((): KeepFile => {
    const base = deps.projectManager.readKeepFile()!;
    if (!decryptData.keep_file) return base;
    const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
    const spliced = SyncEngine.spliceKeepBranch(base, serverKeep, branchName);
    deps.fileManager.writeKeepFile(spliced);
    return spliced;
  })();

  // Write .env BEFORE switching .capy/branch. The .env header records which
  // branch its contents belong to, so if we fail between these writes we must
  // never leave .capy/branch pointing to a branch whose secrets aren't in
  // .env yet. Writing .env first means a crash here leaves us on the old
  // branch with .env already updated — detectable on next run via
  // capy-branch-header mismatch self-heal.
  const written = ((): { varCount: number; seededFromCurrent: boolean } => {
    if (decryptData.env_content) {
      const remoteEnv = deps.fileManager.parseEnvContent(decryptData.env_content);
      const decrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(remoteEnv)) {
        try {
          decrypted[key] = deps.fileManager.decryptValue(value, encryptionKey);
        } catch {
          // Skip undecryptable
        }
      }
      deps.fileManager.writeEncryptedEnvFile(decrypted, encryptionKey, undefined, keepForWrite, branchName);
      return { varCount: Object.keys(decrypted).length, seededFromCurrent: false };
    }
    if (isCreate) {
      // `capy checkout -b <new>` with no remote snapshot: seed the new branch
      // from the current .env. Preserve the plaintext values and re-write them
      // under the new branch header (new resource_ids per (branch, key)), so
      // `capy` sees them as unpinned and offers to push them to <new>.
      const seed = ((): Record<string, string> => {
        try {
          return deps.fileManager.readEncryptedEnvFile(encryptionKey);
        } catch {
          // Unreadable current .env — fall through to empty-stamped file.
          return {};
        }
      })();
      deps.fileManager.writeEncryptedEnvFile(seed, encryptionKey, undefined, keepForWrite, branchName);
      const varCount = Object.keys(seed).length;
      return { varCount, seededFromCurrent: varCount > 0 };
    }
    // Switching to an existing empty branch: overwrite .env with an empty
    // (but branch-stamped) file so the header matches the active branch.
    deps.fileManager.writeEncryptedEnvFile({}, encryptionKey, undefined, keepForWrite, branchName);
    return { varCount: 0, seededFromCurrent: false };
  })();

  deps.projectManager.writeActiveBranch(branchName);
  return { kind: 'ok', varCount: written.varCount, seededFromCurrent: written.seededFromCurrent };
}

export interface CheckoutOptions {
  create?: boolean;
  /** Replace the local .env and sync-state from the current keep.lock. */
  refresh?: boolean;
  /** Settled by `--protected` / `--no-protected`; undefined means ask. */
  protected?: boolean;
  /**
   * Ask this run's questions in a browser instead of at the TTY.
   *
   * Changes only where a question is RENDERED. The same plan decides which
   * questions exist, the same answers reach the same code, and nothing about
   * what is written to keep.lock or .env moves.
   */
  web?: boolean;
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

  private async _execute(branchName: string, options: CheckoutOptions): Promise<void> {
    // Read keep.lock — must be initialized
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      // THROW, never console.error + process.exit. This sits inside the try
      // whose catch routes to `displayErrorAndExit` — the one thing that serves
      // the command-error page under `--web` and holds the process open until
      // the browser has fetched it. Exiting here never throws, so that catch
      // never ran and a --web caller, who has no terminal by definition, got
      // a refusal on a stream with nobody on the other end.
      throw new CapyError(
        `No keep.lock file found. Run ${B('capy')} first to initialize the project.`,
        ERROR_CODES.PROJECT_NOT_INITIALIZED,
      );
    }

    // Load user-scoped session
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }

    // Authenticate
    const spinner = ora('Authenticating...').start();
    const authResult = await (async () => {
      const organizationResult = await this.authService.authenticateSilent(projectState.organizationId);
      if (organizationResult.success) return organizationResult;
      const silentResult = await this.authService.authenticateSilent();
      if (silentResult.success) return silentResult;
      return this.authService.authenticate(projectState.organizationId);
    })();
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
    if (!options.create && !options.refresh) {
      const keep = this.projectManager.readKeepFile();
      const currentBranch = this.projectManager.readActiveBranch();

      // The decrypted .env belongs to the branch recorded in its own header,
      // which can diverge from .capy/branch after an interrupted checkout
      // (CAP-215). Diff the uncommitted-changes check against the branch the
      // ciphertext was actually encrypted for — otherwise a value that simply
      // differs across branches reads as a phantom "uncommitted change",
      // deadlocking the very `capy checkout` the inconsistency error tells the
      // user to run. Fall back to the active branch only when there is no
      // header yet (first run); when the two agree, the header equals it anyway.
      const envHeaderBranch = this.fileManager.readEnvMeta().branch;
      const dirtyBranch = envHeaderBranch || currentBranch;

      if (keep && dirtyBranch) {
        // A git pull/reset can move keep.lock without touching .env or
        // sync-state. Detect that discriminator before diffing .env: the old
        // guards would otherwise call the resulting stale values
        // "uncommitted" or "unpushed" and recommend overwriting the newer
        // lockfile. Refresh is the explicit, destructive recovery path.
        const syncState = this.projectManager.readSyncState();
        const savedHash = getSyncKeepHash(syncState, dirtyBranch);
        const currentKeepHash = SyncEngine.computeKeepHash(keep, dirtyBranch);
        if (savedHash != null && savedHash !== currentKeepHash) {
          console.error(`keep.lock changed outside capy (for example, via git pull).`);
          console.error(`Your local .env for "${dirtyBranch}" may be stale.`);
          console.error(`Run ${B(`capy checkout ${dirtyBranch} --refresh`)} to replace it from the current keep.lock.`);
          process.exit(1);
          return;
        }

        // Check A: uncommitted changes (.env differs from keep.lock)
        try {
          const localPlaintext = this.fileManager.readEncryptedEnvFile(encryptionKey);
          const uncommitted = findUncommittedEnvChange(localPlaintext, keep.variables, dirtyBranch);

          if (uncommitted != null) {
            console.error(`You have uncommitted changes on "${dirtyBranch}" (${uncommitted}).`);
            console.error(`Run ${B('capy')} to commit before switching branches.`);
            process.exit(1);
          }
        } catch {
          // If .env doesn't exist or can't be read, no uncommitted changes to worry about
        }
      }
    }

    if (options.create) {
      const created = await this.createBranch(
        projectId,
        branchName,
        encryptionKey,
        options.protected,
        options.web,
        projectState.projectName || 'project',
      );
      // Cancelling in the browser is a refusal, so nothing was registered and
      // nothing below may run: the rest of this method switches the directory
      // onto a branch that does not exist.
      if (!created) {
        console.log('\nNo branch created.');
        return;
      }
      branchName = created.name;
    } else {
      // Verify the branch exists
      const branchSpinner = ora(`Switching to ${branchName}...`).start();
      const branches = await this.serviceClient.listBranches(projectId);
      const branch = branches.find(b => b.name === branchName);
      if (!branch) {
        branchSpinner.stop();

        // The terminal's answer to a name that does not exist is a listing and
        // exit 1: the branch the user meant is on the screen, and the only way
        // to reach it is to type the command again. In the browser the listing
        // IS the picker, so a wrong name becomes a question rather than a dead
        // end. Only when there is something to pick — a list with no row this
        // directory could move to is a page with no way out of it.
        const switchable = branches.filter(b => b.name !== projectState.activeBranch);
        if (options.web && switchable.length > 0) {
          const picked = await this.pickBranchInBrowser(
            branchName,
            branches,
            projectState.projectName || 'project',
            projectState.activeBranch ?? null,
          );
          if (!picked) {
            console.log('\nNo branch selected — nothing changed.');
            return;
          }
          branchName = picked;
        } else {
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
      } else {
        branchSpinner.stop();
      }
    }

    // Pull latest secrets for this branch from the server BEFORE switching
    // local state, so a 403 (protected branch / no access) leaves the user
    // on their current branch with their current .env intact.
    const syncSpinner = ora(`Syncing secrets for ${branchName}...`).start();

    // The sync + write tail, extracted to `syncAndWriteBranch` (this file)
    // so `capy flow run`'s switch_branch executor can reuse it verbatim.
    // Pure refactor: the branching below reproduces the exact same
    // console/exit behavior this method always had, from the returned
    // outcome instead of inline try/catch.
    const outcome = await syncAndWriteBranch(
      { serviceClient: this.serviceClient, projectManager: this.projectManager, fileManager: this.fileManager },
      projectId,
      branchName,
      encryptionKey,
      options.create === true,
      options.refresh
        ? SyncEngine.computeKeepHash(this.projectManager.readKeepFile()!, branchName)
        : undefined,
    );
    syncSpinner.stop();

    if (outcome.kind === 'forbidden') {
      console.error(`You do not have access to branch "${branchName}".`);
      console.error(`Protected branches are invite-only — ask a project admin to grant access.`);
      process.exit(1);
    }
    if (outcome.kind === 'sync_error') {
      console.error(`Failed to sync secrets: ${outcome.errorMessage}`);
      process.exit(1);
    }

    if (options.refresh) {
      const refreshedKeep = this.projectManager.readKeepFile()!;
      const refreshedPlaintext = this.fileManager.readEncryptedEnvFile(encryptionKey);
      const existingSyncState = this.projectManager.readSyncState();
      this.fileManager.writeSyncState({
        ...existingSyncState,
        last_sync: new Date().toISOString(),
        synced_variables: Object.keys(refreshedPlaintext),
        user_id: authResult.user_id,
        org_id: orgId,
        keep_hash: setSyncKeepHash(
          existingSyncState,
          branchName,
          SyncEngine.computeKeepHash(refreshedKeep, branchName),
        ),
      });
    }

    if (outcome.seededFromCurrent) {
      console.log(`Seeded ${outcome.varCount} variable(s) from current branch into ${branchName} (unpushed — run ${B('capy')} to push)`);
    } else if (outcome.varCount > 0) {
      console.log(`Synced ${outcome.varCount} variable(s) for ${branchName}`);
    } else {
      console.log(`No secrets yet for ${branchName}`);
    }

    console.log(`\nNow on branch: ${branchName}`);
  }

  /**
   * Create the branch, asking whatever the plan left unanswered.
   *
   * Returns the branch that now exists, or null when the browser was
   * cancelled — a step nobody answered has not been approved, and the caller
   * must not go on to switch this directory onto it.
   */
  private async createBranch(
    projectId: string,
    branchName: string,
    encryptionKey: string,
    isProtected: boolean | undefined,
    web: boolean | undefined,
    projectName: string,
  ): Promise<{ name: string } | null> {
    // The whole route, computed before anything opens — the same array
    // `capy checkout -b <name> --json` prints. Asking it what is outstanding,
    // rather than testing `isProtected === undefined` a second time here, is
    // what keeps the questions this run asks and the rail it draws in step.
    const outstanding = unansweredStops(branchCreatePlan({ branchName, isProtected }));

    if (web && outstanding.length > 0) {
      const answer = await this.askCreateInBrowser(
        projectId, branchName, encryptionKey, isProtected, projectName,
      );
      if (answer.cancelled) return null;
      branchName = answer.name;
      isProtected = answer.isProtected;
    }

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
      return { name: branchName };
    } catch (error: any) {
      branchSpinner.stop();
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
      return null;
    }
  }

  /**
   * The protection confirm (and the name, when argv gave none), in a browser.
   *
   * The seed preview is the reason this reads .env at all: `-b` skips both
   * dirty guards, so whatever is in this directory right now is copied onto
   * the new branch and left unpushed, and the terminal only says so afterwards
   * as `Seeded 12 variable(s)`. NAMES and a count cross — never a value. The
   * plaintext read here stays in this frame.
   */
  private async askCreateInBrowser(
    projectId: string,
    branchName: string,
    encryptionKey: string,
    isProtected: boolean | undefined,
    projectName: string,
  ): Promise<{ name: string; isProtected: boolean; cancelled: boolean }> {
    let seedVarNames: string[] = [];
    let seedUnreadable = false;
    try {
      // Missing .env yields {} rather than throwing, which is an empty seed
      // and not an unreadable one — the two say different things on the page.
      seedVarNames = Object.keys(this.fileManager.readEncryptedEnvFile(encryptionKey)).sort();
    } catch {
      seedUnreadable = true;
    }

    // Existing names, so a collision is answered while the user is typing
    // instead of arriving as the server's prose after a round trip. Best
    // effort: without the list the screen simply cannot pre-empt a clash, and
    // `POST /branches` still refuses one.
    let existingBranches: Array<{ name: string; isProtected: boolean }> = [];
    try {
      const branches = await this.serviceClient.listBranches(projectId);
      existingBranches = branches.map(b => ({ name: b.name, isProtected: b.is_protected }));
    } catch {
      /* leave it empty; the server remains the authority on a taken name */
    }

    const { createBranchInBrowser } = await import('../ui/branchScreens');
    return createBranchInBrowser({
      projectName,
      branchName,
      isProtected,
      existingBranches,
      seedFrom: this.fileManager.readEnvMeta().branch || this.projectManager.readActiveBranch() || null,
      seedVarNames,
      seedUnreadable,
      // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI / headless
      // verification drive the loopback without hijacking a real browser.
      open: !process.env.CAPY_WEB_NO_OPEN,
    });
  }

  /**
   * The branch list, served as a picker.
   *
   * Reached only from the not-found path, so it is a correction rather than a
   * menu: the user asked for a branch this project does not have. Deleting is
   * off — `capy checkout` has never deleted anything, and the screen draws no
   * delete control without it.
   */
  private async pickBranchInBrowser(
    missing: string,
    branches: Branch[],
    projectName: string,
    activeBranch: string | null,
  ): Promise<string | null> {
    console.log(`Branch "${missing}" not found\n`);
    const { chooseBranchInBrowser } = await import('../ui/branchScreens');
    const picked = await chooseBranchInBrowser({
      projectName,
      activeBranch,
      branches,
      variableCounts: countVariablesPerBranch(this.projectManager.readKeepFile()),
      canDelete: false,
      open: !process.env.CAPY_WEB_NO_OPEN,
      authService: this.authService,
    });
    return picked.cancelled ? null : picked.branch;
  }
}
