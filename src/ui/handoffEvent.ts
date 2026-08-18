// The machine-readable counterpart of a browser-handoff URL (CAP-386).
//
// WHY THIS EXISTS: every interactive `--web` flow prints a line like
// "Continue in your browser: http://127.0.0.1:PORT/?n=..." so a person (or
// whoever is relaying on their behalf) has a fallback when the browser
// didn't open, or opened the wrong profile. Until now the ONLY way to find
// that URL programmatically was to regex the CLI's human prose for the
// first `https?://` substring (capy-mcp's `firstBrowserUrl`,
// `src/safety.ts`) — a direct violation of the rule against branching on
// human-readable strings, and fragile in a way that already bites: a
// stdout chunk can contain an unrelated URL first (a deploy result link,
// a GitHub PR link) and the regex has no way to tell them apart from a
// real handoff.
//
// THE FIX: every site that prints a handoff URL for a human ALSO emits one
// line of structured data describing the exact same URL, through this one
// helper. The human line is untouched — same bytes, same place — this is
// purely additive.
//
// CHANNEL: stdout, gated on `!process.stdout.isTTY`.
//
//   - Same stream as the human line, so a consumer already reading stdout
//     (capy-mcp's `onStdout` callback, `runCapy` in its `capy.ts`) sees the
//     event without a second pipe to wire up.
//   - Gated on non-TTY so a REAL interactive terminal — someone typing
//     `capy` themselves — gets back byte-for-byte what they always got:
//     zero new bytes on stdout, not just an unchanged human line. This
//     reuses the repo's existing TTY/agent-detection convention
//     (`ui/interactive.ts`'s `isInteractive()`, `ui/spinner.ts`,
//     `rotateScreens.ts`'s "gated on isTTY" path) rather than inventing a
//     new env var: spawning capy via `child_process` pipes — exactly what
//     capy-mcp does, and what the test harness does — is never a TTY, so
//     the gate fires for every machine consumer with no extra plumbing on
//     either side.
//
// FORMAT: a fixed ASCII marker prefix, not bare JSON on its own line. A
// machine consumer must never have to guess whether a stdout line is prose
// or data: `JSON.parse`-and-see-if-it-throws is both slow (every line) and
// unsafe (a JSON-shaped chunk of human prose, or a JSON line torn in half
// across two `data` events, could parse into something unintended). The
// marker makes detection one cheap, unambiguous `startsWith` — nothing in
// this CLI's human-facing output starts a line with it.
//
// A consumer reading raw `data` events (not pre-split into lines) MUST
// buffer until it has a complete `\n`-terminated line before matching the
// marker or parsing the JSON that follows it — `child_process` stdout
// chunks are not guaranteed to land on line boundaries.

/** Line-start marker. Cheap, unambiguous discriminator — see file header. */
export const HANDOFF_EVENT_MARKER = 'CAPY_EVENT_V1 ';

/** The event's own discriminator field, for a consumer that parses first and checks second. */
export const HANDOFF_EVENT_TYPE = 'capy:handoff-url';

/**
 * Stable flow slugs, one per command/ceremony that can print a handoff URL.
 *
 * A closed union rather than a free string: every call site is in this
 * file's diff, so the type checker is the completeness check — a new
 * handoff site that forgets to add its slug here fails the build instead
 * of shipping an `undefined`-shaped event.
 */
export type HandoffFlow =
  | 'edit'
  | 'connect'
  | 'rotate'
  | 'deploy'
  | 'deploy-token'
  | 'add'
  | 'login'
  | 'enroll'
  | 'unlock'
  | 'grant'
  | 'sync'
  | 'branch'
  | 'byoc'
  | 'decrypt'
  | 'init'
  | 'onboard'
  | 'recover'
  | 'end-recover'
  | 'transport'
  | 'invite'
  | 'kick'
  | 'org'
  | 'unlock-passphrase'
  | 'select'
  | 'error';

/** Where the URL resolves — this CLI's own loopback server, or a remote origin. */
export type HandoffLocation = 'loopback' | 'hosted';

export interface HandoffUrlEvent {
  /** Schema version. Bump on any breaking field change; consumers should reject an unknown `v`. */
  v: 1;
  event: typeof HANDOFF_EVENT_TYPE;
  /** The exact URL the human line shows — byte-identical, never re-derived. */
  url: string;
  /** Which flow this handoff belongs to. */
  flow: HandoffFlow;
  /** loopback: 127.0.0.1/localhost/::1, served by this CLI process. hosted: any other origin. */
  location: HandoffLocation;
  /** ISO-8601 timestamp, when the event was emitted. */
  ts: string;
  /**
   * RFC-8628 anti-phishing binding, when the flow step carries one (e.g.
   * `sandbox_session`'s `user_code` — `shared/flows/steps.json`: "not a
   * secret and MUST be shown to the human so they can compare it against the
   * page"). Optional and additive: every existing call site that doesn't
   * pass one keeps emitting the exact same event shape as before. Never a
   * secret — safe on the same channel as the URL it accompanies.
   */
  userCode?: string;
}

/** loopback iff the URL's hostname is one of this process's own loopback addresses. */
export function classifyHandoffLocation(url: string): HandoffLocation {
  try {
    const { hostname } = new URL(url);
    const h = hostname.replace(/^\[|\]$/g, ''); // IPv6 host is bracketed in a URL
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' ? 'loopback' : 'hosted';
  } catch {
    // Every call site builds this URL itself (never user input); malformed
    // is not expected. Fail toward 'hosted' — the classification a consumer
    // should treat with more suspicion, not less.
    return 'hosted';
  }
}

/**
 * Emit the structured counterpart of a browser-handoff URL. Call this
 * immediately alongside (never instead of) the human-readable print that
 * shows the same URL.
 *
 * Two things every call site must get right, because nothing here can
 * check them:
 *
 *   1. Pass the SAME url the human line just printed, verbatim — a
 *      consumer that opens this URL must reach the exact page the human
 *      line pointed at.
 *   2. Never call this for a URL a human print is deliberately withholding.
 *      `src/commands/connectors/stripe.ts`'s Stripe CLI-pairing handoff is
 *      the current example: `pairing.browserUrl` carries a bearer pairing
 *      token, and the existing code already keeps it off stdout under
 *      `--web` for exactly that reason (an agent reading stdout must never
 *      see it). Emitting it here would reopen the same hole through a
 *      second channel. When in doubt: if the human-readable line right
 *      above your call doesn't print the URL, don't call this either.
 *
 * `extra.userCode`, when the call site's step carries one, rides along on
 * the same event — see `HandoffUrlEvent.userCode`'s own doc. Omitted entirely
 * (not even `undefined`) when not given, so an existing consumer diffing the
 * JSON shape sees nothing new.
 */
export function emitHandoffUrlEvent(url: string, flow: HandoffFlow, extra?: { userCode?: string }): void {
  if (process.stdout.isTTY) return; // real terminal: emit nothing new, ever
  const event: HandoffUrlEvent = {
    v: 1,
    event: HANDOFF_EVENT_TYPE,
    url,
    flow,
    location: classifyHandoffLocation(url),
    ts: new Date().toISOString(),
    ...(extra?.userCode ? { userCode: extra.userCode } : {}),
  };
  process.stdout.write(HANDOFF_EVENT_MARKER + JSON.stringify(event) + '\n');
}
