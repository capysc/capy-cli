// `capy add --web`, served as the compiled `secret-intake` screen.
//
// Replaces intakePage.ts, which hand-wrote its HTML. What the hand-written
// page could not do is the reason it is gone: it was the one screen in the
// product whose entire job is naming and collecting variables, and it checked
// neither. `my key` was accepted as a variable name; two rows could claim the
// same name and the second silently won; a row with a name and no value was
// dropped without a word; a value pasted with a trailing space went to the
// server exactly as pasted; and the value box was a plain textarea, so the
// credential this page exists to keep away from the agent sat in the DOM in
// the clear for any screenshare or screenshot.
//
// The promise the old page carried is kept to the word: the values are typed
// into a page the CLI serves on loopback and encrypted in-process — they never
// pass back through the terminal or the model. This transport prints and logs
// nothing but variable NAMES.
import { runBrowserWizard, BrowserRefusal } from './browserWizard';
import { renderScreen } from './screens/serve';
import { VENDOR_LOGOS } from './vendorLogos';
import type { IntakeVar, SecretIntakeData } from './screens/contract';

/** The CLI's variable-name rule, shared with `addCommand`. */
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A model-supplied "where to find this" link is rendered as a clickable
 * anchor, so only http(s) survives — never `javascript:`, never `data:`. The
 * screen re-checks it as well; this is the first of the two layers.
 */
export const safeHttpUrl = (u: string | undefined): string | undefined => {
  const t = u?.trim();
  return t && /^https?:\/\//i.test(t) ? t : undefined;
};

// Common dashboard/console subdomains stripped so we key off the vendor's
// registrable domain (dashboard.stripe.com → stripe.com).
const VENDOR_SUBDOMAIN_RE = /^(www|dashboard|console|app|api|manage|admin|portal|my|account|secure)\./i;

/** Variable-name token → registrable domain, e.g. `stripe` → `stripe.com`. */
const DOMAIN_BY_TOKEN = new Map<string, string>();
for (const domain of Object.keys(VENDOR_LOGOS)) {
  const token = domain.split('.')[0];
  if (!DOMAIN_BY_TOKEN.has(token)) DOMAIN_BY_TOKEN.set(token, domain);
}

/**
 * Which vendor THIS variable belongs to, or nothing.
 *
 * Two signals, strongest first: the per-variable help link's registrable
 * domain, then a token in the variable's own name that matches a known vendor
 * (`STRIPE_SECRET_KEY` → stripe.com, which is how `capy add STRIPE_SECRET_KEY`
 * from a bare terminal still gets its mark). Ambiguity resolves to nothing
 * rather than to a guess: a wrong logo beside a credential box is a claim
 * about where the value should come from.
 */
export function vendorDomainFor(v: { name: string; helpUrl?: string }): string | undefined {
  const url = safeHttpUrl(v.helpUrl);
  if (url) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    host = host.replace(VENDOR_SUBDOMAIN_RE, '');
    const labels = host.split('.');
    return (labels.length > 2 ? labels.slice(-2).join('.') : host).toLowerCase();
  }

  const matched = new Set<string>();
  for (const token of v.name.toLowerCase().split(/[^a-z0-9]+/)) {
    const domain = DOMAIN_BY_TOKEN.get(token);
    if (domain) matched.add(domain);
  }
  return matched.size === 1 ? [...matched][0] : undefined;
}

export interface WebIntakeParams {
  /** Suggested variables (name + optional per-variable help link). */
  vars: Array<{ name: string; helpUrl?: string }>;
  /** Short note shown above the form. Display only. */
  reason?: string;
  open: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

export interface SecretPair {
  name: string;
  value: string;
}

export function buildSecretIntakeData(p: WebIntakeParams, nonce: string): SecretIntakeData {
  const vars: IntakeVar[] = p.vars.map((v) => {
    const spec: IntakeVar = { name: v.name };
    const helpUrl = safeHttpUrl(v.helpUrl);
    if (helpUrl) spec.helpUrl = helpUrl;
    // Bundled inline SVG, resolved from the domain. This page NEVER makes an
    // external request — see the no-network rule in ./vendorLogos.
    const domain = vendorDomainFor(v);
    const logo = domain ? VENDOR_LOGOS[domain] : undefined;
    if (logo) spec.logo = logo;
    return spec;
  });

  const data: SecretIntakeData = {
    nonce,
    vars,
    nonTty: {
      command: 'capy add --non-tty',
      why: 'The answer here is the credential itself, so no flag can carry it: a value on a command line lands in shell history, the process table and every log that captures it. Headless, this step exits 3 (needs input) and hands off to a terminal — there is nothing to pass.',
    },
  };
  if (p.reason) data.reason = p.reason;
  return data;
}

/**
 * Validate + normalize the submitted `{name,value}[]`.
 *
 * Names only — values pass through untouched, because a value is whatever the
 * user pasted and this is not the place to decide it is wrong.
 */
export function parseVars(input: unknown): SecretPair[] | null {
  if (!Array.isArray(input)) return null;
  const out: SecretPair[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const value = rec.value;
    if (!VAR_RE.test(name) || typeof value !== 'string') return null;
    out.push({ name, value });
  }
  return out.length > 0 ? out : null;
}

/**
 * Open the intake form and run `onSubmit` with the pairs the user entered.
 *
 * The save runs INSIDE the request, so the browser learns whether it really
 * succeeded: a throw becomes a 500 with the reason and the form stays live and
 * retryable, exactly as the hand-written page behaved. Values are handled
 * in-process — never printed, logged, or returned.
 *
 * Resolves whether or not anything was entered: `onSubmit` having run is the
 * only signal that it was, and the caller has to check it. The form is the
 * whole flow and carries the overwrite warning, so refusing it means leaving —
 * which is exactly what refusing the terminal's confirm meant, and it must not
 * come back as a save of nothing.
 */
export function runWebIntake(
  params: WebIntakeParams,
  onSubmit: (pairs: SecretPair[]) => Promise<void>,
): Promise<void> {
  return runBrowserWizard(
    {
      title: 'Add secrets',
      firstScreen: { html: '', standalone: true },
      open: params.open,
      onListen: params.onListen,
      timeoutMs: params.timeoutMs,
      renderFirst: (nonce) => renderScreen('secret-intake', buildSecretIntakeData(params, nonce)),
      // The intake screen has no Cancel control, so closing the window is the
      // only refusal there is — and it is the answer to the overwrite warning
      // this form carries. It has to end the run, not be waited out.
      closeIsRefusal: { result: undefined },
    },
    async (_step, payload) => {
      const pairs = parseVars(payload.vars);
      // The screen refuses an illegal name while it is typed and holds its
      // button, so this can only arrive from something that is not the screen.
      // Encrypting a variable nobody could have named is the failure it stops.
      if (!pairs) return { error: 'each variable needs a valid NAME and a value' };
      await onSubmit(pairs);
      return { done: true, result: undefined };
    },
  ).then(
    () => undefined,
    (err: unknown) => {
      // A form nobody filled in saved nothing, which is the same fact as a
      // window that was closed. The caller reads that off `onSubmit` having
      // run, so both arrive there the same way instead of one of them being a
      // thrown "Timed out waiting for the browser (5 minutes)."
      if (err instanceof BrowserRefusal && err.reason === 'timeout') return undefined;
      throw err;
    },
  );
}
