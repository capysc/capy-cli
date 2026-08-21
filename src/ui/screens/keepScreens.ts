/**
 * The keep-screens serving fork (CAP-376), generalized to a per-screen
 * registry (W2-A).
 *
 * `CAPY_KEEP_SCREENS=1` moves a migrated screen's ending from the
 * loopback-served HTML to a hosted page on keep.capy.sc riding the
 * connection broker. Everything else about the flow is unchanged, and with
 * the flag unset (the default) the loopback behavior is byte-identical to
 * before this fork existed — the flag stays off until it is deliberately
 * flipped. It remains the ONE global switch: there is no per-screen flag.
 * A screen "opts in" to the fork by being appended to {@link KEEP_SCREENS},
 * not by bespoke branching in its own caller.
 *
 * `CAPY_KEEP_ORIGIN` overrides the keep origin for dev/test only, with the
 * same standing and precedence style as `CAPY_API_URL` for the service. The
 * production origin is the default; nothing secret rides in these URLs (a
 * connection id is never a credential — the broker 404s non-owners).
 */

import { isStagingEntrypoint, STAGING_KEEP_ORIGIN } from '../../config/stagingTarget';

export const KEEP_DEFAULT_ORIGIN = 'https://keep.capy.sc';

/** The two no-submit flows CAP-376 first shipped. Kept as a named alias
 * (rather than folded into `string`) because `authService.ts`'s
 * `relayAuthScreenViaKeep` still branches on it directly — narrower than
 * `KeepScreenName` on purpose, so a typo there is still a compile error. */
export type KeepAuthFlow = 'auth-success' | 'auth-error';

/**
 * What direction(s) carry a payload beyond a typed acknowledgement.
 *
 *   no-submit     the page answers with nothing but
 *                 `{v, flow, signal: 'acknowledged'}` — auth-success,
 *                 auth-error. Relayed by `authService.ts`'s
 *                 `relayAuthScreenViaKeep`. Carries no request payload
 *                 either: what little the page needs (auth-error's message)
 *                 rides the `/flow/<name>?c=<id>&code=<CODE>` URL itself,
 *                 which only works because that payload is one short code.
 *   payload-both  the CLI sends a request payload over the broker reverse
 *                 channel AND the page answers with a payload of its own —
 *                 secret-intake, and (going forward) any screen that
 *                 carries a browser/phone-entered value back to the CLI.
 *                 Relayed by the shared `runKeepPayloadScreen` helper in
 *                 `src/service/keepPayloadRelay.ts`.
 *   payload-in    W2-B: CLI→page carries a real, structured payload (too
 *                 large for a URL param — an error's causes/remedies, a
 *                 deploy's step log, a status report's diff table) but the
 *                 page has NOTHING to submit back: no button, no form, no
 *                 signal, only "read it and close the tab". The CLI does not
 *                 wait for any acknowledgement — same fire-and-forget
 *                 posture the loopback `serveEndingPage`/`showScreenInBrowser`
 *                 helpers already have ("returns once the browser has the
 *                 page, not once it has been read"). Relayed by
 *                 `runKeepInfoScreen` in `src/service/keepPayloadRelay.ts`.
 *                 The seven no-submit "ending" screens (CommandError,
 *                 ConnectResult, DeployRunResult, RotateProgress,
 *                 SessionInfo, SyncResult, SyncStatus) are this kind — this
 *                 is the "one non-trivial direction" case this doc comment
 *                 used to say had no kind yet.
 */
export type KeepScreenKind = 'no-submit' | 'payload-both' | 'payload-in';

export interface KeepScreenDefinition {
  /** Doubles as the broker `purpose` and the keep-app `/flow/<name>` route
   * slug — one vocabulary shared by CLI, broker and keep-app (CAP-376). */
  name: string;
  kind: KeepScreenKind;
}

/**
 * Every screen migrated off the CLI's loopback transport onto a
 * keep.capy.sc hosted page over the connection broker.
 *
 * APPEND ONLY, in order, at the marker below — this file is edited by every
 * loopback-to-keep migration in parallel, on separate branches off
 * `feat/portability`. Appending a line (never reordering or restructuring
 * an existing one) is what keeps those merges trivial unions instead of
 * conflicts. Removing or renaming an entry is a breaking change to the
 * broker `purpose` / keep-app route vocabulary and needs the same care as
 * renaming a public API.
 */
export const KEEP_SCREENS: readonly KeepScreenDefinition[] = [
  { name: 'auth-success', kind: 'no-submit' },
  { name: 'auth-error', kind: 'no-submit' },
  { name: 'secret-intake', kind: 'payload-both' },
  { name: 'connect-live-gate', kind: 'payload-both' },
  { name: 'org-members', kind: 'payload-both' },
  // <<< keep-migrated screens: append below >>>
  { name: 'command-error', kind: 'payload-in' },
  { name: 'connect-result', kind: 'payload-in' },
  { name: 'deploy-run-result', kind: 'payload-in' },
  { name: 'rotate-progress', kind: 'payload-in' },
  { name: 'session-info', kind: 'payload-in' },
  { name: 'sync-result', kind: 'payload-in' },
  { name: 'sync-status', kind: 'payload-in' },
  { name: 'branch-list', kind: 'payload-both' },
  { name: 'connect-overwrite', kind: 'payload-both' },
  { name: 'connect-provider', kind: 'payload-both' },
  { name: 'connect-setup', kind: 'payload-both' },
  { name: 'deploy-destination', kind: 'payload-both' },
  { name: 'deploy-plan-confirm', kind: 'payload-both' },
  { name: 'deploy-targets', kind: 'payload-both' },
  { name: 'deploy-tokens', kind: 'payload-both' },
];

export function isKeepScreen(name: string): boolean {
  return KEEP_SCREENS.some((s) => s.name === name);
}

export function keepScreenKind(name: string): KeepScreenKind | undefined {
  return KEEP_SCREENS.find((s) => s.name === name)?.kind;
}

export function keepScreensEnabled(): boolean {
  return process.env.CAPY_KEEP_SCREENS === '1';
}

/**
 * CAP-374 step 1: a SEPARATE switch from {@link keepScreensEnabled}, on
 * purpose. `CAPY_KEEP_SCREENS` governs whether an already-in-flight OAuth
 * callback's response gets deferred and redirected to a keep-hosted DISPLAY
 * ending; this flag governs something upstream of that — whether the FIRST
 * hop (`capy login`'s browser link) routes through keep's own `/auth/start`
 * at all, so the same browser also comes away with a keep session cookie.
 * They are orthogonal (either can be on without the other) and deliberately
 * decoupled: CAP-376's existing tests fix `/auth/initiate` as the FIRST
 * network call whenever `CAPY_KEEP_SCREENS=1`, so reusing that flag here
 * would silently break the ending-display feature's own test suite.
 */
export function keepLoginBridgeEnabled(): boolean {
  return process.env.CAPY_KEEP_LOGIN_BRIDGE === '1';
}

export function keepOrigin(): string {
  // capy-staging is pinned. Keep must move with the backend, so this early
  // return is what makes the two origins incapable of drifting apart.
  if (isStagingEntrypoint()) return STAGING_KEEP_ORIGIN;

  return process.env.CAPY_KEEP_ORIGIN || KEEP_DEFAULT_ORIGIN;
}

/**
 * CAP-374 step 1: a bounded reachability probe for keep, used ONLY to
 * decide whether `capy login` should route the browser through keep's
 * `/auth/start` (the "double duty" callback) or fall back to today's direct
 * `/auth/initiate` + own-loopback `redirect_uri` — the ORIGINAL flow,
 * unchanged, that this whole feature must degrade to whenever keep can't be
 * reached. Once the browser is sent into keep's flow there is no way back
 * (WorkOS won't retarget mid-flight), so this check has to happen BEFORE
 * that decision, not react to a failure after the fact. A short timeout: a
 * real outage should fail fast, not cost the user multiple seconds waiting
 * on a probe before they even see a login link.
 */
export async function isKeepReachable(
  origin: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(new URL('/auth/start', origin).toString(), {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any response at all (even a redirect, even a 4xx/5xx) means something
    // is listening and answering HTTP — that's all this gate needs to know.
    // A network error / timeout is the only "unreachable" outcome.
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * The URL the browser is sent to. `c` carries the connection id; auth-error
 * additionally carries the machine-readable failure code (the same
 * `?code=<CODE>` convention keep-app's own /auth/error page uses). No
 * payload ever rides in a URL — the page renders from the broker metadata,
 * its own session, and (for a `payload-both` screen) the sealed reverse-
 * channel request it fetches once attached.
 *
 * Takes any registered screen name, not just {@link KeepAuthFlow} — the
 * route-building rule (`/flow/<name>?c=<id>`) is identical for every screen
 * in {@link KEEP_SCREENS}; only auth-error's `errorCode` display param is
 * specific to that one flow, and every other caller simply omits it.
 */
export function keepFlowUrl(flow: string, connectionId: string, errorCode?: string): string {
  const url = new URL(`/flow/${flow}`, keepOrigin());
  url.searchParams.set('c', connectionId);
  if (flow === 'auth-error' && errorCode) url.searchParams.set('code', errorCode);
  return url.toString();
}
