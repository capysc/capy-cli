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
import { randomUUID } from 'crypto';
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
import { resolveActiveUrl } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { compareSecrets, hashValue, formatSnippet } from './statusCommand';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import {
  attemptCaseCUnlock,
  attemptPickupConsumption,
  runPendingSyncBestEffort,
  syncOrgOntoDeviceKeyIfEnrolled,
  maybeNudgeDeviceKeyEnrollment,
  DeviceKeyWiringContext,
} from '../auth/deviceKey/wiring';
import type { DeviceKeyEnrollmentOptions } from './orgCreation';
import { installGitHooks as installGitHooksShared } from '../git/installGitHooks';
import {
  abortInitWizard,
  askInitWizard,
  blockInitWizard,
  finishInitWizard,
  recordInitWizard,
  reportInitWizardEncryptFailure,
  type InitWizardTransport,
} from '../ui/initWizardTransport';
import {
  branchChoiceQuestion,
  branchNameQuestion,
  encryptQuestion,
  organizationQuestion,
  projectNameQuestion,
  projectQuestion,
  type InitQuestion,
  type InitWizardRecord,
} from '../ui/initWizardQuestions';
import {
  completeInitRunAuthentication,
  createInitRunBootstrap,
  publishInitRunConnection,
  recordInitRunTerminal,
  resolveInitRunBrokerAccessToken,
  type InitRunAuthorizedContext,
  type InitRunBootstrap,
} from '../auth/initRunBootstrap';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { resolveInitRunTransportMode } from '../auth/initRunTransportMode';
import { BrokerClient } from '../service/brokerClient';
import { HostedInitChannelError, openHostedInitChannel } from '../ui/hostedInitChannel';
import { createHostedInitWizardSession, closeHostedInitWizard } from '../ui/hostedInitWizardSession';
import { unlockHostedOrganization } from './hostedOrganizationUnlock';
import { keepOrigin } from '../ui/screens/keepScreens';
import {
  emitInitRunEvent,
  initRunHandoffEvent,
  initRunReceiptEvent,
  initRunUnconfirmedEvent,
  recordInitRunCreated,
  type InitRunEventState,
} from '../ui/initRunEvent';
import type { InitRunTerminalReceipt } from '../auth/initRunContract';
import { openScreen } from '../ui/openScreen';
import { createHostedFreshOrganization } from './hostedFreshOrganization';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

const recordWizard = (
  wizard: InitWizardTransport | null,
  patch: InitWizardRecord,
): InitWizardTransport | null => wizard ? recordInitWizard(wizard, patch) : null;

async function askWizard<T>(
  wizard: InitWizardTransport | null,
  question: InitQuestion<T>,
  terminal: () => Promise<T>,
): Promise<Readonly<{ value: T | null; wizard: InitWizardTransport | null }>> {
  if (!wizard) return { value: await terminal(), wizard: null };
  const result = await askInitWizard(wizard, question);
  return { value: result.value, wizard: result.transport };
}

class InitWizardFlowError extends CapyError {
  constructor(
    readonly original: unknown,
    readonly initWizard: InitWizardTransport | null,
    readonly authService: AuthService | null = null,
  ) {
    super(
      original instanceof Error ? original.message : 'Initialization failed',
      original instanceof CapyError ? original.code : ERROR_CODES.SERVICE_ERROR,
      original instanceof CapyError ? original.details : undefined,
    );
  }
}

class InitWizardPostConsentError extends CapyError {
  constructor(
    readonly failure: import('../ui/screens/contract').InitEncryptFailure,
    readonly initWizard: InitWizardTransport,
    readonly authService: AuthService | null = null,
  ) {
    super(failure.reason, failure.code);
  }
}

class InitWizardCancelledError extends CapyError {
  constructor(
    readonly initWizard: InitWizardTransport | null,
    readonly effects: 'none' | 'indeterminate',
    readonly authService: AuthService | null = null,
  ) {
    super('Initialization cancelled', ERROR_CODES.AUTH_FAILED);
  }
}

const bindInitWizardAuthority = (
  error: unknown,
  authService: AuthService,
  fallbackWizard: InitWizardTransport | null,
): InitWizardFlowError | InitWizardPostConsentError | InitWizardCancelledError => {
  if (error instanceof InitWizardPostConsentError) {
    return new InitWizardPostConsentError(error.failure, error.initWizard, authService);
  }
  if (error instanceof InitWizardCancelledError) {
    return new InitWizardCancelledError(error.initWizard, error.effects, authService);
  }
  if (error instanceof InitWizardFlowError) {
    return new InitWizardFlowError(error.original, error.initWizard, authService);
  }
  return new InitWizardFlowError(error, fallbackWizard, authService);
};

class HostedInitTerminalError extends Error {
  constructor(readonly original: unknown) {
    super('Hosted initialization ended with a terminal failure');
  }
}

async function withWizard<T>(
  wizard: InitWizardTransport | null,
  operation: () => Promise<T> | T,
  deadline: number | null = null,
): Promise<T> {
  if (deadline !== null && Date.now() >= deadline) {
    throw new InitWizardFlowError(
      new CapyError('Hosted initialization expired', 'INIT_RUN_EXPIRED'),
      wizard,
    );
  }
  const result = await capture(operation);
  if (result.ok) return result.value;
  throw new InitWizardFlowError(result.error, wizard);
}

type Captured<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;
async function capture<T>(operation: () => Promise<T> | T): Promise<Captured<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

type InitCommandContext = Readonly<{
  transport: 'local' | 'hosted';
  operationDeadline: number | null;
  authService: AuthService;
  serviceClient: ServiceClient;
}>;

type PreparedInitAuthentication = Readonly<{
  context: InitCommandContext;
  auth: AuthResult;
  rebindHostedSession?: (
    session: import('../ui/hostedInitWizardSession').HostedInitWizardSession,
    authService: AuthService,
  ) => import('../ui/hostedInitWizardSession').HostedInitWizardSession;
}>;

type InitRepositoryTarget = Readonly<{
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  branch: string;
}>;

type InitWorkflowResult = Readonly<{
  wizard: InitWizardTransport | null;
  target: InitRepositoryTarget;
  status: 'succeeded' | 'cancelled' | 'failed-after-consent';
  context: InitCommandContext;
}>;

type InitVerification = Readonly<{
  repositoryVerified: boolean;
  custodyVerified: boolean;
}>;

type HostedCompletionPlan = Readonly<{
  status: InitRunTerminalReceipt['status'];
  code: string | null;
  effects: InitRunTerminalReceipt['effects'];
  delivery: 'finish' | 'abort';
  failureCode: string | null;
}>;

type HostedInitExecution = Readonly<{
  bootstrap: InitRunBootstrap;
  authorized: InitRunAuthorizedContext;
  eventState: InitRunEventState;
  context: InitCommandContext;
  wizard: InitWizardTransport | null;
}>;

const terminalCode = (error: unknown): string => {
  const code = error instanceof CapyError || error instanceof HostedInitChannelError
    ? error.code
    : ERROR_CODES.SERVICE_ERROR;
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : ERROR_CODES.SERVICE_ERROR;
};

const terminalReceipt = (input: Readonly<{
  runId: string;
  status: InitRunTerminalReceipt['status'];
  code: string | null;
  verification: InitVerification;
  effects: InitRunTerminalReceipt['effects'];
}>): InitRunTerminalReceipt => ({
  v: 1,
  run_id: input.runId,
  receipt_id: randomUUID(),
  status: input.status,
  code: input.code,
  repository_verified: input.verification.repositoryVerified,
  custody_verified: input.verification.custodyVerified,
  effects: input.effects,
  completed_at: new Date().toISOString(),
});

export const buildHostedCompletionPlan = (
  status: InitWorkflowResult['status'],
  verification: InitVerification,
): HostedCompletionPlan => {
  if (status === 'cancelled') {
    return {
      status: 'cancelled',
      code: 'INIT_RUN_CANCELLED',
      effects: 'indeterminate',
      delivery: 'abort',
      failureCode: null,
    };
  }
  if (status === 'failed-after-consent') {
    return {
      status: 'failed',
      code: ERROR_CODES.SERVICE_ERROR,
      effects: 'indeterminate',
      delivery: 'abort',
      failureCode: ERROR_CODES.SERVICE_ERROR,
    };
  }
  if (!verification.repositoryVerified) {
    return {
      status: 'failed',
      code: 'INIT_REPOSITORY_VERIFICATION_FAILED',
      effects: 'indeterminate',
      delivery: 'abort',
      failureCode: 'INIT_REPOSITORY_VERIFICATION_FAILED',
    };
  }
  return {
    status: 'succeeded',
    code: null,
    effects: 'complete',
    delivery: 'finish',
    failureCode: null,
  };
};

const parseRemoteKeep = (value: string): KeepFile | null => {
  const parsed = (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  })();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Readonly<Record<string, unknown>>;
  if (candidate.version !== '3.0'
    || typeof candidate.org_id !== 'string'
    || typeof candidate.project_id !== 'string'
    || typeof candidate.project_name !== 'string'
    || !candidate.variables
    || typeof candidate.variables !== 'object'
    || Array.isArray(candidate.variables)) return null;
  const variables = candidate.variables as Readonly<Record<string, unknown>>;
  const validEntries = Object.values(variables).every((entries) => Array.isArray(entries)
    && entries.every((entry) => entry !== null
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && typeof (entry as Readonly<Record<string, unknown>>).resource_id === 'string'
      && typeof (entry as Readonly<Record<string, unknown>>).value_hash === 'string'
      && ((entry as Readonly<Record<string, unknown>>).branch === undefined
        || typeof (entry as Readonly<Record<string, unknown>>).branch === 'string')));
  return validEntries ? parsed as KeepFile : null;
};

const exactConfiguredOrigin = (value: string): string => {
  const parsed = (() => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  })();
  if (!parsed || parsed.origin !== value || parsed.username || parsed.password) {
    throw new CapyError('Hosted initialization origin is invalid', 'INIT_RUN_CONFIGURATION');
  }
  return value;
};

async function presentInitRunHandoff(bootstrap: InitRunBootstrap): Promise<void> {
  if (!process.stdout.isTTY) return;
  human(`Open ${bootstrap.handoff.entryUrl}`);
  human(`Claim code: ${bootstrap.handoff.claimCode}`);
  await openScreen(bootstrap.handoff.entryUrl, { kind: 'handoff' });
}

async function flushHostedTerminalOutput(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    process.stdout.write('', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export class CapyCommand {
  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly syncEngine: SyncEngine;
  private readonly promptEngine: PromptEngine;
  private readonly options: CliOptions;
  private readonly devMode: boolean;

  constructor(options: CliOptions = {}, devMode: boolean = false) {
    const authService = new AuthService(undefined, devMode);
    this.options = options;
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = authService;
    this.serviceClient = new ServiceClient(undefined, devMode, () => authService.getValidToken());
    this.syncEngine = new SyncEngine();
    this.promptEngine = new PromptEngine();
  }

  /**
   * Bridge ServiceClient to the KeyServiceOps interface for key resolution.
   */
  private keyServiceOps(serviceClient: ServiceClient = this.serviceClient): KeyServiceOps {
    return {
      coDecrypt: (orgId, ciphertext) => serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
      wrapOuterLayer: (orgId, plaintext) => serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
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
      const detectedProjectState = await this.projectManager.detectProjectState();
      const envMeta = detectedProjectState.initialized
        ? {}
        : this.fileManager.readEnvMeta(this.options.envPath);
      const projectState = !detectedProjectState.initialized && envMeta.org_id && envMeta.project_id
        ? {
            ...detectedProjectState,
            initialized: true,
            organizationId: envMeta.org_id,
            projectId: envMeta.project_id,
            activeBranch: envMeta.branch ?? null,
          }
        : detectedProjectState;

      if (!projectState.initialized) {
        // Check if .env has metadata we can recover from (e.g. keep.lock was deleted)
        if (isLocalOnly()) {
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
      const original = error instanceof HostedInitTerminalError ? error.original : error;
      this.debugError('execute caught error', original);
      if (error instanceof HostedInitTerminalError) {
        await flushHostedTerminalOutput();
        process.exit(1);
      }
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(original);
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

    // This conflict is a dead end that used to end on stderr and nothing else.
    // Under `--web` the caller has no terminal by definition, so the one
    // explanation of what broke — and the two commands that fix it — reached
    // nobody. `this.options.web` is already on the instance and `execute()`'s
    // catch ends in `displayErrorAndExit`, so no plumbing is needed: the
    // conflict just has to be thrown rather than printed.
    //
    // The sentences are the terminal's own, carried whole. This state already
    // has words and they are good ones; a second set written for the browser
    // would be two things to keep in step.
    if (this.options.web) {
      throw new CapyError(
        `Local state is inconsistent:\n` +
          `  .capy/branch says ${fileBranch}\n` +
          `  .env was encrypted for ${envBranch}\n\n` +
          `This usually means a previous checkout was interrupted.\n` +
          `Recover with: capy checkout ${envBranch} (re-sync to the branch .env actually holds)\n` +
          `           or: capy checkout ${fileBranch} (finish switching to the branch .capy/branch claims)`,
        ERROR_CODES.CONFLICT_RESOLUTION,
      );
    }
    // Terminal path unchanged, deliberately byte-for-byte.
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
  private async initializeProject(): Promise<void> {
    const mode = this.options.web
      ? await (async () => {
          const selected = await capture(() => resolveInitRunTransportMode(process.env.CAPY_INIT_TRANSPORT));
          if (selected.ok) return selected.value;
          emitInitRunEvent(
            { phase: 'new' },
            initRunUnconfirmedEvent({ kind: 'pre-run', code: terminalCode(selected.error) }),
          );
          throw new HostedInitTerminalError(selected.error);
        })()
      : null;
    if (mode === 'hosted') {
      const result = await capture(() => this.initializeProjectHosted());
      if (!result.ok) throw new HostedInitTerminalError(result.error);
      return;
    }
    await this.initializeProjectWithLocalWizard();
  }

  /** Explicit rollback transport and the unchanged terminal workflow. */
  private async initializeProjectWithLocalWizard(): Promise<void> {
    // Imported only on the `--web` path: the module pulls in every compiled
    // screen, and a terminal run has no use for them.
    //
    // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI / headless
    // verification drive the loopback without hijacking a real browser.
    const wizard: InitWizardTransport | null = this.options.web
      ? { kind: 'local', session: new (await import('../ui/initWizardScreen')).InitWizardSession({
          open: !process.env.CAPY_WEB_NO_OPEN,
        }) }
      : null;
    try {
      const completed = await this.runInitialization(wizard);
      if (completed.wizard?.kind === 'local') await completed.wizard.session.finish();
    } catch (err) {
      if (err instanceof InitWizardPostConsentError) {
        if (err.initWizard.kind === 'local') {
          await err.initWizard.session.reportEncryptFailure(err.failure);
          return;
        }
        throw err;
      }
      // The browser is holding a submit at this point, and it must not be told
      // that submit worked. `abort` replaces the question with what stopped
      // the run — carrying the error's CODE, and the remedy any call site that
      // knew one declared with `willBlock` just before it threw.
      const failedWizard = err instanceof InitWizardFlowError || err instanceof InitWizardCancelledError
        ? err.initWizard
        : wizard;
      if (failedWizard?.kind === 'local') await failedWizard.session.abort(err);
      throw err instanceof InitWizardFlowError ? err.original : err;
    }
  }

  private async initializeProjectHosted(): Promise<void> {
    const preparation = await capture(() => ({
      serviceOrigin: exactConfiguredOrigin(resolveActiveUrl(this.devMode)),
      keepOrigin: exactConfiguredOrigin(keepOrigin()),
      identity: resolveInitRunIdentity(),
    }));
    if (!preparation.ok) {
      emitInitRunEvent(
        { phase: 'new' },
        initRunUnconfirmedEvent({ kind: 'pre-run', code: terminalCode(preparation.error) }),
      );
      throw preparation.error;
    }
    const serviceOrigin = preparation.value.serviceOrigin;
    const keep = preparation.value.keepOrigin;
    const identity = preparation.value.identity;

    const created = await capture(() => createInitRunBootstrap({
      serviceOrigin,
      keepOrigin: keep,
      runtimeId: identity.runtimeId,
      repositoryFingerprint: identity.repositoryFingerprint,
      machineName: identity.machineName,
      expectedUserId: this.options.expectedUserId ?? null,
    }));
    if (!created.ok) {
      emitInitRunEvent(
        { phase: 'new' },
        initRunUnconfirmedEvent({ kind: 'pre-run', code: terminalCode(created.error) }),
      );
      throw created.error;
    }

    const createdEventState = recordInitRunCreated({ phase: 'new' }, created.value.handoff.runId);
    const eventState = emitInitRunEvent(createdEventState, initRunHandoffEvent(created.value.handoff));
    await presentInitRunHandoff(created.value);
    const authorized = await capture(() => completeInitRunAuthentication({
      bootstrap: created.value,
      authService: this.authService,
    }));
    if (!authorized.ok) {
      const code = terminalCode(authorized.error);
      const noEffects = [
        'INIT_RUN_DENIED',
        'INIT_AUTH_SUBJECT_MISMATCH',
      ].includes(code);
      emitInitRunEvent(eventState, initRunUnconfirmedEvent(noEffects ? {
        kind: 'no-effects',
        runId: created.value.handoff.runId,
        status: 'failed',
        code,
      } : {
        kind: 'indeterminate',
        runId: created.value.handoff.runId,
        repositoryVerified: false,
        custodyVerified: false,
      }));
      throw authorized.error;
    }

    const context = {
      transport: 'hosted' as const,
      operationDeadline: Date.parse(authorized.value.expiresAt),
      authService: authorized.value.authService,
      serviceClient: new ServiceClient(
        serviceOrigin,
        this.devMode,
        () => authorized.value.authService.getValidToken(),
      ),
    };
    const channel = await capture(() => openHostedInitChannel({
      broker: new BrokerClient(serviceOrigin, () => resolveInitRunBrokerAccessToken(authorized.value)),
      binding: authorized.value.binding,
      deadline: Date.parse(authorized.value.expiresAt),
      publish: (firstConnectionId) => publishInitRunConnection({
        bootstrap: created.value,
        authorized: authorized.value,
        firstConnectionId,
      }).then(() => undefined),
    }));
    if (!channel.ok) {
      return this.failHostedInitialization({
        bootstrap: created.value,
        authorized: authorized.value,
        eventState,
        context,
        wizard: null,
      }, channel.error, 'none');
    }
    const execution: HostedInitExecution = {
      bootstrap: created.value,
      authorized: authorized.value,
      eventState,
      context,
      wizard: { kind: 'hosted', session: createHostedInitWizardSession(channel.value) },
    };
    const initialized = await capture(() => this.runInitialization(execution.wizard, {
      context: execution.context,
      auth: execution.authorized.auth,
      rebindHostedSession: (session, authService) => ({
        ...session,
        channel: {
          ...session.channel,
          broker: new BrokerClient(serviceOrigin, () => resolveInitRunBrokerAccessToken({
            ...authorized.value,
            authService,
          })),
        },
      }),
    }));
    if (!initialized.ok) {
      const failedWizard = initialized.error instanceof InitWizardFlowError
        || initialized.error instanceof InitWizardPostConsentError
        || initialized.error instanceof InitWizardCancelledError
        ? initialized.error.initWizard
        : execution.wizard;
      const failureAuthService = initialized.error instanceof InitWizardFlowError
        || initialized.error instanceof InitWizardPostConsentError
        || initialized.error instanceof InitWizardCancelledError
        ? initialized.error.authService
        : null;
      return this.failHostedInitialization(
        {
          ...execution,
          authorized: failureAuthService
            ? { ...execution.authorized, authService: failureAuthService }
            : execution.authorized,
          wizard: failedWizard,
        },
        initialized.error,
        'indeterminate',
      );
    }
    await this.completeHostedInitialization(
      {
        ...execution,
        authorized: { ...execution.authorized, authService: initialized.value.context.authService },
        context: initialized.value.context,
        wizard: initialized.value.wizard,
      },
      initialized.value,
    );
  }

  private async failHostedInitialization(
    execution: HostedInitExecution,
    error: unknown,
    effects: 'none' | 'indeterminate',
  ): Promise<never> {
    const original = error instanceof InitWizardFlowError ? error.original : error;
    const cancelled = original instanceof InitWizardCancelledError;
    const terminalEffects = cancelled ? original.effects : effects;
    const receipt = terminalReceipt({
      runId: execution.bootstrap.response.run_id,
      status: cancelled ? 'cancelled' : 'failed',
      code: cancelled ? 'INIT_RUN_CANCELLED' : terminalCode(original),
      verification: { repositoryVerified: false, custodyVerified: false },
      effects: terminalEffects,
    });
    const persisted = await capture(() => recordInitRunTerminal({
      bootstrap: execution.bootstrap,
      authorized: execution.authorized,
      receipt,
    }));
    if (persisted.ok) {
      emitInitRunEvent(execution.eventState, initRunReceiptEvent(receipt));
      const delivery = execution.wizard
        ? await (error instanceof InitWizardPostConsentError
          ? capture(() => reportInitWizardEncryptFailure(
              execution.wizard!,
              error.failure,
              receipt,
            ))
          : capture(() => abortInitWizard(execution.wizard!, original, receipt)))
        : { ok: true as const, value: null };
      if (!delivery.ok && execution.wizard?.kind === 'hosted') {
        const hosted = execution.wizard.session;
        await capture(() => closeHostedInitWizard(hosted));
      }
    } else {
      emitInitRunEvent(execution.eventState, initRunUnconfirmedEvent({
        kind: 'indeterminate',
        runId: execution.bootstrap.response.run_id,
        repositoryVerified: false,
        custodyVerified: false,
      }));
      if (execution.wizard?.kind === 'hosted') {
        const hosted = execution.wizard.session;
        await capture(() => closeHostedInitWizard(hosted));
      }
    }
    throw original;
  }

  private async completeHostedInitialization(
    execution: HostedInitExecution,
    result: InitWorkflowResult,
  ): Promise<void> {
    const verificationAttempt = await capture(() => this.verifyHostedInitialization(
      execution.context,
      result.target,
    ));
    if (!verificationAttempt.ok) {
      return this.failHostedInitialization(execution, verificationAttempt.error, 'indeterminate');
    }
    const verification = verificationAttempt.value;
    const plan = buildHostedCompletionPlan(result.status, verification);
    const receipt = terminalReceipt({
      runId: execution.bootstrap.response.run_id,
      status: plan.status,
      code: plan.code,
      verification,
      effects: plan.effects,
    });
    const persisted = await capture(() => recordInitRunTerminal({
      bootstrap: execution.bootstrap,
      authorized: execution.authorized,
      receipt,
    }));
    if (!persisted.ok) {
      emitInitRunEvent(execution.eventState, initRunUnconfirmedEvent({
        kind: 'indeterminate',
        runId: execution.bootstrap.response.run_id,
        repositoryVerified: verification.repositoryVerified,
        custodyVerified: verification.custodyVerified,
      }));
      if (execution.wizard?.kind === 'hosted') {
        const hosted = execution.wizard.session;
        await capture(() => closeHostedInitWizard(hosted));
      }
      throw persisted.error;
    }
    emitInitRunEvent(execution.eventState, initRunReceiptEvent(receipt));
    if (execution.wizard) {
      const finalDelivery = plan.delivery === 'abort'
        ? await capture(() => abortInitWizard(
            execution.wizard!,
            new CapyError(
              plan.status === 'cancelled' ? 'Initialization cancelled' : 'Initialization verification failed',
              plan.code ?? ERROR_CODES.SERVICE_ERROR,
            ),
            receipt,
          ))
        : await capture(() => finishInitWizard(execution.wizard!, receipt));
      if (!finalDelivery.ok && execution.wizard.kind === 'hosted') {
        const hosted = execution.wizard.session;
        await capture(() => closeHostedInitWizard(hosted));
      }
    }
    if (plan.failureCode) {
      throw new CapyError('Initialization effects could not be verified', plan.failureCode);
    }
  }

  private async verifyHostedInitialization(
    context: InitCommandContext,
    target: InitRepositoryTarget,
  ): Promise<InitVerification> {
    if (context.operationDeadline !== null && Date.now() >= context.operationDeadline) {
      throw new CapyError('Hosted initialization expired', 'INIT_RUN_EXPIRED');
    }
    const keep = this.projectManager.readKeepFile();
    const branch = keep ? this.projectManager.deriveActiveBranch() : null;
    const projects = await context.serviceClient.listProjects();
    const branches = await context.serviceClient.listBranches(target.projectId);
    const remote = await (async () => {
      try {
        return await context.serviceClient.getDecryptData(
          target.projectId,
          target.branch,
          undefined,
          true,
        );
      } catch (error) {
        if (error instanceof CapyError && error.code === ERROR_CODES.NO_SECRETS) return null;
        throw error;
      }
    })();
    const remoteSnapshot = remote === null || remote.keep_file === undefined || remote.keep_file === ''
      ? { kind: 'empty' as const }
      : typeof remote.keep_file === 'string'
        ? (() => {
            const parsed = parseRemoteKeep(remote.keep_file!);
            return parsed
              ? { kind: 'keep' as const, keep: parsed }
              : { kind: 'invalid' as const };
          })()
        : { kind: 'invalid' as const };
    const remoteKeep = remoteSnapshot.kind === 'keep' ? remoteSnapshot.keep : null;
    const localHash = keep ? SyncEngine.computeKeepHash(keep, target.branch) : null;
    const remoteHash = remoteKeep
      ? SyncEngine.computeKeepHash(remoteKeep, target.branch)
      : null;
    const targetMatches = keep?.version === '3.0'
      && keep.org_id === target.orgId
      && keep.project_id === target.projectId
      && keep.project_name === target.projectName
      && branch === target.branch;
    const expectedEntries = keep
      ? Object.entries(keep.variables).flatMap(([name, entries]) => entries
          .filter((entry) => entry.branch === target.branch)
          .map((entry) => ({ name, resourceId: entry.resource_id })))
      : [];
    const localValues = this.fileManager.readEnvFile(this.options.envPath);
    const localNames = Object.keys(localValues);
    const expectedNames = expectedEntries.map((entry) => entry.name);
    const localMetadata = this.fileManager.readEnvMeta(this.options.envPath);
    const localEnvironmentVerified = localNames.length === expectedNames.length
      && localNames.every((name) => expectedNames.includes(name))
      && expectedEntries.every((entry) => localValues[entry.name]?.startsWith(`capy:${entry.resourceId}:`))
      && (expectedEntries.length === 0 || (
        localMetadata.org_id === target.orgId
        && localMetadata.project_id === target.projectId
        && localMetadata.branch === target.branch
      ));
    const remoteTargetMatches = remoteSnapshot.kind === 'empty' || (remoteSnapshot.kind === 'keep' &&
      remoteSnapshot.keep.version === '3.0'
      && remoteSnapshot.keep.org_id === target.orgId
      && remoteSnapshot.keep.project_id === target.projectId
      && remoteSnapshot.keep.project_name === target.projectName
    );
    const repositoryVerified = targetMatches
      && localEnvironmentVerified
      && projects.some((project) => project.id === target.projectId
        && project.name === target.projectName
        && project.organization_id === target.orgId)
      && branches.some((candidate) => (candidate.project_id === undefined || candidate.project_id === target.projectId)
        && candidate.name === target.branch
        && candidate.is_protected === false)
      && remoteTargetMatches
      && (remoteSnapshot.kind === 'keep'
        ? localHash === remoteHash && (remote?.keep_hash === undefined || remote.keep_hash === remoteHash)
        : remoteSnapshot.kind === 'empty' && keep !== null && Object.keys(keep.variables).length === 0);
    const readiness = await context.serviceClient.getSignupReadiness(target.orgId);
    const custodyVerified = readiness.signup_complete === true
      && readiness.retryable === false
      && readiness.custody.key_state === 'minted'
      && readiness.custody.ceremony_pending === false
      && readiness.custody.has_live_wrapped_k_local === true;
    return { repositoryVerified, custodyVerified };
  }

  private async runInitialization(
    wizard: InitWizardTransport | null,
    preparedAuthentication?: PreparedInitAuthentication,
  ): Promise<InitWorkflowResult> {
    this.debug('initializeProject start', { cwd: process.cwd() });
    human('Welcome to Capy\n');

    // Check if sync-state has an org hint (e.g. from a recent `capy redeem`)
    const syncState = this.projectManager.readSyncState();
    const orgHint = syncState?.org_id;

    // Authenticate — pass org hint so session scopes to the right org
    const context = preparedAuthentication?.context ?? {
      transport: 'local' as const,
      operationDeadline: null,
      authService: this.authService,
      serviceClient: this.serviceClient,
    };
    const spinner = ora('Logging in...').start();
    const authResult = preparedAuthentication?.auth ?? await context.authService.authenticate(orgHint);
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
    const wizardAfterAuth = recordWizard(wizard, {
      signedInAs: authResult.user_email || authResult.user_first_name || undefined,
      orgCount: authResult.organizations?.length ?? 0,
    });

    // Persist user ID to sync state immediately so the next `capy` run can find
    // the user-scoped session file at ~/.capy/auth/sessions/{userId}.json.
    // Without this, sync-state has no user_id, detectProjectState returns
    // undefined, AuthService loads from the unscoped path and finds nothing,
    // and the user is sent through OAuth again.
    if (authResult.user_id) {
      await withWizard(
        wizardAfterAuth,
        () => this.projectManager.writeSyncStateUserId(authResult.user_id!),
        context.operationDeadline,
      );
    }

    // Resolve organization
    const orgs = authResult.organizations || [];
    const CREATE_NEW_ORG = '__create_new__';
    const refreshToken = authResult._refresh_token || context.authService.getToken()?.refresh_token;

    const currentOrgId = authResult.organization_id;
    const currentOrg = orgs.find(o => o.id === currentOrgId);

    const organizationSelection = await (async (): Promise<Readonly<{
      selectedOrg: Organization;
      wizard: InitWizardTransport | null;
      effectsStarted: boolean;
      context: InitCommandContext;
      auth: AuthResult;
      custodyDeclined: boolean;
    }>> => {
      if (orgs.length === 0) {
        human('\nNo organization found. Let\'s create one.');
        if (context.transport === 'hosted') {
          if (wizardAfterAuth?.kind !== 'hosted' || context.operationDeadline === null
            || !preparedAuthentication?.rebindHostedSession) {
            throw new InitWizardFlowError(
              new CapyError('Hosted organization transport was unavailable', 'INIT_RUN_INVALID'),
              wizardAfterAuth,
            );
          }
          const created = await createHostedFreshOrganization({
            auth: authResult,
            authService: context.authService,
            deadline: context.operationDeadline,
            serviceOrigin: context.authService.getServiceApiUrl(),
            session: wizardAfterAuth.session,
            rebindSession: preparedAuthentication.rebindHostedSession,
          });
          const createdWizard: InitWizardTransport = { kind: 'hosted', session: created.session };
          if (created.kind === 'cancelled') {
            throw new InitWizardCancelledError(createdWizard, created.effects, created.authService ?? null);
          }
          if (created.kind === 'failed') {
            throw new InitWizardFlowError(created.error, createdWizard, created.authService ?? null);
          }
          if (!created.enrollment.ok
            && created.enrollment.code === ERROR_CODES.DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE) {
            throw new InitWizardFlowError(
              new CapyError('Device-key enrollment did not complete', created.enrollment.code),
              createdWizard,
              created.authService,
            );
          }
          const replacementContext: InitCommandContext = {
            transport: 'hosted',
            operationDeadline: context.operationDeadline,
            authService: created.authService,
            serviceClient: created.serviceClient,
          };
          const recorded = await capture(() => recordWizard(createdWizard, {
            organization: { kind: 'new', name: created.organization.name },
            recoveryShown: true,
            hasOrgKey: hasOrgKey(created.organization.id, created.auth.user_id!),
          }));
          if (!recorded.ok) {
            throw new InitWizardFlowError(recorded.error, createdWizard, created.authService);
          }
          return {
            selectedOrg: created.organization,
            wizard: recorded.value,
            effectsStarted: true,
            context: replacementContext,
            auth: created.auth,
            custodyDeclined: !created.enrollment.ok,
          };
        }
      // CAP-382 Case A: a genuinely zero-org identity's exchange carries the
      // Wave-B org-less token — flag-gated, and a no-op (org creation is
      // byte-identical) when the flag is off or no such token was captured.
      const deviceKeyEnrollment = deviceKeysEnabled()
        ? {
            ctx: this.deviceKeyWiringContext(context, authResult, undefined),
            orglessToken: authResult._orgless_access_token,
          }
        : undefined;
      const created = await withWizard(
        wizardAfterAuth,
        () => this.createNewOrganization(context, refreshToken!, authResult.user_id!, deviceKeyEnrollment),
        context.operationDeadline,
      );
      const selectedOrg = created.organization;
      const createdContext: InitCommandContext = {
        ...context,
        authService: created.authService,
        serviceClient: created.serviceClient,
      };
      return { selectedOrg, wizard: recordWizard(wizardAfterAuth, {
        organization: { kind: 'new', name: selectedOrg.name },
        recoveryShown: true,
      }), effectsStarted: true, context: createdContext, auth: created.auth, custodyDeclined: false };

    }
      const choice = await askWizard(
        wizardAfterAuth,
        organizationQuestion(orgs.map(o => ({ id: o.id, name: o.name, isCurrent: o.id === currentOrgId }))),
        async () => {
        // No TTY under --web (e.g. driven through the MCP): the picker is the
        // wizard's `organization` stop, which carries the same list and the
        // same "create new" row an inquirer prompt would have shown — and, on
        // the rail beside it, the five stops that come after.
        // CAP-567. The org picker is a human-only stop, and until now it was
        // the ONLY one on this path with no non-interactive guard. With stdin
        // piped — which is how every agent runs this, including the hosted MCP
        // whose instruction is a bare `capy onboard` — inquirer opened the
        // list, hit EOF, and raised `ExitPromptError`. That is the same
        // exception a human's Ctrl-C raises, and `ui/errorScreen.ts` rightly
        // treats Ctrl-C as `process.exit(0)`.
        //
        // So `capy onboard` over a pipe EXITED 0 having done nothing: no
        // keep.lock, no AGENTS.md, the .env still plaintext. Silent, and
        // indistinguishable from success to the only caller that can't see the
        // picker it stopped at.
        //
        // `ui/interactive.ts` already forbids exactly this — "never render a
        // picker that EOFs to a silent cancel" — and already provides the
        // refusal and the reserved exit code. This stop simply never adopted
        // them. Checked BEFORE the prompt is constructed, the same ordering
        // EDIT_SCREEN_UNSAFE_SURFACE's comment argues for: discovering "no
        // TTY" from ExitPromptError at the first keypress read is too late.
        const { isInteractive, refuseNonInteractive } = await import('../ui/interactive');
        if (!isInteractive()) {
          refuseNonInteractive(
            'choosing an organization is a decision this command cannot make for you, and stdin is not a terminal',
            'Re-run with --web to answer it in a browser — the same picker, on a page you can open from any device.',
          );
        }
        const answer = await inquirer.prompt([{
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
        }]);
        return String(answer.orgId);
      },
    );
      if (choice.value === null) {
        throw new InitWizardCancelledError(choice.wizard, 'none');
      }
      const orgId = choice.value === 'create' ? CREATE_NEW_ORG : choice.value;

      if (orgId === CREATE_NEW_ORG) {
        const created = await withWizard(
          choice.wizard,
          () => this.createNewOrganization(context, refreshToken!, authResult.user_id!),
          context.operationDeadline,
        );
        const selectedOrg = created.organization;
        const createdContext: InitCommandContext = {
          ...context,
          authService: created.authService,
          serviceClient: created.serviceClient,
        };
        // Naming it and being shown the phrase both happened, elsewhere. The
        // rail settles those two stops rather than leaving them ◌ behind a
        // fork this run has already taken.
        const wizardAfterCreate = recordWizard(choice.wizard, {
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
          await withWizard(wizardAfterCreate, () => syncOrgOntoDeviceKeyIfEnrolled(
            this.deviceKeyWiringContext(createdContext, created.auth, selectedOrg.id),
            selectedOrg.id,
          ), context.operationDeadline);
        }
        return {
          selectedOrg, wizard: wizardAfterCreate, effectsStarted: true,
          context: createdContext, auth: created.auth, custodyDeclined: false,
        };
      } else if (currentOrg && orgId === currentOrg.id) {
        return {
          selectedOrg: currentOrg, wizard: choice.wizard, effectsStarted: false,
          context, auth: authResult, custodyDeclined: false,
        };

      } else {
        const selectedOrg = orgs.find(o => o.id === orgId)!;

        const orgSpinner = ora('Switching organization...').start();
        const refreshed = await withWizard(choice.wizard, () => context.authService.refreshWithCredentials(
          refreshToken!,
          selectedOrg.id,
          authResult.user_id,
        ), context.operationDeadline);
        const refreshedContext: InitCommandContext = {
          ...context,
          authService: refreshed.authService,
          serviceClient: new ServiceClient(
            refreshed.authService.getServiceApiUrl(),
            this.devMode,
            () => refreshed.authService.getValidToken(),
          ),
        };
        const authAttempt = refreshed.auth.success ? { auth: refreshed.auth, spinner: orgSpinner } : await (async () => {
          orgSpinner.stop();
          if (context.transport === 'hosted') {
            throw new InitWizardFlowError(
              new CapyError(
                refreshed.auth.error || 'Organization authentication failed',
                'INIT_AUTH_REAUTH_REQUIRED',
              ),
              choice.wizard,
              refreshed.authService,
            );
          }
          const retrySpinner = ora('Re-authenticating...').start();
          refreshed.authService.clearToken();
          const authenticated = await withWizard(
            choice.wizard,
            () => refreshed.authService.authenticate(selectedOrg.id),
            context.operationDeadline,
          );
          if (!authenticated.success) {
            retrySpinner.fail('Failed to authenticate with organization');
            throw new CapyError(
              authenticated.error || 'Organization authentication failed',
              ERROR_CODES.AUTH_FAILED
            );
          }
          return { auth: authenticated, spinner: retrySpinner };
        })();
        const refreshedWizard = (() => {
          if (choice.wizard?.kind !== 'hosted') return choice.wizard;
          const rebindHostedSession = preparedAuthentication?.rebindHostedSession;
          if (!rebindHostedSession) {
            throw new InitWizardFlowError(
              new CapyError('Could not bind the selected organization session', 'INIT_DELIVERY_INDETERMINATE'),
              choice.wizard,
              refreshed.authService,
            );
          }
          return {
            ...choice.wizard,
            session: rebindHostedSession(choice.wizard.session, refreshed.authService),
          };
        })();
        authAttempt.spinner.succeed(`Organization: ${selectedOrg.name}`);
        return {
          selectedOrg, wizard: refreshedWizard, effectsStarted: false,
          context: refreshedContext, auth: authAttempt.auth, custodyDeclined: false,
        };
      }
    })();
    const selectedOrg = organizationSelection.selectedOrg;
    const initialOrganizationWizard = organizationSelection.wizard;
    const selectedContext = organizationSelection.context;
    const selectedAuth = organizationSelection.auth;
    const initiallyHasOrgKey = hasOrgKey(selectedOrg.id, selectedAuth.user_id!);
    const hostedUnlock = selectedContext.transport === 'hosted' && !initiallyHasOrgKey
      && initialOrganizationWizard?.kind === 'hosted'
      ? await unlockHostedOrganization({
          auth: selectedAuth,
          authService: selectedContext.authService,
          serviceClient: selectedContext.serviceClient,
          organizationId: selectedOrg.id,
          session: initialOrganizationWizard.session,
        }).catch((error: unknown) => ({
          kind: 'failed' as const, session: initialOrganizationWizard.session, error,
        }))
      : null;
    const wizardAfterOrganization: InitWizardTransport | null = hostedUnlock
      ? { kind: 'hosted', session: hostedUnlock.session }
      : initialOrganizationWizard;
    const initializationEffectsStarted = organizationSelection.effectsStarted
      || (hostedUnlock?.kind === 'finished' && hostedUnlock.effectsStarted);
    try {

    if (hostedUnlock?.kind === 'cancelled') {
      throw new InitWizardCancelledError(wizardAfterOrganization, 'none');
    }
    if (hostedUnlock?.kind === 'failed') {
      throw new InitWizardFlowError(hostedUnlock.error, wizardAfterOrganization, selectedContext.authService);
    }

    // A browser assertion alone does not prove that the selected org's key
    // was installed. Require the engine outcome and the actual local file.
    const hasKeyAfterHostedUnlock = initiallyHasOrgKey
      || (hostedUnlock?.kind === 'finished' && hostedUnlock.installedCurrentOrg
        && hasOrgKey(selectedOrg.id, selectedAuth.user_id!));

    // Hosted unlock has already used the current encrypted init channel.
    // Keep the existing flag-gated browser ceremony for local transport.
    const afterUnlockHasOrgKey = selectedContext.transport === 'hosted'
      ? hasKeyAfterHostedUnlock
      : !initiallyHasOrgKey && deviceKeysEnabled()
      ? await (async () => {
          const unlock = await withWizard(
            wizardAfterOrganization,
            () => attemptCaseCUnlock(this.deviceKeyWiringContext(selectedContext, selectedAuth, selectedOrg.id)),
            selectedContext.operationDeadline,
          );
          return unlock.ok && hasOrgKey(selectedOrg.id, selectedAuth.user_id!);
        })()
      : initiallyHasOrgKey;

    // A brand-new invitee who already pasted their code into Keep
    // has a pending pickup row waiting server-side. Case C above no-ops for
    // them (no live doors yet, so detectOnboardingCase never reaches
    // 'unlock') and would otherwise dead-end into the KEY_NOT_ON_DEVICE
    // message below. Additive and side-effect-free on every other user:
    // attemptPickupConsumption never throws, and a caller with no pending
    // pickup (the overwhelming common case) gets `{ ok: false }` and this
    // run continues exactly as it does today.
    const afterPickupHasOrgKey = selectedContext.transport !== 'hosted'
      && !afterUnlockHasOrgKey && deviceKeysEnabled()
      ? await (async () => {
          const pickup = await withWizard(
            wizardAfterOrganization,
            () => attemptPickupConsumption(this.deviceKeyWiringContext(selectedContext, selectedAuth, selectedOrg.id)),
            selectedContext.operationDeadline,
          );
          return pickup.ok && hasOrgKey(selectedOrg.id, selectedAuth.user_id!);
        })()
      : afterUnlockHasOrgKey;

    // Master-key mint chokepoint: an auto-provisioned personal org has no
    // key for ANY device until an owner first mints one — still true after
    // the Case C unlock attempt above, since there is nothing to unlock. If
    // this org's own key_state (from the auth-response org list already in
    // hand) says nobody has minted M yet, and this run can safely show a
    // recovery phrase, mint it here instead of falling straight to the
    // invite-code remedy below.
    const orgKeyPresent = selectedContext.transport !== 'hosted' && !afterPickupHasOrgKey
      && shouldAttemptMint(orgs.find(o => o.id === selectedOrg.id)?.key_state, this.options.web)
      ? await (async () => {
          const { mintMasterKeyForOrg } = await import('../auth/masterKeyMint');
          try {
            await withWizard(wizardAfterOrganization, () => mintMasterKeyForOrg({
              orgId: selectedOrg.id,
              userId: selectedAuth.user_id!,
              serviceClient: selectedContext.serviceClient,
              keyServiceOps: this.keyServiceOps(selectedContext.serviceClient),
              web: this.options.web,
            }), selectedContext.operationDeadline);
            return hasOrgKey(selectedOrg.id, selectedAuth.user_id!);
          } catch {
            // KEY_ALREADY_MINTED / KEY_MINT_IN_PROGRESS / unsafe-surface — fall
            // through to the existing "no key on this device" remedy below.
            return false;
          }
        })()
      : afterPickupHasOrgKey;

    const wizardAfterOrgKey = recordWizard(wizardAfterOrganization, { hasOrgKey: orgKeyPresent });
    if (!orgKeyPresent) {
      // The most common way this run stops, and it stops one step after the
      // browser answered a question — so the page would otherwise be told the
      // organization it just picked went through. `redeem` is on the rail from
      // the start for exactly this; the run stops standing on it.
      //
      // Stated in fields rather than left for the message below to be mined
      // for: the remedy is a command, not a sentence that happens to contain
      // one.
      const blockedWizard = wizardAfterOrgKey ? blockInitWizard(wizardAfterOrgKey, 'redeem', {
          code: ERROR_CODES.AUTH_FAILED,
          title: 'This device does not hold this organization\'s key',
          detail:
            'You have access to the organization, but the shared encryption key has never been transferred to this device. An owner can send you an invite code; redeeming it moves the key here. Then run capy again in this directory.',
          remedy: 'capy redeem <code>',
        }, { facts: [{ label: 'Organization', value: selectedOrg.name }] }) : null;
      // Its own code, not AUTH_FAILED: signing in again cannot fix this, and a
      // caller that has to tell the two apart must not do it by reading the
      // sentence. The message is unchanged.
      const error = new CapyError(
        `You have access to "${selectedOrg.name}" but no encryption key on this device.\n\n` +
        '  Ask your org owner for an invite code, then run:\n\n' +
        '    capy redeem <code>\n\n' +
        '  This will securely transfer the shared encryption key to your device.',
        ERROR_CODES.KEY_NOT_ON_DEVICE
      );
      throw new InitWizardFlowError(error, blockedWizard);
    }

    // CAP-382: this machine is enrollment-aware (orgKeyPresent is true, one
    // way or another) — retry any owed key.enc upload left by a previous
    // interrupted sync. Best-effort, flag-gated, never blocks this run.
    if (deviceKeysEnabled()) {
      await withWizard(wizardAfterOrgKey, () => runPendingSyncBestEffort(
        this.deviceKeyWiringContext(selectedContext, selectedAuth, selectedOrg.id),
      ), selectedContext.operationDeadline);

      // Final-gate MAJOR-5: the ordinary-run on-ramp into enrollment. Only
      // fires when this machine has a local root but the account holds zero
      // live doors (Case B); declinable, isInteractive()-gated (a no-op
      // under --web/MCP/CI), and shown at most once per machine — see
      // maybeNudgeDeviceKeyEnrollment's own doc for the eligibility check
      // and the decline-persistence marker.
      if (selectedContext.transport === 'hosted') {
        const readiness = await withWizard(
          wizardAfterOrgKey,
          () => selectedContext.serviceClient.getSignupReadiness(selectedOrg.id),
          selectedContext.operationDeadline,
        );
        if (!readiness.signup_complete && !organizationSelection.custodyDeclined) {
          throw new InitWizardFlowError(
            new CapyError(
              'Hosted device-key ceremony is required before initialization can continue',
              'INIT_HOSTED_DEVICE_CEREMONY_REQUIRED',
            ),
            wizardAfterOrgKey,
          );
        }
      } else {
        await withWizard(wizardAfterOrgKey, () => maybeNudgeDeviceKeyEnrollment(
          this.deviceKeyWiringContext(selectedContext, selectedAuth, selectedOrg.id),
          selectedOrg.name,
        ), selectedContext.operationDeadline);
      }
    }

    // Discover existing projects in the org. If any exist, give the user the
    // choice to bootstrap one of them OR create a new project. This is the path
    // a teammate hits when cloning a repo with no committed keep.lock.
    const CREATE_NEW_PROJECT = '__create_new_project__';
    // "The lookup failed" and "this org has none" both end up as an empty list
    // here, and they are not the same fact: one walks the user into creating a
    // second project alongside one they already have. The rail says which.
    const projectLookup = await (async (): Promise<Readonly<{
      projects: readonly Readonly<{ id: string; name: string; organization_id: string }>[];
      unavailable: boolean;
    }>> => {
      try {
        const listSpinner = ora('Looking for existing projects...').start();
        const projects = await withWizard(
          wizardAfterOrgKey,
          () => selectedContext.serviceClient.listProjects(),
          selectedContext.operationDeadline,
        );
        listSpinner.stop();
        this.debug('listProjects response', projects);
        return { projects, unavailable: false };
      } catch (err) {
        if (err instanceof InitWizardFlowError) throw err;
        this.debugError('listProjects failed', err);
        return { projects: [], unavailable: true };
      }
    })();
    const existingProjects = projectLookup.projects;
    const projectsUnavailable = projectLookup.unavailable;
    const wizardAfterProjects = recordWizard(wizardAfterOrgKey, { projectCount: existingProjects.length, projectsUnavailable });

    if (existingProjects.length > 0) {
      const choices = [
        { name: 'New project', value: CREATE_NEW_PROJECT },
        ...existingProjects.map(p => ({
          name: p.name,
          value: p.id,
        })),
      ];

      const choice = await askWizard(
        wizardAfterProjects,
        projectQuestion(existingProjects.map(p => ({ id: p.id, name: p.name }))),
        async () => {
          const answer = await inquirer.prompt([{
          type: 'list',
          name: 'projectChoice',
          message: 'Which project do you want to use?',
          choices,
          default: CREATE_NEW_PROJECT,
          }]);
          return String(answer.projectChoice);
        },
      );
      if (choice.value === null) {
        throw new InitWizardCancelledError(
          choice.wizard,
          initializationEffectsStarted ? 'indeterminate' : 'none',
        );
      }
      const projectChoice = choice.value === 'new' ? CREATE_NEW_PROJECT : choice.value;

      if (projectChoice !== CREATE_NEW_PROJECT) {
        const picked = existingProjects.find(p => p.id === projectChoice)!;
        await withWizard(choice.wizard, () => this.bootstrapExistingProject(
          picked,
          selectedOrg.id,
          selectedAuth.user_id!,
          selectedContext,
        ), selectedContext.operationDeadline);
        return {
          wizard: choice.wizard,
          target: {
            orgId: selectedOrg.id,
            orgName: selectedOrg.name,
            projectId: picked.id,
            projectName: picked.name,
            branch: 'development',
          },
          status: 'succeeded',
          context: selectedContext,
        };
      }
      return await this.initializeNewProject(
        selectedContext,
        selectedAuth,
        selectedOrg,
        choice.wizard,
        initializationEffectsStarted,
      );
    }
    return await this.initializeNewProject(
      selectedContext,
      selectedAuth,
      selectedOrg,
      wizardAfterProjects,
      initializationEffectsStarted,
    );
    } catch (error) {
      if (selectedContext.transport !== 'hosted') throw error;
      throw bindInitWizardAuthority(error, selectedContext.authService, wizardAfterOrganization);
    }
  }

  private async initializeNewProject(
    context: InitCommandContext,
    authResult: AuthResult,
    selectedOrg: Organization,
    wizard: InitWizardTransport | null,
    priorEffectsStarted = false,
  ): Promise<InitWorkflowResult> {
    // Prompt for project name
    const defaultName = this.projectManager.getDefaultProjectName();
    const named = await askWizard(
      wizard,
      projectNameQuestion(defaultName),
      () => this.promptEngine.promptForProjectName(defaultName),
    );
    if (named.value === null) {
      throw new InitWizardCancelledError(
        named.wizard,
        priorEffectsStarted ? 'indeterminate' : 'none',
      );
    }
    const projectName = named.value;
    const wizardAfterProjectName = named.wizard;

    // Initialize project on service
    const initSpinner = ora('Creating project...').start();
    const projectResult = await withWizard(wizardAfterProjectName, () => context.serviceClient.initializeProject(
      projectName,
      selectedOrg.id,
    ), context.operationDeadline);
    initSpinner.succeed(`Project created: ${projectName} (development)`);

    const keySpinner = ora('Generating encryption keys...').start();

    // Derive project encryption key from master key (requires server co-decrypt)
    const encryptionKey = await withWizard(wizardAfterProjectName, () => resolveProjectKey(
      selectedOrg.id,
      projectResult.project_id,
      authResult.user_id!,
      this.keyServiceOps(context.serviceClient),
    ), context.operationDeadline);

    // Create keep file (v3 format)
    const keep: KeepFile = {
      version: '3.0',
      org_id: projectResult.org_id,
      project_id: projectResult.project_id,
      project_name: projectResult.project_name,
      variables: {}
    };

    await withWizard(
      wizardAfterProjectName,
      () => this.fileManager.writeKeepFile(keep),
      context.operationDeadline,
    );

    keySpinner.succeed('keep.lock created (0 secrets)');

    // Create the initial branch. `POST /projects` no longer auto-creates
    // one, so pick the name: default 'development', or a custom name the
    // user enters. Protection isn't asked here - branches are unprotected
    // by default and can be protected later via a dedicated action.
    const branchChoice = await askWizard(
      wizardAfterProjectName,
      branchChoiceQuestion(),
      async () => {
        const answer = await inquirer.prompt([{
        type: 'list',
        name: 'initialBranchChoice',
        message: 'What branch should this project start with?',
        choices: [
          { name: 'development (default)', value: 'development' },
          { name: 'another branch', value: 'other' },
        ],
        }]);
        return answer.initialBranchChoice as 'development' | 'other';
      },
    );
    if (branchChoice.value === null) {
      throw new InitWizardCancelledError(branchChoice.wizard, 'indeterminate');
    }
    const initialBranchChoice = branchChoice.value;

    const branchName = initialBranchChoice === 'other'
      ? await askWizard(
        branchChoice.wizard,
        branchNameQuestion(),
        async () => {
          const answer = await inquirer.prompt([{
          type: 'input',
          name: 'branchName',
          message: 'Branch name:',
          validate: (input: string) => input.trim().length > 0 || 'Branch name cannot be empty',
          }]);
          return String(answer.branchName).trim();
        },
      )
      : { value: 'development' as const, wizard: branchChoice.wizard };
    if (branchName.value === null) {
      throw new InitWizardCancelledError(branchName.wizard, 'indeterminate');
    }
    const initialBranchName = branchName.value;
    const wizardAfterBranch = branchName.wizard;
    const initialBranchProtected = false;

    const branchSpinner = ora(`Creating branch ${initialBranchName}...`).start();
    try {
      await withWizard(wizardAfterBranch, () => context.serviceClient.createBranch(
        projectResult.project_id,
        initialBranchName,
        initialBranchProtected,
      ), context.operationDeadline);
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
    await withWizard(
      wizardAfterBranch,
      () => this.projectManager.writeActiveBranch(initialBranchName),
      context.operationDeadline,
    );

    // Update gitignore
    await withWizard(
      wizardAfterBranch,
      () => this.fileManager.ensureCapyGitignore(),
      context.operationDeadline,
    );
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
      const storedLocalEnv = this.fileManager.readEnvFile(this.options.envPath);
      const localVarCount = Object.keys(storedLocalEnv).length;
      // The last stop stops being a blank the moment the directory is read: an
      // empty .env is a stop this run will not visit, and the rail says so
      // rather than leaving it looking outstanding.
      const wizardAfterEnvCount = recordWizard(wizardAfterBranch, { localEnvCount: localVarCount });

      if (localVarCount > 0) {
        // Cross-org exfiltration guard
        const encryptedEntries = Object.entries(storedLocalEnv)
          .filter(([_, value]) => value.startsWith('capy:'));

        const foreignKeys = encryptedEntries.flatMap(([key, value]) => {
          try {
            this.fileManager.decryptValue(value, encryptionKey);
            return [];
          } catch {
            return [key];
          }
        });

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
            const blockedWizard = wizardAfterEnvCount ? blockInitWizard(wizardAfterEnvCount, 'encrypt', {
                code: ERROR_CODES.PERMISSION_DENIED,
                title: 'This .env holds values encrypted to a different project',
                detail:
                  'These variables cannot be read with this organization\'s key, so they cannot be pushed to it. Delete the .env file, or replace those values with plaintext, and run capy again.',
                remedy: 'capy',
              }, { names: foreignKeys }) : null;
            throw new InitWizardFlowError(new CapyError(
              'Cannot push secrets encrypted with a different project\'s key to a new org',
              ERROR_CODES.PERMISSION_DENIED,
              { foreignKeys }
            ), blockedWizard);
        }

        // Values encrypted to this project are decrypted in a fresh record.
        const localEnv = Object.fromEntries(Object.entries(storedLocalEnv).map(([key, value]) => [
          key,
          value.startsWith('capy:') ? this.fileManager.decryptValue(value, encryptionKey) : value,
        ]));

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
        const consent = await askWizard(
          wizardAfterEnvCount,
          encryptQuestion(
            { count: localVarCount, names: varNames },
            { projectName, orgName: selectedOrg.name, branch: initBranch },
          ),
          async () => {
          // NAMES and a count reach the page — never a value, and not even a
          // snippet of one. The whole question this stop asks is whether these
          // may stop being plaintext, and showing more than the terminal shows
          // in order to ask it would answer part of it first.
          //
          // A closed window is a "no": `askEncrypt` resolves false on cancel,
          // which is the same thing `chosen === 'yes'` already meant.
          const answer = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmEncrypt',
            message: `Encrypt these ${localVarCount} secrets and push to ${B(projectName)} (${selectedOrg.name}) on ${B(initBranch)}?`,
            default: true,
          }]);
          return answer.confirmEncrypt === true;
        },
      );
        const confirmEncrypt = consent.value === true;

        if (!confirmEncrypt) {
          human(`\nSkipped. Your .env was not modified.`);
          human(`Run ${B('capy')} again from the correct project directory, or run ${B('capy push')} when ready.`);
          return {
            wizard: consent.wizard,
            target: {
              orgId: selectedOrg.id,
              orgName: selectedOrg.name,
              projectId: projectResult.project_id,
              projectName,
              branch: initBranch,
            },
            status: 'cancelled',
            context,
          };
        }

        const syncSpinner = ora('Syncing local variables...').start();

        const syncResult = await withWizard(consent.wizard, () => this.syncInitialEnvironment({
          context,
          authResult,
          encryptionKey,
          initBranch,
          keep,
          localEnv,
          localVarCount,
          projectResult,
        }), context.operationDeadline);
        if (!syncResult.ok) {
          const syncError = syncResult.error;
          const reason = syncError instanceof Error && syncError.message ? syncError.message : 'The push failed.';
          syncSpinner.fail(`Failed to sync variables: ${reason}`);
          human(`You can run ${B('capy')} again to retry syncing`);
          // This is the one failure that happens after the last question, and
          // the terminal path swallows it and carries on — which under --web
          // used to mean the run ended with `finish()` and the page drew a
          // green check over a push that did not happen. The browser gets the
          // same three facts the terminal cannot state: whether the values
          // reached Keep, whether the plaintext copy was kept, and whether the
          // .env in this directory is ciphertext now.
          const failure = {
            code: syncError instanceof CapyError ? syncError.code : ERROR_CODES.SERVICE_ERROR,
            reason,
            ...syncResult.effects,
          };
          if (consent.wizard) throw new InitWizardPostConsentError(failure, consent.wizard);
          return {
            wizard: null,
            target: {
              orgId: selectedOrg.id,
              orgName: selectedOrg.name,
              projectId: projectResult.project_id,
              projectName,
              branch: initBranch,
            },
            status: 'failed-after-consent',
            context,
          };
        }
        syncSpinner.succeed(`keep.lock created (pinned to ${initBranch}, ${localVarCount} secrets)`);
        return {
          wizard: consent.wizard,
          target: {
            orgId: selectedOrg.id,
            orgName: selectedOrg.name,
            projectId: projectResult.project_id,
            projectName,
            branch: initBranch,
          },
          status: 'succeeded',
          context,
        };
      } else {
        human(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
        human('to share them with your team.');

        // Install git hooks
        this.installGitHooks();
        return {
          wizard: wizardAfterEnvCount,
          target: {
            orgId: selectedOrg.id,
            orgName: selectedOrg.name,
            projectId: projectResult.project_id,
            projectName,
            branch: initialBranchName,
          },
          status: 'succeeded',
          context,
        };
      }
    } else {
      const wizardWithoutEnv = recordWizard(wizardAfterBranch, { localEnvCount: 0 });
      human(`\nNo .env file found. Add secrets to .env, then run ${B('capy push')}`);
      human('to share them with your team.');

      // Install git hooks
      this.installGitHooks();
      return {
        wizard: wizardWithoutEnv,
        target: {
          orgId: selectedOrg.id,
          orgName: selectedOrg.name,
          projectId: projectResult.project_id,
          projectName,
          branch: initialBranchName,
        },
        status: 'succeeded',
        context,
      };
    }
  }

  private async syncInitialEnvironment(input: Readonly<{
    context: InitCommandContext;
    authResult: AuthResult;
    encryptionKey: string;
    initBranch: string;
    keep: KeepFile;
    localEnv: Readonly<Record<string, string>>;
    localVarCount: number;
    projectResult: Readonly<{ org_id: string; project_id: string }>;
  }>): Promise<Readonly<
    | { ok: true }
    | {
      ok: false;
      error: unknown;
      effects: Readonly<{ pushed: boolean; backupWritten: boolean; envRewritten: boolean }>;
    }
  >> {
    const prepared = await capture(async () => {
      const { createHash } = await import('crypto');
      const { deriveResourceId } = await import('../crypto/resourceId');
      const { Encryptor } = await import('../crypto/encryptor');
      const encryptedRows = Object.entries(input.localEnv).map(([key, value]) => {
        const resourceId = deriveResourceId(input.initBranch, key);
        return {
          key,
          encrypted: `capy:${resourceId}:${Encryptor.encrypt(value, input.encryptionKey)}`,
          metadata: {
            resource_id: resourceId,
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          },
        } as const;
      });
      const encrypted = Object.fromEntries(encryptedRows.map((row) => [row.key, row.encrypted]));
      const pushedVars = Object.fromEntries(encryptedRows.map((row) => [row.key, row.metadata]));
      const envBlob = Object.entries(encrypted).map(([key, value]) => `${key}=${value}`).join('\n');
      const updatedKeep = this.syncEngine.mergeWithKeep(input.keep, pushedVars, input.initBranch);
      return { envBlob, updatedKeep };
    });
    if (!prepared.ok) {
      return { ok: false, error: prepared.error, effects: { pushed: false, backupWritten: false, envRewritten: false } };
    }

    const pushed = await capture(() => input.context.serviceClient.pushSecrets(
      input.projectResult.project_id,
      JSON.stringify(prepared.value.updatedKeep),
      prepared.value.envBlob,
      input.initBranch,
    ));
    if (!pushed.ok) {
      return { ok: false, error: pushed.error, effects: { pushed: false, backupWritten: false, envRewritten: false } };
    }

    const localMetadata = await capture(() => {
      this.fileManager.writeKeepFile(
        SyncEngine.adoptServerKeep(pushed.value.keep_file, prepared.value.updatedKeep, input.initBranch),
      );
      const initKeepHash = SyncEngine.computeKeepHash(prepared.value.updatedKeep, input.initBranch);
      writeKeepCache(input.projectResult.org_id, input.projectResult.project_id, initKeepHash, prepared.value.envBlob);
      this.fileManager.writeSyncState({
        last_sync: new Date().toISOString(),
        synced_variables: Object.keys(input.localEnv),
        user_id: input.authResult.user_id,
        keep_hash: setSyncKeepHash(null, input.initBranch, initKeepHash),
      });
    });
    if (!localMetadata.ok) {
      return { ok: false, error: localMetadata.error, effects: { pushed: true, backupWritten: false, envRewritten: false } };
    }

    const backup = await capture(() => this.fileManager.backupPlaintextEnv(this.options.envPath));
    if (!backup.ok) {
      return { ok: false, error: backup.error, effects: { pushed: true, backupWritten: false, envRewritten: false } };
    }

    const rewritten = await capture(() => {
      this.fileManager.writeEncryptedEnvFile(
        { ...input.localEnv },
        input.encryptionKey,
        undefined,
        prepared.value.updatedKeep,
        input.initBranch,
      );
    });
    if (!rewritten.ok) {
      return { ok: false, error: rewritten.error, effects: { pushed: true, backupWritten: true, envRewritten: false } };
    }

    const localFinish = await capture(async () => {
      const { autoCommitKeep } = await import('../git/autoCommitKeep');
      autoCommitKeep(input.initBranch);
      this.installGitHooks();
      human(`\nYour .env is now encrypted. To run your app with decrypted secrets,`);
      human(`prefix your command with ${B('capy run')} (e.g. ${B('capy run -- npm start')}).`);
      human(`See: https://docs.capy.sc/using/running-your-app`);
      human(`\nRun ${B('capy push')} to share your secrets with teammates.`);
    });
    return localFinish.ok
      ? { ok: true }
      : { ok: false, error: localFinish.error, effects: { pushed: true, backupWritten: true, envRewritten: true } };
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
    context: InitCommandContext = {
      transport: 'local',
      operationDeadline: null,
      authService: this.authService,
      serviceClient: this.serviceClient,
    },
  ): Promise<void> {
    const branch = 'development';
    const encryptionKey = await resolveProjectKey(orgId, project.id, userId, this.keyServiceOps(context.serviceClient));

    const fetchSpinner = ora(`Pulling ${project.name} (${branch})...`).start();

    const decryptData = await (async () => {
      try {
        return await context.serviceClient.getDecryptData(
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
          human(`\n${B(project.name)} has no secrets yet.`);
          human(`Add secrets to .env, then run ${B('capy push')}.`);
          this.installGitHooks();
          return null;
        }
        fetchSpinner.fail(`Failed to pull from ${B(project.name)}.`);
        throw err;
      }
    })();

    if (!decryptData) {
      return;
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
      // Same routing rule as the 404-stub branch above.
      human(`\n${B(project.name)} has no secrets yet.`);
      human(`Add secrets to .env, then run ${B('capy push')}.`);
      this.installGitHooks();
      return;
    }

    // Parse the keep.json the server sent us
    const parsedServerKeep = JSON.parse(decryptData.keep_file) as KeepFile;
    // Make sure project metadata is consistent (server's keep.json may have
    // been written before project_name existed in the schema)
    const serverKeep: KeepFile = {
      ...parsedServerKeep,
      org_id: orgId,
      project_id: project.id,
      project_name: project.name,
    };

    // Decrypt the env blob into plaintext
    const decryptEntry = ([key, value]: [string, string]): readonly [string, string] | null => {
      try {
        return [key, this.fileManager.decryptValue(value, encryptionKey)] as const;
      } catch {
        // Skip undecryptable (user lacks variable-level permission)
        return null;
      }
    };
    const plaintext = decryptData.env_content
      ? Object.fromEntries(
          Object.entries(this.fileManager.parseEnvContent(decryptData.env_content))
            .map(decryptEntry)
            .filter((entry): entry is readonly [string, string] => entry !== null),
        )
      : {};

    const localEnvPath = this.projectManager.getEnvPath(this.options.envPath);
    const shouldWriteLocalEnv = Object.keys(plaintext).length > 0 || existsSync(localEnvPath);

    // Write keep.lock + encrypted .env locally
    this.fileManager.writeKeepFile(serverKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();
    if (shouldWriteLocalEnv) {
      this.fileManager.writeEncryptedEnvFile(plaintext, encryptionKey, undefined, serverKeep, branch);
    }

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
   * Install git hooks (post-checkout, post-merge). Idempotent, no pre-push
   * hook. Body extracted to `../git/installGitHooks` (byte-identical
   * behavior) so `SetupCommand`'s `capy setup --json --confirm` apply path
   * can install the same hooks without a second copy of this logic.
   */
  private installGitHooks(): void {
    installGitHooksShared(this.devMode);
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
      const real = menuChoices.filter((c) => c.value !== 'skip');
      if (real.length !== 1) return null;
      if (isOnboarding) return real[0].value;
      return null;
    })();

    let action: string;
    // When the conflict is resolved in the browser we already hold the final env;
    // we tag the action 'individual' and skip the TTY ResolveTable below.
    let webFinalEnv: Record<string, string> | undefined;
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
    context: InitCommandContext,
    refreshToken: string,
    userId: string,
    deviceKeyEnrollment?: DeviceKeyEnrollmentOptions,
  ): Promise<import('./orgCreation').CreatedOrganizationContext> {
    if (context.transport === 'hosted') {
      throw new CapyError(
        'Hosted organization ceremony is not available in this build',
        'INIT_HOSTED_ORGANIZATION_CEREMONY_REQUIRED',
      );
    }
    const { createNewOrganization } = await import('./orgCreation');
    return createNewOrganization(
      context.authService,
      (authService) => new ServiceClient(
        authService.getServiceApiUrl(),
        this.devMode,
        () => authService.getValidToken(),
      ),
      refreshToken,
      userId,
      this.options.web,
      deviceKeyEnrollment,
    );
  }

  /** Shared context the device-key wiring (CAP-382) builds ceremony deps from. */
  private deviceKeyWiringContext(
    context: InitCommandContext,
    authResult: AuthResult,
    activeOrgId?: string | null,
  ): DeviceKeyWiringContext {
    return {
      authService: context.authService,
      serviceClient: context.serviceClient,
      devMode: this.devMode,
      userId: authResult.user_id!,
      userEmail: authResult.user_email,
      organizations: authResult.organizations || [],
      activeOrgId,
    };
  }
}
