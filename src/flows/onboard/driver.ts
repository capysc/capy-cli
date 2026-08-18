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
import { isLocalOnly, resolveActiveUrl } from '../../config/profileConfig';
import { CapyError, ERROR_CODES } from '../../types/index';
import { ConnectionKeypair } from '../../service/brokerEnvelope';
import {
  CreateFlowRequest,
  FlowCreds,
  FlowTransport,
  FlowHttpError,
} from '../client';
import { FLOW_CONTRACT_VERSION, FlowContractError, FlowStep, validateStep } from '../validate';
import { OnboardObservations, observeOnboard } from './observe';
import { EXECUTORS, ExecutorContext, ExecutorMap, StepResult } from './executors';
import { runSandboxCeremony } from './sandboxCeremony';

export interface DriverOptions {
  targetDir: string;
  transport: FlowTransport;
  /**
   * Reads the current bearer, if any. Called AFTER every successful step, not
   * once at the start: `authenticate` is a step, so the token that step mints is
   * the one the next request has to carry. Without the re-read the service
   * never sees secret+JWT together, never rebinds the instance, keeps deriving
   * sessionLive as false, and re-issues the auth step forever.
   */
  getToken?: () => Promise<string | undefined>;
  /** Recompute the plan when the service reports the one it holds is stale. */
  buildPlan?: () => unknown;
  /** Render interactive stops in a browser rather than the terminal. */
  web?: boolean;
  /** CAP-451: `capy onboard --project-name`, when given — see ExecutorContext.projectName's own doc. */
  projectName?: string;
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
  /**
   * CAP-451: this process's own ephemeral keypair, minted by
   * `capy onboard --broker-ceremony` BEFORE the flow was created (its
   * pubkey IS `clientPubkey` above). Presence is the gate: when set, the
   * driver runs the `sandbox_session` screen ITSELF instead of stopping on
   * it — see the loop below. Every other caller (TTY, `--web`, the existing
   * explicit `--client-pubkey` caller with no keypair of its own) leaves
   * this unset and hits `isStopStep` exactly as before, unchanged.
   */
  brokerCeremonyKeypair?: ConnectionKeypair;
  /** Service base URL for the ceremony's own connection poll. Defaults to the ordinary URL resolution. */
  serviceUrl?: string;
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
    web: opts.web === true,
    projectName: opts.projectName,
    // CAP-451: same gate as the sandbox_session interception above — only
    // true for `capy onboard --broker-ceremony`'s own ceremony, never the
    // existing explicit `--client-pubkey` caller.
    brokerCeremony: opts.brokerCeremonyKeypair !== undefined,
    onSession: (session) => {
      // A step minted a session. It travels on the NEXT request, which is what
      // lets the service rebind an anonymous instance (it needs the secret and
      // the JWT together) and start deriving sessionLive as true.
      mintedToken = session.token;
    },
  };
  let mintedToken: string | undefined;
  const getToken = opts.getToken ?? (async () => opts.token);
  let sessionLive = opts.sessionLive ?? false;

  let flowId = opts.flowId;
  let creds: FlowCreds = { secret: opts.flowSecret, token: opts.token };
  // The service decides `resumed` ONCE per instance and echoes it on every
  // step (engine.ts resolveResumed) — so the value from the FIRST envelope
  // this run receives is authoritative for the whole run. Reading it again
  // from a later envelope and OR-ing it in would make step 2 of a genuinely
  // fresh flow report resumed:true, which is the exact bug this replaced.
  let resumed = false;
  let resumedSeen = false;
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
      sessionLive,
      envPath: opts.envPath,
    });

    // A plan that moved under the human is resent so the service can replace it
    // and ask for consent again. Only then: an unchanged plan is not resent.
    const plan = lastStep?.code === ERROR_CODES.PLAN_CHANGED ? opts.buildPlan?.() : undefined;

    const answer = await opts.transport.next(
      flowId,
      { contract_version: FLOW_CONTRACT_VERSION, observations, last_step: lastStep, plan },
      creds,
    );

    // Validated BEFORE anything else looks at it. A refusal throws out of the
    // loop with no executor having run.
    const step = validateStep(answer.step, flowId);
    // The service decides this once per INSTANCE and echoes it on every step
    // (engine.ts resolveResumed), so every envelope this run receives already
    // carries the same value — take it from the first one and never OR later
    // envelopes into it. OR-ing was the bug: it made step 2 of a genuinely
    // fresh run report resumed:true just because the instance had, by then,
    // of course already issued a step.
    if (!resumedSeen) {
      resumed = step.resumed;
      resumedSeen = true;
    }

    // CAP-451: under `--broker-ceremony` the driver runs the ONE screen it
    // knows how to answer itself — the flow-owned `sandbox_session`
    // ceremony connection — instead of stopping and handing the URL to a
    // caller that cannot open it (a sandboxed MCP with no browser). Every
    // other screen, and this same screen for every OTHER caller (no
    // keypair minted), still falls through to `isStopStep` below unchanged.
    if (step.kind === 'screen' && step.screen === 'sandbox_session' && opts.brokerCeremonyKeypair) {
      const outcome = await runSandboxCeremony({
        step,
        keypair: opts.brokerCeremonyKeypair,
        flowSecret: creds.secret ?? '',
        serviceUrl: opts.serviceUrl ?? resolveActiveUrl(opts.devMode === true),
        devMode: opts.devMode === true,
        machineName: opts.machineName,
        targetDir: opts.targetDir,
      });
      executed.push({
        step_id: step.step_id,
        verb: 'sandbox_ceremony',
        outcome: outcome.result.outcome,
        code: outcome.result.code,
      });
      lastStep = {
        step_id: step.step_id,
        outcome: outcome.result.outcome,
        code: outcome.result.code,
        result: outcome.result.result,
      };
      if (outcome.result.outcome === 'ok') {
        if (outcome.session) ctx.onSession?.(outcome.session);
        const token = (await getToken()) ?? mintedToken;
        if (token) {
          creds = { ...creds, token };
          sessionLive = true;
        }
      }
      continue;
    }

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

    // Consent was recorded on the flow instance, not in this process — the
    // step says so (params.consent_recorded, filled server-side from
    // instance.consentPlanHash) rather than this driver ever guessing. Only
    // the consent-gated verbs carry it; everything else leaves ctx.consented
    // false, which those executors never consult.
    ctx.consented = (step.params as { consent_recorded?: boolean }).consent_recorded === true;

    const result = await executor(step, ctx);
    executed.push({ step_id: step.step_id, verb: step.verb as string, outcome: result.outcome, code: result.code });
    lastStep = { step_id: step.step_id, outcome: result.outcome, code: result.code, result: result.result };

    if (result.outcome === 'ok') {
      // A step may have minted a session. Carry it on the NEXT request — that
      // is what lets the service rebind an anonymous instance to a real
      // identity (it needs the secret and the JWT together) and start deriving
      // sessionLive as true. A FRESH read wins over a stale minted one: once
      // sync-state carries a user id (write_keep_lock/write_capy_dir), getToken
      // resolves to the org-scoped session that step's authenticate call never
      // had, and the org-less bearer authenticate minted must not keep shadowing
      // it for the rest of the run.
      const token = (await getToken()) ?? mintedToken;
      if (token) {
        creds = { ...creds, token };
        sessionLive = true;
      }
    }
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
