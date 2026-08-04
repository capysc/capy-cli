// The "no" a screen has no way to send.
//
// Several compiled screens confirm a destructive act with two controls: the
// destructive one POSTs, and the decline — which is the answer the terminal
// prompt DEFAULTS to — is CLIENT-SIDE ONLY. It flips the view back to the
// listing it came from and the CLI is never told. Driven in a real browser the
// run is still pending after that click and ends minutes later on the wizard's
// timeout, on a page whose remaining controls cannot answer the question that
// was asked. Nobody is ever removed, revoked or deleted by it — the outcome
// fails safe — but a flow whose most common ending is unreachable is not a
// flow, and "the user waited five minutes" is not a refusal anyone should have
// to perform.
//
// The real fix is the screen's, and every call site writes down which screen
// and which control: the decline should POST `{__action:'cancel'}` exactly the
// way `packages/ui`'s own `Wizard` cancel already does. Until it does, this is
// the CLI holding up its end of the contract — a browser flow has exactly two
// endings, and both must be reachable from the page.
//
// It lives here rather than in one command's screen module because three
// screens now need it, and a second copy of this script would be a second way
// for a page to say no.
import { CapyError } from '../types';

export interface DeclineBridge {
  /** The wizard nonce the served document was rendered with. */
  nonce: string;
  /**
   * A CSS selector for THE QUESTION — not for the decline button.
   *
   * The confirmation is the only thing on the page this run can be answered
   * with, so a document with no such element left in it is a document where
   * the question can no longer be answered, which is a refusal however the
   * page got there. Bound to a design-system variant (`button.danger`,
   * `.callout.danger`) and never to a label: copy is written for humans and is
   * never what code keys off.
   */
  question: string;
  /** The ending's heading. States that nothing happened. */
  headline: string;
  /** One sentence naming what is still true. `You can close this tab.` follows. */
  detail: string;
}

/**
 * The script that watches the question and posts the refusal.
 *
 * WHAT IT WATCHES is the question, not a button — see `question` above.
 *
 * IT CANNOT TURN A CONFIRMATION INTO A CANCEL. The wizard marks itself done
 * inside the handler that resolved it, so a cancel that arrives after a
 * confirmed removal is answered 409 and this script leaves the page exactly as
 * the screen drew it.
 */
function bridgeScript(p: DeclineBridge): string {
  const js = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c');
  return `<script>
(function () {
  // Out of the document before anything else. A script element's source counts
  // as page text — document.body.textContent returns it — and this page's text
  // is the screen's copy, not the CLI's plumbing. Removing the node does not
  // stop the code already running from it.
  var self = document.currentScript;
  if (self && self.parentNode) self.parentNode.removeChild(self);

  var NONCE = ${js(p.nonce)};
  var STILL = ${js(p.detail)};
  var HEAD = ${js(p.headline)};
  // The thing this view answers with, by its design-system variant — the
  // structural attribute, never the label rendered inside it.
  var ANSWERS_WITH = ${js(p.question)};
  var sent = false;

  function ending() {
    document.title = 'Cancelled';
    document.body.textContent = '';
    var wrap = document.createElement('div');
    wrap.setAttribute('style', 'max-width:34rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.6 ui-sans-serif,system-ui,sans-serif');
    var h = document.createElement('h1');
    h.setAttribute('style', 'font-size:1.25rem;margin:0 0 .5rem;font-weight:600');
    h.textContent = HEAD;
    var pEl = document.createElement('p');
    pEl.setAttribute('style', 'margin:0;opacity:.7');
    pEl.textContent = STILL + ' You can close this tab.';
    wrap.appendChild(h);
    wrap.appendChild(pEl);
    document.body.appendChild(wrap);
  }

  function decline() {
    fetch('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, payload: { __action: 'cancel' } })
    }).then(function (r) {
      // Not ok is the destructive act that already went through (409 already
      // finished): the CLI has its answer and this page is not it.
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).then(function (b) {
      if (b && b.done) ending();
    }).catch(function () {
      /* the CLI is gone: it already has its answer, or its timeout. */
    });
  }

  // Watching from the first mutation, never from a poll that could start after
  // the click it exists to catch. The screen mounts itself from its own inline
  // script, so the question may arrive before or after this runs — either way
  // the mount is a mutation, and it is the mutation that records having seen
  // the question. A question that never rendered at all leaves this inert: a
  // page that failed to draw is a page problem, and answering it with a cancel
  // would hide that behind a tidy ending.
  var seen = !!document.querySelector(ANSWERS_WITH);
  var obs = new MutationObserver(function () {
    if (sent) return;
    if (document.querySelector(ANSWERS_WITH)) {
      seen = true;
      return;
    }
    if (!seen) return;
    sent = true;
    obs.disconnect();
    decline();
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
</script>`;
}

/** Put the bridge inside the document the screen build produced. */
export function withDeclineBridge(html: string, p: DeclineBridge): string {
  const script = bridgeScript(p);
  const close = html.lastIndexOf('</body>');
  return close === -1 ? html + script : html.slice(0, close) + script + html.slice(close);
}

/**
 * Turn "nobody answered" into a refusal, and leave a broken server a failure.
 *
 * Structural, never a message match: `runBrowserWizard` mints a `CapyError` for
 * its deadline and for Ctrl-C, and both mean the same thing — the question was
 * never answered, so the destructive act was not approved. A server that could
 * not listen is a different fact and still throws.
 */
export function refusalOn<T>(refused: T): (err: unknown) => T {
  return (err: unknown): T => {
    if (err instanceof CapyError) return refused;
    throw err;
  };
}
