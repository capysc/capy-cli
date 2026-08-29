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
import { CapyError, ERROR_CODES, CliOptions, KeepFile } from '../types/index';
import { debug } from '../ui/debug';
import { FlowClient, FlowHttpError } from '../flows/client';
import { ProjectManager } from '../core/projectManager';
import { FLOW_CONTRACT_VERSION, FlowContractError, FlowStep, validateStep } from '../flows/validate';
import { runOnboardFlow, confirmOnboardPlan } from '../flows/onboard/driver';
import { buildPlan } from '../flows/onboard/plan';
import { readEnvKeys } from '../flows/onboard/edits';
import { existsSync } from 'fs';
import { join as joinPath } from 'path';
import { FileManager } from '../files/fileManager';

export interface OnboardOptions extends CliOptions {
  json?: boolean;
  /** Render interactive stops in a browser (the same wizard `capy --web` uses). */
  web?: boolean;
  targetDir?: string;
  /**
   * Resume a specific instance. OPTIONAL everywhere, including `--accepted`
   * (CAP-487): when omitted, this repo's own instance is resolved from
   * repo_key + identity — the service's attach path, the same one the plain
   * run uses — rather than requiring the caller to thread the id through.
   */
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
  /**
   * Answer a confirm dialog: `--accepted true|false`. `--confirm <plan_hash>`
   * is now OPTIONAL — when omitted, the plan_hash this process confirms with
   * is computed locally (see `runOnboardCommand`'s own doc, Bug A) instead of
   * requiring the caller to echo one back. `accepted` is the actual gate for
   * "this invocation answers a dialog" — `confirm` alone answers nothing.
   */
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
  /**
   * CAP-484: the DB-free owner escape hatch. When this repo's flow is stuck
   * on someone else's instance — a wrong sign-in, a dead ceremony that
   * hasn't self-healed for whatever reason — this cancels it (authorized by
   * org ownership, not by holding its secret or identity) and mints a fresh
   * one in the same run. See `DriverOptions.resetStuckFlow`'s doc in
   * `../flows/onboard/driver.ts`.
   */
  reset?: boolean;
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

/**
 * Does this directory read its configuration from environment variables?
 *
 * `keep.lock` SHORT-CIRCUITS the question. That file is only ever written by a
 * completed onboard, and it enumerates the very variables Capy already manages
 * here — so a directory holding one has demonstrably adopted Capy, and the
 * compat gate (a FIRST-ADOPTION question: "is Capy a fit for this project?")
 * must not be asked of it at all.
 *
 * Without this, a fresh clone of an onboarded repo was refused outright with
 * `blocked: incompatible_project`: `.env` is gitignored by design, so nothing
 * on disk looked like env usage even though keep.lock listed six variables.
 * That is the second-device path — precisely the case onboarding exists to
 * serve.
 */
function usesEnvVars(targetDir: string, hint?: boolean): boolean {
  if (existsSync(joinPath(targetDir, 'keep.lock'))) return true;
  if (hint === true) return true;
  return readEnvKeys(targetDir).length > 0;
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

  // CAP-484: the org this repo already names locally, if any — same readers
  // the observation uses (keep.lock first, then the .env header). Sent at
  // flow creation so the ceremony connection is member-gated: a
  // wrong-account sign-in on the Keep page is refused without consuming the
  // single-use ceremony. A hint, never authority.
  const localOrgHint = ((): string | undefined => {
    let keep: KeepFile | null = null;
    try {
      keep = new ProjectManager(targetDir).readKeepFile();
    } catch {
      keep = null;
    }
    return keep?.org_id ?? new FileManager(targetDir).readEnvMeta(options.envPath).org_id ?? undefined;
  })();

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
  // the table decides what the approval unlocked. Gated on `--accepted`
  // being PRESENT (not on `--confirm`): the hash is now optional — see below.
  if (options.accepted !== undefined) {
    // CAP-487: `--flow-id` is OPTIONAL here now. Requiring the caller to
    // hand it back was a gap of exactly the `--confirm` kind fixed below —
    // the plain `capy onboard` run resolves this repo's own instance from
    // repo_key + identity alone (the service's attach path), so an answer
    // to that instance's dialog can resolve it the same way. Without this,
    // an agent driving `--json` had no signal it must thread the id through,
    // and its `--accepted` call silently recorded nothing: the consent-gated
    // writes never ran and the repo stayed plaintext while looking onboarded.
    let dialogFlowId = options.flowId;
    if (!dialogFlowId) {
      const created = await transport.create(
        {
          contract_version: FLOW_CONTRACT_VERSION,
          auth_mode: clientPubkey ? 'broker_ceremony' : 'interactive_oauth',
          repo_key: targetDir,
          plan: planPayload(targetDir, options.projectName),
          compat: {
            usesEnvVars: usesEnvVars(targetDir, options.usesEnvVars),
            framework: options.framework,
            externalSecretManager: options.externalSecretManager,
          },
          client_pubkey: clientPubkey,
          local_org_hint: localOrgHint,
        },
        token,
      );
      // A create that answered with a step instead of an instance (a lock
      // held by someone else, an incompatible project) is a stop: report it
      // exactly like any other stop step — never confirm into the void.
      if (!created.flow_id) {
        const step = validateStep(created.step);
        await reportResolveStop(options, step);
        return;
      }
      dialogFlowId = created.flow_id;
      options = {
        ...options,
        flowId: dialogFlowId,
        flowSecret: created.flow_secret ?? options.flowSecret,
      };
    }
    // Bug A (CAPY-ONBOARD-SESSION-DUMP.md §3): `--confirm <planHash>` is now
    // OPTIONAL. Requiring a caller to echo the hash back verbatim meant the
    // hash had to round-trip through whatever sits between this process and
    // the human — including a model, whose CLIENT can (and does: Cursor,
    // confirmed) redact high-entropy strings out of tool results before the
    // model ever reads them. When no `--confirm` is given, this process
    // computes the SAME plan_hash locally (`planPayload`, below) that it
    // already posted at flow-creation time for this exact target_dir/
    // project_name, and confirms with that — its own value, never something
    // that had to survive a round trip. A caller that still passes an
    // explicit hash (the TTY path, or any future caller) is unaffected.
    const planHash = options.confirm ?? (planPayload(targetDir, options.projectName).plan_hash as string);
    try {
      await confirmOnboardPlan(transport, dialogFlowId, planHash, options.accepted === true, {
        secret: options.flowSecret,
        token,
      });
    } catch (err) {
      // The service refused this confirm because the plan it holds no
      // longer matches the hash offered — the human approved a plan that
      // has since moved (edited on disk, or a caller offering a hash it
      // never actually saw for this instance, e.g. a redacted sentinel).
      // This used to escape uncaught: past `runOnboardCommand` entirely (this
      // whole block sits BEFORE the try/catch below), into index.ts's generic
      // `displayErrorAndExit`, which prints prose to STDOUT unconditionally —
      // exactly the "Onboarding did not return a result (exit 1).\nFlow
      // request failed: CONFLICT_RESOLUTION (HTTP 409)." an MCP caller saw
      // instead of a step it could act on. Caught here instead and turned
      // into the SAME shape any other `blocked` step already is: coded,
      // structured, and — in `--json` mode — still exactly one JSON object
      // on stdout.
      if (err instanceof FlowHttpError && err.status === 409) {
        await reportPlanChanged(options, dialogFlowId);
        return;
      }
      throw err;
    }
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
      localOrgHint,
      resetStuckFlow: options.reset === true,
      authMode: clientPubkey ? 'broker_ceremony' : 'interactive_oauth',
      clientPubkey,
      brokerCeremonyKeypair,
      plan: planPayload(targetDir, options.projectName),
      compat: {
        // Local file detection OR's with the caller's own hint — a directory
        // with a real .env/.env.example/etc is ALWAYS usesEnvVars:true,
        // never overridden down by a caller that did not pass the hint.
        usesEnvVars: usesEnvVars(targetDir, options.usesEnvVars),
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
      console.error(JSON.stringify({
        error: 'onboard_failed',
        code: resolveOnboardFailureCode(err),
        detail: err instanceof Error ? err.message : String(err),
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/**
 * The `code` to report on the `--broker-ceremony --json` belt-and-suspenders
 * path above: a `CapyError`'s own code, or — for a raw `FlowHttpError`
 * escaping `runOnboardFlow` uncaught (e.g. a 409 `CLIENT_PUBKEY_CONFLICT` off
 * a `next` report that offered a different key than the one already
 * registered for this instance) — its own `.code`, when the service sent one
 * this build recognises. Same known-code guard `errorScreen.ts`'s
 * `renderError` already applies to the TTY path, so a coded flow-service
 * failure surfaces identically on both. Falls back to the generic service
 * error otherwise. Never reads `err.message` to decide anything (Rule 5) —
 * `detail` below is for display only.
 */
function resolveOnboardFailureCode(err: unknown): string {
  if (err instanceof CapyError) return err.code;
  if (err instanceof FlowHttpError) {
    const known = (Object.values(ERROR_CODES) as string[]).includes(err.code ?? '');
    if (known) return err.code as string;
  }
  return ERROR_CODES.SERVICE_ERROR;
}

/**
 * A confirm the service refused with HTTP 409: the plan it holds moved out
 * from under the hash offered (a stale re-approval, a directory edited since
 * the dialog was shown, or a caller — Cursor's model, redacting a high-entropy
 * string it mistook for a secret — that could never have offered the real
 * hash in the first place). Reported exactly like any other `blocked` step
 * this run could have stopped on: coded, never the raw HTTP prose, and — in
 * `--json` mode — still exactly the one object on stdout the whole run
 * promises. The remedy is the same one every other stale-plan case gets: call
 * `capy_onboard`/`capy onboard` again with no `--confirm` to fetch the fresh
 * plan and ask the human again. This run's own previous approval no longer
 * applies — the caller must not silently re-show the old plan as if nothing
 * happened.
 */
async function reportPlanChanged(options: OnboardOptions, flowId: string): Promise<void> {
  const step: FlowStep = {
    contract_version: FLOW_CONTRACT_VERSION,
    flow_id: flowId,
    flow_type: 'onboard',
    step_id: `${flowId}-confirm-conflict`,
    kind: 'blocked',
    resumed: false,
    reason: 'plan_changed',
    params: {},
  };
  if (options.json) {
    const out: OnboardJson = { flow_id: flowId, resumed: false, step, executed: [] };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  // Same rendering renderInteractive's own `blocked` branch uses (console.error
  // + exit 1) — this is a TTY/`--web` fallback path, not the json-purity fix
  // `human()` exists for, so it stays byte-identical to that existing branch.
  const { describeBlocked } = await import('../flows/onboard/copy');
  console.error(`\n${describeBlocked('plan_changed')}`);
  process.exitCode = 1;
}

/**
 * CAP-487: the flow-resolving create (an `--accepted` call with no
 * `--flow-id`) answered with a step instead of an instance — a lock held by
 * a different identity, an incompatible project. Reported exactly like the
 * same step from any other run: in `--json` mode still exactly one object on
 * stdout, on a TTY the same blocked rendering `renderInteractive` uses. The
 * dialog answer was NOT recorded — there is no instance of this caller's to
 * record it on — and the caller must not proceed as if it was.
 */
async function reportResolveStop(options: OnboardOptions, step: FlowStep): Promise<void> {
  if (options.json) {
    const out: OnboardJson = { flow_id: step.flow_id, resumed: false, step, executed: [] };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const { describeBlocked } = await import('../flows/onboard/copy');
  console.error(`\n${describeBlocked(step.reason as string)}`);
  process.exitCode = 1;
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
