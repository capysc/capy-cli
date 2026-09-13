/**
 * Prod target pinning — the production `capy` binary talks to one service and
 * one home directory, and nothing in the ambient environment gets a vote.
 *
 * Why this exists: `CAPY_API_URL` is a perfectly natural name for a *project's
 * own* secret. capy-mcp stores exactly that, to tell the MCP server which Capy
 * service to call. So any environment carrying that project's secrets — a
 * `capy run` child, a process manager, a sourced .env — also retargeted the
 * CLI itself, silently, at whatever that project happened to store. A prod
 * binary that points somewhere else on the strength of a variable it never set
 * is a foot-gun that no warning really fixes, so prod stops reading these.
 *
 * What stays configurable: `~/.capy/config.json` profiles, written by
 * `capy byoc` and `capy use`. BYOC operators still point the prod binary at
 * their own instance — deliberately, on disk, per machine. Only the ambient
 * environment loses its say.
 *
 * Where the overrides went: `capy-dev` (dist/index-dev.js) still honors every
 * variable below, and `bin/capy-staging` runs on that entrypoint for exactly
 * this reason. Dev is the retargetable build; prod is pinned.
 */

/**
 * Variables the prod entrypoint refuses to read. Each one either chooses the
 * service (`CAPY_API_URL`, `CAPY_KEEP_ORIGIN`), chooses which on-disk state to
 * use (`CAPY_GLOBAL_DIR_NAME`, `CAPY_PROFILE`), or unlocks a non-OAuth login
 * (`CAPY_TEST_*` — inert in prod today, since password auth also requires
 * devMode, but stripped so it can never become live by accident).
 *
 * `CAPY_KEEP_ORIGIN` is listed ahead of the branch that reads it: pinning a
 * variable this build does not consume yet costs nothing, and means the
 * portability work cannot land a second unpinned URL.
 */
export const PINNED_ENV_VARS = [
  'CAPY_API_URL',
  'CAPY_KEEP_ORIGIN',
  'CAPY_GLOBAL_DIR_NAME',
  'CAPY_PROFILE',
  'CAPY_TEST_EMAIL',
  'CAPY_TEST_PASSWORD',
] as const;

export type PinnedEnvVar = (typeof PINNED_ENV_VARS)[number];

/**
 * What `applyProdPins` took out of the environment, kept so `capy run` can
 * hand the originals to its child unchanged. The CLI ignores these; a child
 * process is a different program with its own reasons for wanting them, and
 * silently dropping six variables from every `capy run` would be a subtle
 * regression in an unrelated feature.
 */
let strippedFromShell: Record<string, string> = {};

/**
 * Remove every pinned variable from `env`, returning the names that were
 * actually present. Idempotent, and safe to call before any Capy module has
 * read configuration — which is the whole point, so it runs as the first
 * statement of the prod entrypoint.
 *
 * Takes `env` as a parameter rather than closing over `process.env` so tests
 * can drive it against a throwaway object.
 */
export function applyProdPins(env: NodeJS.ProcessEnv = process.env): PinnedEnvVar[] {
  const stripped: PinnedEnvVar[] = [];
  for (const name of PINNED_ENV_VARS) {
    const value = env[name];
    // An empty string is not an override anyone meant to set, but it is still
    // truthy enough to reach a URL resolver, so treat it as present and drop it.
    if (value === undefined) continue;
    if (env === process.env) strippedFromShell[name] = value;
    delete env[name];
    stripped.push(name);
  }
  return stripped;
}

/**
 * The pinned variables as they arrived from the shell, for `capy run` to merge
 * back into its child's environment at the precedence they used to hold.
 * Empty on every path that never called `applyProdPins` (dev, tests, library
 * use), so callers can spread it unconditionally.
 */
export function getShellPinnedEnv(): Record<string, string> {
  return { ...strippedFromShell };
}

/** Test seam — forget what a previous `applyProdPins` captured. */
export function resetShellPinnedEnv(): void {
  strippedFromShell = {};
}

/**
 * One-line notice for a prod run that had overrides stripped. Returns null when
 * nothing was stripped, so the common case prints nothing at all.
 *
 * This is the diagnostic the original bug lacked: the CLI was quietly talking
 * to a URL the user never chose, and nothing on screen said so.
 */
export function formatPinNotice(stripped: PinnedEnvVar[]): string | null {
  if (stripped.length === 0) return null;
  const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
  const names = stripped.join(', ');
  return [
    dim(`capy: ignoring ${names} from the environment.`),
    dim('      Prod capy takes its target from ~/.capy/config.json, not the environment.'),
    dim('      Self-hosted? `capy byoc` saves a profile. Staging or local? Use capy-staging / capy-dev.'),
  ].join('\n');
}
