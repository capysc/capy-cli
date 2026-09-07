import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES, KeepFile } from '../types/index';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
export { compareSecrets, hashValue, type DiffResult } from './statusComparison';
import { branchHashes, localStatusHashes, makeStatusReport, withStatusStage } from './statusData';
import { requireListIdentity, resolveListMetadata } from './listMetadata';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const DIM_B = '\x1b[90;1m';
const RESET = '\x1b[0m';

type RemoteFailure = 'access_denied' | 'network_error' | 'no_data';

/**
 * Why the remote column is missing — from the ERROR, not from its sentence.
 *
 * This badge is not decoration. `access_denied` is what makes the report tell
 * someone to run `capy redeem` instead of `capy`, because syncing will fail
 * the same way again; getting it wrong sends them round a loop. It used to be
 * decided with `reason.includes('do not have access')` against `err.message`,
 * and that sentence is thrown in two places in `keyResolver` — both of which
 * already carry `ERROR_CODES.PERMISSION_DENIED`, which is the actual fact.
 *
 * `no_data` was worse: the CLI matched `'no data'` against a string the CLI
 * itself had just assigned four lines earlier. That case is now set where it
 * is known and never re-read.
 */
function classifyRemoteFailure(err: unknown): RemoteFailure {
  if (err instanceof CapyError && err.code === ERROR_CODES.PERMISSION_DENIED) {
    return 'access_denied';
  }
  return 'network_error';
}

/**
 * Create a value snippet in abc...xyz format.
 */
export function formatSnippet(value: string): string {
  if (!value) return '-';
  const len = value.length;
  if (len <= 6) return value;
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

export class StatusCommand {
  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly terse: boolean;

  constructor(terse: boolean = false, devMode: boolean = false, private readonly expectedUserId?: string) {
    this.terse = terse;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode, expectedUserId);
    this.serviceClient = new ServiceClient(undefined, devMode);

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  async execute(opts: { readonly json?: boolean; readonly web?: boolean } = {}): Promise<void> {
    try {
      await this._execute(opts);
    } catch (error: unknown) {
      // Only Git-hook mode is silent. A requested JSON diagnostic must fail honestly.
      if (this.terse) return;
      const code = error instanceof CapyError ? error.code : ERROR_CODES.SERVICE_ERROR;
      const message = 'Could not check drift. Confirm Capy is connected and this repository has completed setup.';
      const stage = error instanceof CapyError ? error.details?.statusStage : undefined;
      const keyStep = error instanceof CapyError ? error.details?.statusKeyStep : undefined;
      if (opts.json) console.log(JSON.stringify({ ok: false, code, message, stage, keyStep }));
      else console.error(message);
      process.exit(1);
    }
  }

  private async _execute(opts: { readonly json?: boolean; readonly web?: boolean } = {}): Promise<void> {
    const localMode = isLocalOnly();
    const localKeep = this.projectManager.readKeepFile();
    const metadata = {
      authenticate: (orgId?: string) => this.authService.authenticateSilent(orgId),
      billing: () => this.serviceClient.getBillingStatus(),
      projects: () => this.serviceClient.listProjects(),
      snapshot: (projectId: string, branch: string) => this.serviceClient.getDecryptData(projectId, branch),
    };
    const binding = await withStatusStage('binding', async () => {
      if (!localKeep) {
        if (localMode) throw new CapyError('No local project binding.', ERROR_CODES.PROJECT_NOT_FOUND);
        const resolved = await resolveListMetadata(metadata, this.expectedUserId);
        const auth = await requireListIdentity(metadata, this.expectedUserId, resolved.keep.org_id);
        return { ...resolved, userId: auth.user_id! };
      }
      const state = await this.projectManager.detectProjectState();
      if (!state.activeBranch) throw new CapyError('Select a branch before checking drift.', ERROR_CODES.BRANCH_NOT_FOUND);
      if (localMode) {
        if (this.expectedUserId) throw new CapyError('Hosted status requires a connected account.', ERROR_CODES.AUTH_FAILED);
        return { keep: localKeep, branch: state.activeBranch, userId: '' };
      }
      if (!this.expectedUserId && state.userId) this.authService.setSessionUserId(state.userId);
      const auth = await requireListIdentity(metadata, this.expectedUserId, localKeep.org_id);
      return { keep: localKeep, branch: state.activeBranch, userId: auth.user_id! };
    });
    const { keep, branch, userId } = binding;
    const branchLabel = branch;
    const pinned = branchHashes(keep, branch);
    const rawLocal = this.fileManager.readEnvFile();
    const encryptionKey = await withStatusStage('key_access', async () => {
      if (!Object.values(rawLocal).some((value) => value.startsWith('capy:'))) return undefined;
      if (localMode) return resolveLocalProjectKey(keep.project_id);
      const { resolveStatusProjectKey } = await import('./statusKey');
      return resolveStatusProjectKey(keep.org_id, keep.project_id, userId, this.serviceClient, this.authService);
    });
    const localHashes = await withStatusStage('local_values', async () => localStatusHashes(rawLocal, (value) => {
      if (!encryptionKey) throw new CapyError('Device access is required.', ERROR_CODES.PERMISSION_DENIED);
      return this.fileManager.decryptValue(value, encryptionKey);
    }));
    const remote = await (async (): Promise<{ readonly hashes: Readonly<Record<string, string>>; readonly failure?: RemoteFailure }> => {
      if (localMode) return { hashes: pinned };
      try {
        // Latest branch metadata, not the cached snapshot named by the local pin.
        const snapshot = await this.serviceClient.getDecryptData(keep.project_id, branch);
        if (!snapshot.keep_file) return { hashes: {} };
        const latest: KeepFile = JSON.parse(snapshot.keep_file);
        if (latest.org_id !== keep.org_id || latest.project_id !== keep.project_id) {
          throw new CapyError('Remote project mismatch.', ERROR_CODES.PERMISSION_DENIED);
        }
        return { hashes: branchHashes(latest, branch) };
      } catch (error: unknown) {
        return { hashes: {}, failure: classifyRemoteFailure(error) };
      }
    })();
    const report = makeStatusReport({ projectName: keep.project_name, branch, pinned, local: localHashes,
      remote: remote.hashes, remoteFailure: remote.failure });
    const { diffs, totalSecrets } = report;
    const showLocal = !report.localMatchesPinned;
    const showRemote = !report.remoteMatchesPinned;
    const remoteFailure = remote.failure;
    const remoteSkipReason = remoteFailure === 'access_denied' ? 'access denied'
      : remoteFailure ? 'remote status unavailable' : undefined;
    const hasRemote = !remoteFailure;

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (opts.web) {
      // No TTY under --web (this is the agent-driven path), so the report goes
      // to the browser instead of to a stream nobody is reading. The page is
      // display-only: it posts nothing, carries no nonce, and is served under
      // the strict policy that cannot open a socket at all.
      const { showSyncStatusInBrowser } = await import('../ui/syncScreens');
      const { checkExpiringKeys } = await import('./connectors/shared');
      await showSyncStatusInBrowser({
        projectName: keep.project_name ?? '',
        branch,
        totalSecrets,
        localMatchesPinned: !showLocal,
        remoteMatchesPinned: !showRemote,
        hasRemote,
        remoteFailure,
        diffs,
        // The warnings `printExpiryWarnings` puts on stderr after every run,
        // where they can still be acted on.
        expiring: checkExpiringKeys().map(k => ({ variable: k.varName, expiresInDays: k.expiresIn })),
        json: JSON.stringify(report, null, 2),
        // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI /
        // headless verification drive the loopback without hijacking one.
        open: !process.env.CAPY_WEB_NO_OPEN,
        // `authService` opts this call into the keep-hosted transport when
        // CAPY_KEEP_SCREENS=1 (W2-B) — already-authenticated and already in
        // scope on this class, same as the silent-auth call a few lines up.
        authService: this.authService,
      });
      return;
    }

    if (this.terse) {
      // Terse mode for git hooks
      if (diffs.length === 0) return; // Silent when synced
      const count = diffs.length;
      const word = count === 1 ? 'secret differs' : 'secrets differ';
      console.log(`${B('capy')}: ${count} ${word} from remote. Run ${B('capy')} to sync.`);
      return;
    }

    // Full output
    console.log(`${B('capy')}: ${keep.project_name} (${branchLabel})`);
    console.log('');

    if (diffs.length === 0) {
      console.log(`> ${totalSecrets} secret${totalSecrets !== 1 ? 's' : ''} match pinned branch.`);
      if (!hasRemote) {
        if (remoteSkipReason) {
          console.log(`! Could not reach remote: ${remoteSkipReason}`);
        } else {
          console.log('! Remote is empty.');
          console.log('');
          console.log(`  Run ${B('capy push')} to share these secrets with your team.`);
        }
      } else {
        console.log('> Remote is up to date.');
      }
      await this.printFooter();
      process.exit(0);
    }

    // Check local vs pinned
    const localMatchesPinned = !showLocal;
    const remoteMatchesPinned = !showRemote;

    if (localMatchesPinned) {
      console.log(`> ${totalSecrets} secret${totalSecrets !== 1 ? 's' : ''} match pinned branch.`);
    } else if (remoteFailure) {
      console.log(`x Out of sync (${diffs.length} difference${diffs.length !== 1 ? 's' : ''})`);
    } else {
      const localDiffs = diffs.filter(d => d.local !== d.pinned);
      console.log(`x Local has changes (${localDiffs.length} difference${localDiffs.length !== 1 ? 's' : ''})`);
    }

    if (!hasRemote) {
      if (remoteSkipReason) {
        console.log(`! Could not reach remote: ${remoteSkipReason}`);
      } else {
        console.log('! Remote is empty.');
      }
    } else if (remoteMatchesPinned) {
      console.log('> Remote is up to date.');
    } else {
      const remoteDiffs = diffs.filter(d => d.remote !== d.pinned);
      console.log(`x Remote has changes (${remoteDiffs.length} difference${remoteDiffs.length !== 1 ? 's' : ''})`);
    }

    console.log('');

    const failureLabel = remoteFailure === 'access_denied' ? '(access denied)'
      : remoteFailure === 'network_error' ? '(network error)'
      : remoteFailure === 'no_data' ? '(no data)' : undefined;

    for (const diff of diffs) {
      const prefix = failureLabel ? '?' : diff.type === 'new' ? '+' : diff.type === 'deleted' ? '-' : '~';
      const desc = failureLabel ?? (diff.type === 'new'
        ? diff.remote && !diff.pinned ? '(new on remote)' : diff.local && !diff.pinned ? '(new locally)' : '(new)'
        : diff.type === 'deleted'
          ? !diff.remote && diff.pinned ? '(missing from remote)' : !diff.local && diff.pinned ? '(missing locally)' : '(missing)'
          : diff.local !== diff.pinned && diff.remote === diff.pinned ? '(changed locally)'
            : diff.remote !== diff.pinned && diff.local === diff.pinned ? '(changed on remote)' : '(changed)');

      console.log(`  ${prefix} ${diff.variable.padEnd(20)} ${desc}`);
    }

    console.log('');
    if (remoteFailure === 'access_denied') {
      console.log(`  If you have already been invited, run ${B('capy redeem [invite-code]')} to access these secrets.`);
    } else {
      console.log(`  Run ${B('capy')} to sync these changes.`);
    }

    await this.printFooter();
    process.exit(0);
  }

  /**
   * The one place the full report ends.
   *
   * Both exit paths route through here so a third cannot quietly ship
   * without the footer — the in-sync path and the has-differences path used
   * to carry their own copy of the expiry-warning call.
   */
  private async printFooter(): Promise<void> {
    if (this.terse) return;
    const { printExpiryWarnings } = await import('./connectors/shared');
    printExpiryWarnings();
    // Doors discoverability. `capy doors` and keep's doors page are the
    // answer to "my laptop was stolen", and until now nothing anywhere
    // pointed at either — you had to already know the command existed, at
    // exactly the moment nobody is browsing help. One dim line on a report
    // the user asked for by hand is the cheapest place to say it; the terse
    // path (git hooks) is deliberately excluded.
    console.log('');
    console.log(`  ${DIM}Lost a device? ${DIM_B}capy doors${DIM} lists everything that can act as you.${RESET}`);
  }
}
