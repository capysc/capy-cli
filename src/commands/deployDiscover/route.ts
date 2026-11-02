/**
 * Routing `capy deploy <target> --discover [--plan <file>] [--confirm <plan_id>] [--base-url <url>]`
 * (CAP-703), shared by both entrypoints (`index.ts`, `index-dev.ts`) so they cannot drift.
 *
 * `--discover` is an option of `capy deploy`, not a sub-command: a sub-command named
 * `dokploy` would take `capy deploy dokploy` away from the target flow. Only the `dokploy`
 * target has a discovery; any other target is refused with a code.
 */
import { ERROR_CODES } from '../../types/index';
import { conflictFlagsOrExit, type RawConflictFlags } from '../../sync/conflicts';
import { gateFirst } from '../../sync/gate';

export interface DeployDiscoverFlags {
  readonly discover?: boolean;
  readonly plan?: string;
  readonly confirm?: string;
  readonly baseUrl?: string;
}

function printRefusal(code: string, error: string): number {
  console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  return 1;
}

/** The exit code when these flags were a discovery run (or a refusal of one), `undefined` when they were not. */
export async function routeDeployDiscover(
  target: string | undefined,
  flags: DeployDiscoverFlags,
  dryRun: boolean,
  devMode: boolean,
  conflictFlags: RawConflictFlags = {},
): Promise<number | undefined> {
  const discovering = flags.discover === true;
  const discoverOnly = flags.plan !== undefined || flags.confirm !== undefined || flags.baseUrl !== undefined;
  if (!discovering && !discoverOnly) return undefined;
  if (!discovering) {
    return printRefusal(ERROR_CODES.INVALID_FORMAT, '--plan, --confirm and --base-url need --discover.'); // COPY-FLAG
  }
  if (target !== 'dokploy') {
    return printRefusal(ERROR_CODES.DISCOVER_UNSUPPORTED_TARGET, '--discover is only available for the dokploy target: capy deploy dokploy --discover.'); // COPY-FLAG
  }
  // Bare `capy` runs first, before anything is discovered, planned or written (docs/conflict-resolution.md). This run
  // writes no env: its only writes are `.capy/deploy.json` PRs into the discovered repos, through the GitHub API, so no
  // per-repo sync is needed beyond this one in the working directory. It never prompts, so a difference is reported
  // (exit 3, the payload alone on stdout) and answered by a rerun with `--resolve` + `--conflict`.
  conflictFlagsOrExit(conflictFlags, true);
  await gateFirst({ devMode, json: true, nonTty: true, conflictFlags, dryRun });
  const { deployDokployDiscoverCommand } = await import('./index');
  return deployDokployDiscoverCommand(
    { dryRun, plan: flags.plan, confirm: flags.confirm, baseUrl: flags.baseUrl },
    devMode,
  );
}
