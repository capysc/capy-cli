// Multi-step loopback "wizard" — the browser-rendered counterpart to a sequence
// of TTY prompts. It serves a SEQUENCE of screens over ONE persistent local server
// so an agent-driven `capy --web` can render its interactive steps (init trainstops,
// the sync conflict resolver) in the user's browser instead of blocking on inquirer.
//
// Security mirrors the single-step intake (src/commands/addCommand.ts runWebIntake):
// a single-use 32-byte nonce, Host/Origin pinning to the exact loopback address
// (defends DNS-rebinding), a body-size cap, a per-question timeout, and full cleanup. The
// only new capability is statefulness: each POST advances to the next screen, and
// the caller's reducer decides the next screen / done / inline error.
//
// What flows where: the browser submits each screen's answer — serialized from its
// form fields, or built by the screen itself and handed to `window.capySubmit` — and
// the reducer turns that into the NEXT screen or a final result. Values the user types
// stay in the browser→CLI loopback; this transport never prints or logs them.
//
// THE CLOCK ONLY RUNS WHILE A QUESTION IS OUTSTANDING. It used to be a single
// wall clock, set once at `listen()` and never touched again — which was fine
// while every question stood up its own server for one question, and stopped
// being fine the moment a flow held ONE window across a whole run. The init
// wizard's budget then had to cover not just the answering but everything the
// CLI does between two stops: creating an organization, which opens two more
// browser windows of its own and asks somebody to write down 24 words. Five
// minutes is a generous time to answer a question and a short time to be alive.
// So the timer is armed while the browser owes us an answer and disarmed the
// moment one arrives, for exactly as long as the reducer is working. A CLI that
// hangs between two stops is a CLI bug and is not a thing this transport can
// fix by killing a window the user is still looking at.
//
// ENDINGS. A flow ends submitted or cancelled — and either way the page has to
// say which, so `{ done }` is not the only way out. A reducer can also end on a
// final SCREEN (`final: true`): the browser is told to reload, receives a whole
// document that asks nothing, and the wizard resolves once that document has
// been served. That is what a failed run uses. `{ done: true }` renders as the
// ending the page's own button implied — the compiled screens decide "submitted"
// vs "cancelled" from which control was pressed — so answering a submit with
// `done` on a run that just DIED would draw a green check over a failure.
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import { CapyError, ERROR_CODES } from '../types';
import { nonceEqual, isLoopbackHost, isAllowedOrigin } from '../commands/intakeSecurity';
import { DEPLOY_PAGE_CSS } from './deployPage/generatedAssets';
import { screenHeaders } from './screens/serve';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 5_000_000;
/**
 * How long a final screen waits to be collected before the flow gives up on it.
 *
 * The browser is holding the POST that releases it, so the reload lands in
 * milliseconds; this cap is for the window that has already gone, so a CLI that
 * ends on a failure page cannot be held open by a tab nobody will ever load.
 */
const DEFAULT_FINAL_GRACE_MS = 10 * 1000;

/**
 * Where the page reports that it is going away, and how long the flow waits
 * before believing it.
 *
 * The wait exists because a standalone step ADVANCES by reloading (see
 * `WizardScreen.standalone`), and a reload is a page going away followed
 * immediately by the same page coming back.
 *
 * THE WAIT IS NOT WHAT TELLS THEM APART. `sendBeacon` is fire-and-forget and
 * the reload's GET is a fresh connection, so the two arrive in whichever order
 * the kernel feels like — measured, the beacon lands about 4ms AFTER the GET it
 * was supposed to be cancelled by, every time. A flow that believed the beacon
 * unless something re-requested the document inside a grace therefore armed a
 * self-destruct on every healthy advance, and a mistyped recovery phrase ended
 * the run while the user was still retyping. What tells them apart is the
 * GENERATION the beacon carries (see `servedGen`): a document that has already
 * been replaced was reloaded, whichever order the requests land in. The grace
 * below is now only for the other ordering, and it no longer has to be right.
 */
const CLOSED_PATH = '/__closed';
const CLOSE_GRACE_MS = 1_200;

/**
 * The beacon's generation field: which served document is reporting that it is
 * going away.
 *
 * A name, so the check that reads it and the script that writes it cannot
 * drift apart silently.
 */
const BEACON_GEN = 'gen';

/**
 * How a browser flow ended without an answer.
 *
 * An enum rather than a sentence, because every caller has to tell these three
 * apart to say the true thing in the terminal, and two of them are not errors:
 *
 *   declined  a control on the page said no — the screen's own Cancel/Discard
 *   closed    the window went away, which is a refusal and never consent
 *   timeout   nobody answered before the step's deadline
 */
export type WebRefusal = 'declined' | 'closed' | 'timeout';

/**
 * Nobody answered.
 *
 * A typed error rather than a message to match on. `runBrowserWizard` rejects
 * for three different reasons — a socket that would not bind, a deadline that
 * passed, a Ctrl+C — and only the first is a fault. A flow that wants to end a
 * silent run as the refusal it is has to be able to tell them apart, and
 * `SERVICE_ERROR` covers all three; `reason` is the signal that does not.
 */
export class BrowserRefusal extends CapyError {
  constructor(
    message: string,
    public readonly reason: 'timeout' | 'interrupt',
  ) {
    super(message, ERROR_CODES.SERVICE_ERROR);
    this.name = 'BrowserRefusal';
  }
}

export const CAPY_LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

// Escapes `<` so a value can never close the surrounding <script> tag.
const jsStr = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c');

/**
 * One screen of the wizard: the inner HTML for `#screen`.
 *
 * Two ways to answer it, both arriving at the same reducer:
 *
 *   - a `<form>` with named fields, which the wizard serializes (FormData)
 *   - any markup that calls `window.capySubmit(payload)` with its own object
 *
 * The second exists because FormData flattens to string keys and string
 * values. That is enough for a page of text inputs and not enough for the
 * answers some steps carry — a decision per variable, an array of name/value
 * pairs — which would otherwise be encoded into field NAMES and parsed back
 * out by the reducer, making a naming convention into an undeclared second
 * wire format.
 */
export interface WizardScreen {
  html: string;
  /** Optional override for the in-browser "done" message when this screen finishes. */
  doneMessage?: string;
  /**
   * Serve this step as a whole document rather than inside the wizard shell.
   *
   * A compiled screen from `packages/ui` is already a complete page — its own
   * head, its own inlined styles and script — so it cannot be dropped into
   * `#screen` as a fragment, and it does not want the shell's header or CSS
   * around it.
   *
   * The consequence is that advancing is a NAVIGATION rather than an innerHTML
   * swap. The reducer's next screen is not pushed down the open request; it is
   * held, and the browser re-requests the page to receive it. `standalone`
   * steps therefore answer a submit with `{ next: true }` and reload, which is
   * exactly the contract the ui `Wizard` component already implements ("Saved.
   * Opening the next step…").
   */
  standalone?: boolean;
  /**
   * The last document of this flow: it asks nothing, and the wizard resolves
   * once the browser has been served it.
   *
   * This is how a run ENDS on a page rather than on the shell's green check —
   * a stop that was blocked, a push that failed after consent. `{ done: true }`
   * cannot say those things: the compiled screens draw their ending from the
   * control the user pressed, so answering a submit with `done` tells someone
   * who pressed "Encrypt and push" that it worked, whatever happened next.
   *
   * Only meaningful together with `standalone` — a fragment cannot be the last
   * thing a browser is handed, because the shell it swaps into is what would
   * have to say the flow is over.
   */
  final?: boolean;
}

export interface WizardParams {
  title: string;
  firstScreen: WizardScreen;
  open: boolean;
  /** Test-only: receives the loopback URL once listening. Unset in production. */
  onListen?: (url: string) => void;
  /**
   * How long to wait on an OUTSTANDING QUESTION before giving up.
   *
   * Not a budget for the whole run: it is disarmed for as long as the reducer
   * is working on an answer, because during that time nothing is being waited
   * on that a person could supply.
   */
  timeoutMs?: number;
  /** How long a `final` screen waits to be collected. See the constant. */
  finalGraceMs?: number;
  doneMessage?: string;
  /**
   * Build the first screen's HTML once the nonce exists, replacing
   * `firstScreen.html`.
   *
   * A compiled screen carries the nonce inside its own payload — that is how
   * it addresses its answer back — but the nonce is minted in here, after the
   * caller has already constructed its params. Without this the caller would
   * have to mint one itself and hand it in, which would put the security token
   * of every browser flow in the hands of each flow rather than in one place.
   */
  renderFirst?: (nonce: string) => string;
  /**
   * POST paths this flow answers besides `/submit`, by pathname.
   *
   * One screen needs it: `secret-value-editor` asks for a plaintext over
   * `POST /reveal` rather than over `/submit`, because reading a value is not
   * answering the step — the page stays exactly where it was and the CLI hands
   * back one secret. Without a route the request 404s, `submitToCli` reports it
   * as a CLI that has gone away, and the editor can never open its buffer.
   *
   * Handlers get the same treatment as `/submit`: the Host and Origin pinning,
   * the constant-time nonce, the body cap, and the same `WizardDecision`. They
   * do not advance the step — a route that returned `{ screen }` would move the
   * flow without the page that asked knowing it had.
   */
  routes?: Record<string, WizardSubmit>;
  /**
   * What this flow resolves to when the window is closed without answering.
   *
   * A browser flow has two endings, submitted and cancelled, plus closing the
   * window — which is a refusal, never consent. Without this, closing it is not
   * an ending at all: the CLI holds the socket until the step's deadline and
   * then throws, so "look at the table and leave" costs five minutes and exits
   * non-zero. That is the whole bug this exists for, and it is opt-in because
   * `result` is the flow's own word for a refusal and only the flow knows it.
   *
   * It is a REFUSAL: `result` must be the outcome that changes nothing. Never
   * wire a confirmation to it — a closed window has agreed to nothing.
   */
  closeIsRefusal?: { result: unknown; graceMs?: number };
}

/**
 * The script that makes leaving the page an answer.
 *
 * Appended to the served document rather than built into any screen, because
 * it is transport: it renders nothing, reads nothing off the page and adds no
 * control. `pagehide` is the one event that fires for every way a document
 * stops being on screen — closed tab, closed window, navigation away, back
 * button — and `sendBeacon` is the one request that survives it.
 *
 * Carries the nonce the page was served with, which is already in the URL and
 * (for a compiled screen) already in its payload, so this discloses nothing
 * the document did not hold. Besides that it sends ONE number, the generation
 * of the document it is leaving — never anything read off the page.
 */
function closeBeaconScript(nonce: string, gen: number): string {
  return `<script>(function(){var sent=false;function gone(){if(sent)return;sent=true;
  var body=JSON.stringify({nonce:${jsStr(nonce)},payload:{${BEACON_GEN}:${gen}}});
  try{if(navigator.sendBeacon&&navigator.sendBeacon(${jsStr(CLOSED_PATH)},new Blob([body],{type:'application/json'})))return;}catch(e){}
  try{fetch(${jsStr(CLOSED_PATH)},{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:body});}catch(e){}}
  addEventListener('pagehide',gone);})();</script>`;
}

/** Put the beacon inside the document it belongs to, whatever shape it is. */
function withCloseBeacon(html: string, nonce: string, gen: number): string {
  const script = closeBeaconScript(nonce, gen);
  const end = html.lastIndexOf('</body>');
  return end === -1 ? html + script : html.slice(0, end) + script + html.slice(end);
}

/**
 * The reducer's verdict for a submitted screen.
 *
 * `{ screen }` with `final` set on it is the third ending: the flow stops ON
 * that document instead of on the shell's "Done", and `result` is what the
 * wizard resolves with once the browser has collected it.
 */
export type WizardDecision =
  | { screen: WizardScreen; result?: unknown }
  | { done: true; result: unknown }
  | { error: string }
  /**
   * Answer this POST with `body` and leave the flow exactly where it was.
   *
   * A step is not the only thing a screen posts. `secret-table` asks for one
   * variable's plaintext with `{ __action: 'reveal', key }` — a question, not
   * an answer — and it needs the value in the response. Every other decision
   * either advances, finishes or refuses, so without this the only way to hand
   * a value back would be to finish the flow, which is not what happened.
   */
  | { body: Record<string, unknown> };

/** Called for each submitted screen. `step` is the 0-based index of the screen being
 *  submitted (0 = the first). Return the next screen, a final result, or an inline
 *  error (the browser stays on the current screen and shows it). May be async. */
export type WizardSubmit = (step: number, payload: Record<string, unknown>) => Promise<WizardDecision>;

/**
 * Run a multi-step browser wizard. Resolves with the reducer's `result` once it
 * returns `{ done }` or once a `final` screen has been served; rejects on
 * timeout, server error, or Ctrl+C.
 */
export function runBrowserWizard(params: WizardParams, onSubmit: WizardSubmit): Promise<unknown> {
  const nonce = randomBytes(32).toString('hex');
  const connections = new Set<Socket>();
  let step = 0;
  let busy = false;
  let done = false;
  /**
   * The step the browser gets if it asks for the page right now.
   *
   * A shell flow never re-requests — it swaps `#screen` in place — so this only
   * moves for standalone steps, which advance by reloading. Holding it here
   * rather than always serving `firstScreen` is what makes a reload return the
   * step the flow is actually on.
   */
  let current: WizardScreen = params.renderFirst
    ? { ...params.firstScreen, html: params.renderFirst(nonce) }
    : params.firstScreen;

  return new Promise<unknown>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    /** Set once a `final` screen is waiting to be collected. Its `result`. */
    let ending: { result: unknown } | null = null;
    /**
     * How many documents this flow has served.
     *
     * This is the structural half of the close signal, and the half that does
     * not depend on which of two racing requests wins. A reload comes back and
     * asks for the page again, which bumps this; a closed window never does. So
     * a beacon whose generation is no longer the one on screen is reporting a
     * document that was REPLACED, not abandoned, and is ignored outright.
     */
    let servedGen = 0;
    /**
     * Set while a page that said it was leaving might still come back.
     *
     * Only armed by a beacon for the CURRENT generation, and re-checked when it
     * fires, so this is a courtesy delay rather than the thing the decision
     * rests on.
     */
    let goneTimer: NodeJS.Timeout | null = null;

    /** Ctrl+C at the terminal the browser was opened from. A refusal, not a fault. */
    const onSigint = (): void => {
      cleanup();
      reject(new BrowserRefusal('Cancelled.', 'interrupt'));
    };

    const stillHere = (): void => {
      if (goneTimer) clearTimeout(goneTimer);
      goneTimer = null;
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;

      if (req.method === 'GET' && new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname === '/') {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.searchParams.get('n') !== nonce) {
          res.writeHead(403).end('forbidden');
          return;
        }
        // The document is being asked for, so whatever left a moment ago came
        // back: this is a reload, not a closed window.
        stillHere();
        // The wizard page went out with only a content-type. It is a page that
        // renders credentials and can open sockets, so it gets the same policy
        // as any other interactive screen: no remote origins, no eval, no
        // framing, no native form posts, and `connect-src` limited to the
        // loopback origin it was served from — which is the only place its
        // answers are supposed to go.
        res.writeHead(200, screenHeaders({ interactive: true }));
        // A standalone step is its own document and is served as-is. Every
        // other step is a fragment and gets the shell. `current` rather than
        // `firstScreen`, because a standalone flow advances by reloading this
        // same URL — the browser comes back for step 2 and must not be handed
        // step 1 again.
        // A new document is going out, so anything the old one said about
        // leaving is now about a generation that no longer exists.
        servedGen += 1;
        const html = current.standalone
          ? current.html
          : wizardPage(params.title, current.html, nonce, params.doneMessage);
        res.end(params.closeIsRefusal ? withCloseBeacon(html, nonce, servedGen) : html);
        // The flow ended on this document. It has now been delivered, which is
        // the whole reason the server was still up — so let the bytes flush and
        // stop. A run that dies must not be kept alive by its own error page.
        if (ending) {
          const result = ending.result;
          ending = null;
          res.on('finish', () =>
            setTimeout(() => {
              cleanup();
              resolve(result);
            }, 250),
          );
        }
        return;
      }

      // `/submit` advances the flow; a `routes` entry answers beside it without
      // moving the step. Both go through the identical guards below, so a route
      // cannot become a second, laxer door into the same server.
      const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      const route = path === '/submit' ? onSubmit : params.routes?.[path];
      // The page reporting that it is going away. Not a route: it carries no
      // answer and the reducer is never told about it — but it goes through
      // every guard below, because a request that can end a run is a request
      // that has to prove it came from the page we served.
      const closing = params.closeIsRefusal !== undefined && path === CLOSED_PATH;
      if (req.method === 'POST' && (route || closing)) {
        const advances = path === '/submit';
        if (!isLoopbackHost(req.headers.host, port)) {
          res.writeHead(403).end('bad host');
          return;
        }
        if (!isAllowedOrigin(req.headers.origin, port)) {
          res.writeHead(403).end('bad origin');
          return;
        }
        let body = '';
        let aborted = false;
        req.on('data', (c: Buffer) => {
          body += c.toString();
          if (body.length > MAX_BODY) {
            aborted = true;
            res.writeHead(413).end('too large');
            req.destroy();
          }
        });
        req.on('end', async () => {
          if (aborted) return;
          let parsed: { nonce?: unknown; payload?: unknown };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400).end('bad json');
            return;
          }
          if (!nonceEqual(parsed.nonce, nonce)) {
            res.writeHead(403).end('bad nonce');
            return;
          }
          const payload =
            parsed.payload && typeof parsed.payload === 'object' ? (parsed.payload as Record<string, unknown>) : {};
          if (closing) {
            // Answered before it is believed: a beacon is fire-and-forget and
            // the tab is already gone. A flow that has finished, or is mid
            // submit, is not waiting on this page any more.
            res.writeHead(204).end();
            // WHICH document is leaving. A standalone step advances by
            // RELOADING, so `pagehide` fires on a perfectly healthy advance and
            // the beacon it sends usually arrives just AFTER the GET for the
            // next document. That beacon names the generation that has already
            // been replaced, and a replaced document was reloaded, not closed.
            // Ordering cannot change that, which is the whole point: the old
            // grace-window test was a race this lost every time it was measured.
            const gen = payload[BEACON_GEN];
            if (typeof gen !== 'number' || gen !== servedGen) return;
            if (done || busy || goneTimer) return;
            goneTimer = setTimeout(() => {
              goneTimer = null;
              // Re-checked rather than assumed: if the page came back inside the
              // grace, `servedGen` moved on and this beacon is stale after all.
              if (done || gen !== servedGen) return;
              done = true;
              cleanup();
              resolve(params.closeIsRefusal!.result);
            }, params.closeIsRefusal!.graceMs ?? CLOSE_GRACE_MS);
            return;
          }
          // Something is still answering this step, so the page that said it
          // was leaving was reloading.
          stillHere();
          if (done) {
            res.writeHead(409).end('already finished');
            return;
          }
          if (busy) {
            res.writeHead(409).end('a submission is already in progress');
            return;
          }
          busy = true;
          // The answer arrived; nothing is outstanding until the reducer says
          // there is a next question. Whatever the CLI does in between is its
          // own business and none of it is the browser keeping us waiting.
          disarm();
          try {
            const decision = await route!(step, payload);
            if ('error' in decision) {
              busy = false;
              // Refused inline: the page keeps this step, so the same question
              // is outstanding again and the clock goes back on.
              arm();
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: decision.error }));
              return;
            }
            if ('body' in decision) {
              // A question, not an answer: the flow has not moved, so the step
              // counter does not either and the server stays open for the step
              // that is still on screen.
              busy = false;
              // And the clock goes back on. Every POST disarms it, because an
              // answer means the browser owes us nothing while the reducer
              // works — but this branch leaves the SAME question outstanding,
              // so it is outstanding again the moment this response goes out.
              // Without this a run that revealed one value had no deadline at
              // all from then on: the page could be closed and the command
              // would wait for a browser that was never coming back.
              arm();
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision.body));
              return;
            }
            if (!advances) {
              // A side route may only answer or refuse. Advancing from one
              // would move the flow past a step whose page never asked to
              // leave it, and that page would keep posting to a spent token.
              busy = false;
              res
                .writeHead(500, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'That request cannot advance this flow.' }));
              return;
            }
            if ('done' in decision) {
              done = true;
              const result = decision.result;
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ done: true }));
              setTimeout(() => {
                cleanup();
                resolve(result);
              }, 250);
              return;
            }
            // advance to the next screen
            step += 1;
            current = decision.screen;
            busy = false;
            if (decision.screen.final) {
              // The flow ends on this document. Nothing more may be submitted,
              // and the wizard resolves when the browser has been served it —
              // see the GET above. The grace timer is the window that has
              // already been closed: without it a run that died would be held
              // open by a page nobody is coming back for.
              done = true;
              ending = { result: decision.result };
              armFinalGrace();
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ next: true }));
              return;
            }
            // A new question is outstanding from the moment this response goes
            // out, so the clock the answer stopped starts again.
            arm();
            if (decision.screen.standalone) {
              // The next step is a whole document, so it cannot be handed back
              // as a fragment for the current page to swap in. It is held in
              // `current`, and the browser is told there IS a next step so it
              // reloads and receives it from the GET above.
              //
              // `{ next: true }` is the contract the ui `Wizard` component
              // already implements: it freezes its controls and says "Saved.
              // Opening the next step…", precisely because this stop's token
              // is spent and the page is about to be replaced.
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ next: true }));
              return;
            }
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ screen: decision.screen.html, doneMessage: decision.screen.doneMessage }));
          } catch (err) {
            busy = false;
            // The step failed and the page stays on it, so the question is
            // outstanding again.
            arm();
            const message = err instanceof Error ? err.message : 'Step failed.';
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
          }
        });
        return;
      }

      res.writeHead(404).end('not found');
    });

    /** Stop the clock. Nothing is being waited on that a person could supply. */
    const disarm = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    /** Start it again: the browser owes this flow an answer from now. */
    const arm = (): void => {
      disarm();
      const ms = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      timer = setTimeout(() => {
        cleanup();
        // A `BrowserRefusal`, not a bare `CapyError`: same message, same
        // `SERVICE_ERROR` code, but `reason` lets a caller tell "nobody
        // answered" apart from "the socket would not bind" without reading the
        // sentence. Flows that end a silent run as the refusal it is need that.
        reject(
          new BrowserRefusal(
            `Timed out waiting for the browser (${Math.round(ms / 1000)}s with the question unanswered).`,
            'timeout',
          ),
        );
      }, ms);
      timer.unref();
    };

    /**
     * The flow is over and one document is still to be delivered.
     *
     * Resolves rather than rejects when it elapses. The ending already
     * happened; this timer only decides how long we hold a page open for a
     * window that may already be gone.
     */
    const armFinalGrace = (): void => {
      disarm();
      timer = setTimeout(() => {
        const result = ending?.result;
        ending = null;
        cleanup();
        resolve(result);
      }, params.finalGraceMs ?? DEFAULT_FINAL_GRACE_MS);
      timer.unref();
    };

    const cleanup = (): void => {
      disarm();
      stillHere();
      // A wizard that resolved normally used to leave its SIGINT handler on the
      // process for the rest of the run. One flow here opens two wizards per
      // edited variable, so the listener count grew without bound and node
      // started warning about a leak partway through a normal session.
      process.off('SIGINT', onSigint);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      for (const c of connections) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
    };

    server.on('connection', (c: Socket) => {
      connections.add(c);
      c.on('close', () => connections.delete(c));
    });
    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    // The first question is outstanding from the moment there is a URL to open.
    arm();

    process.once('SIGINT', onSigint);

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/?n=${nonce}`;
      params.onListen?.(url);
      console.log('');
      console.log(`  Continue in your browser (your inputs never touch this terminal or the AI):`);
      console.log(`  ${url}`);
      console.log('');
      if (params.open) {
        try {
          const open = (await import('open')).default;
          await open(url);
        } catch {
          /* best-effort; the printed URL is the fallback */
        }
      }
    });
  });
}

/** The page shell: shared CSS/logo + a `#screen` container the client swaps as the
 *  wizard advances, plus the generic submit/serialize/advance JS. The screen HTML is
 *  built server-side by the caller (and must escape its own dynamic content). */
export function wizardPage(title: string, firstScreenHtml: string, nonce: string, doneMessage?: string): string {
  const fallbackDone = doneMessage ?? 'Done. You can close this tab.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy — ${title.replace(/</g, '&lt;')}</title>
  <style>${DEPLOY_PAGE_CSS}</style>
</head>
<body class="min-h-screen bg-white dark:bg-black font-sans text-neutral-900 dark:text-white">
  <div class="max-w-xl mx-auto px-0 py-12">
    <div class="flex items-center gap-3 mb-6">
      <div class="dark:invert">${CAPY_LOGO_SVG}</div>
      <h1 class="text-xl font-semibold">${title.replace(/</g, '&lt;')}</h1>
    </div>
    <div id="screen"></div>
    <div id="status" class="text-sm mt-3"></div>
  </div>
  <script>
    const NONCE = ${jsStr(nonce)};
    let DONE_MSG = ${jsStr(fallbackDone)};
    const screenEl = document.getElementById('screen');
    const statusEl = document.getElementById('status');
    screenEl.innerHTML = ${jsStr(firstScreenHtml)};

    function setStatus(msg, isError) {
      statusEl.textContent = msg || '';
      statusEl.className = 'text-sm mt-3 ' + (isError ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400');
    }
    function finish() {
      document.body.innerHTML = '<div class="max-w-xl mx-auto px-5 py-12"><h1 class="text-xl font-semibold">\\u2713 Done</h1><p class="mt-2"></p></div>';
      document.body.querySelector('p').textContent = DONE_MSG;
    }

    // The one place a payload becomes a request. Both entry points below go
    // through it, so the nonce, the response contract and the error handling
    // have a single implementation rather than one per screen technology.
    //
    // Returns an outcome the caller can act on: a screen rendering its own
    // controls needs to know whether to re-enable them. A form does not — this
    // re-enables its button itself.
    async function post(payload, btn) {
      if (btn) btn.disabled = true;
      setStatus('Working…', false);
      try {
        const r = await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: NONCE, payload }) });
        let b = {};
        try { b = await r.json(); } catch (_) {}
        if (!r.ok) { const m = (b && b.error) || ('HTTP ' + r.status); setStatus(m, true); if (btn) btn.disabled = false; return { kind: 'error', error: m }; }
        if (b.error) { setStatus(b.error, true); if (btn) btn.disabled = false; return { kind: 'error', error: b.error }; }
        if (b.done) { finish(); return { kind: 'done', result: b.result }; }
        if (typeof b.doneMessage === 'string') DONE_MSG = b.doneMessage;
        setStatus('', false);
        screenEl.innerHTML = b.screen || '';
        return { kind: 'next' };
      } catch (err) {
        const m = 'Could not reach the Capy CLI (' + err + '). Is it still running? Try again.';
        setStatus(m, true);
        if (btn) btn.disabled = false;
        return { kind: 'unreachable', error: m };
      }
    }

    // One delegated handler — survives screen swaps. Serializes the submitted
    // form's named fields into a payload object and POSTs it.
    document.addEventListener('submit', async (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      e.preventDefault();
      const payload = {};
      for (const [k, v] of new FormData(form).entries()) payload[k] = v;
      await post(payload, form.querySelector('button[type=submit], button:not([type])'));
    });

    // The other entry point, for a screen that builds its own payload.
    //
    // FormData flattens to string keys and string values, which is enough for
    // a page of text inputs and not enough for the answers some steps carry:
    // the conflict resolver decides per variable, and secret intake sends an
    // array of name/value pairs. Those screens would otherwise have to encode
    // structure into field NAMES and have the reducer parse it back out — a
    // second wire format, undeclared, living in a naming convention.
    //
    // The transport is unchanged: same endpoint, same nonce, same single-use
    // token, same response contract. Only the construction of the payload
    // differs, so this widens nothing a page can reach.
    window.capySubmit = (payload) => post(payload, null);
  </script>
</body>
</html>`;
}
