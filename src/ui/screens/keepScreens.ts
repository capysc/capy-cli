/**
 * The keep-screens serving fork (CAP-376).
 *
 * `CAPY_KEEP_SCREENS=1` moves the auth-success / auth-error endings from the
 * loopback-served HTML to hosted pages on keep.capy.sc riding the connection
 * broker. Everything else about the flow is unchanged, and with the flag
 * unset (the default) the loopback behavior is byte-identical to before this
 * fork existed — the flag stays off until it is deliberately flipped.
 *
 * `CAPY_KEEP_ORIGIN` overrides the keep origin for dev/test only, with the
 * same standing and precedence style as `CAPY_API_URL` for the service. The
 * production origin is the default; nothing secret rides in these URLs (a
 * connection id is never a credential — the broker 404s non-owners).
 */

export const KEEP_DEFAULT_ORIGIN = 'https://keep.capy.sc';

/** The two no-submit flows this fork serves. Slugs double as broker
 * `purpose` values and as keep-app flow route names — one vocabulary. */
export type KeepAuthFlow = 'auth-success' | 'auth-error';

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
 * payload ever rides in a URL — the page renders from the broker metadata
 * and its own session.
 */
export function keepFlowUrl(
  flow: KeepAuthFlow,
  connectionId: string,
  errorCode?: string,
): string {
  const url = new URL(`/flow/${flow}`, keepOrigin());
  url.searchParams.set('c', connectionId);
  if (flow === 'auth-error' && errorCode) url.searchParams.set('code', errorCode);
  return url.toString();
}
