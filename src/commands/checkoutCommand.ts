import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import inquirer from 'inquirer';
import { Branch, CapyError, ERROR_CODES, getSyncKeepHash, KeepFile } from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { SyncEngine } from '../sync/syncEngine';
import { hashValue } from './statusCommand';
import { branchCreatePlan, unansweredStops } from '../core/branchCreatePlan';
import { computePushDiff } from '../core/pushPlan';
import {
  dryRunOk,
  dryRunRefused,
  dryRunExitCode,
  printDryRunResultHuman,
  printDryRunResultJson,
  type DryRunChange,
  type DryRunResult,
  type DryRunUnanswered,
} from '../core/dryRun';
import { isInteractive } from '../ui/interactive';

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
  /**
   * Ask this run's questions in a browser instead of at the TTY.
   *
   * Changes only where a question is RENDERED. The same plan decides which
   * questions exist, the same answers reach the same code, and nothing about
   * what is written to keep.lock or .env moves.
   */
  web?: boolean;
  /** Preview only — see `previewCheckout`. Never writes, never prompts, never signs in. */
  dryRun?: boolean;
  /** `--json` on the real (non-dry-run) create path keeps its existing raw `{stops, unanswered}` shape; dry-run output always goes through the shared printer regardless of this flag. */
  json?: boolean;
  /** Never prompt; resolve from flags or fail fast (agents/CI). */
  nonTty?: boolean;
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

  /** Prints a `DryRunResult` on the shared printer and exits per CAP-659's rule — never returns. */
  private printDryRun(result: DryRunResult, json: boolean): never {
    if (json) printDryRunResultJson(result);
    else printDryRunResultHuman(result);
    process.exit(dryRunExitCode(result));
  }

  /**
   * `capy checkout -b <name> --dry-run` — shares `branchCreatePlan` with the
   * existing `--create --json` route (CAP-659's own ask: one plan, two
   * surfaces). Needs no auth and no network: whatever is outstanding is
   * reported as `unanswered` (exit 3, same as a headless `--create --json`
   * run with the same gaps); once name + protection are both known, the
   * only knowable change is the create call itself plus the NAMES (never
   * values) `.env` already holds, which `-b` would seed onto the new branch.
   */
  private previewCreate(branchName: string, isProtected: boolean | undefined, json: boolean): void {
    const stops = branchCreatePlan({ branchName, isProtected });
    const outstanding = unansweredStops(stops);
    const unanswered: DryRunUnanswered[] = outstanding.map((id) => ({
      id,
      flag: id === 'name' ? 'argument: capy checkout -b <name>' : '--protected or --no-protected',
    }));

    if (unanswered.length > 0) {
      this.printDryRun(dryRunOk('checkout', [], unanswered), json);
      return;
    }

    const seedNames = ((): readonly string[] => {
      try {
        return Object.keys(this.fileManager.readEnvFile());
      } catch {
        return [];
      }
    })();

    const changes: DryRunChange[] = [
      { where: 'capy_service', action: 'create branch', target: branchName, reversible: true },
      ...seedNames.map((name): DryRunChange => ({
        where: 'local_file',
        action: 'seed variable onto new branch (unpushed)',
        target: name,
        reversible: true,
      })),
    ];
    this.printDryRun(dryRunOk('checkout', changes), json);
  }

  /**
   * `capy checkout <branch> --dry-run` (switch mode, no `-b`) — which
   * branch, and which variable NAMES in `.env` would change. Computed from
   * keep.lock's own pins for both branches (the same local snapshot
   * `countVariablesPerBranch` reads) — never a value, and never a fresh
   * network fetch of either branch's actual secrets. `listBranches` is the
   * one read this shares with the real run's own existence check.
   */
  private async previewSwitch(
    projectState: Awaited<ReturnType<ProjectManager['detectProjectState']>>,
    branchName: string,
    encryptionKey: string,
    json: boolean,
  ): Promise<void> {
    const branches = await this.serviceClient.listBranches(projectState.projectId!);
    const branch = branches.find((b) => b.name === branchName);
    if (!branch) {
      this.printDryRun(dryRunRefused('checkout', ERROR_CODES.BRANCH_NOT_FOUND), json);
      return;
    }

    const keep = this.projectManager.readKeepFile();
    const currentBranch = projectState.activeBranch ?? undefined;
    const pinnedFor = (branchName2: string): Record<string, string> =>
      Object.fromEntries(
        Object.entries(keep?.variables ?? {}).flatMap(([varName, entries]) => {
          const entry = entries.find((e) => e.branch === branchName2);
          return entry ? ([[varName, entry.value_hash]] as const) : [];
        }),
      );
    const currentPinned = currentBranch ? pinnedFor(currentBranch) : {};
    const targetPinned = pinnedFor(branchName);

    // Reuses the same name/hash diff math `push` uses against keep.lock:
    // absent from current, present on target → would be added to `.env`;
    // present on current, absent from target → would be removed; present
    // on both with a different hash → would change.
    const diffs = computePushDiff(currentPinned, targetPinned);
    const ACTION: Record<'add' | 'change' | 'remove', string> = {
      add: 'add variable to .env',
      change: 'change variable in .env',
      remove: 'remove variable from .env',
    };
    const changes: DryRunChange[] = [
      { where: 'local_file', action: 'switch active branch', target: branchName, reversible: true },
      ...diffs.map((d): DryRunChange => ({
        where: 'local_file',
        action: ACTION[d.kind],
        target: d.name,
        reversible: true,
      })),
    ];
    this.printDryRun(dryRunOk('checkout', changes), json);
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
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize the project.`);
      process.exit(1);
    }

    if (options.create && options.dryRun) {
      // Create mode needs no auth and no network at all: the plan is the
      // name/protection stops plus the NAMES (never values) of whatever is
      // currently in `.env` — that's all `-b` would seed onto the new,
      // unpushed branch.
      this.previewCreate(branchName, options.protected, options.json === true);
      return;
    }

    // CAP-520: the one question `-b` can still ask (protected y/n) — refused
    // BEFORE auth/key resolution, since every fact this needs (the flags)
    // already came from argv. A `--web` run still answers it in the
    // browser (which needs the key for its seed preview), so this only
    // ever fires for the plain-TTY-less, no-`--web` case.
    if (options.create && options.protected === undefined && !options.web && !isInteractive(options.nonTty)) {
      console.error(
        // COPY-FLAG: wording pending approval; minimal/neutral until then.
        `\n  ${ERROR_CODES.CHECKOUT_PROTECTION_NEEDS_TTY}: "${branchName}" needs --protected or --no-protected.\n` +
          '  Pass one of those flags, or run this in a terminal (or with --web).\n',
      );
      process.exit(3);
    }

    // Load user-scoped session
    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }

    // Authenticate. Under `--dry-run` (switch mode only — `-b` returned
    // above before reaching here), never start a new sign-in: only the
    // silent attempts run, and a dry run with no usable session refuses
    // with the same code the real run would eventually give (AUTH_FAILED)
    // rather than opening a browser.
    const spinner = ora('Authenticating...').start();
    const authResult = await (async () => {
      const scoped = await this.authService.authenticateSilent(projectState.organizationId);
      if (scoped.success) return scoped;
      const anySession = await this.authService.authenticateSilent();
      if (anySession.success || options.dryRun) return anySession;
      return this.authService.authenticate(projectState.organizationId);
    })();
    if (!authResult.success) {
      spinner.fail('Authentication failed');
      if (options.dryRun) {
        this.printDryRun(dryRunRefused('checkout', ERROR_CODES.AUTH_FAILED), options.json === true);
      }
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
      const issue = findDirtyBranchIssue(this.projectManager, this.fileManager, encryptionKey);
      if (issue !== null && options.dryRun) {
        this.printDryRun(dryRunRefused('checkout', issue.code), options.json === true);
      }
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

    if (options.dryRun) {
      // Switch mode preview: which branch, and which variable NAMES in
      // `.env` would change — computed from keep.lock's own pins for both
      // branches (never a value). `listBranches` is a read, same as the
      // real run's own existence check just below.
      await this.previewSwitch(projectState, branchName, encryptionKey, options.json === true);
      return;
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

    // Checkout is an explicit sync of the TARGET branch, so update that
    // branch's pins from the server — but only that branch's (CAP-303).
    // keep.lock holds all branches' metadata and is git-owned; the server's
    // copy is whatever the last pusher had and must not rewrite branches this
    // checkout didn't touch.
    let keepForWrite = this.projectManager.readKeepFile()!;
    if (decryptData.keep_file) {
      const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
      keepForWrite = SyncEngine.spliceKeepBranch(keepForWrite, serverKeep, branchName);
      this.fileManager.writeKeepFile(keepForWrite);
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

    // The no-TTY, no-`--web`, protection-undecided case is refused earlier,
    // in `_execute` — before auth/key resolution ever runs, since every
    // fact that refusal needs (the name, `isProtected`, `web`, `nonTty`)
    // comes straight from argv. Nothing new to decide here by the time
    // this line can be reached: if we get this far with `isProtected`
    // still undefined, there IS a TTY (or `--web` already answered it).
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
    });
    return picked.cancelled ? null : picked.branch;
  }
}
