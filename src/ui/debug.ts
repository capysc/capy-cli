/**
 * One verbosity switch for the whole CLI.
 *
 * Diagnostic / operational chatter (service URLs, file-write progress, key
 * fetches) is silent by default and only emitted under `-v`/`--verbose`. The
 * flag is read from `CAPY_VERBOSE`, which both entrypoints set from argv at the
 * head before any command runs — so this works even for the deep, shared code
 * (auth/service/file managers) that isn't threaded the parsed option.
 *
 * This gates *debug* output only. User-facing output (the ✓ confirmations,
 * prompts, plans, tables, error screens) is NOT routed through here.
 */
export function isVerbose(): boolean {
  return process.env.CAPY_VERBOSE === '1';
}

/** Emit a diagnostic line (to stderr, so it never pollutes piped stdout) — only under --verbose. */
export function debug(...args: unknown[]): void {
  if (process.env.CAPY_VERBOSE === '1') {
    console.error(...args);
  }
}

/**
 * Timestamped, optionally-structured debug line: `[debug <iso>] <msg> <json?>`.
 * The single gate for all the sprinkled `this.debug(...)` diagnostics — class
 * debug() methods just format their scope prefix and delegate here, so toggling
 * verbosity (or changing the format) happens in exactly one place.
 */
export function debugLine(msg: string, data?: unknown): void {
  if (process.env.CAPY_VERBOSE !== '1') return;
  const ts = new Date().toISOString();
  const prefix = `\x1b[90m[debug ${ts}]\x1b[0m`;
  if (data !== undefined) {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.error(`${prefix} ${msg} ${serialized}`);
  } else {
    console.error(`${prefix} ${msg}`);
  }
}
