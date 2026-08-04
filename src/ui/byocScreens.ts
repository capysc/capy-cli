// `capy byoc <url> --web` — pointing this machine at a self-hosted Capy,
// served as the compiled `byoc-connect` screen.
//
// The terminal version is a `while (true)` whose own header comment admits the
// only exit other than success is Ctrl-C: probe, print one red line, re-prompt,
// probe again, forever. Three things follow from that shape, and the screen
// answers all three — there is a Cancel; a failure says which of ENOTFOUND,
// ECONNREFUSED and a timeout it was, because those are three problems with
// three fixes; and the certificate is on screen before you agree to trust it,
// where the terminal asks "Trust it via a CA bundle?" with a default of yes and
// shows you nothing about the certificate at all.
//
// Every decision here keys off a `ProbeCode`, never off the reason sentence.
// Exactly one code opens the CA sub-flow, and deciding that by searching for
// "self-signed" in a string is a bug waiting for a reword.
//
// Renders no secret material: a URL, a hostname-derived profile name, and the
// path to a public certificate bundle.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import { byocConnectPlan } from '../core/onboardingPlan';
import type {
  ByocConnectData,
  ExistingProfile,
  ProbeOutcome,
} from './screens/contract';

/** Which question the flow is standing on. `verifying` is not one of them. */
export type ByocView = 'url' | 'ca-trust' | 'ca-path' | 'name';

export interface WebByocParams {
  /** Prefill for the URL field: the argv positional or the built-in guess. */
  defaultUrl: string;
  /** Where `defaultUrl` came from, so an unasked-for default is legible. */
  urlSource: 'argv' | 'builtin';
  /**
   * Probe a URL with an optional CA bundle. Supplied by the caller so this
   * module never opens a socket of its own, and so a test drives the whole
   * flow without one. `attempt` is this flow's to count, not the prober's.
   */
  probe: (url: string, caBundle?: string) => Promise<Omit<ProbeOutcome, 'attempt'>>;
  /** `deriveProfileName(url)` — `capy.acme.com` → `acme`, else `byoc`. */
  suggestName: (url: string) => string;
  /** Everything already in the config, so a collision is seen before submit. */
  existingProfiles: ExistingProfile[];
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** What the browser settled. `cancelled` means nothing may be written. */
export interface WebByocResult {
  url: string;
  caBundle?: string;
  profileName: string;
  /** A profile of this name already existed and the user agreed to replace it. */
  replaced: boolean;
  cancelled: boolean;
}

/** Everything this run has answered so far. Drives both the view and the rail. */
export interface ByocState {
  url?: string;
  urlFromArgv?: boolean;
  probe?: Omit<ProbeOutcome, 'attempt'> & { attempt: number };
  /** The bundle that made this instance verify. */
  caBundle?: string;
  /** The user asked to trust a bundle and has not supplied a working one yet. */
  bundleRequested?: boolean;
  /** The last path typed, prefilled so a typo is edited rather than retyped. */
  typedBundlePath?: string;
  /**
   * The certificate offer is spent for this address.
   *
   * Two ways to spend it, both ending at the same place — the address question.
   * The user declined it, or they accepted and the bundle they named was
   * readable and still did not chain, which is the terminal's own conclusion
   * that the address (or the instance) is the problem rather than the path.
   */
  declinedBundle?: boolean;
  verified?: boolean;
  profileName?: string;
}

/**
 * Where the flow is standing, derived from what it has answered.
 *
 * Derived rather than assigned, for the same reason `branchScreens` derives
 * its view: the page that gets served and the rail drawn beside it cannot
 * disagree about where the traveller is if only one of them decides.
 */
export function byocView(s: ByocState): ByocView {
  if (s.verified) return 'name';
  // A bundle that could not be opened is a fixable typo in a path, so the
  // question stays where it was. The terminal throws you back to the URL
  // prompt for this, which asks about the one thing that was not wrong.
  if (s.probe?.code === 'ca_unreadable') return 'ca-path';
  if (s.probe?.code === 'tls_untrusted') {
    if (s.bundleRequested) return 'ca-path';
    if (s.declinedBundle) return 'url';
    return 'ca-trust';
  }
  return 'url';
}

/**
 * How this step is answered without a browser.
 *
 * Honest about what argv actually accepts today: the URL is a positional, and
 * there is no flag at all for the profile name or the CA bundle — the terminal
 * asks for both and has nowhere else to get them.
 */
const NON_TTY: ByocConnectData['nonTty'] = {
  command: 'capy byoc <url>',
  why: 'The address is a positional argument. The profile name and any CA bundle have no flags at all, so a run with nowhere to ask has nothing to fall back on and refuses rather than naming a profile for you.',
};

/**
 * What this run has learned about the instance's certificate, in three states.
 *
 * A handshake that COMPLETED is the only thing that answers the question.
 * `connection_failed`, `http_status`, `not_json` and `not_capy` all happened
 * without a certificate ever being judged — the name did not resolve, nothing
 * was listening, the thing that answered was not Capy — so they say nothing
 * about one, and answering `false` for them is what struck `Certificate — not
 * needed` through the rail on the strength of a probe that never got that far.
 *
 * `ca_unreadable` only ever follows an untrusted certificate: it is produced
 * when a bundle offered FOR one could not be opened, so the question is still
 * very much open.
 */
function certVerdict(probe: ByocState['probe']): boolean | undefined {
  if (!probe) return undefined;
  if (probe.code === 'ok') return false;
  if (probe.code === 'tls_untrusted' || probe.code === 'ca_unreadable') return true;
  return undefined;
}

export function buildByocConnectData(
  p: WebByocParams & { state?: ByocState },
  nonce: string,
): ByocConnectData {
  const s = p.state ?? {};
  const view = byocView(s);
  const url = s.url ?? p.defaultUrl;
  /**
   * Whether the address this run is working from is SETTLED.
   *
   * Everything a probe answered belongs to the address that produced it. While
   * the flow is standing back on the address question — the probe failed, or
   * the certificate offer was declined — that address is not an answer, and
   * neither is anything downstream of it. The rail goes back with the page
   * instead of keeping a tick against a question being asked again.
   */
  const settled = view !== 'url';

  return {
    nonce,
    step: view,
    stops: byocConnectPlan({
      url: settled ? s.url : undefined,
      urlFromArgv: s.urlFromArgv ?? p.urlSource === 'argv',
      verified: s.verified,
      // Undefined until something has actually judged a certificate: the rail
      // draws that stop as a blank it still needs an answer for, rather than
      // promising to skip it.
      certUntrusted: settled ? certVerdict(s.probe) : undefined,
      caBundle: (settled && s.caBundle) || undefined,
      profileName: s.profileName,
    }),
    defaultUrl: url,
    urlSource: p.urlSource,
    probe: s.probe,
    suggestedName: view === 'name' ? p.suggestName(url) : undefined,
    existingProfiles: p.existingProfiles,
    caBundlePath: s.typedBundlePath,
    nonTty: NON_TTY,
  };
}

/**
 * Serve the byoc connect flow and return what it settled.
 *
 * The probe runs inside the reducer, while the submit is in flight, so the
 * page's own busy state is the "Trying …/health" line the terminal prints.
 * `verifying` exists in the contract as a step of its own and is deliberately
 * never served: a loopback server cannot push a navigation, so a page parked
 * on it would have to be told to come back and there is nothing to tell it.
 */
export async function connectByocInBrowser(p: WebByocParams): Promise<WebByocResult> {
  const state: ByocState = { urlFromArgv: p.urlSource === 'argv' };
  let nonce = '';
  let attempt = 0;

  const render = (): string =>
    renderScreen('byoc-connect', buildByocConnectData({ ...p, state }, nonce));

  const cancelled: WebByocResult = {
    url: '',
    profileName: '',
    replaced: false,
    cancelled: true,
  };

  const runProbe = async (url: string, caBundle?: string): Promise<void> => {
    attempt += 1;
    const outcome = await p.probe(url, caBundle);
    state.probe = { ...outcome, attempt };
    state.url = outcome.url;
    state.verified = outcome.code === 'ok';
    if (outcome.code === 'ok') {
      state.caBundle = caBundle;
      return;
    }
    // A bundle that did not make the instance verify is not a bundle this
    // profile may be saved with.
    state.caBundle = undefined;
    if (caBundle !== undefined && outcome.code !== 'ca_unreadable') {
      // The path was readable and still did not chain, so the answer is not a
      // better path — the address or the instance is the problem. Back to the
      // URL question, which is where the terminal lands too: its loop only
      // offers `promptForCaBundle` while `!caBundle`, so a second failure with
      // one in hand falls straight through to `promptForUrl`.
      //
      // Both flags, or `byocView` reads `tls_untrusted` with neither set and
      // asks "trust it via a CA bundle?" all over again — the one question
      // this run has already answered twice.
      state.bundleRequested = false;
      state.declinedBundle = true;
    }
  };

  const out = await runBrowserWizard(
    {
      title: 'Connect a self-hosted Capy',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Connected — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: cancelled };

      const view = byocView(state);

      if (view === 'url') {
        const url = typeof payload.url === 'string' ? payload.url.trim() : '';
        // The screen runs the CLI's own `new URL(normalize(input))` check and
        // holds its button, so an unparseable address did not come from it.
        if (!url) return { error: 'URL required' };
        // A new address drops every assumption the old one produced.
        state.declinedBundle = false;
        state.bundleRequested = false;
        state.caBundle = undefined;
        await runProbe(url);
        return { screen: { html: render(), standalone: true } };
      }

      if (view === 'ca-trust') {
        if (typeof payload.trust !== 'boolean') {
          // Two rows, one boolean. Anything else would have this machine
          // decide for itself what certificate authority to believe.
          return { error: 'That is not an answer the certificate step can produce.' };
        }
        if (!payload.trust) {
          // Declined: back to the URL question, exactly as the terminal falls
          // through when the confirm is answered no.
          state.declinedBundle = true;
          return { screen: { html: render(), standalone: true } };
        }
        state.bundleRequested = true;
        return { screen: { html: render(), standalone: true } };
      }

      if (view === 'ca-path') {
        const path = typeof payload.caBundle === 'string' ? payload.caBundle.trim() : '';
        if (!path) return { error: 'Path required' };
        state.typedBundlePath = path;
        await runProbe(state.url ?? p.defaultUrl, path);
        return { screen: { html: render(), standalone: true } };
      }

      // name — and the overwrite gate that rides with it.
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) return { error: 'Name required' };
      if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
        return { error: 'Use letters, digits, hyphen, underscore' };
      }
      const collision = p.existingProfiles.find((e) => e.name === name && e.url);
      if (collision && payload.replace !== true) {
        // The screen holds its button until the replace toggle is on, so this
        // is a submit it could not have produced — and `saveAndActivateProfile`
        // upserts, so applying it would overwrite an address kept nowhere else.
        return { error: `Replacing ${name} has to be agreed to first.` };
      }
      state.profileName = name;

      return {
        done: true,
        result: {
          url: state.url ?? p.defaultUrl,
          caBundle: state.caBundle || undefined,
          profileName: name,
          replaced: Boolean(collision),
          cancelled: false,
        } satisfies WebByocResult,
      };
    },
  );
  return out as WebByocResult;
}
