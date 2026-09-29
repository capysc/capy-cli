/**
 * Keep's web origin, for the links/QR codes `capy transport` and `capy pair`
 * print (CAP-684).
 *
 * `CAPY_KEEP_ORIGIN` was pinned in `prodPins.ts` ahead of any code reading it
 * ("pinning a variable this build does not consume yet costs nothing" — see
 * that file's header) specifically so the portability/BYOC line could not
 * land a second unpinned URL. This is that first reader: prod strips the
 * variable before this module ever sees it (same precedence as
 * `CAPY_API_URL`), so prod always resolves to the built-in default; `capy-dev`
 * / `capy-staging` keep the override live for pointing at a local or staging
 * Keep instance.
 */

const DEFAULT_KEEP_ORIGIN = 'https://keep.capy.sc';

/** No trailing slash. */
export function resolveKeepOrigin(): string {
  const override = process.env.CAPY_KEEP_ORIGIN;
  if (override) return override.replace(/\/+$/, '');
  return DEFAULT_KEEP_ORIGIN;
}
