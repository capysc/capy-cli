// Multi-step loopback "wizard" — the browser-rendered counterpart to a sequence
// of TTY prompts. It serves a SEQUENCE of screens over ONE persistent local server
// so an agent-driven `capy --web` can render its interactive steps (init trainstops,
// the sync conflict resolver) in the user's browser instead of blocking on inquirer.
//
// Security mirrors the single-step intake (src/commands/addCommand.ts runWebIntake):
// a single-use 32-byte nonce, Host/Origin pinning to the exact loopback address
// (defends DNS-rebinding), a body-size cap, an idle timeout, and full cleanup. The
// only new capability is statefulness: each POST advances to the next screen, and
// the caller's reducer decides the next screen / done / inline error.
//
// What flows where: the browser submits each screen's answer — serialized from its
// form fields, or built by the screen itself and handed to `window.capySubmit` — and
// the reducer turns that into the NEXT screen or a final result. Values the user types
// stay in the browser→CLI loopback; this transport never prints or logs them.
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import { CapyError, ERROR_CODES } from '../types';
import { nonceEqual, isLoopbackHost, isAllowedOrigin } from '../commands/intakeSecurity';
import { DEPLOY_PAGE_CSS } from './deployPage/generatedAssets';
import { screenHeaders } from './screens/serve';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 5_000_000;

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
}

export interface WizardParams {
  title: string;
  firstScreen: WizardScreen;
  open: boolean;
  /** Test-only: receives the loopback URL once listening. Unset in production. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
  doneMessage?: string;
}

/** The reducer's verdict for a submitted screen. */
export type WizardDecision =
  | { screen: WizardScreen }
  | { done: true; result: unknown }
  | { error: string };

/** Called for each submitted screen. `step` is the 0-based index of the screen being
 *  submitted (0 = the first). Return the next screen, a final result, or an inline
 *  error (the browser stays on the current screen and shows it). May be async. */
export type WizardSubmit = (step: number, payload: Record<string, unknown>) => Promise<WizardDecision>;

/**
 * Run a multi-step browser wizard. Resolves with the reducer's `result` once it
 * returns `{ done }`; rejects on timeout, server error, or Ctrl+C.
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
  let current: WizardScreen = params.firstScreen;

  return new Promise<unknown>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;

      if (req.method === 'GET' && new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname === '/') {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.searchParams.get('n') !== nonce) {
          res.writeHead(403).end('forbidden');
          return;
        }
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
        res.end(
          current.standalone
            ? current.html
            : wizardPage(params.title, current.html, nonce, params.doneMessage),
        );
        return;
      }

      if (req.method === 'POST' && new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname === '/submit') {
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
          if (done) {
            res.writeHead(409).end('already finished');
            return;
          }
          if (busy) {
            res.writeHead(409).end('a submission is already in progress');
            return;
          }
          busy = true;
          try {
            const decision = await onSubmit(step, payload);
            if ('error' in decision) {
              busy = false;
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: decision.error }));
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
            const message = err instanceof Error ? err.message : 'Step failed.';
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
          }
        });
        return;
      }

      res.writeHead(404).end('not found');
    });

    const cleanup = (): void => {
      clearTimeout(timer);
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

    timer = setTimeout(() => {
      cleanup();
      reject(new CapyError('Timed out waiting for the browser (5 minutes).', ERROR_CODES.SERVICE_ERROR));
    }, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();

    process.once('SIGINT', () => {
      cleanup();
      reject(new CapyError('Cancelled.', ERROR_CODES.SERVICE_ERROR));
    });

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
