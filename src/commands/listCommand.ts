import { ProjectManager } from '../core/projectManager';
import { KeepFile } from '../types/index';
import { listAllVarsOnBranch, listManagedKeys, findManagedConnector } from './connectors/shared';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * `capy list` — variable NAMES + connector metadata for the active branch.
 *
 * With a keep.lock present this reads it directly: no auth, no network, no
 * decryption, never emits values — unchanged from before CAP-304. Without
 * one (lock-less mode) there is no local file to read from, so this falls
 * back to `resolveContext()`, which does need auth + network to fetch the
 * server's latest keep.json for the branch — still never decrypts or emits
 * values, since KeepFile entries only ever carry resource_id/value_hash.
 */
export class ListCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    let keep: KeepFile;
    let branch: string;
    if (!projectState.initialized) {
      const { resolveContext } = await import('./connectors/shared');
      const ctx = await resolveContext({ devMode: this.devMode });
      keep = ctx.keep;
      branch = ctx.branch;
    } else {
      const found = pm.readKeepFile();
      if (!found) {
        console.error('Could not read keep.lock');
        process.exit(1);
      }
      keep = found;
      const activeBranch = projectState.activeBranch;
      if (!activeBranch) {
        // No branch resolved (fresh clone / gitignored .capy) — report and bail
        // rather than guessing one, mirroring status/checkout post-#264.
        if (opts.json) {
          console.log(
            JSON.stringify(
              { projectName: keep.project_name, branch: null, variables: [] },
              null,
              2,
            ),
          );
        } else {
          console.error(`No active branch. Run ${B('capy')} to select a branch.`);
        }
        return;
      }
      branch = activeBranch;
    }

    const managed = new Set(listManagedKeys(keep, branch).map((m) => m.varName));
    const variables = listAllVarsOnBranch(keep, branch).map((name) => {
      const c = managed.has(name) ? findManagedConnector(keep, name, branch) : undefined;
      return {
        name,
        managed: !!c,
        connector: c
          ? {
              provider: c.provider,
              source: c.source,
              mode: c.mode ?? null,
              accountId: c.account_id ?? null,
              fingerprint: c.fingerprint,
              createdAt: new Date(c.created_at * 1000).toISOString(),
              rotatedAt: c.rotated_at ? new Date(c.rotated_at * 1000).toISOString() : null,
              expiresAt: c.expires_at ? new Date(c.expires_at * 1000).toISOString() : null,
            }
          : null,
      };
    });

    if (opts.json) {
      console.log(JSON.stringify({ projectName: keep.project_name, branch, variables }, null, 2));
      return;
    }

    console.log('');
    console.log(`  ${keep.project_name} ${DIM}·${RESET} ${branch} ${DIM}(${variables.length})${RESET}`);
    for (const v of variables) {
      const tag = v.connector ? ` ${DIM}(${v.connector.provider})${RESET}` : '';
      console.log(`  ${v.name}${tag}`);
    }
    console.log('');
  }
}
