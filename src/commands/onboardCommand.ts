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
import { debug } from '../ui/debug';
import { FlowClient } from '../flows/client';
import { ProjectManager } from '../core/projectManager';
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
  /**
   * CAP-451: this process mints its OWN ephemeral keypair and runs the
   * in-process broker ceremony (`../flows/onboard/sandboxCeremony.ts`)
   * against the flow-owned `sandbox_session` connection, instead of
   * stopping on the screen and handing its URL to a caller that cannot
   * open it — the MCP sets this. Off by default; distinct from
   * `clientPubkey`, which is the existing explicit-keypair caller and is
   * left untouched.
   */
  brokerCeremony?: boolean;
  /** The project name to create with, skipping the interactive name prompt. In the plan hash. */
  projectName?: string;
  /** Answer a confirm dialog: `--confirm <plan_hash> --accepted true|false`. */
  confirm?: string;
  accepted?: boolean;
  /**
   * Compat hint: the app reads configuration from environment variables, even
   * when this directory carries no `.env`/`.env.example`/etc of its own (a
   * caller with broader knowledge of the app — e.g. an agent that has read
   * its source — can know this when `readEnvKeys` finds nothing to scan).
   * OR'd with the local file-based detection below, never a replacement for
   * it: a directory that DOES have a `.env` is `usesEnvVars: true` regardless
   * of whether this flag is passed.
   */
  usesEnvVars?: boolean;
  /** Compat hint: detected framework, e.g. "Next.js" — overrides the local guess when given. */
  framework?: string;
  /** Compat hint: name of an external secret manager already in use, e.g. "vault". */
  externalSecretManager?: string;
}

/** Same rule the TTY project-name prompt validates (`../ui/promptEngine.ts`). */
function isValidFlowProjectName(name: string): boolean {
  return name.trim().length > 0 && /^[a-zA-Z0-9-_]+$/.test(name);
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

  if (options.projectName !== undefined && !isValidFlowProjectName(options.projectName)) {
    throw new CapyError(
      'Project name can only contain letters, numbers, hyphens, and underscores',
      ERROR_CODES.INVALID_FORMAT,
    );
  }

  const targetDir = options.targetDir ?? process.cwd();
  const transport = new FlowClient(undefined, devMode);

  // CAP-451: `--broker-ceremony` mints its OWN ephemeral keypair — its
  // pubkey becomes `client_pubkey` at flow creation (the existing plumbing
  // the explicit `--client-pubkey` caller already uses), and the private
  // half is held here, in this process, for the in-process ceremony to
  // decrypt the sealed answer with. Distinct from the existing explicit
  // `--client-pubkey` caller, whose behavior (and whose keypair, since it
  // never mints one here) is unchanged.
  let clientPubkey = options.clientPubkey;
  let brokerCeremonyKeypair: import('../service/brokerEnvelope').ConnectionKeypair | undefined;
  if (options.brokerCeremony) {
    const { mintConnectionKeypair } = await import('../service/brokerEnvelope');
    const keypair = mintConnectionKeypair();
    clientPubkey = keypair.publicKeyB64;
    brokerCeremonyKeypair = keypair;
  }
  // CAP-451: read by errorScreen.ts so a failure anywhere in this process —
  // including one that escapes all the way out, below — never opens a
  // loopback error page, `--web` notwithstanding. Set unconditionally (not
  // just in the `if` above) so it's also correctly OFF on a re-drive that
  // dropped the flag (there is none today, but this is the same posture
  // `setWebMode` takes: always assert the CURRENT invocation's value).
  const { setBrokerCeremonyMode, setOnboardJsonMode } = await import('../ui/webMode');
  setBrokerCeremonyMode(options.brokerCeremony === true);
  // Read by `runSandboxCeremony` so its rare human-at-a-TTY code print (see
  // that file's doc) never lands inside a `--json` caller's parseable output.
  setOnboardJsonMode(options.json === true);
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
  //
  // Scoped to the user this directory already knows about, when it does: the
  // session file is user-scoped (~/.capy*/auth/sessions/<userId>.json) and the
  // ordinary `capy` run finds it through `.capy/sync-state`'s user_id — the
  // `authenticate` executor writes that id for exactly this reason. Without
  // the scope a fresh reader looks at the unscoped path and finds nothing.
  const getToken = async (): Promise<string | undefined> => {
    const auth = new AuthService(undefined, devMode);
    const pm = new ProjectManager(targetDir);
    const knownUserId = pm.readSyncState()?.user_id;
    if (knownUserId) auth.setSessionUserId(knownUserId);
    // CAP-451 fix: `getValidToken()` alone never resolves anything — it
    // requires `currentOrgId` already set, and nothing on a freshly loaded
    // AuthService sets that (`load()`/`setSessionUserId()` only load the
    // session, they don't authenticate into an org). `authenticateSilent`
    // does that as a side effect on success — cached, refreshed, or the
    // org-less §7.1.1 branch — scoped to sync-state's org hint when one is
    // known (written by the `authenticate` local_action's own `publish()`,
    // or — under `--broker-ceremony` — by the sandbox-session ceremony,
    // which replaces that local_action and writes the same hint).
    const orgHint = pm.readSyncState()?.org_id;
    const result = await auth.authenticateSilent(orgHint);
    if (!result.success) {
      // Not terminal for the RUN — the caller falls back to `mintedToken`
      // (driver.ts) or simply proceeds anonymous — but worth knowing why
      // this particular re-read came up empty.
      debug(`[onboard] getToken: silent auth came up empty (${result.error_code ?? 'no_session'})`);
      return undefined;
    }
    return (await auth.getValidToken())?.access_token ?? result._orgless_access_token ?? undefined;
  };
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
      projectName: options.projectName,
      // Recomputed on demand: only sent when the plan the instance holds has
      // gone stale under the human.
      buildPlan: () => planPayload(targetDir, options.projectName),
      flowId: options.flowId,
      flowSecret: options.flowSecret,
      authMode: clientPubkey ? 'broker_ceremony' : 'interactive_oauth',
      clientPubkey,
      brokerCeremonyKeypair,
      plan: planPayload(targetDir, options.projectName),
      compat: {
        // Local file detection OR's with the caller's own hint — a directory
        // with a real .env/.env.example/etc is ALWAYS usesEnvVars:true,
        // never overridden down by a caller that did not pass the hint.
        usesEnvVars: envKeys.length > 0 || options.usesEnvVars === true,
        framework: options.framework ?? plan.framework,
        externalSecretManager: options.externalSecretManager,
      },
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
    // CAP-451: under --broker-ceremony there is no human at a terminal and
    // no local browser to redirect to — an escaped exception (one that got
    // past every executor's own coded-failure handling) must still surface
    // as JSON on stderr, never a bare re-throw to index.ts's generic
    // `displayErrorAndExit` (whose loopback error page is independently
    // gated off for this mode too, in errorScreen.ts — this is belt and
    // suspenders: the caller gets a parseable object either way).
    if (options.brokerCeremony && options.json) {
      const code = err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR;
      console.error(JSON.stringify({
        error: 'onboard_failed',
        code,
        detail: err instanceof Error ? err.message : String(err),
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/**
 * The plan, in the contract's shape. Names, paths, counts and a hash — never
 * a value. `projectName`, when given, is passed into `buildPlan` itself so
 * `planHash` actually covers it (a rename produces a different hash and
 * re-opens consent — CAP-451 §9 row 7) rather than riding alongside a hash
 * that never saw it. The service now has its own `project_name` slot on
 * this dialog to render (`shared/flows/steps.json`'s `onboard_plan`).
 */
function planPayload(targetDir: string, projectName?: string): Record<string, unknown> {
  const plan = buildPlan({ targetDir, projectName });
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
    ...(projectName ? { project_name: projectName } : {}),
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
