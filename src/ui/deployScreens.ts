// `capy deploy`, served as compiled screens.
//
// Twenty questions live in this command and none of them had a browser answer.
// They are asked as a run of `inquirer` prompts with nothing between them, and
// how many there are depends on the platform: pick Vercel and a mode question
// appears, pick Heroku and it silently does not. Three of them are quietly
// load-bearing —
//
//   1. the variable checkbox is the only boundary between a runtime secret and
//      a public browser bundle: a Pages build inlines whatever is ticked into
//      JavaScript the browser downloads;
//   2. the Vercel git-branch question is asked one prompt after the *capy*
//      branch question, in almost the same words, and answering the second
//      with the first pushes every variable to a Preview environment nothing
//      is wired to;
//   3. the confirm gate reads one raw keypress, and `d` deletes the saved
//      target immediately — no second question, no summary of what is going.
//
// Under `--web` each of them becomes a stop on a route that is declared BEFORE
// anything opens. The route is `deployPlan`'s, not this file's and not the
// screen's: one builder feeds the payload and `--json`, which is the only way
// the rail a person reads and the array an agent parses can be claimed to be
// the same array.
//
// Renders variable NAMES only, everywhere. Preflight deliberately runs before
// a single value is decrypted and these screens sit in the same window, so no
// plaintext exists yet when they are drawn — and the deploy PR body already
// holds itself to the same rule.
import { runBrowserWizard } from './browserWizard';
import { refusalOn, withDeclineBridge } from './declineBridge';
import { renderScreen } from './screens/serve';
import { deployPlan, SIGNIN_COMMAND, type DeployStopId } from '../core/deployPlan';
import type {
  DeployAdapterChoice,
  DeployChangeGate,
  DeployDelivery,
  DeployDestinationData,
  DeployDestinationStep,
  DeployDrift,
  DeployPlanConfirmData,
  DeployPlanTarget,
  DeployPlatform,
  DeployPreflightCheck,
  DeployRunResultData,
  DeploySettings,
  DeploySetupIntent,
  DeploySetupStep,
  DeployTargetRow,
  DeployTargetSetupData,
  DeployTargetsData,
  DeployTargetsPurpose,
  DeployTokenRow,
  DeployTokensData,
  DeployVar,
  Gloss,
  NonTtyEscape,
  ScreenDataMap,
  ScreenName,
} from './screens/contract';
import type { DeployMode } from '../deploy/adapter';
import type { AuthService } from '../auth/authService';
import { keepScreensEnabled } from './screens/keepScreens';
import { runKeepInfoScreen } from '../service/keepPayloadRelay';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to strings the CLI also PRINTS — the detected-defaults line, an
 * adapter's dim description, a step's detail — because a payload is not a
 * terminal and an escape renders as a literal `[90m` in the browser.
 *
 * Deliberately NOT applied to an identifier that has to round-trip: a target
 * name, a variable name and a branch name come back as the answer this command
 * then acts on, so rewriting them here would mean the browser could only ever
 * ask for a target that does not exist. Those are checked against the list the
 * server sent instead, which no rewriting can defeat.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** `stripAnsi` for an optional field, keeping `undefined` as `undefined`. */
const stripOpt = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : stripAnsi(s);

/**
 * `stripAnsi` across a `Gloss` — the segmented one-liners a screen marks up.
 *
 * A gloss is built from an adapter's own description, which is written for a
 * terminal. Only the prose segments are rewritten; a `{ code }` segment is a
 * command the user retypes and is left exactly as it is.
 */
const stripGloss = (g: Gloss): Gloss =>
  g.map((seg) => (typeof seg === 'string' ? stripAnsi(seg) : seg));

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** Common test/production knobs every serve function takes. */
interface WebServeOptions {
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * How long a screen with no way to refuse stays open.
 *
 * `deploy-targets` and `deploy-tokens` are the two screens here that are not
 * wizards: neither has a Cancel, and their `list` views offer nothing but the
 * action itself — `Edit target` / `Remove target`, `Revoke token`. So a run
 * that opens one and is never answered has only ONE signal available to it,
 * silence, and this deadline is what turns that silence into an ending.
 *
 * Deliberately not the wizard's five minutes. Five minutes of a terminal that
 * has printed nothing, after a user has already decided not to do the thing,
 * is not an ending anybody experiences as one — and `capy deploy targets --web`
 * is a LISTING, which should cost about as much as `ls`. Two minutes is the
 * CLI's own display-screen default: long enough to read a listing and type a
 * name back, short enough that a command that is over feels over.
 *
 * It is the backstop, not the mechanism. A CONFIRM view — one question, one
 * destructive answer — ends the moment the user declines, through
 * `withDeclineBridge`; this deadline is what is left for the listings, where
 * there is no decline to detect because there is no question outstanding.
 */
export const NO_REFUSAL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// deploy-destination — where this project deploys, and how
// ---------------------------------------------------------------------------

export interface WebDeployDestinationParams extends WebServeOptions {
  /** Every platform the CLI knows, in the order it offers them. */
  platforms: DeployPlatform[];
  /** The platform recorded in `.capy/config`, pre-selected. */
  lastPlatform?: string;
  /** Settled by `--platform`; that step is not asked. */
  platform?: string;
  /** Settled by `--mode`; that step is not asked. */
  mode?: 'connector' | 'token';
  /** Why the previous answer was refused — an invalid `--platform`, usually. */
  rejected?: { argv?: string; message: string };
}

export interface WebDeployDestinationResult {
  platform: string;
  /**
   * Null when the chosen platform has no connector: that question does not
   * exist for it, which is a different fact from "they chose the token route".
   */
  mode: 'connector' | 'token' | null;
  cancelled: boolean;
}

/** Which question this run is standing on, or null when nothing is left. */
function destinationStep(p: WebDeployDestinationParams): DeployDestinationStep | null {
  if (!p.platform) return 'platform';
  const row = p.platforms.find((x) => x.id === p.platform);
  if (row?.hasConnector && p.mode === undefined) return 'mode';
  return null;
}

export function buildDeployDestinationData(
  p: WebDeployDestinationParams,
  nonce: string,
): DeployDestinationData {
  const step = destinationStep(p);
  const row = p.platform ? p.platforms.find((x) => x.id === p.platform) : undefined;

  const answers: Partial<Record<DeployStopId, string>> = {};
  if (row) answers.platform = row.name;
  if (p.mode) answers.mode = p.mode === 'connector' ? 'Connector' : 'Deploy token';

  // A platform with no connector never reaches the mode question — the
  // terminal skips it in silence, and this is the line that says so.
  const skipped: DeployStopId[] = row && !row.hasConnector ? ['mode'] : [];

  return {
    nonce,
    // `currentStep` returning null means there is nothing to serve and the
    // caller never opens a browser. Falling back to the platform step keeps
    // the type total without inventing a third view.
    step: step ?? 'platform',
    stops: deployPlan({ at: step, answers, skipped }),
    platforms: p.platforms,
    lastPlatform: p.lastPlatform,
    platform: row,
    rejected: p.rejected,
    nonTty: {
      command: 'capy deploy --platform <id> --mode connector',
      why: 'The platform decides which connector runs and the mode decides whether Capy deploys at all, so neither is guessed: an unanswered run refuses rather than picking one.',
    },
  };
}

/**
 * Serve the two questions at the front of `capy deploy`.
 *
 * Two stops over one server, so answering the first is a page RELOAD and the
 * same address then serves the second — a compiled screen is a whole document
 * and cannot be spliced into the open page.
 */
export async function chooseDeployDestinationInBrowser(
  p: WebDeployDestinationParams,
): Promise<WebDeployDestinationResult> {
  // The nonce is minted inside `runBrowserWizard` and reaches a caller only
  // through `renderFirst`. A second standalone step has to be rendered with
  // that same token, so it is captured on the way past rather than this flow
  // minting one of its own.
  let nonce = '';
  let answered: WebDeployDestinationParams = { ...p };
  const render = (): string =>
    renderScreen('deploy-destination', buildDeployDestinationData(answered, nonce));

  const out = await runBrowserWizard(
    {
      title: 'Deploy',
      flow: 'deploy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Answered — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { platform: '', mode: null, cancelled: true } };
      }

      const step = destinationStep(answered);
      if (step === 'platform') {
        const id = typeof payload.platform === 'string' ? payload.platform : '';
        // The page offers exactly the list this run sent, so anything else is
        // a malformed submit rather than a user mistake — and the answer is
        // written to `.capy/config` and decides which connector runs.
        if (!p.platforms.some((x) => x.id === id)) {
          return { error: 'That platform is not one this run offers.' };
        }
        answered = { ...answered, platform: id };
      } else if (step === 'mode') {
        const mode = payload.mode;
        if (mode !== 'connector' && mode !== 'token') {
          return { error: 'That is not an answer the mode step can produce.' };
        }
        answered = { ...answered, mode };
      } else {
        return { error: 'There is nothing left to answer on this run.' };
      }

      if (destinationStep(answered) === null) {
        const row = p.platforms.find((x) => x.id === answered.platform);
        return {
          done: true,
          result: {
            platform: answered.platform!,
            // A platform with no connector was never asked, so it answers
            // null rather than a mode nobody chose.
            mode: row?.hasConnector ? (answered.mode ?? 'connector') : null,
            cancelled: false,
          },
        };
      }
      return { screen: { html: render(), standalone: true } };
    },
  );
  return out as WebDeployDestinationResult;
}

// ---------------------------------------------------------------------------
// deploy-target-setup — the target being described
// ---------------------------------------------------------------------------

/**
 * Everything the settings, variables, delivery and name steps need, resolved
 * once the adapter is known.
 *
 * A callback rather than a field because the adapter can be chosen IN the
 * browser: `adapter.detect(cwd)` is async and only meaningful afterwards, so
 * the CLI runs it in the reducer — which is async — exactly where the terminal
 * runs it, one line after the picker.
 */
export interface WebDeployAdapterContext {
  id: string;
  label: string;
  /**
   * One line on what this adapter does with your secrets, as segments — the
   * terminal's dim description. Segmented because every one of these names
   * something the user could retype (`wrangler secret bulk`, `VITE_*`), and a
   * plain string cannot mark up its own middle.
   */
  detail: Gloss;
  /** The terminal's `Detected: …` line. Absent when detection found nothing. */
  detected?: string;
  /** Settings defaults, already merged saved-over-detected as the CLI merges them. */
  defaults: Record<string, string>;
  /** Variables on the active branch, by NAME. Never a value. */
  vars: DeployVar[];
  /** What the pre-ticked set was chosen by: `all vars`, a prefix list. */
  presetLabel: string;
  delivery: DeployDelivery;
  /** Local + origin git refs, most-recent first. For a Vercel Preview target. */
  gitBranches: string[];
  /** False when `aws configure get region` had no answer and us-east-1 was assumed. */
  regionDetected: boolean;
  /** The variable the aws-ssm naming preview is demonstrated on. */
  exampleVar: string;
}

export interface WebDeploySetupParams extends WebServeOptions {
  intent: DeploySetupIntent;
  /**
   * The steps this run asks, in order. The CLI decides — an existing target
   * has already chosen its adapter, and the Vercel heal path asks for settings
   * and nothing else.
   */
  steps: DeploySetupStep[];
  /** Rail context: the platform answer from earlier in the run. */
  platformAnswer?: string;
  /** Set only when the mode question was really asked. Absent → that stop is skipped. */
  modeAnswer?: string;
  /** Offered on the `adapter` step, planned rows included. */
  adapters?: DeployAdapterChoice[];
  /** Chosen before the browser opened: a saved target, or `--target <id>`. */
  adapterId?: string;
  /** Capy branches in keep.lock. Empty → the CLI offers `development` only. */
  capyBranches: string[];
  /** The CLI's own default branch for this target. */
  branch: string;
  /** Saved target names, so a silent overwrite is caught before it happens. */
  existingNames: string[];
  /** The saved target's name, when this is an edit. */
  existingName?: string;
  /** Resolve label, detected defaults and everything downstream of the adapter. */
  resolveAdapter: (id: string) => Promise<WebDeployAdapterContext>;
}

export interface WebDeploySetupResult {
  adapterId: string;
  branch: string;
  options: Record<string, unknown>;
  vars: string[];
  mode: DeployMode;
  gitBaseBranch?: string;
  name: string;
  cancelled: boolean;
}

/** The answers folded forward as the run walks its steps. */
interface SetupAnswers {
  adapterId?: string;
  branch?: string;
  options?: Record<string, unknown>;
  vars?: string[];
  mode?: DeployMode;
  gitBaseBranch?: string;
  name?: string;
}

/** Which step id draws which stop. `drift` is the variables stop, re-asked. */
const STEP_STOP: Record<DeploySetupStep, DeployStopId> = {
  adapter: 'platform',
  branch: 'branch',
  settings: 'settings',
  variables: 'variables',
  drift: 'variables',
  delivery: 'delivery',
  name: 'name',
};

/** A one-line summary of the adapter settings, for the rail. */
function settingsAnswer(adapterId: string, options: Record<string, unknown>): string | undefined {
  const s = (k: string): string | undefined =>
    typeof options[k] === 'string' ? (options[k] as string) : undefined;
  switch (adapterId) {
    case 'cf-worker': {
      const name = s('workerName');
      const dir = s('workerDir');
      return name ? (dir && dir !== '.' ? `${name} in ${dir}` : name) : undefined;
    }
    case 'cf-pages':
      return s('projectName');
    case 'vercel': {
      const dir = s('projectDir');
      const env = s('vercelEnv');
      return dir && env ? `${dir} · ${env}` : (env ?? dir);
    }
    case 'aws-ssm': {
      const region = s('region');
      const prefix = s('pathPrefix');
      return region && prefix ? `${region} · ${prefix}` : (region ?? prefix);
    }
    default:
      return undefined;
  }
}

/** The settings block for the step, built from the CLI's own defaults. */
function settingsFor(
  ctx: WebDeployAdapterContext,
  d: Record<string, string>,
): DeploySettings | undefined {
  switch (ctx.id) {
    case 'cf-worker':
      return {
        kind: 'cf-worker',
        workerName: d.workerName ?? '',
        workerDir: d.workerDir ?? '.',
      };
    case 'cf-pages':
      return {
        kind: 'cf-pages',
        projectName: d.projectName ?? '',
        buildDir: d.buildCwd ?? '.',
        buildCommand: d.buildCmd ?? 'bun run build',
        distDir: d.distDir ?? 'dist',
      };
    case 'vercel':
      return {
        kind: 'vercel',
        projectDir: d.projectDir ?? '.',
        env: d.vercelEnv === 'production' ? 'production' : 'preview',
        gitBranch: d.gitBranch ?? '',
        gitBranches: ctx.gitBranches,
      };
    case 'aws-ssm':
      return {
        kind: 'aws-ssm',
        region: d.region ?? 'us-east-1',
        regionDetected: ctx.regionDetected,
        pathPrefix: d.pathPrefix ?? '/capy/',
        naming: d.naming === 'kebab' ? 'kebab' : 'verbatim',
        exampleVar: ctx.exampleVar,
      };
    default:
      return undefined;
  }
}

/** The CLI's own path-prefix rule, so the two surfaces cannot disagree. */
const PATH_PREFIX_RULE = /^\/[a-zA-Z0-9_.\-/]*\/$/;
/** The CLI's own target-name rule: `upsertTarget` keys by exactly this shape. */
const TARGET_NAME_RULE = /^[a-z0-9][a-z0-9-]*$/;

const SETUP_NON_TTY: Record<DeploySetupStep, NonTtyEscape> = {
  adapter: {
    command: 'capy deploy --target <id> --yes',
    why: 'The adapter decides which vendor CLI runs and what a variable means to it, so it is never picked for you.',
  },
  branch: {
    command: 'capy deploy --target <id> --yes',
    why: 'Off a TTY the branch falls back to production, or to the first branch in keep.lock — a guess about whose secrets ship.',
  },
  settings: {
    command: 'capy deploy --target <id> --yes',
    why: 'Settings come from what Capy can detect in this directory. Anything it cannot detect has no headless answer, so run the picker once interactively.',
  },
  variables: {
    command: 'capy deploy --target <id> --yes',
    why: 'The pre-ticked set is a prefix rule, not a decision. Under --yes it is taken as one, and on a build-time target that decides what ends up in a public bundle.',
  },
  drift: {
    command: 'capy deploy <name> --yes',
    why: 'Under --yes a variable added since the target was saved refuses the run, and one removed is dropped silently. Neither is an answer to what should ship.',
  },
  delivery: {
    command: 'capy deploy --target <id> --yes',
    why: 'Delivery is the difference between opening a pull request and shipping from this machine. A target saved without it resolves to direct — the irreversible one.',
  },
  name: {
    command: 'capy deploy --target <id> --yes',
    why: 'An unnamed run builds an ad-hoc target that is never written to disk, so the next deploy re-detects everything from scratch.',
  },
};

export function buildDeployTargetSetupData(
  p: WebDeploySetupParams,
  nonce: string,
  step: DeploySetupStep,
  ctx: WebDeployAdapterContext | null,
  answered: SetupAnswers,
): DeployTargetSetupData {
  const answers: Partial<Record<DeployStopId, string>> = {};
  if (p.platformAnswer) answers.platform = stripAnsi(p.platformAnswer);
  else if (ctx) answers.platform = stripAnsi(ctx.label);
  if (p.modeAnswer) answers.mode = stripAnsi(p.modeAnswer);
  if (answered.branch) answers.branch = answered.branch;
  if (answered.options && ctx) {
    const summary = settingsAnswer(ctx.id, answered.options);
    if (summary) answers.settings = stripAnsi(summary);
  }
  if (answered.vars) answers.variables = plural(answered.vars.length, 'variable', 'variables');
  if (answered.mode) answers.delivery = answered.mode === 'ci' ? 'CI' : 'Direct';
  if (answered.name) answers.name = answered.name;

  // Stops this run will not travel: the mode question when it was never asked,
  // and any setup stop no step in this run's route reaches (an existing target
  // has already chosen its adapter; the Vercel heal path asks settings alone).
  const willVisit = new Set(p.steps.map((s) => STEP_STOP[s]));
  const skipped: DeployStopId[] = [];
  if (!p.modeAnswer) skipped.push('mode');
  for (const stop of new Set(Object.values(STEP_STOP))) {
    if (!willVisit.has(stop) && answers[stop] === undefined && !skipped.includes(stop)) {
      skipped.push(stop);
    }
  }

  return {
    nonce,
    step,
    intent: p.intent,
    stops: deployPlan({ at: STEP_STOP[step], answers, skipped }),
    adapters: step === 'adapter' ? p.adapters : undefined,
    adapter: ctx
      ? { id: ctx.id, label: stripAnsi(ctx.label), detail: stripGloss(ctx.detail) }
      : undefined,
    detected: ctx?.detected ? stripAnsi(ctx.detected) : undefined,
    capyBranches: p.capyBranches,
    branch: answered.branch ?? p.branch,
    settings: ctx
      ? settingsFor(ctx, { ...ctx.defaults, ...(answered.options as Record<string, string>) })
      : undefined,
    vars: ctx?.vars,
    presetLabel: ctx?.presetLabel,
    delivery: ctx
      ? {
          ...ctx.delivery,
          mode: answered.mode ?? ctx.delivery.mode,
          prBase: answered.gitBaseBranch ?? ctx.delivery.prBase,
        }
      : undefined,
    name: answered.name ?? p.existingName ?? (ctx ? `${ctx.id}-${answered.branch ?? p.branch}` : ''),
    existingNames: p.existingNames,
    nonTty: SETUP_NON_TTY[step],
  };
}

/** Read a trimmed string field off a submit. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Serve the picker.
 *
 * One step per render, folding each answer forward, so the rail redraws itself
 * from `deployPlan` rather than this file deciding what a stop's state is.
 * Every refusal below is inline: the screen holds its button on all of them,
 * so an answer that breaks one did not come from the screen, and applying a
 * guess would write a target that pushes somebody's secrets somewhere.
 */
export async function setUpDeployTargetInBrowser(
  p: WebDeploySetupParams,
): Promise<WebDeploySetupResult> {
  let nonce = '';
  let ctx: WebDeployAdapterContext | null = null;
  let answered: SetupAnswers = {};
  let index = 0;

  if (p.adapterId) {
    ctx = await p.resolveAdapter(p.adapterId);
    answered.adapterId = p.adapterId;
  }

  const render = (): string =>
    renderScreen(
      'deploy-target-setup',
      buildDeployTargetSetupData(p, nonce, p.steps[index], ctx, answered),
    );

  /** Everything the caller asked for, with the CLI's defaults for the rest. */
  const settle = (): WebDeploySetupResult => ({
    adapterId: answered.adapterId ?? p.adapterId ?? '',
    branch: answered.branch ?? p.branch,
    options: answered.options ?? {},
    vars: answered.vars ?? (ctx?.vars.filter((v) => v.checked).map((v) => v.name) ?? []),
    mode: answered.mode ?? ctx?.delivery.mode ?? 'direct',
    gitBaseBranch: answered.gitBaseBranch ?? (ctx?.delivery.mode === 'ci' ? ctx.delivery.prBase : undefined),
    name: answered.name ?? p.existingName ?? '',
    cancelled: false,
  });

  const out = await runBrowserWizard(
    {
      title: 'Set up a deploy target',
      flow: 'deploy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Target described — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { ...settle(), cancelled: true } };
      }

      const step = p.steps[index];
      if (step === undefined) return { error: 'There is nothing left to answer on this run.' };

      switch (step) {
        case 'adapter': {
          const id = str(payload.adapter);
          const row = p.adapters?.find((a) => a.id === id);
          // A planned adapter is rendered disabled: it is announced, not
          // shippable, and a target saved against one deploys nothing.
          if (!row || row.planned) {
            return { error: 'That adapter is not one this run can deploy to.' };
          }
          ctx = await p.resolveAdapter(id);
          answered = { ...answered, adapterId: id };
          break;
        }
        case 'branch': {
          const branch = str(payload.branch);
          const offered = p.capyBranches.length > 0 ? p.capyBranches : ['development'];
          if (!offered.includes(branch)) {
            return { error: 'That branch is not one this project has.' };
          }
          answered = { ...answered, branch };
          break;
        }
        case 'settings': {
          const problem = settingsProblem(ctx, payload);
          if (typeof problem === 'string') return { error: problem };
          answered = { ...answered, options: problem };
          break;
        }
        case 'variables':
        case 'drift': {
          const offered = new Set((ctx?.vars ?? []).map((v) => v.name));
          const raw = Array.isArray(payload.vars) ? payload.vars : [];
          const vars = raw.filter((v): v is string => typeof v === 'string' && offered.has(v));
          if (vars.length !== raw.length) {
            return { error: 'That list contains a variable this branch does not have.' };
          }
          // The CLI's own validator: `select at least one`. A target with no
          // variables has nothing to push, and saving one is a deploy that
          // reports success having sent nothing.
          if (vars.length === 0) {
            return { error: 'Select at least one variable — a target with none has nothing to push.' };
          }
          answered = { ...answered, vars };
          break;
        }
        case 'delivery': {
          const mode = payload.mode;
          if (mode !== 'ci' && mode !== 'direct') {
            return { error: 'That is not an answer the delivery step can produce.' };
          }
          // A CI-only adapter has no direct mode at all — Capy never runs its
          // CLI — so `direct` here would push secrets and hope.
          if (ctx?.delivery.ciOnly && mode !== 'ci') {
            return { error: `${ctx.label} always deploys through CI.` };
          }
          if (mode === 'ci') {
            const base = str(payload.gitBaseBranch);
            if (!base) return { error: 'Enter the git branch the deploy PR should open against.' };
            answered = { ...answered, mode, gitBaseBranch: base };
          } else {
            answered = { ...answered, mode, gitBaseBranch: undefined };
          }
          break;
        }
        case 'name': {
          const name = str(payload.name);
          if (!TARGET_NAME_RULE.test(name)) {
            return { error: 'Target names are lowercase letters, numbers and dashes, starting with a letter or a number.' };
          }
          answered = { ...answered, name };
          break;
        }
      }

      index += 1;
      if (index >= p.steps.length) return { done: true, result: settle() };
      // A whole document cannot be spliced into the open page, so it is handed
      // back as `standalone` and the browser reloads to receive it.
      return { screen: { html: render(), standalone: true } };
    },
  );
  return out as WebDeploySetupResult;
}

/**
 * Validate a settings submit against the adapter it claims to be for.
 *
 * Returns the options to save, or the sentence to show. Each rule is the CLI's
 * own — the same emptiness checks its `validate` callbacks make and the same
 * path-prefix regex — so a value one surface accepts is never refused by the
 * other.
 */
function settingsProblem(
  ctx: WebDeployAdapterContext | null,
  payload: Record<string, unknown>,
): string | Record<string, unknown> {
  if (!ctx) return 'No adapter has been chosen on this run.';
  switch (ctx.id) {
    case 'cf-worker': {
      const workerName = str(payload.workerName);
      const workerDir = str(payload.workerDir);
      if (!workerName) return 'Worker name cannot be empty — it is the name field in wrangler.toml.';
      if (!workerDir) return 'Worker directory cannot be empty — use . if wrangler.toml is at the repository root.';
      return { workerName, workerDir };
    }
    case 'cf-pages': {
      const projectName = str(payload.projectName);
      const buildCwd = str(payload.buildCwd);
      const buildCmd = str(payload.buildCmd);
      const distDir = str(payload.distDir);
      if (!projectName) return 'Pages project name cannot be empty — wrangler pages project list prints the names.';
      if (!buildCwd) return 'Build directory cannot be empty — use . if package.json is at the repository root.';
      if (!buildCmd) return 'Build command cannot be empty.';
      if (!distDir) return 'Dist directory cannot be empty — it is where the build leaves its output.';
      return { projectName, buildCwd, buildCmd, distDir };
    }
    case 'vercel': {
      const projectDir = str(payload.projectDir);
      const vercelEnv = payload.vercelEnv;
      if (!projectDir) return 'Project directory cannot be empty — use . if the Vercel project is at the repository root.';
      if (vercelEnv !== 'preview' && vercelEnv !== 'production') {
        return 'That is not a Vercel environment this step offers.';
      }
      if (vercelEnv === 'production') {
        // Dropped rather than sent empty: Production is not branch-scoped, and
        // a blank would preflight as "missing" on the next run.
        return { projectDir, vercelEnv };
      }
      const gitBranch = str(payload.gitBranch);
      if (!gitBranch) {
        return 'Pick the git branch the Preview environment is wired to — this is a git branch, not a capy branch.';
      }
      return { projectDir, vercelEnv, gitBranch };
    }
    case 'aws-ssm': {
      const region = str(payload.region);
      const pathPrefix = str(payload.pathPrefix);
      const naming = payload.naming;
      if (!region) return 'AWS region cannot be empty.';
      if (!PATH_PREFIX_RULE.test(pathPrefix)) {
        return 'Parameter path prefix must start and end with / — for example /capy/prod/.';
      }
      if (naming !== 'verbatim' && naming !== 'kebab') {
        return 'That is not a naming scheme this step offers.';
      }
      return { region, pathPrefix, naming };
    }
    default:
      return 'This adapter has no settings this run can save.';
  }
}

// ---------------------------------------------------------------------------
// deploy-plan-confirm — the last gate before anything is decrypted
// ---------------------------------------------------------------------------

/** What the gate came back with. `edit` is an answer the CLI acts on. */
export type WebDeployDecision = 'deploy' | 'edit' | 'delete';

export interface WebDeployConfirmParams extends WebServeOptions {
  target: DeployPlanTarget;
  /** Whether the primary button opens a PR or ships from this machine. */
  action: 'ci' | 'direct';
  dryRun: boolean;
  preflight: DeployPreflightCheck[];
  /** True once `adapter.preflight` has passed — the only thing that can say
   *  the manual vendor sign-in really happened. */
  signedIn: boolean;
  drift?: DeployDrift;
  changeGate?: DeployChangeGate;
  /** Working-tree changes other than keep.lock, which a direct deploy stashes. */
  otherGitChanges?: number;
  /** Set only when the mode question was really asked earlier in the run. */
  modeAnswer?: string;
  /**
   * The decisions this gate will honour.
   *
   * The confirm gate takes all three. The change-gate question that comes
   * after decryption takes only `deploy` — the picker cannot be re-entered
   * from there, and the CLI's own prompt at that point is a bare y/N.
   */
  allow?: readonly WebDeployDecision[];
  rejected?: string;
}

export interface WebDeployConfirmResult {
  /** Null when the window was cancelled: an unanswered gate is a refusal. */
  decision: WebDeployDecision | null;
  /** The change-gate switch. False unless the page asked and it was set. */
  force: boolean;
  cancelled: boolean;
}

export function buildDeployPlanConfirmData(
  p: WebDeployConfirmParams,
  nonce: string,
): DeployPlanConfirmData {
  const t = p.target;
  const answers: Partial<Record<DeployStopId, string>> = {
    platform: stripAnsi(t.adapterLabel),
    branch: t.branch,
    variables: plural(t.vars.length, 'variable', 'variables'),
    delivery: t.mode === 'ci' ? 'CI' : 'Direct',
  };
  if (p.modeAnswer) answers.mode = stripAnsi(p.modeAnswer);
  const settings = settingsAnswer(
    t.adapterId,
    Object.fromEntries(t.options.map((o) => [o.key, o.value])),
  );
  if (settings) answers.settings = stripAnsi(settings);
  // Preflight is the only place Capy learns whether the vendor session the
  // user established by hand exists. Before it, the stop is honestly unknown.
  if (p.signedIn && SIGNIN_COMMAND[t.adapterId]) answers.signin = SIGNIN_COMMAND[t.adapterId];
  if (t.saved) answers.name = t.name;

  const skipped: DeployStopId[] = [];
  if (!p.modeAnswer) skipped.push('mode');
  // An ad-hoc target was assembled from `--target` and never named, so the
  // naming question did not happen rather than being answered.
  if (!t.saved) skipped.push('name');

  return {
    nonce,
    stops: deployPlan({ at: 'review', answers, skipped, dryRun: p.dryRun }),
    // The label and the preflight rows are strings the CLI also PRINTS, so
    // they arrive coloured and would render as a literal `[90m` on the page.
    // `name` is deliberately NOT rewritten: it is the string the delete gate
    // makes the user type back, and it has to match what is on disk.
    target: { ...t, adapterLabel: stripAnsi(t.adapterLabel) },
    action: p.action,
    dryRun: p.dryRun,
    preflight: p.preflight.map((c) => ({
      ...c,
      label: stripAnsi(c.label),
      detail: stripOpt(c.detail),
      fix: stripOpt(c.fix),
    })),
    drift: p.drift,
    changeGate: p.changeGate,
    otherGitChanges: p.otherGitChanges,
    rejected: p.rejected,
    nonTty: {
      command: `capy deploy ${t.name} --yes`,
      why: '--yes is not optional off a TTY: without it the confirm resolves to cancel and the run exits 0 having deployed nothing.',
    },
    deleteNonTty: {
      command: `capy deploy targets-remove ${t.name}`,
      why: 'Removing a target deletes its platform, branch, settings and variable list from .capy/deploy.json, and nothing keeps a copy.',
    },
  };
}

/**
 * Serve the gate and wait for a decision.
 *
 * `edit` is an ANSWER, not an exit: the CLI re-enters the picker and comes
 * back here with the edited target, exactly as pressing `e` does at the TTY.
 */
export async function confirmDeployInBrowser(
  p: WebDeployConfirmParams,
): Promise<WebDeployConfirmResult> {
  const allow = p.allow ?? (['deploy', 'edit', 'delete'] as const);
  const out = await runBrowserWizard(
    {
      title: `Review this deploy — ${p.target.name}`,
      flow: 'deploy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Answered — back to your terminal.',
      renderFirst: (nonce) =>
        renderScreen('deploy-plan-confirm', buildDeployPlanConfirmData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { decision: null, force: false, cancelled: true } };
      }
      const decision = payload.decision;
      if (decision !== 'deploy' && decision !== 'edit' && decision !== 'delete') {
        return { error: 'That is not a decision this gate can take.' };
      }
      if (!allow.includes(decision)) {
        // The change-gate question is asked after the plan was already
        // approved and after the secrets were decrypted; there is no picker
        // left to re-enter and no target left to delete without stranding the
        // run half-done.
        return { error: 'That is not available at this point in the run.' };
      }
      if (decision === 'delete') {
        // The screen holds its button until the target's name has been typed
        // back, so a delete that names anything else did not come from it.
        if (str(payload.target) !== p.target.name) {
          return { error: 'That is not the target this page is about.' };
        }
      }
      return {
        done: true,
        result: { decision, force: payload.force === true, cancelled: false },
      };
    },
  );
  return out as WebDeployConfirmResult;
}

// ---------------------------------------------------------------------------
// deploy-targets — the saved destinations, read and answered
// ---------------------------------------------------------------------------

/** What the listing came back with. */
export type WebTargetsAction = 'use' | 'new' | 'edit' | 'remove';

export interface WebDeployTargetsParams extends WebServeOptions {
  projectName: string;
  /** Where the list was read from, so an empty list has an explanation. */
  configPath: string;
  purpose: DeployTargetsPurpose;
  /** The adapter kind a `pick` was narrowed to, from `--target <id>`. */
  filterKind?: string;
  filterKindLabel?: string;
  targets: DeployTargetRow[];
  activeBranch?: string;
  view?: DeployTargetsData['view'];
  subjectTarget?: string;
  /** The actions this run will honour. Anything else is refused inline. */
  allow: readonly WebTargetsAction[];
}

export interface WebDeployTargetsResult {
  action: WebTargetsAction | null;
  /** Empty for `new`, and for a cancelled window. */
  target: string;
  cancelled: boolean;
}

export function buildDeployTargetsData(
  p: WebDeployTargetsParams,
  nonce: string,
): DeployTargetsData {
  return {
    nonce,
    projectName: stripAnsi(p.projectName),
    configPath: p.configPath,
    purpose: p.purpose,
    filterKind: p.filterKind,
    filterKindLabel: stripOpt(p.filterKindLabel),
    // `name` round-trips as the answer, so it is left alone; the label is
    // printed prose and an escape in it renders as `[90m` on the page.
    targets: p.targets.map((t) => ({ ...t, adapterLabel: stripOpt(t.adapterLabel) })),
    activeBranch: p.activeBranch,
    view: p.view,
    subjectTarget: p.subjectTarget,
    nonTty: {
      command: 'capy deploy targets',
      why: 'The listing prints name, adapter, branch and variable names. It never prints a value — .capy/deploy.json holds none.',
    },
    nonTtyRemove: {
      command: 'capy deploy targets-remove <name>',
      why: 'Removing a target deletes its platform, branch, settings and variable list from .capy/deploy.json, and nothing keeps a copy.',
    },
  };
}

/**
 * Serve the listing and wait for a row.
 *
 * The submitted name is resolved against the list the server sent, never
 * trusted: `use` is followed by a real deploy against whatever comes back, and
 * a target the screen could not have offered did not come from the screen.
 *
 * TWO ENDINGS, and this function is responsible for both of them REACHING the
 * caller — every caller, which is why it is here and not repeated at the three
 * call sites. Picked, edited, removed and "set up a new one" are submits.
 * Everything else — the window closed, `Keep it` clicked, the deadline reached
 * — is a refusal, and a refusal RESOLVES as `{ action: null, cancelled: true }`.
 * It does not reject. `capy deploy targets-remove <name> --web` used to hang
 * for the wizard's five minutes on a decline and `capy deploy --web` used to
 * throw its timeout out of the picker, both for a user who had simply chosen
 * not to go on.
 *
 * SCREEN CHANGE NEEDED (packages/ui/screens/deploy-targets/Screen.svelte — not
 * made here, this parcel may not edit packages/ui):
 *   1. `confirm-remove`'s "Keep it" (line ~248) sets `view = 'list'` and posts
 *      nothing. It should `submitToCli('/submit', data.nonce, { __action:
 *      'cancel' })` the way the same package's `Wizard` cancel does.
 *   2. The `list` view has no exit control at all — Edit and Remove are the
 *      only buttons. It needs a quiet "Done" posting the same thing.
 * Until (1) lands, `withDeclineBridge` answers the confirm view from this side.
 * Until (2) lands, `NO_REFUSAL_TIMEOUT_MS` is the listing's only ending.
 */
export async function chooseDeployTargetInBrowser(
  p: WebDeployTargetsParams,
): Promise<WebDeployTargetsResult> {
  const refused: WebDeployTargetsResult = { action: null, target: '', cancelled: true };
  const out = await runBrowserWizard(
    {
      title: p.purpose === 'pick' ? 'Which target?' : `Deploy targets — ${p.projectName}`,
      flow: 'deploy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs ?? NO_REFUSAL_TIMEOUT_MS,
      doneMessage: 'Picked — back to your terminal.',
      renderFirst: (nonce) => {
        const html = renderScreen('deploy-targets', buildDeployTargetsData(p, nonce));
        // Only when the CONFIRM is the whole question. On the listing, backing
        // out of a remove leaves the user on a page they still have business
        // with — ending the run there would be answering a question nobody
        // asked.
        return p.view === 'confirm-remove'
          ? withDeclineBridge(html, {
              nonce,
              // The confirm view's danger callout: `deploy-targets` has exactly
              // one, and it is the sentence that makes this a question. Not the
              // danger BUTTON, which the sibling screen keeps in its listing —
              // one selector for both, bound to a design-system variant.
              question: '.callout.danger',
              headline: 'Kept — nothing was removed.',
              detail: `${stripAnsi(p.subjectTarget ?? 'The target')} is still in ${p.configPath}.`,
            })
          : html;
      },
    },
    async (_step, payload) => {
      const action = payload.__action;
      if (action === 'cancel') {
        return { done: true, result: refused };
      }
      if (
        action !== 'use' &&
        action !== 'new' &&
        action !== 'edit' &&
        action !== 'remove'
      ) {
        return { error: 'That is not an action this screen offers.' };
      }
      if (!p.allow.includes(action)) {
        return { error: 'That is not something this run can do.' };
      }
      if (action === 'new') {
        return { done: true, result: { action, target: '', cancelled: false } };
      }
      const name = str(payload.target);
      if (!p.targets.some((t) => t.name === name)) {
        return { error: 'That target is not saved for this project.' };
      }
      return { done: true, result: { action, target: name, cancelled: false } };
    },
  ).catch(refusalOn(refused));
  return out as WebDeployTargetsResult;
}

// ---------------------------------------------------------------------------
// deploy-tokens — the minted credentials, and the one irreversible thing
// ---------------------------------------------------------------------------

export interface WebDeployTokensParams extends WebServeOptions {
  /** Null when the project record has no name. The CLI prints `"undefined"`. */
  projectName: string | null;
  tokens: DeployTokenRow[];
  view?: DeployTokensData['view'];
  subjectToken?: string;
}

export interface WebDeployTokensResult {
  /** The full deploy id to revoke, or null when nothing was revoked. */
  deployId: string | null;
  /** True whenever the flow ended without a revoke. Never an error. */
  cancelled: boolean;
}

export function buildDeployTokensData(
  p: WebDeployTokensParams,
  nonce: string,
): DeployTokensData {
  return {
    nonce,
    projectName: p.projectName === null ? null : stripAnsi(p.projectName),
    tokens: p.tokens,
    view: p.view,
    subjectToken: p.subjectToken,
    nonTty: {
      command: 'capy deploy list',
      why: 'A deploy id is an identifier, not a credential — the token itself is never returned by the service after minting.',
    },
    nonTtyRevoke: {
      command: 'capy deploy revoke <deployId>',
      why: 'Revoking cuts every pipeline holding that token off from this project immediately, and it cannot be undone.',
    },
  };
}

/**
 * Serve the token listing.
 *
 * TWO ENDINGS, and this function is responsible for both of them REACHING the
 * caller. Revoked is a submit. Everything else — the window closed, "Leave it
 * active" clicked, the deadline reached — is a refusal, and a refusal RESOLVES
 * here as `{ deployId: null, cancelled: true }`. It does not reject.
 *
 * That last part is the fix for a real defect: declining a revoke used to
 * reject with a timeout, which `capy deploy revoke <id> --web` turned into an
 * error screen and a non-zero exit — for a user who had correctly chosen NOT to
 * revoke. A decline is not a failure, and the only thing the CLI truthfully
 * knows in every one of these cases is the same: nothing was revoked.
 *
 * A refusal is distinguished from a broken server structurally, never by
 * reading a message: `runBrowserWizard` rejects with `CapyError` when nobody
 * answered (deadline, Ctrl-C) and with the raw socket error when the server
 * itself failed. Only the first is an ending; the second is still a throw.
 *
 * SCREEN CHANGE NEEDED (packages/ui/screens/deploy-tokens/Screen.svelte — not
 * made here, this parcel may not edit packages/ui):
 *   1. "Leave it active" (line ~195) sets `view = 'list'` and posts nothing.
 *      It should `submitToCli('/submit', data.nonce, { __action: 'cancel' })`
 *      so the decline is the page's own act rather than something inferred.
 *   2. The `list` view has NO exit control at all — the only button is Revoke.
 *      It needs a quiet "Done" that posts the same `__action: 'cancel'`.
 * With those two, the reducer below already answers them: `__action: 'cancel'`
 * is handled. Until (1) lands, `withDeclineBridge` posts it from this side the
 * instant the question leaves the page, so `capy deploy revoke <id> --web`
 * answers a decline at once and shows the user that it did. Until (2) lands,
 * `NO_REFUSAL_TIMEOUT_MS` is the listing's only ending.
 */
export async function showDeployTokensInBrowser(
  p: WebDeployTokensParams,
): Promise<WebDeployTokensResult> {
  const refused: WebDeployTokensResult = { deployId: null, cancelled: true };
  const out = await runBrowserWizard(
    {
      title: `Deploy tokens — ${p.projectName ?? 'this project'}`,
      flow: 'deploy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs ?? NO_REFUSAL_TIMEOUT_MS,
      doneMessage: 'Done — back to your terminal.',
      renderFirst: (nonce) => {
        const html = renderScreen('deploy-tokens', buildDeployTokensData(p, nonce));
        // Only when the CONFIRM is the whole question — `capy deploy revoke
        // <id> --web`. On `capy deploy list --web` the same click walks back to
        // a listing the user may still want, and ending the run there would be
        // answering a question nobody asked.
        return p.view === 'confirm-revoke'
          ? withDeclineBridge(html, {
              nonce,
              // The confirm view's danger callout — "This cannot be undone".
              // NOT `button.danger`: this screen keeps a danger button in its
              // listing too, so the button survives the decline and the callout
              // does not.
              question: '.callout.danger',
              headline: 'Left active — nothing was revoked.',
              detail: `${stripAnsi(p.subjectToken ?? 'The token')} can still fetch this project's secrets.`,
            })
          : html;
      },
    },
    async (_step, payload) => {
      // Already the vocabulary every other screen answers in, so the moment
      // the screen grows the two controls named above this path is live.
      if (payload.__action === 'cancel') {
        return { done: true, result: refused };
      }
      // This screen posts a bare `action`, not the wizard's `__action`: it
      // drives its own submit rather than going through the shared form.
      if (payload.action !== 'revoke') {
        return { error: 'That is not an action this screen offers.' };
      }
      const id = str(payload.deployId);
      // The full id, resolved against the list the server sent. Two tokens can
      // share twelve characters, and a prefix the screen did not offer would
      // revoke whichever one the service matched first.
      if (!p.tokens.some((t) => t.deployId === id)) {
        return { error: 'That token is not one this project has.' };
      }
      return { done: true, result: { deployId: id, cancelled: false } };
    },
  ).catch(refusalOn(refused));
  return out as WebDeployTokensResult;
}

// ---------------------------------------------------------------------------
// deploy-run-result — what the run actually did
// ---------------------------------------------------------------------------

export function buildDeployRunResultData(d: DeployRunResultData): DeployRunResultData {
  return {
    ...d,
    projectName: stripAnsi(d.projectName),
    // The adapter label is printed beside every step in the terminal, and the
    // epilogue is lifted straight out of the adapter's own stdout block — the
    // two places colour is most likely to have been baked in already.
    target: { ...d.target, adapterLabel: stripAnsi(d.target.adapterLabel) },
    steps: d.steps.map((s) => ({
      ...s,
      label: stripAnsi(s.label),
      detail: stripOpt(s.detail),
      output: stripOpt(s.output),
    })),
    epilogue:
      d.epilogue === undefined
        ? undefined
        : {
            ...d.epilogue,
            title: stripAnsi(d.epilogue.title),
            snippet: stripAnsi(d.epilogue.snippet),
            note: stripOpt(d.epilogue.note),
          },
  };
}

/**
 * Serve a screen that only displays, and wait for the browser to fetch it.
 *
 * This is `serveEndingPage` — the shared ending-page wait — with the one thing
 * a deploy adds on top: a serve that FAILS must not look like a deploy that
 * failed. Everything else it needs is already there, and deliberately is not
 * reimplemented here: `ScreenServer.delivered` is the fact that the page
 * reached a browser, and awaiting it is what stops the run exiting out from
 * under the socket it just opened. `deploy-run-result` is the last thing a
 * deploy does, so that window is exactly where the page would have died.
 *
 * The wait ends when the page has been served, or when the deadline says
 * nobody is coming.
 */
export async function showScreenInBrowser<K extends ScreenName>(
  screen: K,
  data: ScreenDataMap[K],
  opts: WebServeOptions & { note?: string } = {},
): Promise<void> {
  const { serveEndingPage } = await import('./endingPage');
  try {
    await serveEndingPage(screen, data, {
      open: opts.open ?? true,
      onListen: opts.onListen,
      timeoutMs: opts.timeoutMs ?? 120_000,
      lead: opts.note ?? 'Open this in your browser:',
      flow: 'deploy',
    });
  } catch (err) {
    // A page that cannot be served must not undo a deploy that already
    // happened — but it is said out loud rather than swallowed.
    console.log(`  Could not open the result page: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Serve the step log the terminal prints as `renderResult`.
 *
 * Dispatches to the keep-hosted transport (W2-B) when `CAPY_KEEP_SCREENS=1`
 * AND an `authService` was supplied on `opts`; any keep-path outcome short of
 * `sent` degrades to the unchanged loopback body below. `authService` is
 * intersected onto `opts` locally rather than added to the shared
 * `WebServeOptions` base — that interface is extended by every other screen
 * in this file, most of them outside this batch.
 */
export async function showDeployRunResultInBrowser(
  data: DeployRunResultData,
  opts: WebServeOptions & { authService?: AuthService } = {},
): Promise<void> {
  if (opts.authService && keepScreensEnabled()) {
    const sent = await runDeployRunResultViaKeep(data, opts.authService, opts.timeoutMs);
    if (sent) return;
  }
  return showScreenInBrowser('deploy-run-result', buildDeployRunResultData(data), {
    ...opts,
    note: 'What this deploy did (your secrets never reach this page):',
  });
}

/** The keep-hosted transport (W2-B) — `payload-in`: see `syncScreens.ts`'s
 *  `runSyncStatusViaKeep` for the shared shape. No URL to return: this
 *  function's own public contract is `Promise<void>`, unlike its siblings. */
async function runDeployRunResultViaKeep(
  data: DeployRunResultData,
  authService: AuthService,
  timeoutMs?: number,
): Promise<boolean> {
  const outcome = await runKeepInfoScreen({
    screen: 'deploy-run-result',
    handoffFlow: 'deploy',
    label: 'What this deploy did (your secrets never reach this page):',
    serviceApiUrl: authService.getServiceApiUrl(),
    getToken: async () => (await authService.getValidToken())?.access_token ?? null,
    requestPayload: buildDeployRunResultData(data),
    ttlSeconds: 60,
    deadlineMs: timeoutMs ?? 60_000,
  });
  return outcome.kind === 'sent';
}
