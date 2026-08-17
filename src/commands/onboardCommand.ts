/**
 * `capy onboard` — the flow-driven onboarding path.
 *
 * Undocumented and off by default while the existing path remains the shipped
 * one. Two ways in:
 *
 *   capy onboard [--json]        explicit
 *   CAPY_FLOW_ONBOARD=1 capy     the plain entry diverts here
 *
 * Neither is reachable in local-only mode, which has no server to ask.
 *
 * In `--json` mode the run prints exactly one JSON object — the step it stopped
 * on — and exits 0. A `confirm`, a `screen` and a `blocked` are all legitimate
 * places to stop: they are answers, not failures, and an agent reading this
 * output needs to tell them apart by their `kind`, not by an exit code. Only a
 * genuine failure (a refused step, an unreachable service) exits non-zero.
 */
import { isLocalOnly } from '../config/profileConfig';
import { CapyError, ERROR_CODES, CliOptions } from '../types/index';
import { FlowClient } from '../flows/client';
import { FlowContractError, FlowStep } from '../flows/validate';
import { runOnboardFlow, confirmOnboardPlan } from '../flows/onboard/driver';
import { buildPlan } from '../flows/onboard/plan';
import { readEnvKeys } from '../flows/onboard/edits';

export interface OnboardOptions extends CliOptions {
  json?: boolean;
  /** Render interactive stops in a browser (the same wizard `capy --web` uses). */
  web?: boolean;
  targetDir?: string;
  flowId?: string;
  flowSecret?: string;
  clientPubkey?: string;
  /** Answer a confirm dialog: `--confirm <plan_hash> --accepted true|false`. */
  confirm?: string;
  accepted?: boolean;
}

/** What the run stopped on, plus what it did on the way — printed as one object in --json mode. */
interface OnboardJson {
  flow_id: string;
  resumed: boolean;
  step: FlowStep;
  executed: Array<{ step_id: string; verb: string; outcome: string; code?: string }>;
  flow_secret?: string;
}

export async function runOnboardCommand(options: OnboardOptions = {}, devMode = false): Promise<void> {
  if (isLocalOnly()) {
    throw new CapyError(
      'Onboarding through the flow service is not available in local-only mode.',
      ERROR_CODES.PERMISSION_DENIED,
      { localOnly: true },
    );
  }

  const targetDir = options.targetDir ?? process.cwd();
  const transport = new FlowClient(undefined, devMode);
  const { AuthService } = await import('../auth/authService');
  // The bearer the flow API sees. Absent = an anonymous instance, which is the
  // ordinary state of a first run in a fresh repo.
  //
  // A FRESH AuthService per read, deliberately: the `authenticate` step writes
  // the session to disk from its own instance, and one constructed before that
  // step ran has already decided there is no session. Reusing it meant the
  // token minted mid-flow never travelled, the service never rebound the
  // instance, sessionLive stayed false, and the flow re-issued `authenticate`
  // until the driver gave up.
  const getToken = async (): Promise<string | undefined> =>
    (await new AuthService(undefined, devMode).getValidToken())?.access_token ?? undefined;
  const token = await getToken();

  // Answering a dialog is a separate invocation: record it, then re-drive so
  // the table decides what the approval unlocked.
  if (options.confirm) {
    if (!options.flowId) {
      throw new CapyError(
        'Answering a plan dialog needs the flow it belongs to: pass --flow-id.',
        ERROR_CODES.INVALID_FORMAT,
      );
    }
    await confirmOnboardPlan(transport, options.flowId, options.confirm, options.accepted === true, {
      secret: options.flowSecret,
      token,
    });
  }

  // The plan and the compat findings are computed LOCALLY — names, paths and
  // counts only, never a value.
  const plan = buildPlan({ targetDir });
  const envKeys = readEnvKeys(targetDir);

  try {
    const result = await runOnboardFlow({
      targetDir,
      transport,
      envPath: options.envPath,
      devMode,
      sessionLive: Boolean(token),
      token,
      getToken,
      web: options.web === true,
      // Recomputed on demand: only sent when the plan the instance holds has
      // gone stale under the human.
      buildPlan: () => planPayload(targetDir),
      flowId: options.flowId,
      flowSecret: options.flowSecret,
      authMode: options.clientPubkey ? 'broker_ceremony' : 'interactive_oauth',
      clientPubkey: options.clientPubkey,
      plan: planPayload(targetDir),
      compat: { usesEnvVars: envKeys.length > 0, framework: plan.framework },
    });

    // A screen is the one stop an agent cannot answer for the user, so its URL
    // goes out through the SAME structured event every other Capy handoff uses
    // — in json mode too, where the object below is the only other output.
    if (result.step.kind === 'screen') surfaceScreen(result.step);

    if (options.json) {
      const out: OnboardJson = {
        flow_id: result.flowId,
        resumed: result.resumed,
        step: result.step,
        executed: result.executed,
      };
      // The secret exists only for an anonymous instance this run created, and
      // it is handed to the caller ONCE, here. This CLI never writes it to disk.
      if (result.flowSecret) out.flow_secret = result.flowSecret;
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    await renderInteractive(
      result,
      transport,
      { secret: result.flowSecret ?? options.flowSecret, token: await getToken() },
      options,
      devMode,
    );
  } catch (err) {
    if (err instanceof FlowContractError && options.json) {
      // A refused step is a failure of the SERVICE's side of the contract, and
      // it must be loud: exit non-zero with the code, never a step-shaped
      // object that a caller might act on.
      console.error(JSON.stringify({ error: 'flow_contract_violation', code: err.code, detail: err.detail }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/** The plan, in the contract's shape. Names, paths, counts and a hash — never a value. */
function planPayload(targetDir: string): Record<string, unknown> {
  const plan = buildPlan({ targetDir });
  const envKeys = readEnvKeys(targetDir);
  return {
    plan_hash: plan.planHash,
    target_dir: plan.targetDir,
    framework: plan.framework ?? null,
    edit_paths: plan.diffs.map((d) => d.path),
    connector_providers: plan.connectors.map((c) => c.provider),
    cli_checks: plan.cliChecks.map((c) => ({ cli: c.cli, installed: c.installed })),
    variable_names: envKeys,
    variable_count: envKeys.length,
  };
}

/**
 * TTY rendering. A `confirm` is asked with the CLI's own copy for that dialog
 * id — the service supplies structured params, never the words — and a `screen`
 * is handed over as a URL the user opens, the same shape every other Capy
 * browser handoff has.
 */
async function renderInteractive(
  result: Awaited<ReturnType<typeof runOnboardFlow>>,
  transport: FlowClient,
  creds: { secret?: string; token?: string },
  options: OnboardOptions,
  devMode: boolean,
): Promise<void> {
  const step = result.step;

  if (step.kind === 'done') {
    console.log('\nCapy is set up in this project.');
    return;
  }

  if (step.kind === 'blocked') {
    // Copy comes from THIS binary, keyed off the reason enum. Service prose is
    // never rendered.
    const { describeBlocked } = await import('../flows/onboard/copy');
    console.error(`\n${describeBlocked(step.reason as string)}`);
    process.exitCode = 1;
    return;
  }

  if (step.kind === 'screen') {
    surfaceScreen(step);
    return;
  }

  // confirm
  const { renderPlanDialog } = await import('../flows/onboard/copy');
  console.log(`\n${renderPlanDialog(step.params)}`);
  const inquirer = (await import('inquirer')).default;
  const { proceed } = await inquirer.prompt([
    { type: 'confirm', name: 'proceed', message: 'Proceed?', default: true },
  ]);
  await confirmOnboardPlan(transport, result.flowId, step.params.plan_hash as string, proceed === true, creds);
  if (!proceed) {
    console.log('\nNothing was changed.');
    return;
  }
  // Approval recorded — re-drive, same instance, fresh observations.
  await runOnboardCommand({ ...options, flowId: result.flowId, flowSecret: creds.secret }, devMode);
}

/**
 * Hand a screen step to the human: the readable line, and — byte-identical, on
 * the line after it — the structured handoff event every Capy browser handoff
 * emits. An agent driving this reads the event; a person reads the line above
 * it. Never one without the other.
 */
function surfaceScreen(step: FlowStep): void {
  const { describeScreen } = require('../flows/onboard/copy') as typeof import('../flows/onboard/copy');
  const { emitHandoffUrlEvent } = require('../ui/handoffEvent') as typeof import('../ui/handoffEvent');
  const url = step.url as string;
  console.log(`\n${describeScreen(step.screen as string, step.params)}`);
  console.log(`\n  ${url}\n`);
  emitHandoffUrlEvent(url, 'onboard');
}
