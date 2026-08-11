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
//
// W2-A: under CAPY_KEEP_SCREENS=1, this same promise is kept over the
// connection broker instead of loopback — the page is hosted at
// keep.capy.sc, the request payload (this same SecretIntakeData, minus the
// loopback-only nonce) is sealed to the page's key, and the entered values
// come back sealed to this connection's key. Either transport, the values
// are handled in-process and never printed, logged or returned as plain
// data — see `runWebIntakeViaKeep` below and its own comment.
import { runBrowserWizard, BrowserRefusal } from './browserWizard';
import { renderScreen } from './screens/serve';
import { VENDOR_LOGOS } from './vendorLogos';
import type { IntakeVar, SecretIntakeData } from './screens/contract';
import type { AuthService } from '../auth/authService';
import { keepScreensEnabled } from './screens/keepScreens';
import { runKeepPayloadScreen } from '../service/keepPayloadRelay';

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
  /**
   * Enables the keep-hosted transport (CAPY_KEEP_SCREENS=1). Optional and
   * additive: omitted (or the flag unset) is exactly today's loopback-only
   * behavior, byte for byte — see `authServiceKeepScreens.test.ts`'s sibling
   * pin in `secretIntakeScreen.test.ts` for the enforced guarantee.
   */
  authService?: AuthService;
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
 * Dispatches to the keep-hosted transport when `CAPY_KEEP_SCREENS=1` AND an
 * `authService` was supplied; otherwise (and on any keep-path failure) this
 * is exactly today's loopback flow, byte for byte — the flag-off case never
 * even imports/touches the keep machinery's request path beyond the two
 * cheap checks below, matching the fork CAP-376 established.
 *
 * Resolves whether or not anything was entered: `onSubmit` having run is the
 * only signal that it was, and the caller has to check it. The form is the
 * whole flow and carries the overwrite warning, so refusing it means leaving —
 * which is exactly what refusing the terminal's confirm meant, and it must not
 * come back as a save of nothing.
 */
export async function runWebIntake(
  params: WebIntakeParams,
  onSubmit: (pairs: SecretPair[]) => Promise<void>,
): Promise<void> {
  if (params.authService && keepScreensEnabled()) {
    const handled = await runWebIntakeViaKeep(params, params.authService, onSubmit);
    if (handled) return;
    // Any keep-path outcome short of a validated answer degrades to the
    // loopback form below — broker unavailable, the page never attached, no
    // answer in time, or an answer that failed typed validation. Matches
    // CAP-376's own "any broker failure degrades to the loopback screen"
    // posture (invariant 8 coexistence). Known gap: a user who opens the
    // keep page and deliberately closes it without saving lands here too,
    // and sees a second (loopback) form rather than a clean "nothing was
    // added" — there is no page->CLI "I declined" signal today, only
    // "answered" or "never answered". Flagged rather than silently accepted.
  }
  return runWebIntakeLoopback(params, onSubmit);
}

/**
 * The keep-hosted transport (W2-A). Seals this same `SecretIntakeData` the
 * loopback path would have served (minus the loopback-only `nonce`, which
 * has no meaning once the broker's connection identity + encryption are
 * doing the job a CSRF-style token did) to the page's key over the broker
 * reverse channel, then waits for the page to seal the entered `{name,
 * value}[]` pairs back. `onSubmit` runs in-process on the plaintext exactly
 * once, on the same contract the loopback path has always had: the values
 * are never printed, logged, or returned by this function — only whether
 * they were saved (via `onSubmit` having run) is observable to the caller.
 *
 * Returns `true` iff a validated answer arrived and `onSubmit` ran —
 * anything else (including a thrown `onSubmit`, which propagates) is the
 * caller's cue to fall back to the loopback form.
 */
async function runWebIntakeViaKeep(
  params: WebIntakeParams,
  authService: AuthService,
  onSubmit: (pairs: SecretPair[]) => Promise<void>,
): Promise<boolean> {
  // '' — nonce is a loopback-only CSRF-style token; the keep transport's
  // security boundary is the broker connection's identity + E2E encryption
  // instead. Kept in the payload only because SecretIntakeData's shape is
  // otherwise byte-identical to the kit's (and the loopback contract's).
  const requestPayload = buildSecretIntakeData(params, '');

  const outcome = await runKeepPayloadScreen<SecretPair[]>({
    screen: 'secret-intake',
    handoffFlow: 'add',
    label: 'Add secrets in your browser (your inputs never touch this terminal or the AI):',
    serviceApiUrl: authService.getServiceApiUrl(),
    getToken: async () => (await authService.getValidToken())?.access_token ?? null,
    requestPayload,
    // A ceremony a human deliberates and types into, not a no-submit ack —
    // see brokerClient.ts's DEFAULT_TTL_SECONDS guidance. Independent
    // budgets: up to 15 minutes to open the link, then up to another 15 to
    // finish and submit the form.
    ttlSeconds: 900,
    deadlineMs: 900_000,
    validateAnswer: (plaintext) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { v, vars } = parsed as Record<string, unknown>;
      if (v !== 1) return null;
      return parseVars(vars);
    },
  });

  if (outcome.kind !== 'answered') return false;
  await onSubmit(outcome.answer);
  return true;
}

async function runWebIntakeLoopback(
  params: WebIntakeParams,
  onSubmit: (pairs: SecretPair[]) => Promise<void>,
): Promise<void> {
  return runBrowserWizard(
    {
      title: 'Add secrets',
      flow: 'add',
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
