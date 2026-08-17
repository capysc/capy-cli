/**
 * The onboard flow driver: observe → ask → validate → execute → repeat.
 *
 * The decision tree is NOT here. This loop reports what is true of a directory,
 * asks the service what to do next, refuses anything it does not recognise, runs
 * the one step it was given, and asks again. It stops on a step only a human can
 * answer (`confirm`, `screen`), on `blocked`, or on `done`.
 *
 * Three rules this file exists to hold:
 *
 *  1. NOTHING is executed before it is validated. The step is put through
 *     `validateStep` — closed kinds, closed verbs, params against the vendored
 *     schema, URLs against this binary's own pinned Keep origin — and a refusal
 *     aborts the run before any executor is reached.
 *  2. Observations are RE-OBSERVED every iteration. Nothing is carried over
 *     from the previous pass; the reconciler is level-triggered, so a world
 *     that changed underneath is simply the next report.
 *  3. Local-only mode never enters here. It has no server, no org and no
 *     identity — the flow API is meaningless there, and the CLI stays on its
 *     existing path.
 */
import { isLocalOnly } from '../../config/profileConfig';
import { CapyError, ERROR_CODES } from '../../types/index';
import {
  CreateFlowRequest,
  FlowCreds,
  FlowTransport,
  FlowHttpError,
} from '../client';
import { FLOW_CONTRACT_VERSION, FlowContractError, FlowStep, validateStep } from '../validate';
import { OnboardObservations, observeOnboard } from './observe';
import { EXECUTORS, ExecutorContext, ExecutorMap, StepResult } from './executors';

export interface DriverOptions {
  targetDir: string;
  transport: FlowTransport;
  /** Injectable so tests can drive the loop without touching the machine. */
  executors?: ExecutorMap;
  observe?: (opts: { targetDir: string; sessionLive: boolean; envPath?: string }) => OnboardObservations;
  /** Whether a session exists. A HINT: the service derives its own answer and its answer wins. */
  sessionLive?: boolean;
  envPath?: string;
  devMode?: boolean;
  authMode?: 'interactive_oauth' | 'broker_ceremony';
  clientPubkey?: string;
  machineName?: string;
  /** Resume an instance instead of creating one. */
  flowId?: string;
  flowSecret?: string;
  token?: string;
  /** Repo identity for the concurrency lock. Defaults to the absolute target dir. */
  repoKey?: string;
  /** Plan + compat findings, computed locally at creation. */
  plan?: unknown;
  compat?: CreateFlowRequest['compat'];
  /** Safety valve against a service that keeps handing back work. */
  maxSteps?: number;
}

export interface DriverResult {
  flowId: string;
  /** The step the run stopped on: confirm, screen, blocked or done. */
  step: FlowStep;
  /** Every step this run executed, in order — what it did, for the caller to report. */
  executed: Array<{ step_id: string; verb: string; outcome: StepResult['outcome']; code?: string }>;
  resumed: boolean;
  /** Present only when this run CREATED an anonymous instance. Never written to disk by this CLI. */
  flowSecret?: string;
}

const DEFAULT_MAX_STEPS = 12;

/** Terminal for the loop: a step no executor can advance. */
function isStopStep(step: FlowStep): boolean {
  return step.kind === 'confirm' || step.kind === 'screen' || step.kind === 'blocked' || step.kind === 'done';
}

export async function runOnboardFlow(opts: DriverOptions): Promise<DriverResult> {
  if (isLocalOnly()) {
    // Local-only is an offline path with a synthetic org and no server of any
    // kind. Same class as `capy run` on cached state and `capy decrypt`:
    // permanently off this layer.
    throw new CapyError(
      'The flow layer is not used in local-only mode.',
      ERROR_CODES.PERMISSION_DENIED,
      { localOnly: true },
    );
  }

  const observe = opts.observe ?? observeOnboard;
  const executors = opts.executors ?? EXECUTORS;
  const ctx: ExecutorContext = {
    targetDir: opts.targetDir,
    envPath: opts.envPath,
    devMode: opts.devMode === true,
    consented: false,
  };

  let flowId = opts.flowId;
  let creds: FlowCreds = { secret: opts.flowSecret, token: opts.token };
  let resumed = false;
  let createdSecret: string | undefined;

  if (!flowId) {
    const created = await opts.transport.create(
      {
        contract_version: FLOW_CONTRACT_VERSION,
        auth_mode: opts.authMode ?? 'interactive_oauth',
        repo_key: opts.repoKey ?? opts.targetDir,
        plan: opts.plan,
        compat: opts.compat,
        client_pubkey: opts.clientPubkey,
        machine_name: opts.machineName,
      },
      opts.token,
    );
    flowId = created.flow_id;
    resumed = created.resumed === true;
    createdSecret = created.flow_secret;
    creds = { secret: created.flow_secret ?? opts.flowSecret, token: opts.token };
    // A creation that already carries a step (incompatible, version skew, a
    // lock held elsewhere) is an answer, not a start.
    if (created.step) {
      const step = validateStep(created.step, flowId);
      if (isStopStep(step)) {
        return { flowId, step, executed: [], resumed, flowSecret: createdSecret };
      }
    }
  }

  const executed: DriverResult['executed'] = [];
  let lastStep: { step_id: string; outcome: 'ok' | 'failed'; code?: string; result?: StepResult['result'] } | undefined;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  for (let i = 0; i < maxSteps; i++) {
    // Re-observed every pass, never carried over.
    const observations = observe({
      targetDir: opts.targetDir,
      sessionLive: opts.sessionLive ?? false,
      envPath: opts.envPath,
    });

    const answer = await opts.transport.next(
      flowId,
      { contract_version: FLOW_CONTRACT_VERSION, observations, last_step: lastStep },
      creds,
    );

    // Validated BEFORE anything else looks at it. A refusal throws out of the
    // loop with no executor having run.
    const step = validateStep(answer.step, flowId);
    if (step.resumed) resumed = true;

    if (isStopStep(step)) {
      return { flowId, step, executed, resumed, flowSecret: createdSecret };
    }

    // The only remaining kind is local_action, and the vocabulary is closed —
    // but a verb this build has no executor for is still a refusal, never a skip.
    const executor = executors[step.verb as string];
    if (!executor) {
      throw new FlowContractError(
        'FLOW_UNKNOWN_VERB' as never,
        'no executor for this local action',
        { verb: step.verb },
      );
    }

    const result = await executor(step, ctx);
    executed.push({ step_id: step.step_id, verb: step.verb as string, outcome: result.outcome, code: result.code });
    lastStep = { step_id: step.step_id, outcome: result.outcome, code: result.code, result: result.result };
  }

  throw new CapyError(
    'The onboarding flow did not settle.',
    ERROR_CODES.SERVICE_ERROR,
    { flowId, steps: executed.length },
  );
}

/** Record the human's answer to a confirm dialog, then let the caller re-drive. */
export async function confirmOnboardPlan(
  transport: FlowTransport,
  flowId: string,
  planHash: string,
  accepted: boolean,
  creds: FlowCreds,
): Promise<void> {
  await transport.confirm(flowId, planHash, accepted, creds);
}

export { FlowHttpError };
