import { ProjectManager } from '../core/projectManager';
import { listAllVarsOnBranch, listManagedKeys, findManagedConnector } from './connectors/shared';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * `capy list` — variable NAMES + connector metadata for the active branch.
 * Reads keep.lock only: no auth, no network, no decryption. Never emits values.
 */
export class ListCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      console.error(`No keep.lock found. Run ${B('capy')} to initialize.`);
      process.exit(1);
    }
    const keep = pm.readKeepFile();
    if (!keep) {
      console.error('Could not read keep.lock');
      process.exit(1);
    }
    const branch = projectState.activeBranch;

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
