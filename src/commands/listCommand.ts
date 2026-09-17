import { existsSync } from 'fs';
import { ProjectManager } from '../core/projectManager';
import { CapyError, ERROR_CODES } from '../types/index';
import { listAllVarsOnBranch, listManagedKeys, findManagedConnector } from './connectors/shared';
import { requireListIdentity } from './listMetadata';
import { assertSupportedKeepMode } from '../sync/legacyKeepMode';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * `capy list` — variable NAMES + connector metadata for the active branch.
 *
 * With a keep.lock present this reads it directly: no auth, no network, no
 * decryption, never emits values. Without a lock, silently authenticate and
 * fetch the free default project's metadata; never resolve a key or decrypt.
 * Hosted callers additionally require an exact matching session identity.
 */
export class ListCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(opts: { readonly json?: boolean; readonly expectedUserId?: string } = {}): Promise<void> {
    const pm = new ProjectManager();

    const context = await (async () => {
      if (!existsSync(pm.getKeepPath())) {
        assertSupportedKeepMode(pm.readSyncState());
        throw new CapyError('No keep.lock found in this directory.', ERROR_CODES.PROJECT_NOT_INITIALIZED);
      }
      const projectState = await pm.detectProjectState();
      const found = pm.readKeepFile();
      if (!found) {
        throw new CapyError('Could not read keep.lock', ERROR_CODES.PROJECT_NOT_FOUND);
      }
      if (opts.expectedUserId) {
        const { createListMetadataDependencies } = await import('./listMetadata');
        await requireListIdentity(await createListMetadataDependencies(this.devMode, opts.expectedUserId), opts.expectedUserId, found.org_id);
      }
      return { keep: found, branch: projectState.activeBranch };
    })();
    const { keep, branch } = context;
    if (!branch) {
      // No branch resolved: report it rather than guessing.
      if (opts.json) {
        console.log(JSON.stringify({ projectName: keep.project_name, branch: null, variables: [] }, null, 2));
      } else {
        console.error(`No active branch. Run ${B('capy')} to select a branch.`);
      }
      return;
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
