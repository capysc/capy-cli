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
 *                 `relayAuthScreenViaKeep`.
 *   payload-both  the CLI sends a request payload over the broker reverse
 *                 channel AND the page answers with a payload of its own —
 *                 secret-intake, and (going forward) any screen that
 *                 carries a browser/phone-entered value back to the CLI.
 *                 Relayed by the shared `runKeepPayloadScreen` helper in
 *                 `src/service/keepPayloadRelay.ts`.
 *
 * A screen needing only ONE non-trivial direction (e.g. a request payload
 * with a bare ack back, or no request but a real answer payload) has no
 * kind here yet — add one, and the relay case it needs, when the first such
 * screen actually migrates, rather than guessing its shape in advance.
 */
export type KeepScreenKind = 'no-submit' | 'payload-both';

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

export function keepOrigin(): string {
  return process.env.CAPY_KEEP_ORIGIN || KEEP_DEFAULT_ORIGIN;
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
