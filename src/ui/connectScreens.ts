// `capy connect`, served as compiled screens.
//
// Seven inquirer prompts live behind this command and none of them had a
// browser answer. Worse, most of them do not fire at all for the caller `--web`
// exists for: `isInteractive()` is false the moment stdin is piped, so an agent
// running `capy connect stripe` gets a silent `test` for the mode question, a
// refusal for the account picker, and a refusal for the variable picker. The
// questions were never asked, and the run either guessed or stopped. Under
// `--web` they are asked — in a browser, where the consequence of each one can
// actually be stated.
//
// Five screens, one per decision the command makes:
//
//   connect-provider   which connector, with what each will want from you
//   connect-setup      the variable, the mode, the account, the refresh offer
//   connect-overwrite  the guard in front of a variable that already holds a value
//   connect-live-gate  the typed account-ID echo in front of a live key
//   connect-result     what the run actually did
//
// The rail is `connectPlan`'s, not this file's and not the screens'. One
// builder feeds the payload and would feed `--json`, which is the only way the
// route a person reads and the array an agent parses can be claimed to be the
// same route.
//
// NO KEY VALUE REACHES A PAYLOAD. The comparison the overwrite guard draws is
// built from `fingerprint()`'s `abc…xyz` form and an eight-character key
// prefix — the same rule the terminal's own tables follow. `ctx.localPlaintext`
// holds the decrypted .env while these screens are served and none of it
// crosses.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import { serveEndingPage } from './endingPage';
import { connectPlan, type ConnectPlanInput } from '../commands/connectors/plans';
import type { AuthService } from '../auth/authService';
import { keepScreensEnabled } from './screens/keepScreens';
import { runKeepInfoScreen } from '../service/keepPayloadRelay';
import type {
  Blocked,
  ConnectAuthState,
  ConnectIncomingKey,
  ConnectLiveAction,
  ConnectLiveGateData,
  ConnectLiveGateStop,
  ConnectModeOption,
  ConnectOutcome,
  ConnectOverwriteData,
  ConnectProviderData,
  ConnectResultData,
  ConnectSetupData,
  ConnectStep,
  ConnectStop,
  ConnectVarSlot,
  ConnectVarState,
  ConnectorChoice,
  StripeAccount,
} from './screens/contract';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to strings the CLI also PRINTS — a project name inside a header, a
 * provider description — because a payload is not a terminal and an escape
 * renders as a literal `[90m` in the browser.
 *
 * Deliberately NOT applied to a variable name or a provider id. Those are the
 * identifiers the answer comes back as and the ones the command then writes to,
 * so they have to round-trip byte for byte; they are checked against the list
 * the CLI offered instead, which no rewriting can defeat.
 */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Shared options every one of these screens takes. */
interface ServeOptions {
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// connect-provider
// ---------------------------------------------------------------------------

export interface WebConnectProviderParams extends ServeOptions {
  projectName: string;
  branch: string;
  connectors: ConnectorChoice[];
  /** What the caller typed that matched nothing, so the mistake and the menu arrive together. */
  unknownProvider?: string;
}

/** What the browser picked. `cancelled` means no connector may be run. */
export interface WebConnectProviderResult {
  provider: string;
  cancelled: boolean;
}

export function buildConnectProviderData(
  p: WebConnectProviderParams,
  nonce: string,
): ConnectProviderData {
  return {
    nonce,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    connectors: p.connectors.map((c) => ({
      ...c,
      description: stripAnsi(c.description),
    })),
    ...(p.unknownProvider ? { unknownProvider: p.unknownProvider } : {}),
    nonTty: {
      command: 'capy connect <provider>',
      why: 'Which integration owns a credential is not guessable from the variable it lands in, so the provider is a positional argument rather than a default.',
    },
  };
}

/**
 * Serve the connector list and wait for a pick.
 *
 * `capy connect` with no provider prints two columns and stops — a catalogue,
 * not a choice. Under `--web` the catalogue is the picker, and the row says
 * the three things the terminal only reveals one command later: that the
 * connector wants a binary you may not have, that it hands you off to a
 * browser pairing, and how many variables on this branch it already owns.
 *
 * The pick is resolved against the list the CLI offered. A provider the screen
 * could not have shown did not come from the screen.
 */
export async function chooseConnectorInBrowser(
  p: WebConnectProviderParams,
): Promise<WebConnectProviderResult> {
  const out = await runBrowserWizard(
    {
      title: `Connect a provider — ${p.projectName}`,
      flow: 'connect',
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Picked — back to your terminal.',
      renderFirst: (nonce) => renderScreen('connect-provider', buildConnectProviderData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { provider: '', cancelled: true } };
      }
      const provider = typeof payload.provider === 'string' ? payload.provider : '';
      const row = p.connectors.find((c) => c.id === provider);
      if (!row) return { error: 'That connector is not in this build.' };
      if (row.toolFound === false) {
        // The row draws the same refusal as a preview. Running it anyway would
        // walk the user into a `precheck` that exits, having spent a click.
        return { error: `${row.requiresTool ?? row.id} is not on your PATH yet.` };
      }
      return { done: true, result: { provider: row.id, cancelled: false } };
    },
  );
  return out as WebConnectProviderResult;
}

// ---------------------------------------------------------------------------
// connect-setup + connect-overwrite
// ---------------------------------------------------------------------------

/**
 * One question this run still has to ask, with everything its screen needs.
 *
 * A discriminated union rather than a bag of optional fields, because the
 * caller assembles the list from five different points in `connect()` and the
 * compiler is the only thing that can say a step was handed the wrong data. A
 * screen that renders the wrong question is worse than a terminal prompt.
 */
export type ConnectQuestion =
  | { kind: 'var'; vars: ConnectVarSlot[]; defaultVarName: string }
  | { kind: 'mode'; modes: ConnectModeOption[] }
  /**
   * The sign-in hand-off. Not a question the user answers so much as one they
   * ACT on: the only control is "Open Stripe", and pressing it is consent to be
   * sent there, not an answer that comes back with a value.
   */
  | { kind: 'auth'; command: string; state: ConnectAuthState; pairingCode?: string }
  | {
      kind: 'overwrite';
      varName: string;
      current: ConnectVarState;
      incoming: ConnectIncomingKey;
    }
  | { kind: 'account'; accounts: StripeAccount[] }
  | { kind: 'refresh'; mode: 'test' | 'live'; expiresInDays: number; command: string };

/** What the browser answered. Only the keys whose questions were asked. */
export interface ConnectAnswers {
  var?: string;
  mode?: 'test' | 'live';
  overwrite?: boolean;
  account?: string;
  refresh?: boolean;
}

export interface WebConnectSetupParams extends ServeOptions {
  provider: string;
  projectName: string;
  branch: string;
  /** Everything `connectPlan` needs that this session does not answer itself. */
  plan: ConnectPlanInput;
  /** The questions this session will ask, in the order the command asks them. */
  questions: ConnectQuestion[];
}

export interface WebConnectSetupResult {
  answers: ConnectAnswers;
  cancelled: boolean;
}

/** The `ConnectStep` a question stands on. `overwrite` is not a stop; see below. */
const STEP_FOR: Record<ConnectQuestion['kind'], ConnectStep | null> = {
  var: 'var',
  mode: 'mode',
  auth: 'auth',
  // The overwrite guard is not a station on the route — it is the route being
  // interrupted by something already in the way — so the rail keeps standing
  // where it was and the guard draws no rail of its own.
  overwrite: null,
  account: 'account',
  refresh: 'refresh',
};

/**
 * How each question is answered without a browser.
 *
 * Written from the CLI's argv as it is today, and from what
 * `refuseNonInteractive` already tells a headless caller at each of these
 * sites — one source for the flag, so the footnote and the refusal cannot
 * describe different arguments.
 */
function nonTtyEscape(kind: ConnectQuestion['kind']): ConnectSetupData['nonTty'] {
  switch (kind) {
    case 'auth':
      return {
        command: 'stripe login   # in a terminal, then re-run capy connect stripe',
        why: 'A pairing is approved by a person in a browser. No flag completes one, so the only headless answer is to already be signed in before the run starts.',
      };
    case 'var':
      return {
        command: 'capy connect stripe --var STRIPE_SECRET_KEY',
        why: 'Which variable holds the key decides what gets overwritten, so it is never guessed from the ones already on the branch.',
      };
    case 'mode':
      return {
        command: 'capy connect stripe --live',
        why: 'Test is the default and live is only ever reached by asking for it: a mode that could be defaulted into is a live key nobody chose.',
      };
    case 'account':
      return {
        command: 'capy connect stripe --account acct_1234',
        why: 'With several accounts paired there is no unambiguous one to take a key from, so the run refuses rather than picking.',
      };
    case 'refresh':
      return {
        command: 'capy rotate <VAR>',
        why: 'A near-expiry key is taken as-is without a browser; re-pairing is a hand-off no flag can complete for you.',
      };
    case 'overwrite':
      return {
        command: 'capy connect stripe --var <VAR> -f',
        why: 'Overwriting a value Capy cannot recover is not a default. -f is the same flag the non-interactive refusal already names.',
      };
  }
}

export function buildConnectSetupData(
  p: WebConnectSetupParams,
  q: ConnectQuestion,
  answers: ConnectAnswers,
  nonce: string,
): ConnectSetupData {
  const step = STEP_FOR[q.kind] ?? 'var';
  const stops = connectPlan({
    ...p.plan,
    standing: step,
    // Folded forward so the rail redraws itself from one place: this file
    // never decides what a stop's state is.
    ...(answers.var !== undefined ? { varName: answers.var } : {}),
    ...(answers.mode !== undefined ? { mode: answers.mode } : {}),
    ...(answers.account !== undefined ? { account: answers.account } : {}),
    ...(answers.refresh !== undefined ? { refreshAccepted: answers.refresh } : {}),
  });

  return {
    nonce,
    provider: p.provider,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    stops,
    step,
    ...(q.kind === 'var'
      ? { vars: q.vars, defaultVarName: q.defaultVarName }
      : q.kind === 'mode'
        ? { modes: q.modes }
        : q.kind === 'account'
          ? { accounts: q.accounts }
          : q.kind === 'refresh'
            ? { refresh: { mode: q.mode, expiresInDays: q.expiresInDays, command: q.command } }
            : q.kind === 'auth'
              ? {
                  auth: {
                    command: q.command,
                    state: q.state,
                    // Omitted rather than empty: the screen has two readings of
                    // its own instruction and picks between them on whether
                    // there is a code to compare, so an empty string would put
                    // "compare the code below" above a blank row.
                    ...(q.pairingCode ? { pairingCode: q.pairingCode } : {}),
                  },
                }
              : {}),
    nonTty: nonTtyEscape(q.kind),
  };
}

export function buildConnectOverwriteData(
  p: WebConnectSetupParams,
  q: Extract<ConnectQuestion, { kind: 'overwrite' }>,
  nonce: string,
): ConnectOverwriteData {
  return {
    nonce,
    provider: p.provider,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    varName: q.varName,
    current: q.current,
    incoming: q.incoming,
    nonTty: nonTtyEscape('overwrite'),
  };
}

/** The four names a variable step may answer with, beyond the offered list. */
const VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Serve the run's outstanding questions, one screen at a time, over one server.
 *
 * Standalone rather than the wizard shell, so advancing is a page RELOAD: a
 * compiled screen is a whole document and cannot be spliced into the open page.
 * The browser comes back to the same address and the CLI hands it the next
 * question.
 *
 * Every refusal below is inline (`{ error }`) rather than a guess, because each
 * one can only arrive from something that is not the screen — the account list
 * offers exactly the accounts the config holds, the mode list holds two ids,
 * the overwrite screen has one button and it means yes.
 */
export async function askConnectInBrowser(
  p: WebConnectSetupParams,
): Promise<WebConnectSetupResult> {
  if (p.questions.length === 0) return { answers: {}, cancelled: false };

  // The nonce is minted inside `runBrowserWizard` and reaches a caller only
  // through `renderFirst`. Later standalone steps have to be rendered with that
  // same token, so it is captured on the way past rather than each flow minting
  // its own — which would put the security token of every browser path in the
  // hands of each path instead of in one place.
  let nonce = '';
  let index = 0;
  const answers: ConnectAnswers = {};

  const render = (): string => {
    const q = p.questions[index];
    return q.kind === 'overwrite'
      ? renderScreen('connect-overwrite', buildConnectOverwriteData(p, q, nonce))
      : renderScreen('connect-setup', buildConnectSetupData(p, q, answers, nonce));
  };

  const out = await runBrowserWizard(
    {
      title: `Connect ${p.provider} — ${p.projectName}`,
      flow: 'connect',
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
        return { done: true, result: { answers, cancelled: true } };
      }

      const q = p.questions[index];
      if (!q) return { error: 'There is nothing left to answer on this run.' };

      if (q.kind === 'var') {
        const name = typeof payload.var === 'string' ? payload.var.trim() : '';
        if (!name) return { error: 'Variable name cannot be empty' };
        // A name the list did not offer is a new one, and a new one has to pass
        // the same check `validateVarName` applies in the terminal — the screen
        // holds its button on a bad name, so this can only be a malformed
        // submit.
        if (!q.vars.some((v) => v.name === name) && !VAR_NAME_RE.test(name)) {
          return { error: 'Must be UPPER_SNAKE_CASE (letters, digits, underscore).' };
        }
        answers.var = name;
      } else if (q.kind === 'mode') {
        const mode = payload.mode;
        const offered = q.modes.find((m) => m.id === mode);
        if (!offered) return { error: 'That mode is not one this run offers.' };
        if (!offered.available) {
          // The screen disables an unavailable mode. Writing a live key this
          // machine has no live key for, or that the dev firewall refuses, is
          // the failure this refusal exists to prevent.
          return { error: 'That mode is not available for this account.' };
        }
        answers.mode = offered.id;
      } else if (q.kind === 'overwrite') {
        // One button, and it means yes. Anything else did not come from it.
        if (payload.overwrite !== true) {
          return { error: 'That is not an answer the overwrite guard can produce.' };
        }
        answers.overwrite = true;
      } else if (q.kind === 'account') {
        const account = typeof payload.account === 'string' ? payload.account : '';
        if (!q.accounts.some((a) => a.id === account)) {
          return { error: 'That account is not in this provider’s config.' };
        }
        answers.account = account;
      } else {
        if (typeof payload.relogin !== 'boolean') {
          return { error: 'That is not an answer the refresh step can produce.' };
        }
        answers.refresh = payload.relogin;
      }

      index += 1;
      if (index >= p.questions.length) {
        return { done: true, result: { answers, cancelled: false } };
      }
      // A whole document cannot be spliced into the open page, so it is handed
      // back as `standalone` and the browser reloads to receive it.
      return { screen: { html: render(), standalone: true } };
    },
  );
  return out as WebConnectSetupResult;
}

// ---------------------------------------------------------------------------
// connect-setup, as the sign-in hand-off
// ---------------------------------------------------------------------------

/**
 * The Stripe pairing, in a browser.
 *
 * THE STOP THIS FLOW USED TO SKIP. Every other question `capy connect stripe`
 * asks has had a `--web` answer since the screens landed; sign-in did not, and
 * fell through to `stripe login` with an inherited stdout. On the MCP transport
 * that stdout is the tool-result channel, so the pairing URL and the
 * verification code were handed to the AI agent while the user — the only party
 * who can approve a pairing — was never asked anything (CAP-365).
 *
 * WHY THE HAND-OFF RUNS INSIDE THE REDUCER. `approve` blocks: it opens Stripe
 * and then polls until the pairing lands or five minutes pass. A reducer is the
 * one place in this transport where that is allowed — the wizard's clock is
 * disarmed for exactly as long as one is working, because during that time
 * nothing is outstanding that a person could supply. The page holds its POST
 * open and shows its own "Working…" until this returns.
 *
 * THREE ENDINGS, NOT TWO, and the third is why this does not return a boolean.
 * A pairing nobody approved is a wall — the run could not proceed — and someone
 * pressing Cancel is a refusal, which changed nothing and was the point. The
 * exit code is the only thing an agent reads, so collapsing them would report
 * "capy failed" for a user who decided not to. Closing the window is a refusal
 * too: it has agreed to nothing.
 *
 * The caller draws whatever each ending says, so one place decides it rather
 * than one per surface.
 */
export type WebSignInResult = 'paired' | 'declined' | 'not-approved';

export async function signInInBrowser(
  p: WebConnectSetupParams,
  approve: () => Promise<boolean>,
): Promise<WebSignInResult> {
  const q = p.questions[0];
  if (p.questions.length !== 1 || !q || q.kind !== 'auth') {
    throw new Error('signInInBrowser serves exactly one auth step.');
  }

  const out = await runBrowserWizard(
    {
      title: `Sign in to ${p.provider} — ${p.projectName}`,
      flow: 'connect',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Paired — back to your terminal.',
      renderFirst: (nonce) =>
        renderScreen('connect-setup', buildConnectSetupData(p, q, {}, nonce)),
      // A window closed on the pairing screen has approved nothing, and the
      // command must not sit on the socket for five minutes finding that out.
      closeIsRefusal: { result: 'declined' satisfies WebSignInResult },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: 'declined' };
      // One control, and it means "send me to Stripe". Anything else did not
      // come from this screen — there is no field on it to send.
      if (payload.step !== 'auth') {
        return { error: 'That is not an answer the sign-in step can produce.' };
      }
      return { done: true, result: (await approve()) ? 'paired' : 'not-approved' };
    },
  );
  // Anything the wizard can resolve with that is not one of the three is a
  // transport that went somewhere this flow did not write, and the safe reading
  // of "I do not know what happened" is that nobody got signed in.
  return out === 'paired' || out === 'declined' ? out : 'not-approved';
}

// ---------------------------------------------------------------------------
// connect-live-gate
// ---------------------------------------------------------------------------

export interface WebLiveGateParams extends ServeOptions {
  action: ConnectLiveAction;
  provider: string;
  projectName: string;
  branch: string;
  varName: string;
  /**
   * The string the user must type back. Null when the provider's config
   * section carried no account id — the terminal's fallback there is to ask
   * for the literal `(unknown)`, which satisfies the prompt and proves
   * nothing, so the screen treats null as a condition to surface instead.
   */
  accountId: string | null;
  accountName?: string;
  /** `value.slice(0, 8)` — `rk_live_`. Exactly what the terminal prints. */
  keyPrefix?: string;
  push: boolean;
  pushFromFlag?: boolean;
  accountFromFlag?: boolean;
  varFromFlag?: boolean;
  /** The route this run declared, so the gate draws the same rail as the rest. */
  stops: ConnectLiveGateStop[];
}

export function buildLiveGateData(p: WebLiveGateParams, nonce: string): ConnectLiveGateData {
  return {
    nonce,
    action: p.action,
    provider: p.provider,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    varName: p.varName,
    accountId: p.accountId,
    ...(p.accountName ? { accountName: stripAnsi(p.accountName) } : {}),
    ...(p.keyPrefix ? { keyPrefix: p.keyPrefix } : {}),
    ...(p.accountFromFlag ? { accountFromFlag: true } : {}),
    ...(p.varFromFlag ? { varFromFlag: true } : {}),
    push: p.push,
    ...(p.pushFromFlag ? { pushFromFlag: true } : {}),
    stops: p.stops,
    // Always empty from the CLI. A page that arrived with the answer already in
    // the box would be a gate that confirms itself.
    typed: '',
    nonTty: {
      command: 'capy connect stripe --var <VAR>   # then confirm in a terminal',
      why: 'Typing the account ID is the confirmation. No flag can stand in for it, because a flag is exactly the thing a script repeats without reading.',
    },
  };
}

/**
 * The live-mode gate, in a browser.
 *
 * `confirmLiveAction` returns false on any string that is not equal, and the
 * command prints `Cancelled.` and exits — so a typo and a change of heart are
 * indistinguishable and the typo costs the whole run. Here the submit is
 * refused inline and the page stays where it is, which is the same outcome the
 * terminal would have had if it had asked twice.
 *
 * The comparison is made HERE, against the account id the CLI resolved, and
 * never in the page: a gate whose verdict is computed by the thing being gated
 * is not a gate.
 */
export async function confirmLiveActionInBrowser(p: WebLiveGateParams): Promise<boolean> {
  const out = await runBrowserWizard(
    {
      title: `Confirm live mode — ${p.varName}`,
      flow: 'connect',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Confirmed — back to your terminal.',
      renderFirst: (nonce) => renderScreen('connect-live-gate', buildLiveGateData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: false };
      if (p.accountId === null) {
        // There is nothing to confirm against, and the screen draws no field.
        return { error: 'Capy cannot name this account, so there is nothing to confirm.' };
      }
      const typed = typeof payload.confirmed === 'string' ? payload.confirmed.trim() : '';
      if (typed !== p.accountId) {
        return { error: 'That is not the account ID above. Compare it character by character.' };
      }
      return { done: true, result: true };
    },
  );
  return out === true;
}

// ---------------------------------------------------------------------------
// connect-result
// ---------------------------------------------------------------------------

export interface WebConnectResultParams extends ServeOptions {
  outcome: ConnectOutcome;
  provider: string;
  projectName: string;
  branch: string;
  varName: string;
  mode?: 'test' | 'live';
  accountId?: string;
  keyPrefix?: string;
  fingerprint?: string;
  expiresInDays?: number;
  detail?: string;
  /** The route the run travelled, as the CLI declared it. */
  stops: ConnectResultData['stops'];
  /** Enables the keep-hosted transport (CAPY_KEEP_SCREENS=1, W2-B). Optional
   *  and additive: omitted (or the flag unset) is exactly today's loopback
   *  behavior, byte for byte. */
  authService?: AuthService;
}

/**
 * The command that finishes the job, keyed off the outcome.
 *
 * Two endings leave the key on this machine and nowhere else — `--no-push`,
 * and a push that did not land — and both are finished by the same command.
 * Derived here rather than at each call site so a new ending cannot quietly
 * arrive with no next move.
 */
function followUpFor(outcome: ConnectOutcome): string | undefined {
  return outcome === 'local-only' || outcome === 'push-failed' ? 'capy push' : undefined;
}

export function buildConnectResultData(p: WebConnectResultParams): ConnectResultData {
  return {
    outcome: p.outcome,
    provider: p.provider,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    varName: p.varName,
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.accountId ? { accountId: p.accountId } : {}),
    ...(p.keyPrefix ? { keyPrefix: p.keyPrefix } : {}),
    ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}),
    ...(typeof p.expiresInDays === 'number' ? { expiresInDays: p.expiresInDays } : {}),
    ...(followUpFor(p.outcome) ? { followUp: followUpFor(p.outcome) as string } : {}),
    ...(p.detail ? { detail: stripAnsi(p.detail) } : {}),
    stops: p.stops,
    nonTty: {
      command: `capy connect ${p.provider} --var ${p.varName}`,
      why: 'The same run without a browser. Nothing on this page is a decision, so there is nothing here a flag has to answer.',
    },
  };
}

/**
 * Show what the run did, and do not ask for anything.
 *
 * A display-only ending: `serveEndingPage` serves it under the strict
 * `connect-src 'none'` policy `screenHeaders()` applies by default, so a page
 * that names which key landed where cannot open a socket at all.
 *
 * IT DOES NOT RETURN UNTIL THE BROWSER HAS THE PAGE. Both callers are at the
 * end of a run — one of them is a push that failed, which is the ending whose
 * whole reason for existing is that the user cannot otherwise tell whether
 * .env holds a key nobody else has — and a command that exits on the next line
 * closes the loopback server that is serving this. The wait is bounded by
 * `timeoutMs`.
 *
 * Dispatches to the keep-hosted transport (W2-B) when `CAPY_KEEP_SCREENS=1`
 * AND an `authService` was supplied; any keep-path outcome short of `sent`
 * degrades to the loopback body below unchanged.
 */
export async function showConnectResultInBrowser(p: WebConnectResultParams): Promise<string> {
  if (p.authService && keepScreensEnabled()) {
    const url = await runConnectResultViaKeep(p, p.authService);
    if (url) return url;
  }
  return showConnectResultInBrowserLoopback(p);
}

/** The keep-hosted transport (W2-B) — `payload-in`: a real report, no submit
 *  control on the page at all. See `syncScreens.ts`'s `runSyncStatusViaKeep`
 *  for the shared shape this mirrors. */
async function runConnectResultViaKeep(
  p: WebConnectResultParams,
  authService: AuthService,
): Promise<string | undefined> {
  const outcome = await runKeepInfoScreen({
    screen: 'connect-result',
    handoffFlow: 'connect',
    label: 'What this run did, in your browser:',
    serviceApiUrl: authService.getServiceApiUrl(),
    getToken: async () => (await authService.getValidToken())?.access_token ?? null,
    requestPayload: buildConnectResultData(p),
    ttlSeconds: 60,
    deadlineMs: p.timeoutMs ?? 60_000,
  });
  return outcome.kind === 'sent' ? outcome.url : undefined;
}

async function showConnectResultInBrowserLoopback(p: WebConnectResultParams): Promise<string> {
  const { url } = await serveEndingPage('connect-result', buildConnectResultData(p), {
    ...(p.open === undefined ? {} : { open: p.open }),
    ...(p.onListen ? { onListen: p.onListen } : {}),
    ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
    lead: 'What this run did, in your browser:',
    flow: 'connect',
  });
  return url;
}

// ---------------------------------------------------------------------------
// connect-setup, as a wall
// ---------------------------------------------------------------------------

export interface WebConnectBlockedParams extends ServeOptions {
  provider: string;
  projectName: string;
  branch: string;
  /**
   * The step the run died on, so the rail keeps standing where it stopped.
   *
   * Every step that can be STOOD ON, which is each one with a `nonTtyEscape`.
   * `push` is the exception and stays out: it is not a question, so a wall
   * there would have no question to replace and nothing to tell a headless
   * caller to run instead.
   *
   * `auth` earns its place the hard way. A pairing that is never approved is a
   * dead end like any other, and before CAP-365 it was the one dead end that
   * exited the process instead of drawing itself — which under `--web` killed
   * the loopback server mid-run and left the browser on a page that just
   * stopped.
   */
  step: Extract<ConnectStep, 'auth' | 'var' | 'mode' | 'account' | 'refresh'>;
  stops: ConnectStop[];
  blocked: Blocked;
}

/**
 * A question this run cannot ask, served as the reason instead.
 *
 * `connect-setup` renders `blocked` in place of its controls — no submit, no
 * cancel, nothing to answer — so it must NOT be served through the wizard: a
 * wizard waits for a submit, and a page with no control to produce one leaves
 * the run sitting there until the five-minute timeout. That is the failure
 * this exists to prevent, so it goes out as an ending: served, read, over.
 *
 * The nonce is empty and that is deliberate. A page with nothing to submit
 * needs no token to submit it with, and minting one would be handing out a
 * credential for a channel that does not exist.
 */
export async function showConnectBlockedInBrowser(
  p: WebConnectBlockedParams,
): Promise<string> {
  const data: ConnectSetupData = {
    nonce: '',
    provider: p.provider,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    stops: p.stops,
    step: p.step,
    blocked: p.blocked,
    nonTty: nonTtyEscape(p.step),
  };
  const { url } = await serveEndingPage('connect-setup', data, {
    ...(p.open === undefined ? {} : { open: p.open }),
    ...(p.onListen ? { onListen: p.onListen } : {}),
    ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
    lead: 'Why this run cannot continue, in your browser:',
    flow: 'connect',
  });
  return url;
}
