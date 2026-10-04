import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { PromptEngine } from '../ui/promptEngine';
import { debugLine } from '../ui/debug';
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
  AuthResult,
  ProjectInitResult,
  CapyError,
  ERROR_CODES,
  getSyncKeepHash,
  setSyncKeepHash,
} from '../types/index';
import { validateSeedPhrase } from '../crypto/keyManager';
import { offerAgentsSetupAfterInit } from './agentsCommand';
import {
  resolveBranchFromLocalState,
  selectBranchWithServer,
  branchesFromKeep,
  syncedBranchNames,
} from '../core/branchResolver';
import {
  resolveProjectKey,
  hasOrgKey,
  KeyServiceOps,
} from '../crypto/keyResolver';
import { writeKeepCache, fetchSecretsWithCache, readSecretsLocal, LOCAL_ORG_ID, LOCAL_USER_ID } from '../config/globalConfig';
import { excludeSystemProject, assertProjectNameAllowed } from '../system/reservedProjectName';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { compareSecrets, hashValue, formatSnippet } from './statusCommand';
import { ACCENT } from '../ui/colors';
import { installSyncHooks } from '../git/syncHooks';
import { initProjectQuestion } from '../ui/projectQuestions';
import { reportRepoLinkForCommand } from '../core/repoLinkReporter';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * The org project listing's own core: "the lookup failed" and "this org has
 * none" both surface as an empty list, but `projectsUnavailable` says
 * which — a network/auth error must not be read as "you have no projects
 * yet" (that misread is what let `capy connect dokploy --discover` offer
 * only "create new" on a transient lookup failure, silently risking a
 * duplicate project — CAP-657 follow-up). Extracted so `CapyCommand`'s own
 * `listExistingProjectsOrUnavailable` (below, with its spinner/debug
 * wrapping) and `dokploy.ts`'s discovery both call ONE function rather than
 * two copies of this try/catch. `onError` is optional so a caller with no
 * debug-logging concept of its own isn't forced to fake one.
 */
export async function listOrgProjectsOrUnavailable(
  serviceClient: ServiceClient,
  onError?: (err: unknown) => void,
): Promise<{
  existingProjects: Array<{ id: string; name: string; organization_id: string }>;
  projectsUnavailable: boolean;
}> {
  try {
    // Belt-and-braces: the service already hides the org's `_system`
    // project from this listing (CAP-664). Filtered again here so it can
    // never be offered as a bootstrap target even against an older service.
    const existingProjects = excludeSystemProject(await serviceClient.listProjects());
    return { existingProjects, projectsUnavailable: false };
  } catch (err) {
    onError?.(err);
    return { existingProjects: [], projectsUnavailable: true };
  }
}

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

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
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
    debugLine(msg, data);
  }

  /** Format any caught error for debug output, preserving stack and CapyError details. */
  private debugError(label: string, err: unknown): void {
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
          projectState.activeBranch = envMeta.branch ?? null;
        } else if (isLocalOnly()) {
          // Local-only mode: bootstrap a project entirely on this machine
          // (synthetic org, generated projectId) instead of server onboarding.
          await this.initializeProjectLocal();
          return;
        } else {
          await this.initializeProject();
          return;
        }
      }

      await this.syncProject(projectState);
      // CAP-697: auth is established by now. Reporting never changes this command's output or exit code.
      if (!isLocalOnly() && projectState.organizationId && projectState.projectId) {
        await reportRepoLinkForCommand({
          cwd: process.cwd(),
          orgId: projectState.organizationId,
          projectId: projectState.projectId,
          projectName: projectState.projectName,
          client: this.serviceClient,
          dryRun: this.options.dryRun === true,
        });
        // CAP-702: configured deploy targets that never got a push read as behind in `capy secrets`. Best-effort, silent.
        await (await import('../deploy/configuredTargets')).recordConfiguredTargets({
          cwd: process.cwd(),
          projectId: projectState.projectId,
          client: this.serviceClient,
          dryRun: this.options.dryRun === true,
        });
      }
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    } catch (error: any) {
      this.debugError('execute caught error', error);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /**
   * Resolve the branch this run operates on. Local signals first — the .env
   * header (what the secrets on disk were actually encrypted for) outranks
   * .capy/branch, and either alone suffices; .capy/* is a gitignored local
   * cache, so its absence is a normal state that gets rebuilt, never errored
   * on. Only when both files exist and genuinely disagree (an interrupted
   * checkout) do we stop — and only after confirming the .capy/branch side
   * names a real branch, so recovery instructions never point at a branch
   * that doesn't exist. With no local signal at all, the server branch list
   * decides: sole branch → use it; otherwise prompt, never preselecting a
   * protected branch (keyed off is_protected, never the branch name).
   *
   * Runs after authentication — the server-assisted steps need a token.
   * localMode skips all server steps; an unknown branch there falls back to
   * the local-mode default (local-only projects have exactly one branch).
   */
  private async resolveActiveBranch(projectState: ProjectState, localMode: boolean): Promise<string> {
    const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
    const local = resolveBranchFromLocalState({
      envBranch: envMeta.branch,
      fileBranch: this.projectManager.readActiveBranch() ?? undefined,
    });
    this.debug('branch resolution (local signals)', local);

    if (local.kind === 'resolved') {
      if (local.rebuildBranchFile) {
        // .capy/branch was missing — rebuild it from the .env header.
        this.projectManager.writeActiveBranch(local.branch);
      }
      return local.branch;
    }

    if (local.kind === 'conflict') {
      return this.reconcileBranchConflict(projectState, localMode, local.envBranch, local.fileBranch);
    }

    // No .env header and no .capy/branch.
    if (localMode) {
      // Local-only projects operate on a single branch (see localGate); the
      // first run has no files yet, so the local-mode default applies.
      this.projectManager.writeActiveBranch(SyncEngine.DEFAULT_BRANCH);
      return SyncEngine.DEFAULT_BRANCH;
    }

    const selected = await selectBranchWithServer({
      listBranches: () => this.serviceClient.listBranches(projectState.projectId!),
      syncedBranches: syncedBranchNames(this.projectManager.readSyncState()),
      promptPick: async (branches, defaultName) => {
        const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
        console.log('\nNo branch is checked out in this directory yet.');
        const { selected: pick } = await inquirer.prompt([{
          type: 'list',
          name: 'selected',
          message: 'Which branch do you want to use?',
          choices: branches.map(b => ({
            name: b.is_protected ? `${b.name}  ${grey('(protected)')}` : b.name,
            value: b.name,
          })),
          default: defaultName,
        }]);
        return pick;
      },
    });
    this.projectManager.writeActiveBranch(selected);
    return selected;
  }

  /**
   * .env and .capy/branch both exist and disagree — usually an interrupted
   * checkout. Before showing recovery instructions, verify the .capy/branch
   * side is a real branch: if it isn't (stale or foreign cache), the .env
   * header wins and the cache is rebuilt. A genuine conflict is a hard stop
   * with both recovery paths spelled out.
   */
  private async reconcileBranchConflict(
    projectState: ProjectState,
    localMode: boolean,
    envBranch: string,
    fileBranch: string,
  ): Promise<string> {
    const knownLocally = new Set([
      ...branchesFromKeep(this.safeReadKeep()),
      ...syncedBranchNames(this.projectManager.readSyncState()),
    ]);
    let fileBranchIsReal = knownLocally.has(fileBranch);
    if (!fileBranchIsReal && !localMode) {
      try {
        const branches = await this.serviceClient.listBranches(projectState.projectId!);
        fileBranchIsReal = branches.some(b => b.name === fileBranch);
      } catch (err) {
        // Offline: can't verify. Both files exist, so treat the conflict as
        // genuine rather than silently discarding one side.
        this.debugError('listBranches failed during conflict reconciliation', err);
        fileBranchIsReal = true;
      }
    }

    if (!fileBranchIsReal) {
      console.log(`Ignoring stale .capy/branch (${B(fileBranch)} is not a branch in this project); staying on ${B(envBranch)}.`);
      this.projectManager.writeActiveBranch(envBranch);
      return envBranch;
    }

    console.error(`\nLocal state is inconsistent:`);
    console.error(`  .capy/branch says ${B(fileBranch)}`);
    console.error(`  .env was encrypted for ${B(envBranch)}`);
    console.error(`\nThis usually means a previous checkout was interrupted.`);
    console.error(`Recover with: ${B(`capy checkout ${envBranch}`)} (re-sync to the branch .env actually holds)`);
    console.error(`           or: ${B(`capy checkout ${fileBranch}`)} (finish switching to the branch .capy/branch claims)\n`);
    process.exit(1);
  }

  /** keep.lock contents, or null when absent or corrupt (corruption is reported by the paths that need it). */
  private safeReadKeep(): KeepFile | null {
    try {
      return this.projectManager.readKeepFile();
    } catch {
      return null;
    }
  }

  /**
   * Local-only onboarding: create a project entirely on this machine — no
   * auth, no org selection, no server. Generates a local projectId, writes
   * keep.lock with the synthetic local org, then runs the normal (local-gated)
   * sync so the user can commit their .env.
   */
  private async initializeProjectLocal(): Promise<void> {
    this.debug('initializeProjectLocal start', { cwd: process.cwd() });
    const { randomUUID } = await import('crypto');
    const { basename } = await import('path');

    // Unlock now so a missing/locked key fails before we write keep.lock.
    await resolveLocalProjectKey('bootstrap');

    const projectName = basename(process.cwd()) || 'local-project';
    const keep: KeepFile = {
      version: '3.0',
      org_id: LOCAL_ORG_ID,
      project_id: randomUUID(),
      project_name: projectName,
      variables: {},
    };
    this.fileManager.writeKeepFile(keep);
    console.log(`Created local project "${projectName}" (this machine only).\n`);

    const projectState = await this.projectManager.detectProjectState();
    await this.syncProject(projectState);

    // One additional TTY-only prompt at the very end of a successful init —
    // skipped under --dry-run (a dry run must never prompt or write), and a
    // no-op if AGENTS.md/CLAUDE.md already has the section.
    if (!this.options.dryRun) await offerAgentsSetupAfterInit();
  }

  /** First run in this directory. */
  private async initializeProject(): Promise<void> {
    await this.runInitialization();
    // The same one-time, TTY-only offer as the local-only init path above —
    // same --dry-run gating.
    if (!this.options.dryRun) await offerAgentsSetupAfterInit();
  }

  /**
   * Resolves which org this init run targets. Each branch (no orgs yet /
   * create new / switch to current / switch to another) returns its answer
   * directly rather than assigning an outer variable, so there is exactly
   * one place `selectedOrg` is bound.
   */
  private async resolveSelectedOrganization(
    orgs: Organization[],
    authResult: AuthResult,
    refreshToken: string | undefined,
  ): Promise<Organization> {
    const CREATE_NEW_ORG = '__create_new__';
    const currentOrgId = authResult.organization_id;
    const currentOrg = orgs.find(o => o.id === currentOrgId);

    if (orgs.length === 0) {
      console.log('\nNo organization found. Let\'s create one.');
      return this.createNewOrganization(refreshToken!, authResult.user_id!);
    }

    const orgId = await this.resolveOrgIdChoice(orgs, currentOrgId, CREATE_NEW_ORG);

    if (orgId === CREATE_NEW_ORG) {
      return this.createNewOrganization(refreshToken!, authResult.user_id!);
    }

    if (currentOrg && orgId === currentOrg.id) {
      return currentOrg;
    }

    const target = orgs.find(o => o.id === orgId)!;
    await this.switchToOrganization(refreshToken!, target, authResult.user_id);
    return target;
  }

  /** Asks which org id was chosen. */
  private async resolveOrgIdChoice(
    orgs: Organization[],
    currentOrgId: string | undefined,
    createNewOrgValue: string,
  ): Promise<string> {
    const { orgId } = await inquirer.prompt([{
      type: 'list',
      name: 'orgId',
      message: 'Select organization for project:',
      choices: [
        ...orgs.map(o => ({
          name: o.id === currentOrgId ? `${o.name}  ${ACCENT}← current\x1b[0m` : o.name,
          value: o.id,
        })),
        { name: 'Create new organization +', value: createNewOrgValue },
      ],
      default: currentOrgId,
    }]);
    return orgId;
  }

  /** Switches the active session into `org`, refreshing or re-authenticating as needed. Throws on failure. */
  private async switchToOrganization(refreshToken: string, org: Organization, userId: string | undefined): Promise<void> {
    const orgSpinner = ora('Switching organization...').start();
    const scopedAuth = await this.authService.refreshWithCredentials(refreshToken, org.id, userId);
    if (scopedAuth.success) {
      orgSpinner.succeed(`Organization: ${org.name}`);
      return;
    }
    orgSpinner.text = 'Re-authenticating...';
    this.authService.clearToken();
    const reauthed = await this.authService.authenticate(org.id);
    if (!reauthed.success) {
      orgSpinner.fail('Failed to authenticate with organization');
      throw new CapyError(
        reauthed.error || 'Organization authentication failed',
        ERROR_CODES.AUTH_FAILED
      );
    }
    orgSpinner.succeed(`Organization: ${org.name}`);
  }

  private async runInitialization(): Promise<void> {
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

    // Resolve organization
    const orgs = authResult.organizations || [];
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;
    const selectedOrg = await this.resolveSelectedOrganization(orgs, authResult, refreshToken);

    // User has access to an existing org but no local key — they were invited
    // and need to redeem their invite code to receive the shared master key.
    const orgKeyPresent = hasOrgKey(selectedOrg.id, authResult.user_id!);
    if (!orgKeyPresent) {
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
    // "The lookup failed" and "this org has none" both end up as an empty list
    // here, and they are not the same fact: one walks the user into creating a
    // second project alongside one they already have. The rail says which.
    const { existingProjects } = await this.listExistingProjectsOrUnavailable();

    if (existingProjects.length > 0) {
      const projectChoice = await this.resolveProjectChoice(existingProjects, CREATE_NEW_PROJECT);

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
    const projectName = await this.resolveProjectName(defaultName);

    // Defense in depth: the prompt validators above already refuse
    // "_system" (CAP-664), but this is the actual choke point before the
    // service is asked to create anything, so it's checked again here.
    assertProjectNameAllowed(projectName);

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

    keySpinner.succeed('keep.lock created (0 secrets)');

    // Create the initial branch. `POST /projects` no longer auto-creates
    // one, so pick the name: default 'development', or a custom name the
    // user enters. Protection isn't asked here - branches are unprotected
    // by default and can be protected later via a dedicated action.
    const initialBranchChoice = await this.resolveInitialBranchChoice();
    const initialBranchName = initialBranchChoice === 'other'
      ? await this.resolveCustomBranchName()
      : 'development';
    const initialBranchProtected = false;

    const branchSpinner = ora(`Creating branch ${initialBranchName}...`).start();
    try {
      await this.serviceClient.createBranch(
        projectResult.project_id,
        initialBranchName,
        initialBranchProtected,
      );
    } catch (err) {
      branchSpinner.fail(`Failed to create branch ${initialBranchName}`);
      throw err;
    }
    branchSpinner.succeed(
      initialBranchProtected
        ? `Created protected branch ${initialBranchName}`
        : `Created branch ${initialBranchName}`,
    );

    // The initial branch is what this project is "on" locally going forward.
    this.projectManager.writeActiveBranch(initialBranchName);

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
      const rawLocalEnv = this.fileManager.readEnvFile(this.options.envPath);
      const localVarCount = Object.keys(rawLocalEnv).length;

      if (localVarCount > 0) {
        // Cross-org exfiltration guard — throws a CapyError if any encrypted
        // entry can't be read with this project's key.
        const decryptedLocalEnv = this.resolveDecryptedLocalEnv(rawLocalEnv, encryptionKey);

        // Show found variables (max 5 names, "etc." for 6+)
        const varNames = Object.keys(decryptedLocalEnv);
        const displayNames = varNames.length > 5
          ? varNames.slice(0, 5).join(', ') + ', etc.'
          : varNames.join(', ');
        console.log(`\nFound .env with ${localVarCount} secrets:`);
        console.log(`  ${displayNames}`);

        // The user already chose their initial branch above — push the
        // existing .env to that branch. (Previously we re-prompted for a
        // commit target here, but now that project init explicitly sets
        // the initial branch, asking again was redundant + could create a
        // second branch the user didn't ask for.)
        const initBranch = initialBranchName;

        // Confirm before encrypting + pushing — user may not be in the
        // right project on first setup. After this step .env is rewritten
        // with ciphertext, so getting it wrong is painful to recover from.
        const confirmEncrypt = await this.resolveConfirmEncrypt(
          localVarCount, projectName, selectedOrg.name, initBranch,
        );

        if (!confirmEncrypt) {
          console.log(`\nSkipped. Your .env was not modified.`);
          console.log(`Run ${B('capy')} again from the correct project directory, or run ${B('capy push')} when ready.`);
          return;
        }

        const syncSpinner = ora('Syncing local variables...').start();
        const syncResult = await this.pushAndEncryptLocalEnv(
          decryptedLocalEnv, encryptionKey, initBranch, keep, projectResult, authResult,
        );

        if (syncResult.ok) {
          syncSpinner.succeed(`keep.lock created (pinned to ${initBranch}, ${localVarCount} secrets)`);

          // Install git hooks
          this.installGitHooks();

          console.log(`\nYour .env is now encrypted. To run your app with decrypted secrets,`);
          console.log(`prefix your command with ${B('capy run')} (e.g. ${B('capy run -- npm start')}).`);
          console.log(`See: https://docs.capy.sc/using/running-your-app`);
          console.log(`\nRun ${B('capy push')} to share your secrets with teammates.`);
        } else {
          const syncError: any = syncResult.error;
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
   * Lists the org's existing (non-system) projects for the bootstrap-or-create
   * choice. "The lookup failed" and "this org has none" both surface as an
   * empty list to the caller, but `projectsUnavailable` says which — a network
   * or auth error must not be read as "you have no projects yet". Wraps the
   * extracted `listOrgProjectsOrUnavailable` (below) with THIS class's own
   * spinner/debug reporting — kept here rather than folded into the
   * extracted core so a caller with no spinner/debug concept of its own
   * (e.g. `dokploy.ts`'s discovery, which reuses the core directly) isn't
   * forced to carry them.
   */
  private async listExistingProjectsOrUnavailable(): Promise<{
    existingProjects: Array<{ id: string; name: string; organization_id: string }>;
    projectsUnavailable: boolean;
  }> {
    const listSpinner = ora('Looking for existing projects...').start();
    const result = await listOrgProjectsOrUnavailable(this.serviceClient, (err) => this.debugError('listProjects failed', err));
    if (!result.projectsUnavailable) {
      listSpinner.stop();
      this.debug('listProjects response', result.existingProjects);
    }
    return result;
  }

  /** Asks which existing project to bootstrap, or "new". */
  private async resolveProjectChoice(
    existingProjects: Array<{ id: string; name: string; organization_id: string }>,
    createNewProjectValue: string,
  ): Promise<string> {
    const { projectChoice } = await inquirer.prompt([initProjectQuestion(existingProjects, createNewProjectValue)]);
    return projectChoice;
  }

  /** Asks (via the prompt engine) for the new project's name. */
  private async resolveProjectName(defaultName: string): Promise<string> {
    return this.promptEngine.promptForProjectName(defaultName);
  }

  /** Asks whether the initial branch is 'development' or a custom name. */
  private async resolveInitialBranchChoice(): Promise<string> {
    const { initialBranchChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'initialBranchChoice',
      message: 'What branch should this project start with?',
      choices: [
        { name: 'development (default)', value: 'development' },
        { name: 'another branch', value: 'other' },
      ],
    }]);
    return initialBranchChoice;
  }

  /** Asks for the custom initial branch name. */
  private async resolveCustomBranchName(): Promise<string> {
    const { branchName } = await inquirer.prompt([{
      type: 'input',
      name: 'branchName',
      message: 'Branch name:',
      validate: (input: string) => input.trim().length > 0 || 'Branch name cannot be empty',
    }]);
    return String(branchName).trim();
  }

  /**
   * Cross-org exfiltration guard: any `.env` entry already shaped like an
   * encrypted value must decrypt with THIS project's key, or it was written
   * for a different project and must not be silently carried into this one.
   * Returns a new object — `localEnv` itself is never mutated — with every
   * such entry replaced by its decrypted plaintext. Throws when any entry fails
   * to decrypt.
   */
  private resolveDecryptedLocalEnv(
    localEnv: Readonly<Record<string, string>>,
    encryptionKey: string,
  ): Record<string, string> {
    const encryptedEntries = Object.entries(localEnv)
      .filter(([, value]) => value.startsWith('capy:'));
    if (encryptedEntries.length === 0) {
      return { ...localEnv };
    }

    const foreignKeys = encryptedEntries
      .filter(([, value]) => {
        try {
          this.fileManager.decryptValue(value, encryptionKey);
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);

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
    return {
      ...localEnv,
      ...Object.fromEntries(
        encryptedEntries.map(([key, value]) => [key, this.fileManager.decryptValue(value, encryptionKey)]),
      ),
    };
  }

  /** Asks to confirm encrypting + pushing the local .env. */
  private async resolveConfirmEncrypt(
    localVarCount: number,
    projectName: string,
    orgName: string,
    initBranch: string,
  ): Promise<boolean> {
    const { confirmEncrypt } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmEncrypt',
      message: `Encrypt these ${localVarCount} secrets and push to ${B(projectName)} (${orgName}) on ${B(initBranch)}?`,
      default: true,
    }]);
    return confirmEncrypt;
  }

  /**
   * Encrypts `localEnv`, pushes it to the newly created project, and rewrites
   * the local `.env` to ciphertext. Never throws: every checkpoint below
   * ("reached Keep" / "plaintext backed up" / ".env rewritten") is captured in
   * the RETURNED result exactly as far as execution got, since a caller that
   * swallows a mid-sync failure still has to report precisely which of those
   * three things happened before it did — a `let` mutated as each step
   * completes would say the same thing, but only by being reassigned; nesting
   * the failure branches says it by construction instead.
   */
  private async pushAndEncryptLocalEnv(
    localEnv: Readonly<Record<string, string>>,
    encryptionKey: string,
    initBranch: string,
    keep: KeepFile,
    projectResult: ProjectInitResult,
    authResult: AuthResult,
  ): Promise<
    | { ok: true }
    | { ok: false; error: unknown; pushedToKeep: boolean; backupWritten: boolean; envRewritten: boolean }
  > {
    try {
      const { createHash } = await import('crypto');
      const { deriveResourceId } = await import('../crypto/resourceId');
      const { Encryptor } = await import('../crypto/encryptor');

      // Derive the encrypted env blob and keep.lock hashes from localEnv —
      // built once as plain values, never mutated in place.
      const derivedEntries = Object.entries(localEnv).map(([key, value]) => {
        const resourceId = deriveResourceId(initBranch, key);
        return {
          key,
          envLine: `${key}=capy:${resourceId}:${Encryptor.encrypt(value, encryptionKey)}`,
          pushedVar: {
            resource_id: resourceId,
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          },
        };
      });
      const envBlob = derivedEntries.map((e) => e.envLine).join('\n');
      const pushedVars = Object.fromEntries(derivedEntries.map((e) => [e.key, e.pushedVar]));

      const updatedKeep = this.syncEngine.mergeWithKeep(keep, pushedVars, initBranch);
      const keepJson = JSON.stringify(updatedKeep);

      const initPushResult = await this.serviceClient.pushSecrets(
        projectResult.project_id,
        keepJson,
        envBlob,
        initBranch,
      );
      // pushedToKeep is true for every outcome from here down.

      try {
        // Prefer the server's copy — it carries server-assigned changed_at
        this.fileManager.writeKeepFile(
          SyncEngine.adoptServerKeep(initPushResult.keep_file, updatedKeep, initBranch),
        );

        // Cache encrypted blob locally
        const initKeepHash = SyncEngine.computeKeepHash(updatedKeep, initBranch);
        writeKeepCache(projectResult.org_id, projectResult.project_id, initKeepHash, envBlob);

        this.fileManager.writeSyncState({
          last_sync: new Date().toISOString(),
          synced_variables: Object.keys(localEnv),
          user_id: authResult.user_id,
          keep_hash: setSyncKeepHash(null, initBranch, initKeepHash),
        });
      } catch (error) {
        return { ok: false, error, pushedToKeep: true, backupWritten: false, envRewritten: false };
      }

      try {
        // Backup plaintext .env before encrypting
        this.fileManager.backupPlaintextEnv(this.options.envPath);
      } catch (error) {
        return { ok: false, error, pushedToKeep: true, backupWritten: false, envRewritten: false };
      }
      // backupWritten is true for every outcome from here down.

      try {
        // Encrypt the local .env file
        this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, undefined, updatedKeep, initBranch);
      } catch (error) {
        return { ok: false, error, pushedToKeep: true, backupWritten: true, envRewritten: false };
      }

      return { ok: true };
    } catch (error) {
      // Either building the blob/keep or the initial push itself failed —
      // nothing reached Keep.
      return { ok: false, error, pushedToKeep: false, backupWritten: false, envRewritten: false };
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
   * Install git hooks (post-checkout, post-merge) — see ../git/syncHooks.
   * No pre-push hook.
   */
  private installGitHooks(): void {
    try {
      const gitDir = execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      installSyncHooks(gitDir, this.devMode ? 'capy-dev' : 'capy');
    } catch {
      // Not a git repo or hooks dir inaccessible — silently skip
    }
  }

  /**
   * Clear local UX state after a CONFIRMED kick from the org.
   *
   * Implementation lives in `../cleanup/orgCleanup.ts` so `redeemCommand`
   * can use the same destructive logic on a confirmed-kick co-decrypt
   * failure. The gate predicate
   * (`../errors/membershipRevoked.ts:isMembershipRevokedError`) MUST be
   * checked at every call site before invoking — bare 403s (token-scope
   * mismatch, transient WorkOS, route-level rechecks, branch RBAC) must
   * leave local state intact.
   *
   * No method here — call sites import `cleanupOrgData` directly.
   */

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
      const blackBg: Record<number, Set<number>> = {
        1: new Set([3, 4, 10, 11]), // eyes (top 3/8 of ▅▅ pairs)
        4: new Set([6, 8]),         // mouth (top half of ▄ chars)
      };
      const nose: Record<number, Set<number>> = {
        3: new Set([7]),            // nose top (space → solid black █)
      };
      const furry = (s: string, row: number) => s.split('').map((ch, col) => {
        if (nose[row]?.has(col)) return `\x1b[38;2;0;0;0m█\x1b[0m`;
        if (ch === ' ') return ch;
        const v = Math.random() * 40 - 20; // ±20 variation
        const r = Math.round(150 + v);
        const g = Math.round(115 + v * 0.7);
        const b = Math.round(80 + v * 0.5);
        const bg = blackBg[row]?.has(col) ? '\x1b[48;2;0;0;0m' : '';
        return `${bg}\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
      }).join('');
      console.log(`${grey('\u2502')} ${left}${' '.repeat(leftPad)}${' '.repeat(gap)}${furry(right, i)}${' '.repeat(rightPad + 1)}${grey('\u2502')}`);
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

    // Local-only mode: no identity provider, no server. Identity is the fixed
    // synthetic local/local pair; the key is unwrapped from the passphrase
    // session. Everything below this point is shared with the server path,
    // gated by `localMode` at the few seams that would otherwise call out.
    const localMode = isLocalOnly();

    const { authResult, branch } = await (async (): Promise<{ authResult: AuthResult; branch: string }> => {
      if (localMode) {
        const localBranch = await this.resolveActiveBranch(projectState, true);
        this.displayHeader(
          projectState.projectName || 'local project',
          'local (this machine only)',
          'local',
          localBranch,
        );
        return { authResult: { success: true, user_id: LOCAL_USER_ID }, branch: localBranch };
      }

      // Load user-scoped session if we know who last synced this project
      if (projectState.userId) {
        this.authService.setSessionUserId(projectState.userId);
      }

      // Authenticate — try silent first, then interactive if needed.
      const spinner = ora('Authenticating...').start();
      const result = await (async (): Promise<AuthResult> => {
        const silent = await this.authService.authenticateSilent(projectState.organizationId);
        if (silent.success) return silent;

        // If silent auth failed, try without a specific org to use any valid session
        const silentAny = await this.authService.authenticateSilent();
        if (silentAny.success) return silentAny;

        // If still no session, fall through to interactive auth — except on
        // network failures: a browser round-trip can't fix an unreachable
        // service, and bouncing to OAuth there hides the real problem.
        const refreshFailure = this.authService.getLastRefreshFailure();
        if (refreshFailure?.reason === 'network') {
          spinner.fail('Could not reach the Capy service to refresh your session');
          throw new CapyError(
            `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
            ERROR_CODES.NETWORK_ERROR,
            { detail: refreshFailure.detail }
          );
        }
        if (refreshFailure?.reason === 'session_ended') {
          // Say why the browser is about to open instead of silently bouncing.
          spinner.text = 'Session expired — opening your browser to sign in again...';
        }
        return this.authService.authenticate(projectState.organizationId);
      })();

      this.debug('authResult', {
        success: result.success,
        user_id: result.user_id,
        organization_id: result.organization_id,
        _auth_method: result._auth_method,
        error: result.error,
      });

      if (!result.success) {
        spinner.fail('Authentication failed');
        throw new CapyError(
          result.error || 'Authentication failed',
          ERROR_CODES.AUTH_FAILED
        );
      }

      // Persist user ID to sync state immediately
      if (result.user_id) {
        this.projectManager.writeSyncStateUserId(result.user_id);
      }

      spinner.succeed(`Authenticated as ${result.user_email || result.user_first_name} (${result._auth_method || 'oauth'})`);

      // Branch resolution needs a token (server-assisted steps: branch list,
      // conflict validation, fresh-clone prompt) — so it runs post-auth.
      const resolvedBranch = await this.resolveActiveBranch(projectState, false);

      const orgName = result.organization_name
        || result.organizations?.find(o => o.id === result.organization_id)?.name
        || (result.organizations?.length === 0 ? 'not yet created' : result.organization_id)
        || 'not yet created';

      this.displayHeader(
        projectState.projectName || 'not yet created',
        orgName,
        result.user_first_name || result.user_email || '',
        resolvedBranch,
      );

      const token = this.authService.getToken();
      if (!token) {
        throw new CapyError(
          'You do not have access to this project\'s organization.\n\n' +
          'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
          ERROR_CODES.PERMISSION_DENIED
        );
      }
      return { authResult: result, branch: resolvedBranch };
    })();

    const encryptionKey = await (async (): Promise<string> => {
      try {
        return localMode
          ? await resolveLocalProjectKey(projectState.projectId!)
          : await resolveProjectKey(
              projectState.organizationId!,
              projectState.projectId!,
              authResult.user_id!,
              this.keyServiceOps(),
            );
      } catch (err: any) {
        // Confirmed kick → destructive local cleanup (wraps key, user dir,
        // project caches, keep.lock). Any other error path — bare 403,
        // network blip, etc. — leaves local state untouched. The single
        // gate predicate lives in errors/membershipRevoked.ts. Never runs in
        // local mode (no server, no membership).
        if (!localMode && isMembershipRevokedError(err)) {
          cleanupOrgData(projectState.organizationId!, projectState.userId);
        }
        throw err;
      }
    })();

    // Read keep.lock. The file is git-owned (CAP-303): the fetch below never
    // rewrites an existing keep.lock — `currentKeep` (returned by the fetch
    // IIFE below) only differs from this initial read in the bootstrap case
    // (no local file → reconstructed from the server, where `pinned` is
    // empty anyway) — and the diff table always reflects what was actually
    // pinned on this machine.
    const initialKeep = this.projectManager.readKeepFile();
    this.debug('keep.lock', initialKeep ? {
      version: initialKeep.version,
      org_id: initialKeep.org_id,
      project_id: initialKeep.project_id,
      variableCount: Object.keys(initialKeep.variables).length,
      variables: Object.keys(initialKeep.variables),
    } : 'NOT FOUND');

    const rebuildPinned = (keep: KeepFile | null): Record<string, string> =>
      Object.fromEntries(
        Object.entries(keep?.variables ?? {})
          .map(([varName, entries]) => [varName, entries.find(e => e.branch === branch)?.value_hash])
          .filter((pair): pair is [string, string] => pair[1] !== undefined),
      );
    const pinned = rebuildPinned(initialKeep);
    this.debug('pinned', pinned);

    // Read local .env and compute hashes. A read/decrypt failure that isn't a
    // typed CapyError is swallowed (debug-logged only) exactly as before —
    // in every case that can actually happen, nothing had been accumulated
    // yet when it's thrown, so falling back to empty objects is the same
    // partial state the old `for` loop's mutation would have left behind.
    const { localPlaintext, localHashes } = ((): {
      localPlaintext: Record<string, string>;
      localHashes: Record<string, string>;
    } => {
      try {
        const rawLocal = this.fileManager.readEnvFile(this.options.envPath);
        this.debug('.env keys', Object.keys(rawLocal));
        const plaintext = Object.fromEntries(
          Object.entries(rawLocal).map(([key, value]) => [
            key,
            value.startsWith('capy:') ? this.decryptLocalEnvValueForSync(key, value, encryptionKey) : value,
          ]),
        );
        const hashes = Object.fromEntries(
          Object.entries(plaintext).map(([key, value]) => [key, hashValue(value)]),
        );
        this.debug('local hashes', hashes);
        return { localPlaintext: plaintext, localHashes: hashes };
      } catch (error: any) {
        if (error instanceof CapyError) throw error;
        this.debugError('.env read failed', error);
        return { localPlaintext: {}, localHashes: {} };
      }
    })();

    // Fetch remote secrets. In local-only mode there is no remote — skip the
    // fetch entirely and reuse the existing offline path (networkAvailable
    // false → empty remote → pinned-vs-local comparison only). Returns
    // `currentKeep` (bootstrapped from the server when there was no local
    // file at all — see the comment above `initialKeep`) rather than
    // reassigning it, and `networkAvailable`/`remotePlaintext`/`remoteHashes`
    // likewise, in place of the `let`s and in-loop mutation this used to be.
    const { currentKeep, networkAvailable, remotePlaintext, remoteHashes } = await (async (): Promise<{
      currentKeep: KeepFile | null;
      networkAvailable: boolean;
      remotePlaintext: Record<string, string>;
      remoteHashes: Record<string, string>;
    }> => {
      const remotePlaintext: Record<string, string> = {};
      const remoteHashes: Record<string, string> = {};
      if (localMode) {
        return { currentKeep: initialKeep, networkAvailable: false, remotePlaintext, remoteHashes };
      }

      const fetchSpinner = ora('Fetching remote secrets...').start();
      try {
        // Always ask for the latest remote blob for this branch (no keep_hash).
        // The server returns the env_blob AND the latest keep.json — used only
        // to bootstrap a missing keep.lock (never to rewrite an existing one).
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

        // Bootstrap only (CAP-303): an existing keep.lock is git-owned and is
        // never overwritten outside an explicit user action — the old silent
        // "self-heal" adopted whatever the last pusher's file looked like and
        // could erase branches the pusher didn't have. Reconstruction from the
        // server is only legitimate when there is no local file at all.
        const bootstrappedKeep = ((): KeepFile | null => {
          if (!decryptData.keep_file || initialKeep) return initialKeep;
          const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
          this.debug('bootstrap: no local keep.lock, reconstructing from server');
          this.fileManager.writeKeepFile(serverKeep);
          return serverKeep;
        })();
        fetchSpinner.stop();
        return { currentKeep: bootstrappedKeep, networkAvailable: true, remotePlaintext, remoteHashes };
      } catch (err: any) {
        this.debugError('remote fetch failed', err);
        // 403 may be one of two different cases:
        //   (a) User was kicked from the org — confirmed by an explicit
        //       `code: 'MEMBERSHIP_REVOKED'` from the server. Destructive
        //       cleanup runs (key.enc, user dir, project caches, keep.lock).
        //   (b) Anything else — branch-level denial, WorkOS hiccup, token-scope
        //       mismatch, route-handler 403. DO NOT cleanup. The wrapped M and
        //       all other local state stay intact; the user can retry.
        if (err instanceof CapyError) {
          const status = err.details?.status;
          if (status === 403) {
            if (isMembershipRevokedError(err)) {
              fetchSpinner.fail('Access denied — you have been removed from this organization.');
              cleanupOrgData(projectState.organizationId!, projectState.userId);
              throw err;
            }
            // Branch-level denial: user is still in the org, just can't read THIS branch.
            // This is the demotion scenario — the user may have been a Project Admin
            // with access to a protected branch, then downgraded to Member. Try to
            // suggest an accessible alternative before throwing.
            fetchSpinner.fail(`No access to branch "${branch}" — your role does not permit reading this branch.`);
            try {
              const branches = await this.serviceClient.listBranches(projectState.projectId!);
              const candidates = branches.filter(b => !b.is_protected);
              if (candidates.length > 0) {
                const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
                console.log('\nBranches you can switch to:');
                for (const b of candidates) {
                  console.log(`  ${B(b.name)}`);
                }
                const suggested = candidates[0].name;
                console.log(`\nRun ${B(`capy checkout ${suggested || ''}`)} to switch.`);
              }
            } catch (listErr) {
              this.debugError('listBranches failed during 403 recovery', listErr);
            }
            throw err;
          }
          if (status === 401) {
            fetchSpinner.fail(err.message);
            throw err;
          }
        }
        fetchSpinner.fail('Cannot reach remote. Showing local changes only.');
        return { currentKeep: initialKeep, networkAvailable: false, remotePlaintext, remoteHashes };
      }
    })();

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
    const isOnboarding = ((): boolean => {
      if (Object.keys(localHashes).length !== 0 || Object.keys(remotePlaintext).length === 0) return false;
      const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
      return !(envMeta.org_id === projectState.organizationId && envMeta.project_id === projectState.projectId);
    })();

    // Hide local column for onboarding — it's all "-" and adds noise
    const effectiveShowLocal = isOnboarding ? false : showLocal;

    // Resolve pinned plaintext for display. Try local first (a pinned
    // variable whose local value already matches), then fetch from S3 for
    // anything that doesn't — `needsFetch` derived from the same predicate
    // rather than a `let` flipped inside the loop that built `localMatches`.
    const localMatches: Record<string, string> = Object.fromEntries(
      Object.keys(pinned)
        // Presence is `!== undefined`: '' is a valid pinned value, and a
        // falsy check forces a remote fetch on every sync for empty variables.
        .filter((variable) => localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinned[variable])
        .map((variable) => [variable, localPlaintext[variable]]),
    );
    const needsFetch = Object.keys(pinned).some(
      (variable) => !(localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinned[variable]),
    );
    const pinnedPlaintext: Record<string, string> =
      needsFetch && currentKeep && Object.keys(pinned).length > 0
        ? await (async (): Promise<Record<string, string>> => {
            try {
              const keepHash = SyncEngine.computeKeepHash(currentKeep, branch);
              const blob = localMode
                ? readSecretsLocal(projectState.organizationId!, projectState.projectId!, keepHash)
                : await fetchSecretsWithCache(
                    this.serviceClient,
                    projectState.organizationId!,
                    projectState.projectId!,
                    keepHash,
                  );
              if (!blob?.env_file) return localMatches;
              const encrypted = this.fileManager.parseEnvContent(blob.env_file);
              const fetched = Object.fromEntries(
                Object.entries(encrypted)
                  .filter(([key]) => pinned[key] && localMatches[key] === undefined)
                  .flatMap(([key, value]) => {
                    try {
                      return [[key, this.fileManager.decryptValue(value, encryptionKey)]] as const;
                    } catch (decryptErr) {
                      this.debugError(`pinned decrypt failed for ${key}`, decryptErr);
                      return [];
                    }
                  }),
              );
              return { ...localMatches, ...fetched };
            } catch (err) {
              this.debugError('pinned fetch failed', err);
              return localMatches;
            }
          })()
        : localMatches;

    const DIM = '\x1b[90m';
    const RST = '\x1b[0m';

    console.log(`  You have unsynced environment variables (${diffs.length} difference${diffs.length !== 1 ? 's' : ''} found).\n`);

    // Display comparison table.
    this.displayComparisonTable(diffs, effectiveShowLocal, showRemote, pinned, localHashes, remoteHashes, localPlaintext, remotePlaintext, pinnedPlaintext);
    console.log(`\n  ${DIM}← → select value   ↑ ↓ move between rows   Enter confirm   q cancel${RST}\n`);

    // Build menu options based on what columns are visible
    const hasPinned = Object.keys(pinned).length > 0;

    // Direction detection: compare sync-state keep_hash to current keep.lock
    const syncState = this.projectManager.readSyncState();
    const currentKeepHash = currentKeep ? SyncEngine.computeKeepHash(currentKeep, branch) : null;
    const savedHash = getSyncKeepHash(syncState, branch);
    const isBehind = savedHash != null
      && currentKeepHash != null
      && savedHash !== currentKeepHash;

    type MenuChoice = { name: string; value: string };
    const stateMenuChoices: MenuChoice[] = ((): MenuChoice[] => {
      if (isOnboarding) {
        // Onboarding: local .env is empty/foreign — only offer retrieve options
        return showRemote
          ? [
              { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
              { name: 'Retrieve all remote values', value: 'retrieve_remote' },
            ]
          : [{ name: 'Retrieve all pinned values', value: 'retrieve_pinned' }];
      }
      if (!hasPinned) {
        // State 6: No pinned values — only offer commit or skip
        return [{ name: 'Commit and push all local values', value: 'commit_local' }];
      }
      if (!hasRemote) {
        // State 5: No remote values — local vs pinned only
        return [
          { name: 'Commit and push all local values', value: 'commit_local' },
          { name: 'Individually resolve', value: 'individual' },
        ];
      }
      if (showLocal && !showRemote) {
        // State 2: Local differs from pinned, remote matches pinned
        return [
          ...(isBehind
            ? [
                // 2b: keep.lock changed via git pull → user is behind
                { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
                { name: 'Commit and push all local values', value: 'commit_local' },
              ]
            : [
                // 2a: user edited .env locally → user is ahead
                { name: 'Commit and push all local values', value: 'commit_local' },
                { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
              ]),
          { name: 'Individually resolve', value: 'individual' },
        ];
      }
      if (!showLocal && showRemote) {
        // State 3: Remote differs from pinned, local matches pinned
        return [
          { name: 'Retrieve all remote values', value: 'retrieve_remote' },
          { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
          { name: 'Individually resolve', value: 'individual' },
        ];
      }
      // State 4: Both differ
      return [
        ...(isBehind
          ? [
              // 4b: keep.lock changed + another push happened → retrieve remote first
              { name: 'Retrieve all remote values', value: 'retrieve_remote' },
              { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
              { name: 'Commit and push all local values', value: 'commit_local' },
            ]
          : [
              // 4a: user edited .env + teammate pushed
              { name: 'Commit and push all local values', value: 'commit_local' },
              { name: 'Retrieve all pinned values', value: 'retrieve_pinned' },
              { name: 'Retrieve all remote values', value: 'retrieve_remote' },
            ]),
        { name: 'Individually resolve', value: 'individual' },
      ];
    })();

    // In local-only mode there is no remote, so "push" is misleading — build
    // a new array with that one choice's label swapped, rather than mutating
    // each choice object in place.
    const menuChoices: MenuChoice[] = [...stateMenuChoices, { name: 'Continue working', value: 'skip' }].map((c) =>
      localMode && c.value === 'commit_local' ? { ...c, name: 'Commit all local values' } : c,
    );
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: menuChoices,
    }]) as { action: string };

    // Apply the chosen action. An `abort`-or-`proceed` result stands in for
    // `let finalEnv` plus a bare `return` from two of its branches
    // (a failed pinned-fetch, a cancelled individual resolution).
    const finalEnvDecision = await (async (): Promise<
      | { kind: 'abort' }
      | { kind: 'proceed'; finalEnv: Record<string, string> }
    > => {
      if (action === 'retrieve_pinned') {
        // Fetch the pinned snapshot — the one displayed in the Pinned column of
        // the diff table. currentKeep is exactly what keep.lock pins (the fetch
        // never rewrites it), and the snapshot is still in S3 because env blobs
        // are content-addressed and immutable.
        if (!(currentKeep && Object.keys(pinned).length > 0)) {
          return { kind: 'proceed', finalEnv: { ...localPlaintext } };
        }
        const keepHash = SyncEngine.computeKeepHash(currentKeep, branch);
        try {
          const blob = localMode
            ? readSecretsLocal(projectState.organizationId!, projectState.projectId!, keepHash)
            : await fetchSecretsWithCache(
                this.serviceClient,
                projectState.organizationId!,
                projectState.projectId!,
                keepHash,
              );
          if (!blob?.env_file) {
            return { kind: 'proceed', finalEnv: { ...localPlaintext } };
          }
          const encrypted = this.fileManager.parseEnvContent(blob.env_file);
          const fetchedEnv = Object.fromEntries(
            Object.entries(encrypted).flatMap(([key, value]) => {
              try {
                return [[key, this.fileManager.decryptValue(value, encryptionKey)]] as const;
              } catch (decryptErr) {
                this.debugError(`retrieve_pinned decrypt failed for ${key}`, decryptErr);
                return [];
              }
            }),
          );
          return { kind: 'proceed', finalEnv: fetchedEnv };
        } catch (err) {
          this.debugError('retrieve_pinned fetch failed', err);
          console.log('Could not fetch pinned values from remote.');
          return { kind: 'abort' };
        }
      }
      if (action === 'retrieve_remote') {
        return { kind: 'proceed', finalEnv: { ...remotePlaintext } };
      }
      if (action === 'commit_local') {
        return { kind: 'proceed', finalEnv: { ...localPlaintext } };
      }
      if (action === 'skip') {
        return { kind: 'abort' };
      }
      // Individual resolution.
      const resolved = await this.resolveIndividually(diffs, showLocal, showRemote, pinned, localPlaintext, remotePlaintext, pinnedPlaintext);
      if (!resolved) return { kind: 'abort' }; // Cancelled
      return { kind: 'proceed', finalEnv: resolved };
    })();

    if (finalEnvDecision.kind === 'abort') return;
    const { finalEnv } = finalEnvDecision;

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

    const pushedVars = Object.fromEntries(
      Object.entries(finalEnv).map(([key, value]) => [
        key,
        {
          resource_id: deriveResourceId(branch, key),
          value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
        },
      ]),
    );

    const mergedKeep = this.syncEngine.mergeWithKeep(keep, pushedVars, branch);

    // Remove variables not in finalEnv from keep (for this branch) — built as
    // a new object rather than mutated in place (was a `for` loop doing
    // `finalKeep.variables[varName] = entries` / `delete
    // finalKeep.variables[varName]` on the value mergeWithKeep returned).
    const finalKeep: KeepFile = {
      ...mergedKeep,
      variables: Object.fromEntries(
        Object.entries(mergedKeep.variables).flatMap(([varName, entries]) => {
          if (varName in finalEnv) return [[varName, entries]];
          const kept = entries.filter(e => e.branch !== branch);
          return kept.length > 0 ? [[varName, kept]] : [];
        }),
      ),
    };

    this.fileManager.writeKeepFile(finalKeep);

    // Build the encrypted env blob (used for both push and local cache).
    const { Encryptor } = await import('../crypto/encryptor');
    const cacheKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
    const envBlob = Object.entries(finalEnv)
      .map(([k, v]) => {
        const resourceId = deriveResourceId(branch, k);
        const enc = Encryptor.encrypt(v, encryptionKey);
        return `${k}=capy:${resourceId}:${enc}`;
      })
      .join('\n');

    // Commit + push are coupled: choosing "commit local" pushes too — except
    // in local-only mode, where there is no remote. The local writes below
    // (keep cache, encrypted .env, sync-state) ARE the commit.
    if (action === 'commit_local' && !localMode) {
      const pushResult = await this.serviceClient.pushSecrets(
        projectState.projectId!,
        JSON.stringify(finalKeep),
        envBlob,
        branch,
      );
      // Re-write keep.lock with the server's copy — it carries the
      // server-assigned changed_at timestamps for this push.
      this.fileManager.writeKeepFile(SyncEngine.adoptServerKeep(pushResult.keep_file, finalKeep, branch));
    }

    writeKeepCache(projectState.organizationId!, projectState.projectId!, cacheKeepHash, envBlob);

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
      console.log(
        localMode
          ? `\nStored ${changeCount} change(s) locally (local-only mode).`
          : `\nPushed ${changeCount} change(s) to Keep.`,
      );
    }

    // Install hooks on every run (idempotent)
    this.installGitHooks();
  }

  /**
   * Decrypt one `.env` value during `syncProject`'s local read — wrapped so
   * the caller can use it in a ternary rather than a `let plaintext = value`
   * reassigned inside a conditional try/catch.
   */
  private decryptLocalEnvValueForSync(key: string, value: string, encryptionKey: string): string {
    try {
      return this.fileManager.decryptValue(value, encryptionKey);
    } catch (decryptErr) {
      this.debugError(`decrypt failed for ${key}`, decryptErr);
      throw new CapyError(
        `"${key}" is encrypted with a different project's key and cannot be used in this project.`,
        ERROR_CODES.PERMISSION_DENIED,
        { variable: key }
      );
    }
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
    type ColumnKey = import('../ui/resolveTable').ColumnKey;

    // A pinned value is only usable if it resolves back to a concrete plaintext
    // (some local or remote value hashes to the pinned hash). Mirrors the
    // resolution logic below where 'pinned' is applied.
    const pinnedResolves = (variable: string): boolean => {
      const pinnedHash = pinned[variable];
      if (!pinnedHash) return false;
      return (
        (localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinnedHash) ||
        (remotePlaintext[variable] !== undefined && hashValue(remotePlaintext[variable]) === pinnedHash)
      );
    };

    // Sensible per-row default: keep the pinned (last-agreed) value when it's
    // resolvable — the safe choice for a genuine conflict — otherwise fall back
    // to a concrete value that won't drop the secret (local, then remote).
    const defaults: ColumnKey[] = diffs.map(diff => {
      if (pinnedResolves(diff.variable)) return 'pinned';
      if (showLocal && localPlaintext[diff.variable] !== undefined) return 'local';
      if (showRemote && remotePlaintext[diff.variable] !== undefined) return 'remote';
      return 'pinned';
    });

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

    const table = new ResolveTable(rows, showLocal, showRemote, defaults);
    const { choices, outcome } = await table.run();

    if (outcome === 'needs-input') {
      // A conflict is the one thing in a sync that Capy cannot answer for you:
      // both sides changed, and which one survives is a fact only the person
      // who made the changes holds. Off a TTY this used to apply the defaults
      // and carry on — a resolution written and reported as consent with
      // nobody in the room. Exit 3 so a caller can tell "I need a human or a
      // browser" apart from "this failed, retry".
      const { refuseNonInteractive } = await import('../ui/interactive');
      refuseNonInteractive(
        `${diffs.length} ${diffs.length === 1 ? 'variable has' : 'variables have'} changed on both sides and need a decision`,
        'Run `capy` in a terminal.', // COPY-FLAG
      );
    }

    if (outcome === 'cancelled') {
      return null;
    }

    return this.mapResolveChoicesToEnv(choices, diffs, pinned, localPlaintext, remotePlaintext, pinnedPlaintext);
  }

  /**
   * Map a per-variable resolve choice set ('pinned'|'local'|'remote'|'delete')
   * to the final plaintext env. Variables not in `diffs` (unchanged) are
   * carried over from local.
   */
  private mapResolveChoicesToEnv(
    choices: Record<string, 'pinned' | 'local' | 'remote' | 'delete'>,
    diffs: { variable: string }[],
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
    pinnedPlaintext: Record<string, string> = {},
  ): Record<string, string> {
    const chosenValue = (variable: string, choice: 'pinned' | 'local' | 'remote' | 'delete'): string | undefined => {
      if (choice === 'pinned') {
        const pinnedHash = pinned[variable];
        // Prefer the resolved pinned plaintext (from the keep cache / remote
        // fetch). Without it, "pinned" could only be reconstructed when the
        // pinned value happened to equal local or remote — so in local-only
        // mode, choosing "pinned" for a locally-EDITED var matched nothing and
        // the keep.lock cleanup then silently DELETED the variable. The cache
        // holds the baseline, so consult it first.
        // `!== undefined` throughout: '' is a valid pinned value.
        if (pinnedPlaintext[variable] !== undefined) return pinnedPlaintext[variable];
        if (localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinnedHash) {
          return localPlaintext[variable];
        }
        if (remotePlaintext[variable] !== undefined && hashValue(remotePlaintext[variable]) === pinnedHash) {
          return remotePlaintext[variable];
        }
        return undefined;
      }
      if (choice === 'local') return localPlaintext[variable];
      if (choice === 'remote') return remotePlaintext[variable];
      return undefined; // 'delete' — don't add to result
    };

    const chosen: Record<string, string> = Object.fromEntries(
      Object.entries(choices).flatMap(([variable, choice]) => {
        const value = chosenValue(variable, choice);
        return value === undefined ? [] : [[variable, value] as const];
      }),
    );

    // Add unchanged variables from local
    const unchanged: Record<string, string> = Object.fromEntries(
      Object.entries(localPlaintext).filter(
        ([key]) => !(key in chosen) && !diffs.some(d => d.variable === key),
      ),
    );

    return { ...chosen, ...unchanged };
  }

  private async createNewOrganization(refreshToken: string, userId: string): Promise<Organization> {
    const { createNewOrganization } = await import('./orgCreation');
    return createNewOrganization(this.authService, this.serviceClient, refreshToken, userId);
  }
}
