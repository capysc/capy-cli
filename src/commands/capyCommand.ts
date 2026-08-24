import ora from '../ui/spinner';
import { human } from '../ui/webMode';
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
  CapyError,
  ERROR_CODES,
  getSyncKeepHash,
  setSyncKeepHash,
} from '../types/index';
import { validateSeedPhrase } from '../crypto/keyManager';
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
import { shouldAttemptMint } from '../auth/masterKeyMint';
import { writeKeepCache, fetchSecretsWithCache, readSecretsLocal, LOCAL_ORG_ID, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { compareSecrets, hashValue, formatSnippet } from './statusCommand';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import {
  attemptCaseCUnlock,
  runPendingSyncBestEffort,
  syncOrgOntoDeviceKeyIfEnrolled,
  maybeNudgeDeviceKeyEnrollment,
  DeviceKeyWiringContext,
} from '../auth/deviceKey/wiring';
import type { DeviceKeyEnrollmentOptions } from './orgCreation';

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

    // No .env header and no .capy/branch — but keep.lock pins a branch for
    // every variable it tracks, and a fresh clone HAS keep.lock (it is
    // committed; only .env is gitignored). Consulting it here is what keeps a
    // second device off the interactive branch picker, which under a
    // broker-ceremony/--json run has no TTY to answer it: the flow would hang
    // or refuse on a question already answered by a committed file.
    // Only an unambiguous pin counts — a keep.lock spanning several branches
    // is a real choice and still belongs to the human.
    const pinned = branchesFromKeep(this.projectManager.readKeepFile());
    if (pinned.length === 1) {
      this.projectManager.writeActiveBranch(pinned[0]);
      return pinned[0];
    }

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
        // CAP-451: a broker-ceremony run has no TTY and no local browser —
        // picking a branch is a human-only stop. Refuse before binding a
        // loopback server or printing anything, same as every other
        // wizard stop under noWizardStops.
        if (this.noWizardStops) {
          this.refuseWizardStop();
        }
        const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
        human('\nNo branch is checked out in this directory yet.');
        if (this.options.web) {
          // The compiled branch list, which is the same listing `capy checkout`
          // serves. It marks protection off `is_protected` — the terminal
          // picker prints `(protected)` and then lets a 403 explain — and the
          // rows come from the server, so a name that is not one of them did
          // not come from this page.
          //
          // No row opens selected: this directory is on no branch, so there is
          // nothing for the list to open on, and the CLI's `defaultName`
          // preselection has no field on that screen to land in.
          const { chooseBranchInBrowser } = await import('../ui/branchScreens');
          const { branch: chosen, cancelled } = await chooseBranchInBrowser({
            projectName: projectState.projectName || 'project',
            activeBranch: null,
            branches,
            canDelete: false,
            // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI /
            // headless verification drive the loopback without hijacking one.
            open: !process.env.CAPY_WEB_NO_OPEN,
          });
          if (cancelled) {
            throw new CapyError('Branch selection cancelled', ERROR_CODES.AUTH_FAILED);
          }
          return chosen;
        }
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
      human(`Ignoring stale .capy/branch (${B(fileBranch)} is not a branch in this project); staying on ${B(envBranch)}.`);
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
  }

  /**
   * First run in this directory.
   *
   * Under `--web` the six questions below are stops on ONE declared route,
   * served into one browser window by `InitWizardSession`. The window is opened
   * by the first question and released here — on the way out, or on the way out
   * through a failure, so a run that dies between two stops does not leave a
   * page claiming to still be working on it.
   */
  /**
   * First-run initialization, as a public entry point for the flow driver's
   * `write_keep_lock(select_or_create)` executor (src/flows/onboard/executors).
   *
   * Deliberately the SAME method the ordinary `capy` path calls — the flow
   * layer sequences the CLI's existing actuators, it does not re-implement
   * them. `assumeEncryptConsent` is threaded through for the one question the
   * flow has already asked in its own consent dialog; everything else behaves
   * identically.
   */
  async initializeProjectForFlow(
    opts: {
      assumeEncryptConsent?: boolean;
      /**
       * Called the instant a project is chosen or created — BEFORE the intake
       * that follows it. The flow records the ids there and then, so a run that
       * dies between "project created" and "keep.lock written" still leaves the
       * id pinned and the retry adopts it instead of creating a second project.
       */
      onProjectResolved?: (ids: { org_id: string; project_id: string; branch?: string }) => void;
      /**
       * CAP-451: the org the flow instance already pinned (from the
       * `authenticate` step's own result, or an earlier `select_organization`
       * screen). When set, the org picker this wizard-less path would
       * otherwise show is skipped entirely — the ORG resolution below runs
       * exactly as if that id had been chosen.
       */
      pinnedOrgId?: string;
      /**
       * CAP-451: the project name the plan dialog already carried
       * (`write_keep_lock`'s optional `project_name` param, or `capy onboard
       * --project-name`). When set, the project-name prompt is skipped.
       */
      projectName?: string;
      /**
       * CAP-451: true ONLY under `capy onboard --broker-ceremony` — a
       * sandboxed caller with no browser and no TTY to prompt in. Any
       * human-only stop (org picker, project picker, project-name prompt)
       * NOT already resolved by pinnedOrgId/projectName above is refused
       * (FLOW_STOP_UNREACHABLE) instead of falling through to inquirer,
       * which would hang that process forever.
       *
       * Left false (the default) for every other flow-driven call —
       * notably a plain, interactive `capy onboard` at a real terminal
       * (auth_mode interactive_oauth, no --web): that run has a real TTY,
       * so it keeps the SAME inquirer prompts the wizard-less path has
       * always shown, byte-identical to before pinnedOrgId/projectName/this
       * flag existed. A `--web` run is unaffected either way — the `wizard`
       * check above always wins when one is present.
       */
      noWizardStops?: boolean;
    } = {},
  ): Promise<void> {
    this.assumeEncryptConsent = opts.assumeEncryptConsent === true;
    this.onProjectResolved = opts.onProjectResolved;
    this.pinnedOrgId = opts.pinnedOrgId;
    this.flowProjectName = opts.projectName;
    this.noWizardStops = opts.noWizardStops === true;
    try {
      await this.initializeProject();
    } finally {
      this.assumeEncryptConsent = false;
      this.onProjectResolved = undefined;
      this.pinnedOrgId = undefined;
      this.flowProjectName = undefined;
      this.noWizardStops = false;
    }
  }

  /**
   * The ordinary sync, as an entry point for the flow driver's `encrypt_env`
   * executor — with one difference that matters: it THROWS.
   *
   * `execute()` ends its catch in `displayErrorAndExit`, which calls
   * process.exit. Under the driver that would kill the run instead of returning
   * a failed outcome with a code, and the flow layer's whole contract is that a
   * step reports what happened rather than ending the process.
   */
  async syncForFlow(): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      const envMeta = this.fileManager.readEnvMeta(this.options.envPath);
      if (!envMeta.org_id || !envMeta.project_id) {
        throw new CapyError('No keep.lock in this directory', ERROR_CODES.NO_KEEP_FILE);
      }
      projectState.initialized = true;
      projectState.organizationId = envMeta.org_id;
      projectState.projectId = envMeta.project_id;
      projectState.activeBranch = envMeta.branch ?? null;
    }
    await this.syncProject(projectState);
  }

  /**
   * Adopt an existing project into this directory, as a public entry point for
   * the flow driver's `write_keep_lock(env_header)` executor. Same method the
   * ordinary path uses when the user picks an existing project.
   */
  async bootstrapProjectForFlow(
    project: { id: string; name: string; organization_id: string },
    orgId: string,
    userId: string,
  ): Promise<void> {
    await this.bootstrapExistingProject(project, orgId, userId);
  }

  /** Set for the duration of a flow-driven init: the plan dialog already carried this question. */
  private assumeEncryptConsent = false;
  /** Set for the duration of a flow-driven init — see initializeProjectForFlow. */
  private onProjectResolved?: (ids: { org_id: string; project_id: string; branch?: string }) => void;
  /** CAP-451: skips the org picker when set — see initializeProjectForFlow. */
  private pinnedOrgId?: string;
  /** CAP-451: skips the project-name prompt when set — see initializeProjectForFlow. */
  private flowProjectName?: string;
  /**
   * CAP-451: true ONLY under `capy onboard --broker-ceremony` — see
   * initializeProjectForFlow's own doc on this option. A plain flow-driven
   * `capy onboard` at a real terminal, and any `--web` run, leave this
   * false and keep their existing prompts.
   */
  private noWizardStops = false;

  /**
   * A broker-ceremony run has no TTY and no browser to prompt in — reaching
   * a stop only a human can answer (org picker, org-create wizard, project
   * picker, project-name prompt) would otherwise fall through to
   * `inquirer.prompt`, which hangs that non-interactive process forever.
   * Refused instead, with a code the flow layer's driver reports upward
   * like any other step outcome — never `openScreen`/inquirer under
   * `--broker-ceremony`. Only ever called when `this.noWizardStops` is
   * true — see that field's own doc for why a plain TTY `capy onboard`
   * never reaches this.
   */
  private refuseWizardStop(): never {
    throw new CapyError(
      'This step needs a human decision the flow cannot make for it here.',
      ERROR_CODES.FLOW_STOP_UNREACHABLE,
    );
  }

  private async initializeProject(): Promise<void> {
    // Imported only on the `--web` path: the module pulls in every compiled
    // screen, and a terminal run has no use for them.
    //
    // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI / headless
    // verification drive the loopback without hijacking a real browser.
    //
    // CAP-451: `noWizardStops` (only ever true under `capy onboard
    // --broker-ceremony`) wins over `--web` here — a broker-ceremony caller
    // is agent-driven with no LOCAL browser to send to, even when `--web`
    // was also passed (the MCP path always used to imply loopback before
    // this flag existed). No wizard is constructed at all in that case, so
    // no loopback server is ever bound and no handoff URL is ever printed —
    // every `if (wizard)` stop below simply has nothing to check.
    const wizard = this.options.web && !this.noWizardStops
      ? new (await import('../ui/initWizardScreen')).InitWizardSession({
          open: !process.env.CAPY_WEB_NO_OPEN,
        })
      : null;
    try {
      await this.runInitialization(wizard);
      await wizard?.finish();
    } catch (err) {
      // The browser is holding a submit at this point, and it must not be told
      // that submit worked. `abort` replaces the question with what stopped
      // the run — carrying the error's CODE, and the remedy any call site that
      // knew one declared with `willBlock` just before it threw.
      await wizard?.abort(err);
      throw err;
    }
  }

  private async runInitialization(
    wizard: import('../ui/initWizardScreen').InitWizardSession | null,
  ): Promise<void> {
    this.debug('initializeProject start', { cwd: process.cwd() });
    human('Welcome to Capy\n');

    // Check if sync-state has an org hint (e.g. from a recent `capy redeem`)
    const syncState = this.projectManager.readSyncState();
    // CAP-451: the flow's own pinned org — settled moments ago by the
    // sandbox-session ceremony (create_org/select_org/unlock) or a
    // `select_organization` screen — wins over sync-state's org hint. Sync
    // state is written for the SAME org in the ordinary case, but relying on
    // it alone leaves a window (a org created THIS run, on a machine with a
    // stale/ambiguous sync-state left from something else) where
    // authenticate(undefined) would resolve organizations[0] instead of the
    // org this process is actually supposed to be scoped to.
    const orgHint = this.pinnedOrgId ?? syncState?.org_id;

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

    // The first stop is settled before anything opens: the browser is only
    // reached once there is a session, so `auth` is drawn done from the start.
    wizard?.record({
      signedInAs: authResult.user_email || authResult.user_first_name || undefined,
      orgCount: authResult.organizations?.length ?? 0,
    });

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
    let selectedOrg: Organization;
    const CREATE_NEW_ORG = '__create_new__';
    const refreshToken = authResult._refresh_token || this.authService.getToken()?.refresh_token;

    const currentOrgId = authResult.organization_id;
    const currentOrg = orgs.find(o => o.id === currentOrgId);

    if (orgs.length === 0) {
      // CAP-451: a zero-org identity under `--broker-ceremony` hits this
      // branch just as often as the org-picker branch below does (a fresh
      // account with nothing to pick from at all), and it is the SAME class
      // of human-only stop `refuseWizardStop`'s own doc already names ("an
      // org-create wizard"). This branch used to call `createNewOrganization`
      // unconditionally — no gate — which is exactly what let a sandboxed
      // caller with no browser fall into the org-create wizard's loopback
      // server (`this.options.web` was still true from the outer `--web`
      // flag, `noWizardStops` notwithstanding). Checked BEFORE anything else
      // in this branch, same as the `pinnedOrgId`-then-`noWizardStops`-then-
      // `wizard` order below.
      if (this.noWizardStops) {
        this.refuseWizardStop();
      }
      human('\nNo organization found. Let\'s create one.');
      // CAP-382 Case A: a genuinely zero-org identity's exchange carries the
      // Wave-B org-less token — flag-gated, and a no-op (org creation is
      // byte-identical) when the flag is off or no such token was captured.
      const deviceKeyEnrollment = deviceKeysEnabled()
        ? {
            ctx: this.deviceKeyWiringContext(authResult, undefined),
            orglessToken: authResult._orgless_access_token,
          }
        : undefined;
      selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!, deviceKeyEnrollment);
      wizard?.record({
        organization: { kind: 'new', name: selectedOrg.name },
        recoveryShown: true,
      });

    } else {
      let orgId: string;
      if (this.pinnedOrgId) {
        // CAP-451: the flow instance already pinned this org (the
        // `authenticate` step's own result, or a `select_organization`
        // screen upstream of this call) — no picker to show.
        orgId = this.pinnedOrgId;
      } else if (this.noWizardStops && orgs.length === 1) {
        // CAP-469: with exactly one organization, there is no human decision
        // to make. The free tier is single-org by construction, so this is the
        // dominant broker-ceremony path: fetch the list from the service (the
        // source of truth), then proceed with that sole org. This resolves a
        // dead-end at the org picker even when the session is already scoped to
        // the only organization.
        orgId = orgs[0].id;
      } else if (this.noWizardStops) {
        // No default to fall back to: which org to use is a genuine human
        // decision this source has no way to make. Checked BEFORE `wizard`
        // — `wizard` is guaranteed null here anyway (see initializeProject),
        // but the order itself is the contract: broker-ceremony always wins.
        this.refuseWizardStop();
      } else if (wizard) {
        // No TTY under --web (e.g. driven through the MCP): the picker is the
        // wizard's `organization` stop, which carries the same list and the
        // same "create new" row an inquirer prompt would have shown — and, on
        // the rail beside it, the five stops that come after.
        const chosen = await wizard.askOrganization(
          orgs.map(o => ({ id: o.id, name: o.name, isCurrent: o.id === currentOrgId })),
        );
        if (chosen === null) {
          throw new CapyError('Organization selection cancelled', ERROR_CODES.AUTH_FAILED);
        }
        orgId = chosen === 'create' ? CREATE_NEW_ORG : chosen;
      } else {
        ({ orgId } = await inquirer.prompt([{
          type: 'list',
          name: 'orgId',
          message: 'Select organization for project:',
          choices: [
            ...orgs.map(o => ({
              name: o.id === currentOrgId ? `${o.name}  \x1b[38;5;43m← current\x1b[0m` : o.name,
              value: o.id,
            })),
            { name: 'Create new organization +', value: CREATE_NEW_ORG },
          ],
          default: currentOrgId,
        }]));
      }

      if (orgId === CREATE_NEW_ORG) {
        selectedOrg = await this.createNewOrganization(refreshToken!, authResult.user_id!);
        // Naming it and being shown the phrase both happened, elsewhere. The
        // rail settles those two stops rather than leaving them ◌ behind a
        // fork this run has already taken.
        wizard?.record({
          organization: { kind: 'new', name: selectedOrg.name },
          recoveryShown: true,
        });

        // Final-gate failure-signal #4: this branch runs when the account
        // already has ≥1 org (the zero-org path above is Case A, handled by
        // createNewOrganization's own deviceKeyEnrollment option). A SECOND
        // org created while already enrolled mints its own fresh per-org
        // root and is unportable via the device key until something unifies
        // it onto the canonical one — exactly the gap
        // syncOrgOntoDeviceKeyIfEnrolled exists to close, today only called
        // from `capy redeem`'s post-success hook. Silent maintenance (no
        // prompt: nothing new is being decided), best-effort, and a no-op
        // when nothing is enrolled anywhere yet.
        if (deviceKeysEnabled()) {
          await syncOrgOntoDeviceKeyIfEnrolled(this.deviceKeyWiringContext(authResult, selectedOrg.id), selectedOrg.id);
        }

      } else if (currentOrg && orgId === currentOrg.id) {
        selectedOrg = currentOrg;

      } else {
        selectedOrg = orgs.find(o => o.id === orgId)!;

        const orgSpinner = ora('Switching organization...').start();
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

    // User has access to an existing org but no local key — they were invited
    // and need to redeem their invite code to receive the shared master key.
    let orgKeyPresent = hasOrgKey(selectedOrg.id, authResult.user_id!);

    // CAP-382 Case C: exactly the purpose program's marquee failure signal
    // — a new machine, already enrolled elsewhere, that today dead-ends
    // into "run capy redeem". Try the device-key unlock ceremony before
    // falling through to that message. Flag-gated; no enrolled device key,
    // a decline, or any ceremony failure leaves this branch unchanged.
    if (!orgKeyPresent && deviceKeysEnabled()) {
      const unlock = await attemptCaseCUnlock(this.deviceKeyWiringContext(authResult, selectedOrg.id));
      if (unlock.ok) {
        orgKeyPresent = hasOrgKey(selectedOrg.id, authResult.user_id!);
      }
    }

    // Master-key mint chokepoint: an auto-provisioned personal org has no
    // key for ANY device until an owner first mints one — still true after
    // the Case C unlock attempt above, since there is nothing to unlock. If
    // this org's own key_state (from the auth-response org list already in
    // hand) says nobody has minted M yet, and this run can safely show a
    // recovery phrase, mint it here instead of falling straight to the
    // invite-code remedy below.
    if (!orgKeyPresent && shouldAttemptMint(orgs.find(o => o.id === selectedOrg.id)?.key_state, this.options.web)) {
      const { mintMasterKeyForOrg } = await import('../auth/masterKeyMint');
      try {
        await mintMasterKeyForOrg({
          orgId: selectedOrg.id,
          userId: authResult.user_id!,
          serviceClient: this.serviceClient,
          keyServiceOps: this.keyServiceOps(),
          web: this.options.web,
        });
        orgKeyPresent = hasOrgKey(selectedOrg.id, authResult.user_id!);
      } catch {
        // KEY_ALREADY_MINTED / KEY_MINT_IN_PROGRESS / unsafe-surface — fall
        // through to the existing "no key on this device" remedy below,
        // unchanged.
      }
    }

    wizard?.record({ hasOrgKey: orgKeyPresent });
    if (!orgKeyPresent) {
      // The most common way this run stops, and it stops one step after the
      // browser answered a question — so the page would otherwise be told the
      // organization it just picked went through. `redeem` is on the rail from
      // the start for exactly this; the run stops standing on it.
      //
      // Stated in fields rather than left for the message below to be mined
      // for: the remedy is a command, not a sentence that happens to contain
      // one.
      wizard?.willBlock(
        'redeem',
        {
          code: ERROR_CODES.AUTH_FAILED,
          title: 'This device does not hold this organization\'s key',
          detail:
            'You have access to the organization, but the shared encryption key has never been transferred to this device. An owner can send you an invite code; redeeming it moves the key here. Then run capy again in this directory.',
          remedy: 'capy redeem <code>',
        },
        { facts: [{ label: 'Organization', value: selectedOrg.name }] },
      );
      // Its own code, not AUTH_FAILED: signing in again cannot fix this, and a
      // caller that has to tell the two apart must not do it by reading the
      // sentence. The message is unchanged.
      throw new CapyError(
        `You have access to "${selectedOrg.name}" but no encryption key on this device.\n\n` +
        '  Ask your org owner for an invite code, then run:\n\n' +
        '    capy redeem <code>\n\n' +
        '  This will securely transfer the shared encryption key to your device.',
        ERROR_CODES.KEY_NOT_ON_DEVICE
      );
    }

    // CAP-382: this machine is enrollment-aware (orgKeyPresent is true, one
    // way or another) — retry any owed key.enc upload left by a previous
    // interrupted sync. Best-effort, flag-gated, never blocks this run.
    if (deviceKeysEnabled()) {
      await runPendingSyncBestEffort(this.deviceKeyWiringContext(authResult, selectedOrg.id));

      // Final-gate MAJOR-5: the ordinary-run on-ramp into enrollment. Only
      // fires when this machine has a local root but the account holds zero
      // live doors (Case B); declinable, isInteractive()-gated (a no-op
      // under --web/MCP/CI), and shown at most once per machine — see
      // maybeNudgeDeviceKeyEnrollment's own doc for the eligibility check
      // and the decline-persistence marker.
      await maybeNudgeDeviceKeyEnrollment(this.deviceKeyWiringContext(authResult, selectedOrg.id), selectedOrg.name);
    }

    // Discover existing projects in the org. If any exist, give the user the
    // choice to bootstrap one of them OR create a new project. This is the path
    // a teammate hits when cloning a repo with no committed keep.lock.
    const CREATE_NEW_PROJECT = '__create_new_project__';
    let existingProjects: Array<{ id: string; name: string; organization_id: string }> = [];
    // "The lookup failed" and "this org has none" both end up as an empty list
    // here, and they are not the same fact: one walks the user into creating a
    // second project alongside one they already have. The rail says which.
    let projectsUnavailable = false;
    try {
      const listSpinner = ora('Looking for existing projects...').start();
      existingProjects = await this.serviceClient.listProjects();
      listSpinner.stop();
      this.debug('listProjects response', existingProjects);
    } catch (err) {
      this.debugError('listProjects failed', err);
      // Network or auth issue — fall through to new-project flow
      existingProjects = [];
      projectsUnavailable = true;
    }
    wizard?.record({ projectCount: existingProjects.length, projectsUnavailable });

    // CAP-451: a projectName the plan dialog already carried means the
    // decision "create fresh with this name" was already made — the
    // existing-project picker below is exactly the wizard stop that
    // decision exists to skip, so it never runs in that case.
    const skipProjectPicker = Boolean(this.flowProjectName);
    if (existingProjects.length > 0 && !skipProjectPicker) {
      const choices = [
        { name: 'New project', value: CREATE_NEW_PROJECT },
        ...existingProjects.map(p => ({
          name: p.name,
          value: p.id,
        })),
      ];

      let projectChoice: string;
      if (this.noWizardStops) {
        // Existing projects, no name pinned: adopt-vs-create is a genuine
        // human decision this source cannot make — refuse rather than
        // guess. Checked before `wizard` for the same reason as the org
        // picker above.
        this.refuseWizardStop();
      } else if (wizard) {
        const chosen = await wizard.askProject(
          existingProjects.map(p => ({ id: p.id, name: p.name })),
        );
        if (chosen === null) {
          throw new CapyError('Project selection cancelled', ERROR_CODES.AUTH_FAILED);
        }
        projectChoice = chosen === 'new' ? CREATE_NEW_PROJECT : chosen;
      } else {
        ({ projectChoice } = await inquirer.prompt([{
          type: 'list',
          name: 'projectChoice',
          message: 'Which project do you want to use?',
          choices,
          default: CREATE_NEW_PROJECT,
        }]));
      }

      if (projectChoice !== CREATE_NEW_PROJECT) {
        const picked = existingProjects.find(p => p.id === projectChoice)!;
        // Known now, before anything is pulled or written.
        this.onProjectResolved?.({ org_id: selectedOrg.id, project_id: picked.id });
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
    let projectName: string;
    if (this.flowProjectName) {
      // CAP-451: the plan dialog already named it (`write_keep_lock`'s
      // `project_name` param, or `capy onboard --project-name`).
      projectName = this.flowProjectName;
    } else if (this.noWizardStops) {
      // Unlike the org/project pickers above, this stop HAS a documented
      // default — the same one the TTY prompt pre-fills — so it uses it
      // rather than refusing. Checked before `wizard` for the same reason
      // as the pickers above.
      projectName = defaultName;
    } else if (wizard) {
      // Same two refusals the TTY validator makes, in the same words — the
      // screen holds its button on both, so either arriving here means the
      // submit did not come from the screen.
      const entered = await wizard.askProjectName(defaultName);
      if (entered === null) {
        throw new CapyError('Project naming cancelled', ERROR_CODES.AUTH_FAILED);
      }
      projectName = entered;
    } else {
      projectName = await this.promptEngine.promptForProjectName(defaultName);
    }

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

    // The project exists on the service from here on. Report it immediately:
    // everything after this point can fail, and a retry that did not know this
    // id would create a SECOND project.
    this.onProjectResolved?.({ org_id: projectResult.org_id, project_id: projectResult.project_id });

    // Create the initial branch. `POST /projects` no longer auto-creates
    // one, so pick the name: default 'development', or a custom name the
    // user enters. Protection isn't asked here - branches are unprotected
    // by default and can be protected later via a dedicated action.
    let initialBranchChoice: string;
    if (this.noWizardStops) {
      // CAP-451: the same default the TTY prompt's first (and effectively
      // default) row offers — 'development' — used directly, never asked.
      // Checked before `wizard` for the same reason as the stops above.
      initialBranchChoice = 'development';
    } else if (wizard) {
      // No TTY under --web: without a browser screen here, init dies one step
      // before createBranch/writeActiveBranch and leaves a branchless project.
      const chosen = await wizard.askBranchChoice();
      if (chosen === null) {
        throw new CapyError('Branch selection cancelled', ERROR_CODES.AUTH_FAILED);
      }
      initialBranchChoice = chosen;
    } else {
      ({ initialBranchChoice } = await inquirer.prompt([{
        type: 'list',
        name: 'initialBranchChoice',
        message: 'What branch should this project start with?',
        choices: [
          { name: 'development (default)', value: 'development' },
          { name: 'another branch', value: 'other' },
        ],
      }]));
    }

    let initialBranchName: string;
    if (initialBranchChoice === 'other') {
      // Unreachable under noWizardStops — that branch always hard-codes
      // 'development' above and never produces 'other' — but refuse rather
      // than silently falling to inquirer if that ever changes.
      if (this.noWizardStops) {
        this.refuseWizardStop();
      } else if (wizard) {
        const entered = await wizard.askBranchName();
        if (entered === null) {
          throw new CapyError('Branch naming cancelled', ERROR_CODES.AUTH_FAILED);
        }
        initialBranchName = entered;
      } else {
        const { branchName } = await inquirer.prompt([{
          type: 'input',
          name: 'branchName',
          message: 'Branch name:',
          validate: (input: string) => input.trim().length > 0 || 'Branch name cannot be empty',
        }]);
        initialBranchName = String(branchName).trim();
      }
    } else {
      initialBranchName = 'development';
    }
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
    human('> .gitignore updated (added .env, .capy/)');

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
      // The last stop stops being a blank the moment the directory is read: an
      // empty .env is a stop this run will not visit, and the rail says so
      // rather than leaving it looking outstanding.
      wizard?.record({ localEnvCount: localVarCount });

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
            // The stop this run dies at is the consent gate, and the variables
            // are the whole subject — so they go as NAMES, in the field that
            // draws them as a list of things to go and find in a file, rather
            // than as a count inside a red sentence. Names only: these values
            // cannot be read by this key, which is the problem.
            wizard?.willBlock(
              'encrypt',
              {
                code: ERROR_CODES.PERMISSION_DENIED,
                title: 'This .env holds values encrypted to a different project',
                detail:
                  'These variables cannot be read with this organization\'s key, so they cannot be pushed to it. Delete the .env file, or replace those values with plaintext, and run capy again.',
                remedy: 'capy',
              },
              { names: foreignKeys },
            );
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
        human(`\nFound .env with ${localVarCount} secrets:`);
        human(`  ${displayNames}`);

        // The user already chose their initial branch above — push the
        // existing .env to that branch. (Previously we re-prompted for a
        // commit target here, but now that project init explicitly sets
        // the initial branch, asking again was redundant + could create a
        // second branch the user didn't ask for.)
        const initBranch = initialBranchName;

        // Confirm before encrypting + pushing — user may not be in the
        // right project on first setup. After this step .env is rewritten
        // with ciphertext, so getting it wrong is painful to recover from.
        let confirmEncrypt: boolean;
        if (this.assumeEncryptConsent) {
          // Under the flow driver this question was already asked, once, by the
          // onboard plan dialog — and the answer is recorded server-side on the
          // flow instance. Asking again is the consent fatigue the flow layer
          // exists to remove; it is NOT a consent being skipped.
          confirmEncrypt = true;
        } else if (this.noWizardStops) {
          // Defensive: `write_keep_lock(select_or_create)` is always
          // consent-gated, so assumeEncryptConsent should already be true
          // by the time a broker-ceremony run reaches here. If it somehow
          // isn't, refuse rather than fall through to a prompt nobody can
          // answer — never silently encrypt-and-push without consent either.
          this.refuseWizardStop();
        } else if (wizard) {
          // NAMES and a count reach the page — never a value, and not even a
          // snippet of one. The whole question this stop asks is whether these
          // may stop being plaintext, and showing more than the terminal shows
          // in order to ask it would answer part of it first.
          //
          // A closed window is a "no": `askEncrypt` resolves false on cancel,
          // which is the same thing `chosen === 'yes'` already meant.
          confirmEncrypt = await wizard.askEncrypt(
            { count: localVarCount, names: varNames },
            { projectName, orgName: selectedOrg.name, branch: initBranch },
          );
        } else {
          ({ confirmEncrypt } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmEncrypt',
            message: `Encrypt these ${localVarCount} secrets and push to ${B(projectName)} (${selectedOrg.name}) on ${B(initBranch)}?`,
            default: true,
          }]));
        }

        if (!confirmEncrypt) {
          human(`\nSkipped. Your .env was not modified.`);
          human(`Run ${B('capy')} again from the correct project directory, or run ${B('capy push')} when ready.`);
          return;
        }

        const syncSpinner = ora('Syncing local variables...').start();

        // What this actually got done, for the report a failure has to make.
        // Read off the writes themselves rather than inferred afterwards: the
        // three facts that matter are whether the values reached Keep, whether
        // the plaintext copy was kept, and whether the .env in this directory
        // is now ciphertext — and the third one is the reason this cannot be
        // answered by looking at the error.
        let pushedToKeep = false;
        let backupWritten = false;
        let envRewritten = false;

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

          const initPushResult = await this.serviceClient.pushSecrets(
            projectResult.project_id,
            keepJson,
            envBlob,
            initBranch,
          );
          pushedToKeep = true;

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

          // Backup plaintext .env before encrypting
          this.fileManager.backupPlaintextEnv(this.options.envPath);
          backupWritten = true;

          // Encrypt the local .env file
          this.fileManager.writeEncryptedEnvFile(localEnv, encryptionKey, undefined, updatedKeep, initBranch);
          envRewritten = true;

          syncSpinner.succeed(`keep.lock created (pinned to ${initBranch}, ${localVarCount} secrets)`);

          // The freshly created pin only reaches teammates once committed —
          // this is how "main was never committed" incidents start.
          const { autoCommitKeep } = await import('../git/autoCommitKeep');
          autoCommitKeep(initBranch);

          // Install git hooks
          this.installGitHooks();

          human(`\nYour .env is now encrypted. To run your app with decrypted secrets,`);
          human(`prefix your command with ${B('capy run')} (e.g. ${B('capy run -- npm start')}).`);
          human(`See: https://docs.capy.sc/using/running-your-app`);
          human(`\nRun ${B('capy push')} to share your secrets with teammates.`);
        } catch (syncError: any) {
          syncSpinner.fail(`Failed to sync variables: ${syncError.message}`);
          human(`You can run ${B('capy')} again to retry syncing`);
          // This is the one failure that happens after the last question, and
          // the terminal path swallows it and carries on — which under --web
          // used to mean the run ended with `finish()` and the page drew a
          // green check over a push that did not happen. The browser gets the
          // same three facts the terminal cannot state: whether the values
          // reached Keep, whether the plaintext copy was kept, and whether the
          // .env in this directory is ciphertext now.
          await wizard?.reportEncryptFailure({
            code: syncError instanceof CapyError ? syncError.code : ERROR_CODES.SERVICE_ERROR,
            reason: syncError?.message ? String(syncError.message) : 'The push failed.',
            envRewritten,
            backupWritten,
            pushed: pushedToKeep,
          });
        }
      } else {
        human(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
        human('to share them with your team.');

        // Install git hooks
        this.installGitHooks();
      }
    } else {
      wizard?.record({ localEnvCount: 0 });
      human(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
      human('to share them with your team.');

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

    human('');
    human(grey('Capy CLI'));
    human(grey('\u250c' + '\u2500'.repeat(maxLen) + '\u2510'));

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
      human(`${grey('\u2502')} ${left}${' '.repeat(leftPad)}${' '.repeat(gap)}${furry(right, i)}${' '.repeat(rightPad + 1)}${grey('\u2502')}`);
    }

    human(grey('\u2514' + '\u2500'.repeat(maxLen) + '\u2518'));
    human('');
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
    let branch: string;

    let authResult: AuthResult;

    if (localMode) {
      authResult = { success: true, user_id: LOCAL_USER_ID };
      branch = await this.resolveActiveBranch(projectState, true);
      projectState.activeBranch = branch;
      this.displayHeader(
        projectState.projectName || 'local project',
        'local (this machine only)',
        'local',
        branch,
      );
    } else {
      // Load user-scoped session if we know who last synced this project
      if (projectState.userId) {
        this.authService.setSessionUserId(projectState.userId);
      }

      // Authenticate — try silent first, then interactive if needed.
      const spinner = ora('Authenticating...').start();
      let result = await this.authService.authenticateSilent(projectState.organizationId);

      // If silent auth failed, try without a specific org to use any valid session
      if (!result.success) {
        result = await this.authService.authenticateSilent();
      }

      // If still no session, fall through to interactive auth — except on
      // network failures: a browser round-trip can't fix an unreachable
      // service, and bouncing to OAuth there hides the real problem.
      if (!result.success) {
        const refreshFailure = this.authService.getLastRefreshFailure();
        if (refreshFailure?.reason === 'network') {
          spinner.fail('Could not reach the Capy service to refresh your session');
          throw new CapyError(
            `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
            ERROR_CODES.NETWORK_ERROR,
            { detail: refreshFailure.detail }
          );
        }
        // Bug D residual: a sandboxed `--broker-ceremony` caller has no
        // browser to send loopback OAuth to — `this.authService.authenticate`
        // below would otherwise bind one nothing can answer. Refused with a
        // coded failure instead; the flow's own `authenticate` step (which
        // DOES have a broker-driven ceremony) is what re-establishes a
        // session for a broker-ceremony run, not this ordinary sync path.
        if (this.options.brokerCeremony) {
          spinner.fail('Session needs interactive sign-in');
          throw new CapyError(
            'This step needs interactive sign-in the flow cannot do here.',
            ERROR_CODES.FLOW_STOP_UNREACHABLE,
          );
        }
        if (refreshFailure?.reason === 'session_ended') {
          // Say why the browser is about to open instead of silently bouncing.
          spinner.text = 'Session expired — opening your browser to sign in again...';
        }
        result = await this.authService.authenticate(projectState.organizationId);
      }

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
      branch = await this.resolveActiveBranch(projectState, false);
      projectState.activeBranch = branch;

      const orgName = result.organization_name
        || result.organizations?.find(o => o.id === result.organization_id)?.name
        || (result.organizations?.length === 0 ? 'not yet created' : result.organization_id)
        || 'not yet created';

      this.displayHeader(
        projectState.projectName || 'not yet created',
        orgName,
        result.user_first_name || result.user_email || '',
        branch,
      );

      const token = this.authService.getToken();
      if (!token) {
        throw new CapyError(
          'You do not have access to this project\'s organization.\n\n' +
          'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
          ERROR_CODES.PERMISSION_DENIED
        );
      }
      authResult = result;
    }

    let encryptionKey: string;
    try {
      if (localMode) {
        encryptionKey = await resolveLocalProjectKey(projectState.projectId!);
      } else {
        encryptionKey = await resolveProjectKey(
          projectState.organizationId!,
          projectState.projectId!,
          authResult.user_id!,
          this.keyServiceOps(),
        );
      }
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

    // Read keep.lock. The file is git-owned (CAP-303): the fetch below never
    // rewrites an existing keep.lock, so currentKeep only mutates in the
    // bootstrap case (no local file → reconstructed from the server, where
    // `pinned` is empty anyway) and the diff table always reflects what was
    // actually pinned on this machine.
    let currentKeep = this.projectManager.readKeepFile();
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
    this.debug('pinned', pinned);

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

    // Fetch remote secrets. In local-only mode there is no remote — skip the
    // fetch entirely and reuse the existing offline path (networkAvailable
    // false → empty remote → pinned-vs-local comparison only).
    const remotePlaintext: Record<string, string> = {};
    const remoteHashes: Record<string, string> = {};
    let networkAvailable = !localMode;

    if (!localMode) {
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
      if (decryptData.keep_file && !currentKeep) {
        const serverKeep = JSON.parse(decryptData.keep_file) as KeepFile;
        this.debug('bootstrap: no local keep.lock, reconstructing from server');
        this.fileManager.writeKeepFile(serverKeep);
        currentKeep = serverKeep;
      }
      fetchSpinner.stop();
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
              human('\nBranches you can switch to:');
              for (const b of candidates) {
                human(`  ${B(b.name)}`);
              }
              const suggested = candidates[0].name;
              human(`\nRun ${B(`capy checkout ${suggested || ''}`)} to switch.`);
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
      networkAvailable = false;
      fetchSpinner.fail('Cannot reach remote. Showing local changes only.');
    }
    } // end if (!localMode) remote fetch

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
      human('Everything is up to date!');
      // Always re-encrypt local .env
      const finalKeep = this.projectManager.readKeepFile();
      this.fileManager.writeEncryptedEnvFile(localPlaintext, encryptionKey, undefined, finalKeep, branch);
      this.installGitHooks();
      // NO BROWSER PAGE HERE, deliberately. This is the path a synced
      // directory takes on every single run: nothing was asked, nothing
      // differed, and the one line above says so. Serving a report anyway
      // opened a tab per run — and where `--web` actually lives, which is a
      // headless or remote host, `open()` fails quietly and the listening
      // socket holds the process for its whole 120-second timeout waiting for
      // a browser that is never coming. A no-op that takes two minutes to
      // exit is worse than a no-op nobody rendered.
      //
      // The three ENDS below still report: they follow a question somebody
      // answered in a window that is demonstrably in use.
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
      // Presence is `!== undefined`: '' is a valid pinned value, and a falsy
      // check forces a remote fetch on every sync for empty variables.
      if (localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinned[variable]) {
        pinnedPlaintext[variable] = localPlaintext[variable];
      } else {
        needsFetch = true;
      }
    }
    if (needsFetch && currentKeep && Object.keys(pinned).length > 0) {
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
        if (blob?.env_file) {
          const encrypted = this.fileManager.parseEnvContent(blob.env_file);
          for (const [key, value] of Object.entries(encrypted)) {
            if (pinned[key] && pinnedPlaintext[key] === undefined) {
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

    human(`  You have unsynced environment variables (${diffs.length} difference${diffs.length !== 1 ? 's' : ''} found).\n`);

    // Display comparison table (TTY only — the --web resolver renders its own).
    if (!this.options.web) {
      this.displayComparisonTable(diffs, effectiveShowLocal, showRemote, pinned, localHashes, remoteHashes, localPlaintext, remotePlaintext, pinnedPlaintext);
      human(`\n  ${DIM}← → select value   ↑ ↓ move between rows   Enter confirm   q cancel${RST}\n`);
    }

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
      menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    } else if (showLocal && !showRemote) {
      // State 2: Local differs from pinned, remote matches pinned
      if (isBehind) {
        // 2b: keep.lock changed via git pull → user is behind
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
      } else {
        // 2a: user edited .env locally → user is ahead
        menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
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
        menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
      } else {
        // 4a: user edited .env + teammate pushed
        menuChoices.push({ name: 'Commit and push all local values', value: 'commit_local' });
        menuChoices.push({ name: 'Retrieve all pinned values', value: 'retrieve_pinned' });
        menuChoices.push({ name: 'Retrieve all remote values', value: 'retrieve_remote' });
      }
      menuChoices.push({ name: 'Individually resolve', value: 'individual' });
    }

    menuChoices.push({ name: 'Continue working', value: 'skip' });

    // In local-only mode there is no remote, so "push" is misleading.
    if (localMode) {
      for (const c of menuChoices) {
        if (c.value === 'commit_local') c.name = 'Commit all local values';
      }
    }

    // A menu with exactly one real action is not a decision.
    //
    // Onboarding a fresh clone is precisely this shape: `.env` is gitignored,
    // so nothing is on disk to lose and "retrieve the pinned values" is the
    // only thing that can happen. Asking a human — or refusing below for want
    // of a TTY — turns a fully determined outcome into a stop the flow cannot
    // pass, which is how a second device reached `done` with an empty
    // directory. `skip` is excluded because "do nothing" is always on the menu
    // and is never the action the user came for.
    const soleAction = ((): string | null => {
      if (!isOnboarding) return null;
      const real = menuChoices.filter((c) => c.value !== 'skip');
      return real.length === 1 ? real[0].value : null;
    })();

    let action: string;
    // When the conflict is resolved in the browser we already hold the final env;
    // we tag the action 'individual' and skip the TTY ResolveTable below.
    let webFinalEnv: Record<string, string> | undefined;
    // Bug D residual: a sandboxed `--broker-ceremony` caller has no browser to
    // send a conflict resolver to — `resolveConflictViaBrowser` below binds a
    // loopback server nothing can answer — and no TTY either, so falling
    // through to `inquirer.prompt` hangs the process on piped stdin. This must
    // gate on `brokerCeremony` alone: a broker run without `--web` still has
    // neither a browser nor a TTY, so `this.options.web` is not a precondition
    // for the refusal.
    if (!soleAction && this.options.brokerCeremony) {
      throw new CapyError(
        'This step needs a human decision the flow cannot make for it here.',
        ERROR_CODES.FLOW_STOP_UNREACHABLE,
      );
    }
    if (soleAction) {
      action = soleAction;
    } else if (this.options.web) {
      // The browser now answers the same two-level question the terminal asks,
      // so the whole-run menu goes to it verbatim — same wording, same order,
      // and that order is the CLI's recommendation. It used to be discarded
      // here and `individual` forced in its place.
      const resolved = await this.resolveConflictViaBrowser(
        diffs, effectiveShowLocal, showRemote, pinned,
        localPlaintext, remotePlaintext, pinnedPlaintext,
        projectState.projectName || 'project', branch,
        {
          localMode,
          isOnboarding,
          isBehind,
          remoteState: showRemote ? 'ok' : 'empty',
          actions: menuChoices.map(c => ({ value: c.value, label: c.name })),
        },
      );
      if (resolved === null) {
        human('\n  No changes applied.');
        // A closed window changed nothing on disk, and the report says exactly
        // that rather than reporting a sync that did not happen.
        await this.reportSyncResult(projectState, branch, {
          outcome: 'nothing-to-do',
          pulled: [],
          pushed: [],
          envRewritten: false,
        });
        return;
      }
      // Only individual resolution hands back an env; every other action is
      // applied below by the same branch the terminal path takes.
      webFinalEnv = resolved.finalEnv;
      action = resolved.action;
    } else {
      const res = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: menuChoices,
      }]);
      action = res.action as string;
    }

    // Apply the chosen action
    let finalEnv: Record<string, string>;

    if (action === 'retrieve_pinned') {
      // Fetch the pinned snapshot — the one displayed in the Pinned column of
      // the diff table. currentKeep is exactly what keep.lock pins (the fetch
      // never rewrites it), and the snapshot is still in S3 because env blobs
      // are content-addressed and immutable.
      finalEnv = { ...localPlaintext };
      if (currentKeep && Object.keys(pinned).length > 0) {
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
          human('Could not fetch pinned values from remote.');
          return;
        }
      }
    } else if (action === 'retrieve_remote') {
      finalEnv = { ...remotePlaintext };
    } else if (action === 'commit_local') {
      finalEnv = { ...localPlaintext };
    } else if (action === 'skip') {
      await this.reportSyncResult(projectState, branch, {
        outcome: 'nothing-to-do',
        pulled: [],
        pushed: [],
        envRewritten: false,
      });
      return;
    } else {
      // Individual resolution — already resolved in the browser when --web.
      const resolved = webFinalEnv ?? await this.resolveIndividually(diffs, showLocal, showRemote, pinned, localPlaintext, remotePlaintext, pinnedPlaintext);
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
    human(`\n> keep.lock updated (${diffs.length} changes)`);

    // Every action above rewrites pins (retrieve updates them, commit pushes
    // them) — commit the new pin so the team's keep.lock travels with git.
    const { autoCommitKeep } = await import('../git/autoCommitKeep');
    autoCommitKeep(branch);

    if (action === 'commit_local') {
      human(
        localMode
          ? `\nStored ${changeCount} change(s) locally (local-only mode).`
          : `\nPushed ${changeCount} change(s) to Keep.`,
      );
    }

    // Install hooks on every run (idempotent)
    this.installGitHooks();

    // Which way each variable moved is which list it lands in.
    //
    // Pulled is computed rather than assumed: it is the variables whose value
    // in the file actually CHANGED, which is the only definition that stays
    // true for individual resolution, where the answer is per variable and a
    // row resolved to "keep mine" moved nowhere at all.
    //
    // Pushed is `commit_local` and only `commit_local`: it is the one action
    // that sends anything up. Individual resolution rewrites the file and
    // repins, and never pushes — see the guard above.
    const changes = (rows: { variable: string; type: 'new' | 'changed' | 'deleted' }[]) =>
      rows.map(d => ({ variable: d.variable, type: d.type }));
    await this.reportSyncResult(projectState, branch, {
      outcome: 'synced',
      pulled: action === 'commit_local'
        ? []
        : changes(diffs.filter(d => finalEnv[d.variable] !== localPlaintext[d.variable])),
      pushed: action === 'commit_local' ? changes(diffs) : [],
      envRewritten: true,
    });
  }

  /**
   * The end-of-run report, in the browser, under `--web`.
   *
   * `capy --web` is agent-driven, so the three console lines above go to a
   * stream nobody is necessarily watching. The same facts render as the
   * compiled `sync-result` screen instead — variable NAMES and directions, no
   * values, and `envRewritten` carried rather than inferred, because the .env
   * is rewritten on a path where nothing moved at all.
   */
  private async reportSyncResult(
    projectState: ProjectState,
    branch: string | null,
    result: {
      outcome: 'synced' | 'nothing-to-do';
      pulled: { variable: string; type: 'new' | 'changed' | 'deleted' }[];
      pushed: { variable: string; type: 'new' | 'changed' | 'deleted' }[];
      envRewritten: boolean;
    },
  ): Promise<void> {
    if (!this.options.web) return;
    const { showSyncResultInBrowser } = await import('../ui/syncScreens');
    await showSyncResultInBrowser({
      projectName: projectState.projectName || 'project',
      branch,
      ...result,
      open: !process.env.CAPY_WEB_NO_OPEN,
      // `authService` opts this call into the keep-hosted transport when
      // CAPY_KEEP_SCREENS=1 (W2-B) — this class already threads
      // `this.authService` into other browser-ending calls (see
      // `createNewOrganization` / `deviceKeyWiringContext` below).
      authService: this.authService,
    });
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
    human(`  ${headerLine}`);
    human(`  ${'─'.repeat(colWidths.reduce((a, b) => a + b, 0))}`);

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
      human(`  ${row}`);
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
        'Run `capy --web` to resolve them in a browser, or run `capy` in a terminal.',
      );
    }

    if (outcome === 'cancelled') {
      return null;
    }

    return this.mapResolveChoicesToEnv(choices, diffs, pinned, localPlaintext, remotePlaintext, pinnedPlaintext);
  }

  /**
   * Map a per-variable resolve choice set ('pinned'|'local'|'remote'|'delete')
   * to the final plaintext env. Shared by the TTY ResolveTable and the --web
   * browser resolver so both paths produce byte-identical results. Variables not
   * in `diffs` (unchanged) are carried over from local.
   */
  private mapResolveChoicesToEnv(
    choices: Record<string, 'pinned' | 'local' | 'remote' | 'delete'>,
    diffs: { variable: string }[],
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
    pinnedPlaintext: Record<string, string> = {},
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [variable, choice] of Object.entries(choices)) {
      if (choice === 'pinned') {
        const pinnedHash = pinned[variable];
        // Prefer the resolved pinned plaintext (from the keep cache / remote
        // fetch). Without it, "pinned" could only be reconstructed when the
        // pinned value happened to equal local or remote — so in local-only
        // mode, choosing "pinned" for a locally-EDITED var matched nothing and
        // the keep.lock cleanup then silently DELETED the variable. The cache
        // holds the baseline, so consult it first.
        // `!== undefined` throughout: '' is a valid pinned value.
        if (pinnedPlaintext[variable] !== undefined) {
          result[variable] = pinnedPlaintext[variable];
        } else if (localPlaintext[variable] !== undefined && hashValue(localPlaintext[variable]) === pinnedHash) {
          result[variable] = localPlaintext[variable];
        } else if (remotePlaintext[variable] !== undefined && hashValue(remotePlaintext[variable]) === pinnedHash) {
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

  /**
   * Render the sync conflict resolver in the browser (`capy --web`).
   *
   * Serves the compiled `sync-conflict` screen, which asks BOTH levels the
   * terminal asks: the whole-run action first, in the CLI's own order so the
   * recommended answer sits at the top, and the per-variable table only when
   * the user chooses to resolve individually. The previous browser path threw
   * the first level away and hard-coded individual resolution, so someone who
   * wanted "take theirs" answered once per variable and never saw the ordering
   * that carried the recommendation.
   *
   * SNIPPETS only, never full secret values — the same rule the TTY table
   * follows. Returns the chosen action so the caller can apply a whole-run
   * answer directly, or null when nothing was decided.
   */
  private async resolveConflictViaBrowser(
    diffs: { variable: string; type: string; pinned?: string; local?: string; remote?: string }[],
    showLocal: boolean,
    showRemote: boolean,
    pinned: Record<string, string>,
    localPlaintext: Record<string, string>,
    remotePlaintext: Record<string, string>,
    pinnedPlaintext: Record<string, string>,
    projectName: string,
    branch: string,
    context: {
      localMode: boolean;
      isOnboarding: boolean;
      isBehind: boolean;
      remoteState: 'ok' | 'empty' | 'unreachable';
      actions: { value: string; label: string }[];
    },
  ): Promise<{ action: string; finalEnv?: Record<string, string> } | null> {
    const { resolveConflictInBrowser } = await import('../ui/syncConflictScreen');

    // Which pins cannot be reconstructed. The terminal encodes this by writing
    // an ANSI-italic `unresolvable` into the value column and testing for that
    // string later; a variable whose snippet read "unresolvable" would defeat
    // it. The screen takes a set of names, which no value can spoof.
    const unresolvable = new Set(
      diffs
        .map(d => d.variable)
        .filter(v => pinned[v] !== undefined && pinnedPlaintext[v] === undefined),
    );

    const rows = diffs.map(diff => ({
      variable: diff.variable,
      pinned: pinnedPlaintext[diff.variable]
        ? formatSnippet(pinnedPlaintext[diff.variable])
        : pinned[diff.variable] !== undefined
          ? ''
          : null,
      local: localPlaintext[diff.variable] ? formatSnippet(localPlaintext[diff.variable]) : null,
      remote: remotePlaintext[diff.variable] ? formatSnippet(remotePlaintext[diff.variable]) : null,
    }));

    const { action, choices, cancelled } = await resolveConflictInBrowser({
      rows,
      unresolvable,
      showLocal,
      showRemote,
      localMode: context.localMode,
      isOnboarding: context.isOnboarding,
      isBehind: context.isBehind,
      remoteState: context.remoteState,
      actions: context.actions.map(a => ({ value: a.value as never, label: a.label })),
      projectName,
      branch,
      // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI / headless
      // verification drive the loopback without hijacking a real browser.
      open: !process.env.CAPY_WEB_NO_OPEN,
    });
    if (cancelled) return null;

    // A whole-run action is applied by the same code the terminal path uses;
    // only individual resolution produces an env here.
    if (action !== 'individual') return { action };

    return {
      action,
      finalEnv: this.mapResolveChoicesToEnv(
        choices, diffs, pinned, localPlaintext, remotePlaintext, pinnedPlaintext,
      ),
    };
  }

  private async createNewOrganization(
    refreshToken: string,
    userId: string,
    deviceKeyEnrollment?: DeviceKeyEnrollmentOptions,
  ): Promise<Organization> {
    const { createNewOrganization } = await import('./orgCreation');
    return createNewOrganization(
      this.authService,
      this.serviceClient,
      refreshToken,
      userId,
      this.options.web,
      deviceKeyEnrollment,
    );
  }

  /** Shared context the device-key wiring (CAP-382) builds ceremony deps from. */
  private deviceKeyWiringContext(authResult: AuthResult, activeOrgId?: string | null): DeviceKeyWiringContext {
    return {
      authService: this.authService,
      serviceClient: this.serviceClient,
      devMode: this.devMode,
      userId: authResult.user_id!,
      userEmail: authResult.user_email,
      organizations: authResult.organizations || [],
      activeOrgId,
    };
  }
}
