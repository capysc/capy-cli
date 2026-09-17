/** Stable hosted Development endpoints, shared by both entrypoints and API fallback. */
export function devOrigins(env: Readonly<NodeJS.ProcessEnv> = process.env) {
  const host = env.CAPY_DEV_HOST || 'mabels-mac-mini.tailcbfb49.ts.net';
  return {
    CAPY_API_URL: `https://${host}:3444`,
    CAPY_KEEP_ORIGIN: `https://${host}:3443`,
  } as const;
}
