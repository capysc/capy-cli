/**
 * `capy flow run` — attach to a hosted-minted `checkout` flow instance for
 * this account and drive it to completion.
 *
 * `checkout` (shared/flows) is the proving flow for a hosted-minted,
 * CLI-executed branch switch: someone approves a project/branch switch in
 * the hosted chat (POST /flows/checkout mints the instance there), and this
 * command is the CLI side that actually performs it. Undocumented, additive,
 * and off by default — a sibling to `capy flow cancel` under the same
 * hidden `flow` group, never reachable from the plain `capy` entry point.
 *
 * Same three rules `flows/onboard/driver.ts` holds for onboard, held here for
 * checkout:
 *
 *  1. NOTHING is executed before it is validated (`validateStep`, the SAME
 *     vendored-contract trust boundary onboard uses — closed kinds, closed
 *     verbs, params against the vendored schema).
 *  2. Observations are RE-OBSERVED every report. Nothing is carried over
 *     except the two pinned NAMES this run has itself already seen echoed
 *     back in a step's own params (see `computeRepoMatchesProject`'s doc).
 *  3. This command never answers the flow's one consent gate
 *     (`checkout_plan`). A human approves it in the hosted chat; while
 *     waiting, this run polls `GET /flows/:id/next` a few times (cheap —
 *     reports nothing) and only re-enters the real `POST /next` loop once
 *     that peek shows something changed.
 *
 * Authentication is SILENT ONLY — `authenticateSilent`, never
 * `authenticate()`. An agent-driven attach must never open a browser or
 * block on a ceremony; a caller with no session gets a coded refusal and a
 * non-zero exit instead.
 */
import { AuthService } from '../auth/authService';
import { ServiceClient, FlowSummary } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { CapyError, ERROR_CODES, KeepFile } from '../types/index';
import {
  FLOW_CONTRACT_VERSION,
  FLOW_ERROR_CODES,
  FlowContractError,
  FlowStep,
  isTerminalReason,
  validateStep,
} from '../flows/validate';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { syncAndWriteBranch } from './checkoutCommand';
import { codeForSilentAuthFailure } from '../flows/onboard/executors/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface FlowRunOptions {
  json?: boolean;
  targetDir?: string;
}

interface ExecutedStep {
  readonly step_id: string;
  readonly verb: string;
  readonly outcome: string;
  readonly code?: string;
}

interface LastStepReport {
  readonly step_id: string;
  readonly outcome: 'ok' | 'failed';
  readonly code?: string;
}

interface DriveState {
  readonly pinnedProjectName?: string;
  readonly pinnedBranchName?: string;
  readonly lastStep?: LastStepReport;
  readonly executed: ReadonlyArray<ExecutedStep>;
}

/** Injected so tests can drive the loop against a fake service/project tree, never the real machine or network. */
export interface FlowRunDeps {
  readonly projectManager: ProjectManager;
  readonly fileManager: FileManager;
  readonly serviceClient: ServiceClient;
  readonly userId: string;
  readonly sleep: (ms: number) => Promise<void>;
}

export type FlowRunOutcome =
  | { readonly kind: 'done'; readonly step: FlowStep; readonly executed: ReadonlyArray<ExecutedStep> }
  | { readonly kind: 'blocked'; readonly step: FlowStep; readonly executed: ReadonlyArray<ExecutedStep> }
  | { readonly kind: 'confirm_pending'; readonly step: FlowStep; readonly executed: ReadonlyArray<ExecutedStep> };

const MAX_ITERATIONS = 12;
const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectNameFromParams(step: FlowStep): string | undefined {
  const name = (step.params as { project_name?: unknown }).project_name;
  return typeof name === 'string' ? name : undefined;
}

function branchNameFromParams(step: FlowStep): string | undefined {
  const name = (step.params as { branch_name?: unknown }).branch_name;
  return typeof name === 'string' ? name : undefined;
}

function readKeepFileOrNull(pm: ProjectManager): KeepFile | null {
  try {
    return pm.readKeepFile();
  } catch {
    return null;
  }
}

/**
 * `repoMatchesProject` — this directory's keep.lock project against the
 * flow's pinned project. No keep.lock at all is always false (spec: an
 * unattached directory can never match).
 *
 * `expectedProjectName` is the NAME this run has learned from a step's own
 * params so far — nothing is fetched or cached beyond that. Before any full
 * envelope has been seen there is nothing yet to compare against; reporting
 * `false` here would trip the checkout engine's `wrong_repo` gate (checked
 * BEFORE the confirm dialog, checkoutEngine.ts step 3) even for a directory
 * that turns out to be exactly right, on every fresh attach. Optimistic
 * `true` in that one case only: the first full envelope this run ever
 * receives is a `confirm` (or `blocked`/`done`), and every one of those kinds
 * carries `project_name` in its params (contract/steps.json) — from the next
 * report onward the real name is known and this collapses to a real
 * comparison. The one local_action this flow has, `switch_branch`, is only
 * ever issued AFTER a confirm step has already surfaced the pinned name
 * (checkoutEngine.ts step 4 before step 5), so an optimistic `true` here can
 * never let a wrong directory reach the verb that writes to disk.
 */
function computeRepoMatchesProject(pm: ProjectManager, expectedProjectName: string | undefined): boolean {
  const keep = readKeepFileOrNull(pm);
  if (!keep) return false;
  if (expectedProjectName === undefined) return true;
  return keep.project_name === expectedProjectName;
}

/**
 * `switchCompleted` — has this directory's active branch already reached the
 * plan's pinned branch? An unknown pinned branch reports false — the engine
 * never reads this observation until AFTER a confirm step has already
 * surfaced `branch_name` (checkoutEngine.ts step 5 follows step 4), so there
 * is no bootstrapping problem to solve here the way there is for
 * `repoMatchesProject`.
 */
function computeSwitchCompleted(pm: ProjectManager, expectedBranchName: string | undefined): boolean {
  if (expectedBranchName === undefined) return false;
  return pm.readActiveBranch() === expectedBranchName;
}

function observationsFor(pm: ProjectManager, state: DriveState): Record<string, boolean> {
  return {
    repoMatchesProject: computeRepoMatchesProject(pm, state.pinnedProjectName),
    switchCompleted: computeSwitchCompleted(pm, state.pinnedBranchName),
  };
}

/** Fold a freshly validated step's own NAMES into the state — never an id, never a value. */
function withPinnedNames(state: DriveState, step: FlowStep): DriveState {
  return {
    ...state,
    pinnedProjectName: projectNameFromParams(step) ?? state.pinnedProjectName,
    pinnedBranchName: branchNameFromParams(step) ?? state.pinnedBranchName,
  };
}

/**
 * Perform the one local_action this flow ever issues, reusing
 * `checkoutCommand.ts`'s own `syncAndWriteBranch` — the exact sync/write tail
 * `capy checkout <branch>` uses for an existing branch, extracted there as a
 * pure refactor for this reuse. Never throws: every failure mode collapses to
 * the flow's own coded outcome, `BRANCH_SWITCH_FAILED`.
 */
async function executeSwitchBranch(
  deps: FlowRunDeps,
  branchName: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const projectState = await deps.projectManager.detectProjectState();
    if (!projectState.initialized || !projectState.projectId || !projectState.organizationId) {
      return { ok: false, code: ERROR_CODES.BRANCH_SWITCH_FAILED };
    }
    const keyOps: KeyServiceOps = {
      coDecrypt: (oid, ct) => deps.serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid, pt) => deps.serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    };
    const encryptionKey = await resolveProjectKey(
      projectState.organizationId,
      projectState.projectId,
      deps.userId,
      keyOps,
    );

    const branches = await deps.serviceClient.listBranches(projectState.projectId);
    const branch = branches.find((b) => b.name === branchName);
    if (!branch) return { ok: false, code: ERROR_CODES.BRANCH_SWITCH_FAILED };

    const outcome = await syncAndWriteBranch(
      { serviceClient: deps.serviceClient, projectManager: deps.projectManager, fileManager: deps.fileManager },
      projectState.projectId,
      branchName,
      encryptionKey,
      false,
    );
    if (outcome.kind !== 'ok') return { ok: false, code: ERROR_CODES.BRANCH_SWITCH_FAILED };
    return { ok: true };
  } catch {
    return { ok: false, code: ERROR_CODES.BRANCH_SWITCH_FAILED };
  }
}

/**
 * Poll `GET /flows/:id/next` a few times (`POLL_ATTEMPTS`) while a confirm
 * dialog is pending — cheap, and reports nothing: the dialog is answered in
 * the hosted chat, not by this run, so there is nothing new to tell the
 * service while waiting. The first GET whose cached step no longer matches
 * the one this run is waiting on (including a cache CLEARED to `null` —
 * `POST /:id/confirm` does exactly that the instant it records an answer,
 * service/src/routes/flows.ts) means something happened; this re-enters the
 * real loop with a fresh `POST /next` rather than ever executing anything
 * off the GET's own (deliberately allowed to be stale) copy.
 */
async function awaitConfirmApproval(
  deps: FlowRunDeps,
  flowId: string,
  confirmStep: FlowStep,
  state: DriveState,
  iteration: number,
  attempt: number,
): Promise<FlowRunOutcome> {
  if (attempt >= POLL_ATTEMPTS || iteration >= MAX_ITERATIONS) {
    return { kind: 'confirm_pending', step: confirmStep, executed: state.executed };
  }
  await deps.sleep(POLL_INTERVAL_MS);
  const peek = await deps.serviceClient.getFlowStep(flowId);
  const peekedStepId =
    peek.step && typeof peek.step === 'object' ? (peek.step as { step_id?: unknown }).step_id : undefined;
  if (peekedStepId === confirmStep.step_id) {
    return awaitConfirmApproval(deps, flowId, confirmStep, state, iteration + 1, attempt + 1);
  }
  return driveCheckoutFlow(deps, flowId, state, iteration + 1);
}

/**
 * observe → POST /next → validate → act, recursively. `iteration` is the
 * overall safety valve (bounds confirm-polling too, since `awaitConfirmApproval`
 * feeds it back in on every retry).
 */
async function driveCheckoutFlow(
  deps: FlowRunDeps,
  flowId: string,
  state: DriveState,
  iteration: number,
): Promise<FlowRunOutcome> {
  if (iteration >= MAX_ITERATIONS) {
    throw new CapyError('The checkout flow did not settle.', ERROR_CODES.SERVICE_ERROR, {
      flowId,
      steps: state.executed.length,
    });
  }

  const response = await deps.serviceClient.reportFlowObservations(flowId, {
    contract_version: FLOW_CONTRACT_VERSION,
    observations: observationsFor(deps.projectManager, state),
    last_step: state.lastStep,
  });

  // Validated BEFORE anything else looks at it — a refusal throws out of the
  // loop with no executor having run, same as onboard's driver.
  const step = validateStep(response.step, flowId);
  const seenState = withPinnedNames(state, step);

  if (step.kind === 'confirm') {
    return awaitConfirmApproval(deps, flowId, step, seenState, iteration + 1, 0);
  }

  if (step.kind === 'local_action') {
    // The vocabulary is closed, but a verb this build has no executor for is
    // still a refusal, never a skip — checkout has exactly one verb.
    if (step.verb !== 'switch_branch') {
      throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_VERB, 'capy flow run has no executor for this local action', {
        verb: step.verb,
      });
    }
    const branchName = branchNameFromParams(step) ?? '';
    const result = await executeSwitchBranch(deps, branchName);
    const executedEntry: ExecutedStep = {
      step_id: step.step_id,
      verb: 'switch_branch',
      outcome: result.ok ? 'ok' : 'failed',
      code: result.ok ? undefined : result.code,
    };
    const nextState: DriveState = {
      ...seenState,
      executed: [...seenState.executed, executedEntry],
      lastStep: { step_id: step.step_id, outcome: result.ok ? 'ok' : 'failed', code: result.ok ? undefined : result.code },
    };
    return driveCheckoutFlow(deps, flowId, nextState, iteration + 1);
  }

  if (step.kind === 'blocked') {
    return { kind: 'blocked', step, executed: seenState.executed };
  }

  if (step.kind === 'done') {
    return { kind: 'done', step, executed: seenState.executed };
  }

  // 'screen' — checkout's own contract (checkoutEngine.ts) never mints one;
  // this headless attach has no renderer for it either way. Fail closed
  // rather than silently skip.
  throw new CapyError(
    'capy flow run cannot render a screen step for a checkout flow',
    ERROR_CODES.SERVICE_ERROR,
    { flowId, screen: step.screen },
  );
}

function isDrivableCheckoutFlow(f: FlowSummary): boolean {
  return f.flow_type === 'checkout' && f.contract_version === FLOW_CONTRACT_VERSION && f.status !== 'done' && f.status !== 'cancelled';
}

interface FlowRunJson {
  ok: boolean;
  flow_id?: string;
  step?: FlowStep;
  executed: ReadonlyArray<ExecutedStep>;
  code?: string;
  detail?: string;
}

function printJson(payload: FlowRunJson): void {
  console.log(JSON.stringify(payload, null, 2));
}

function reportNoSession(
  options: FlowRunOptions,
  errorCode: Parameters<typeof codeForSilentAuthFailure>[0],
  error: string | undefined,
): void {
  const code = codeForSilentAuthFailure(errorCode);
  const detail = error || 'no active session';
  if (options.json) {
    printJson({ ok: false, code, detail, executed: [] });
  } else {
    console.error(`\n  No active session (${detail}). Run ${B('capy')} to sign in first.\n`);
  }
  process.exitCode = 1;
}

function reportNoFlow(options: FlowRunOptions): void {
  if (options.json) {
    printJson({ ok: true, executed: [] });
  } else {
    console.log('\n  No open checkout flow found for this account.\n');
  }
}

function reportOutcome(options: FlowRunOptions, flowId: string, outcome: FlowRunOutcome): void {
  if (outcome.kind === 'confirm_pending') {
    if (options.json) {
      printJson({ ok: true, flow_id: flowId, step: outcome.step, executed: outcome.executed });
      return;
    }
    const params = outcome.step.params as { project_name?: string; branch_name?: string };
    console.log(
      `\n  Waiting on approval for ${B(params.project_name ?? 'this project')} → ${B(params.branch_name ?? 'this branch')} in the hosted chat.`,
    );
    console.log(`  Run ${B('capy flow run')} again after approving it there.\n`);
    return;
  }

  if (outcome.kind === 'blocked') {
    const reason = outcome.step.reason ?? 'service_error';
    const terminal = isTerminalReason(reason);
    if (options.json) {
      printJson({ ok: false, flow_id: flowId, code: reason, step: outcome.step, executed: outcome.executed });
    } else {
      console.error(`\n  Blocked: ${reason}\n`);
    }
    if (terminal) process.exitCode = 1;
    return;
  }

  // done
  const params = outcome.step.params as { project_name?: string | null; branch_name?: string | null };
  if (options.json) {
    printJson({ ok: true, flow_id: flowId, step: outcome.step, executed: outcome.executed });
    return;
  }
  console.log(`\n  Now on branch: ${B(params.branch_name ?? '')} (${params.project_name ?? ''})\n`);
}

function reportError(options: FlowRunOptions, flowId: string | undefined, err: unknown): void {
  if (err instanceof FlowContractError) {
    if (options.json) {
      printJson({ ok: false, flow_id: flowId, code: err.code, detail: err.message, executed: [] });
    } else {
      console.error(`\n  Refused: ${err.message} (${err.code})\n`);
    }
    process.exitCode = 1;
    return;
  }
  const capyErr =
    err instanceof CapyError ? err : new CapyError(err instanceof Error ? err.message : String(err), ERROR_CODES.SERVICE_ERROR);
  if (options.json) {
    printJson({ ok: false, flow_id: flowId, code: capyErr.code, detail: capyErr.message, executed: [] });
  } else {
    console.error(`\n  capy flow run failed: ${capyErr.message}\n`);
  }
  process.exitCode = 1;
}

export async function runFlowRunCommand(options: FlowRunOptions = {}, devMode = false): Promise<void> {
  const targetDir = options.targetDir ?? process.cwd();
  const projectManager = new ProjectManager(targetDir);
  const fileManager = new FileManager(targetDir);

  const projectState = await projectManager.detectProjectState();
  const authService = new AuthService(undefined, devMode, projectState.userId);
  if (projectState.userId) authService.setSessionUserId(projectState.userId);

  // Silent ONLY — never a ceremony, never a browser. A caller with no usable
  // session gets a coded refusal (from authResult.error_code — see
  // reportNoSession/codeForSilentAuthFailure), never an interactive prompt.
  const authResult = await authService.authenticateSilent(projectState.organizationId);
  if (!authResult.success || !authResult.user_id) {
    reportNoSession(options, authResult.error_code, authResult.error);
    return;
  }

  const serviceClient = new ServiceClient(undefined, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const flows = await serviceClient.listMyFlows();
  const candidate = flows.find(isDrivableCheckoutFlow);
  if (!candidate) {
    reportNoFlow(options);
    return;
  }

  const deps: FlowRunDeps = {
    projectManager,
    fileManager,
    serviceClient,
    userId: authResult.user_id,
    sleep: defaultSleep,
  };
  const initialState: DriveState = { executed: [] };

  try {
    const outcome = await driveCheckoutFlow(deps, candidate.flow_id, initialState, 0);
    reportOutcome(options, candidate.flow_id, outcome);
  } catch (err) {
    reportError(options, candidate.flow_id, err);
  }
}

// Exported for tests only — the recursive driver and its pure observation
// helpers, exercised directly against a fake ServiceClient/ProjectManager
// rather than through the full command (which also needs a real auth
// session).
export const __testables = {
  driveCheckoutFlow,
  computeRepoMatchesProject,
  computeSwitchCompleted,
  isDrivableCheckoutFlow,
};
