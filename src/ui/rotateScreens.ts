// `capy rotate`, served as compiled screens.
//
// This is the one command that already drew a route: `renderRotationPlan`
// prints ● ○ ◌ joined by │ and ┊ and then asks `Proceed?`. What it could not
// do is show that route to anyone who is not sitting at a TTY — and `Proceed?`
// is gated on `isTTY`, so the only approval the whole rotate → push → deploy
// chain has silently disappears on a piped run. An agent invoking `capy rotate
// --all` today rotates every live credential in the project with nothing
// asked. Under `--web` the gate exists for every caller.
//
// Three screens:
//
//   rotate-plan-confirm  the variable, the integration, and the one Y/N
//   rotate-progress      what the run actually did, stop by stop
//   connect-live-gate    reused from connect, because it is one condition
//
// Three separate serves rather than one page with client-side steps, because
// the CLI owns the state machine: it cannot know whether the picked variable
// needs the integration step until the answer comes back.
//
// The rail is `rotationPlan`'s. `renderRotationPlan` renders the same array, so
// the diagram in the terminal and the rail in the browser cannot drift.
//
// RENDERS NO KEY MATERIAL. A credential's fingerprint is the redacted `abc…xyz`
// form keep.lock already stores; the provider's pairing code is a one-time
// device code, not a credential, and is already on the terminal and in the
// provider's own browser tab.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import { serveEndingPage } from './endingPage';
import { stripAnsi } from './connectScreens';
import type {
  RotateAdvisory,
  RotateCandidate,
  RotateDeployResult,
  RotateIntegration,
  RotateKeyResult,
  RotatePairing,
  RotatePlanConfirmData,
  RotatePlanStop,
  RotateRunOutcome,
  RotateRunStep,
  RotateRunStop,
  RotateProgressData,
  RotateStep,
} from './screens/contract';

interface ServeOptions {
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// rotate-plan-confirm
// ---------------------------------------------------------------------------

export interface WebRotatePlanParams extends ServeOptions {
  /** Which of the three questions this serve is asking. */
  step: RotateStep;
  projectName: string;
  branch: string;
  /** A `capy-dev` binary: live keys are refused, direct deploys are dropped. */
  devMode: boolean;
  all: boolean;
  noPush: boolean;
  /** The whole declared route, from `rotationPlan`. */
  stops: RotatePlanStop[];
  /** The variable step's rows, in the order `listAllVarsOnBranch` sorted them. */
  candidates?: RotateCandidate[];
  /** The integration step's rows — `listProviders()`, verbatim. */
  integrations?: RotateIntegration[];
  /** The variable the integration and plan steps are about. */
  varName?: string;
  /** What the plan step would rotate. */
  targets?: RotateCandidate[];
  deployTargetCount?: number;
  advisories?: RotateAdvisory[];
}

/** How each of the three questions is answered without a browser. */
function nonTtyEscape(step: RotateStep, varName?: string): RotatePlanConfirmData['nonTty'] {
  if (step === 'variable') {
    return {
      command: 'capy rotate <VAR>',
      why: 'Rotating invalidates the credential in use now, so which one is never picked for you.',
    };
  }
  if (step === 'integration') {
    return {
      command: `capy rotate ${varName ?? '<VAR>'} --provider stripe`,
      why: 'Connecting an unmanaged variable replaces whatever is in it with a key the integration issues, so the integration is never guessed — not even when only one is registered.',
    };
  }
  return {
    command: 'capy rotate <VAR> --yes',
    why: '--yes is the whole chain approved unattended: rotate, push and deploy. It is the only gate the chain has, which is why a piped run must state it rather than inherit it.',
  };
}

export function buildRotatePlanData(
  p: WebRotatePlanParams,
  nonce: string,
): RotatePlanConfirmData {
  return {
    nonce,
    step: p.step,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    devMode: p.devMode,
    all: p.all,
    noPush: p.noPush,
    stops: p.stops,
    ...(p.candidates ? { candidates: p.candidates } : {}),
    ...(p.integrations
      ? { integrations: p.integrations.map((i) => ({ ...i, description: stripAnsi(i.description) })) }
      : {}),
    ...(p.varName ? { varName: p.varName } : {}),
    ...(p.targets ? { targets: p.targets } : {}),
    ...(typeof p.deployTargetCount === 'number'
      ? { deployTargetCount: p.deployTargetCount }
      : {}),
    ...(p.advisories && p.advisories.length > 0
      ? { advisories: p.advisories.map((a) => ({ ...a, detail: stripAnsi(a.detail) })) }
      : {}),
    nonTty: nonTtyEscape(p.step, p.varName),
  };
}

/** Serve one step of the rotate plan and hand the reducer's verdict back. */
async function serveRotateStep(
  p: WebRotatePlanParams,
  title: string,
  doneMessage: string,
  reduce: (payload: Record<string, unknown>) => { done: true; result: unknown } | { error: string },
): Promise<unknown> {
  return runBrowserWizard(
    {
      title,
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage,
      renderFirst: (nonce) => renderScreen('rotate-plan-confirm', buildRotatePlanData(p, nonce)),
    },
    async (_step, payload) => reduce(payload),
  );
}

export interface WebRotateVariableResult {
  variable: string;
  cancelled: boolean;
}

/**
 * Which credential to rotate.
 *
 * The submitted name is resolved against the rows the CLI offered rather than
 * trusted: what follows is a rotation that invalidates whatever is in that
 * variable, and a name the screen could not have shown did not come from the
 * screen.
 */
export async function askRotateVariableInBrowser(
  p: WebRotatePlanParams,
): Promise<WebRotateVariableResult> {
  const out = await serveRotateStep(
    { ...p, step: 'variable' },
    `Rotate — ${p.projectName}`,
    'Picked — back to your terminal.',
    (payload) => {
      if (payload.__action === 'cancel') return { done: true, result: { variable: '', cancelled: true } };
      const variable = typeof payload.variable === 'string' ? payload.variable : '';
      if (!(p.candidates ?? []).some((c) => c.name === variable)) {
        return { error: 'That variable is not on this branch.' };
      }
      return { done: true, result: { variable, cancelled: false } };
    },
  );
  return out as WebRotateVariableResult;
}

export interface WebRotateIntegrationResult {
  provider: string;
  cancelled: boolean;
}

/**
 * Which integration should own an unmanaged variable.
 *
 * Never pre-selected, however few are registered: off a TTY the CLI
 * auto-picks the single provider with no output at all, for a variable the
 * user never associated with it — and the connect flow it hands off to runs
 * with `force: true`, so the value in that variable is replaced rather than
 * rotated.
 */
export async function askRotateIntegrationInBrowser(
  p: WebRotatePlanParams,
): Promise<WebRotateIntegrationResult> {
  const out = await serveRotateStep(
    { ...p, step: 'integration' },
    `Connect ${p.varName ?? 'a variable'} — ${p.projectName}`,
    'Picked — back to your terminal.',
    (payload) => {
      if (payload.__action === 'cancel') return { done: true, result: { provider: '', cancelled: true } };
      const provider = typeof payload.provider === 'string' ? payload.provider : '';
      if (!(p.integrations ?? []).some((i) => i.name === provider)) {
        return { error: 'That integration is not registered in this build.' };
      }
      return { done: true, result: { provider, cancelled: false } };
    },
  );
  return out as WebRotateIntegrationResult;
}

/**
 * The single Y/N that authorises the whole chain.
 *
 * `!opts.skipPrompts && isTTY` drops this in the terminal the moment stdin is
 * piped, which is every agent-driven run — so the one approval gate the
 * destructive half of this command has vanishes exactly where nobody is
 * watching. Here it is asked of every caller, and closing the window is a
 * refusal rather than consent.
 */
export async function confirmRotatePlanInBrowser(p: WebRotatePlanParams): Promise<boolean> {
  const out = await serveRotateStep(
    { ...p, step: 'plan' },
    `Rotation plan — ${p.projectName}`,
    'Approved — back to your terminal.',
    (payload) => {
      if (payload.__action === 'cancel') return { done: true, result: false };
      // The plan step's button sends exactly this. An approval for the whole
      // rotate → push → deploy chain is not something to infer from a submit
      // that did not say so.
      if (payload.proceed !== true) {
        return { error: 'That is not an answer the plan step can produce.' };
      }
      return { done: true, result: true };
    },
  );
  return out === true;
}

// ---------------------------------------------------------------------------
// rotate-progress
// ---------------------------------------------------------------------------

export interface WebRotateProgressParams extends ServeOptions {
  outcome: RotateRunOutcome;
  projectName: string;
  branch: string;
  all: boolean;
  noPush: boolean;
  devMode: boolean;
  /** The declared route, with the stops travelled marked done. */
  stops: RotateRunStop[];
  /** The chain, stop by stop. */
  steps: RotateRunStep[];
  /** One row per credential the run touched. */
  keys: RotateKeyResult[];
  deploy?: RotateDeployResult;
  pairing?: RotatePairing;
}

export function buildRotateProgressData(p: WebRotateProgressParams): RotateProgressData {
  return {
    outcome: p.outcome,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    all: p.all,
    noPush: p.noPush,
    devMode: p.devMode,
    stops: p.stops,
    steps: p.steps.map((s) => ({
      ...s,
      ...(s.detail ? { detail: stripAnsi(s.detail) } : {}),
    })),
    keys: p.keys.map((k) => ({
      ...k,
      // The provider's own words, printed by the CLI in red before they got
      // here. A payload is not a terminal.
      ...(k.detail ? { detail: stripAnsi(k.detail) } : {}),
      ...(k.output ? { output: stripAnsi(k.output) } : {}),
      ...(k.partialWrite ? { partialWrite: stripAnsi(k.partialWrite) } : {}),
    })),
    ...(p.deploy ? { deploy: p.deploy } : {}),
    ...(p.pairing ? { pairing: p.pairing } : {}),
    nonTty: {
      command: 'capy rotate <VAR> --yes',
      why: 'Nothing on this page is a decision — it reports a run that already happened. The flag is how the same run is repeated without a browser.',
    },
  };
}

/**
 * Show what the rotation did, and do not ask for anything.
 *
 * A display-only ending: `serveEndingPage` serves it under `connect-src
 * 'none'`, so a page that renders a rotation's outcome cannot open a socket to
 * anywhere, including us.
 *
 * IT DOES NOT RETURN UNTIL THE BROWSER HAS THE PAGE. Every caller of this
 * function is at the end of a run and several of them exit the process on the
 * next line — and an exit closes the loopback server that is serving this. The
 * `deploy-failed` page in particular reports keys that are live in Capy while
 * every running system still holds the old ones, which is the single worst
 * state this command can leave and the one a user must not be left guessing
 * about. The wait is bounded by `timeoutMs`.
 */
export async function showRotateProgressInBrowser(
  p: WebRotateProgressParams,
): Promise<string> {
  const { url } = await serveEndingPage('rotate-progress', buildRotateProgressData(p), {
    ...(p.open === undefined ? {} : { open: p.open }),
    ...(p.onListen ? { onListen: p.onListen } : {}),
    ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
    lead: 'What this rotation did, in your browser:',
  });
  return url;
}
