import { createHash } from 'crypto';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { KeepFile } from '../types/index';
import { fetchSecretsWithCache, readSecretsLocal } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

type RemoteFailure = 'access_denied' | 'network_error' | 'no_data';

function classifyRemoteFailure(reason: string): RemoteFailure {
  if (reason.includes('do not have access')) return 'access_denied';
  if (reason.includes('no data')) return 'no_data';
  return 'network_error';
}

export interface DiffResult {
  variable: string;
  type: 'new' | 'changed' | 'deleted';
  pinned?: string;
  local?: string;
  remote?: string;
}

/**
 * Compare three sources: pinned (keep.lock hashes), local (.env values), remote (Keep values).
 * Returns diff results and column visibility flags.
 */
export function compareSecrets(
  pinned: Record<string, string>,  // variable -> value_hash
  local: Record<string, string>,   // variable -> plaintext value (hashed for comparison)
  remote: Record<string, string>,  // variable -> plaintext value (hashed for comparison)
): { diffs: DiffResult[]; showLocal: boolean; showRemote: boolean } {
  const hasRemote = Object.keys(remote).length > 0;

  const allVars = new Set([
    ...Object.keys(pinned),
    ...Object.keys(local),
    ...(hasRemote ? Object.keys(remote) : []),
  ]);

  const diffs: DiffResult[] = [];
  let localDiffersFromPinned = false;
  let remoteDiffersFromPinned = false;

  for (const variable of allVars) {
    const pinnedHash = pinned[variable];
    const localHash = local[variable];
    // If remote has no data at all, treat each variable as matching pinned.
    // If remote has data but this variable is missing, it's a real absence.
    const remoteHash = hasRemote ? remote[variable] : pinnedHash;

    // Track if local or remote differs from pinned at all
    if (localHash !== pinnedHash) localDiffersFromPinned = true;
    if (remoteHash !== pinnedHash) remoteDiffersFromPinned = true;

    // Only report rows with mismatches
    if (pinnedHash === localHash && pinnedHash === remoteHash) continue;
    if (!pinnedHash && !localHash && !remoteHash) continue;

    // Determine type
    let type: 'new' | 'changed' | 'deleted';
    if (!pinnedHash && !localHash && remoteHash) {
      type = 'new';
    } else if (!pinnedHash && localHash && !remoteHash) {
      type = 'new';
    } else if (pinnedHash && !remoteHash && !localHash) {
      type = 'deleted';
    } else if ((pinnedHash && !remoteHash) || (!pinnedHash && remoteHash)) {
      type = remoteHash ? 'new' : 'deleted';
    } else {
      type = 'changed';
    }

    diffs.push({
      variable,
      type,
      pinned: pinnedHash || undefined,
      local: localHash || undefined,
      remote: remoteHash || undefined,
    });
  }

  // Column visibility:
  // If all local values match pinned → hide Local column
  // If all remote values match pinned → hide Remote column
  const showLocal = localDiffersFromPinned;
  const showRemote = remoteDiffersFromPinned;

  return { diffs, showLocal, showRemote };
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

/**
 * Hash a plaintext value the same way keep.lock stores it.
 */
export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class StatusCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private terse: boolean;

  constructor(terse: boolean = false, devMode: boolean = false) {
    this.terse = terse;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    try {
      await this._execute(opts);
    } catch {
      // Exit silently on any error (auth, network, etc.)
      // Hooks must never block git operations
      process.exit(0);
    }
  }

  private async _execute(opts: { json?: boolean } = {}): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      if (this.terse) return;
      console.log(`No keep.lock found. Run ${B('capy')} to initialize.`);
      return;
    }

    const keep = this.projectManager.readKeepFile();
    if (!keep) return;

    const branch = projectState.activeBranch;
    if (!branch) {
      // Runs from git hooks — report and bail rather than guessing a branch.
      if (!this.terse) console.log(`No active branch. Run ${B('capy')} to select a branch.`);
      return;
    }
    const branchLabel = branch;

    // Build pinned hashes from keep.lock for active branch
    const pinned: Record<string, string> = {};
    for (const [varName, entries] of Object.entries(keep.variables)) {
      const entry = entries.find(e => e.branch === branch);
      if (entry) {
        pinned[varName] = entry.value_hash;
      }
    }

    // Build local hashes from .env
    const localHashes: Record<string, string> = {};
    let encryptionKey: string | undefined;
    let remoteSkipReason: string | undefined;
    const localMode = isLocalOnly();
    try {
      if (localMode) {
        encryptionKey = await resolveLocalProjectKey(projectState.projectId!);
      } else {
        if (projectState.userId) {
          this.authService.setSessionUserId(projectState.userId);
        }
        const { resolveProjectKey } = await import('../crypto/keyResolver');
        const authResult = await this.authService.authenticateSilent(projectState.organizationId);
        if (!authResult.success) throw new Error('auth failed');

        const keyOps = {
          coDecrypt: (oid: string, ct: string) => this.serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
          wrapOuterLayer: (oid: string, pt: string) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
        };
        encryptionKey = await resolveProjectKey(
          projectState.organizationId!,
          projectState.projectId!,
          authResult.user_id!,
          keyOps,
        );
      }

      const rawLocal = this.fileManager.readEnvFile();
      for (const [key, value] of Object.entries(rawLocal)) {
        let plaintext = value;
        if (value.startsWith('capy:') && encryptionKey) {
          try {
            plaintext = this.fileManager.decryptValue(value, encryptionKey);
          } catch {
            continue;
          }
        }
        localHashes[key] = hashValue(plaintext);
      }
    } catch (err: any) {
      // Auth or key resolution failed — compare pinned vs local only
      remoteSkipReason = err?.message || 'auth or key resolution failed';
    }

    // Build remote hashes (fetch from Keep)
    const remoteHashes: Record<string, string> = {};
    if (encryptionKey) {
      try {
        const hasVariables = Object.keys(pinned).length > 0;
        if (hasVariables) {
          const keepHash = SyncEngine.computeKeepHash(keep, branch);
          const blob = localMode
            ? readSecretsLocal(projectState.organizationId!, projectState.projectId!, keepHash)
            : await fetchSecretsWithCache(
                this.serviceClient,
                projectState.organizationId!,
                projectState.projectId!,
                keepHash,
              );
          if (blob?.env_file) {
            const encrypted = this.fileManager.parseEnvContent(blob.env_file);
            for (const [key, value] of Object.entries(encrypted)) {
              try {
                const plaintext = this.fileManager.decryptValue(value, encryptionKey);
                remoteHashes[key] = hashValue(plaintext);
              } catch {
                // Skip values we can't decrypt
              }
            }
          } else {
            remoteSkipReason = 'no data at this keep_hash';
          }
        }
      } catch (err: any) {
        remoteSkipReason = err?.message || 'network error';
      }
    }

    const hasRemote = Object.keys(remoteHashes).length > 0;
    const remoteFailure: RemoteFailure | undefined = !hasRemote && remoteSkipReason
      ? classifyRemoteFailure(remoteSkipReason)
      : undefined;
    const { diffs, showLocal, showRemote } = compareSecrets(pinned, localHashes, remoteHashes);

    if (opts.json) {
      // diffs carry value HASHES only (sha256 prefix), never plaintext.
      const totalSecrets = new Set([...Object.keys(pinned), ...Object.keys(localHashes)]).size;
      console.log(
        JSON.stringify(
          {
            projectName: keep.project_name,
            branch,
            totalSecrets,
            inSync: diffs.length === 0,
            localMatchesPinned: !showLocal,
            remoteMatchesPinned: !showRemote,
            remoteFailure: remoteFailure ?? null,
            diffs,
          },
          null,
          2,
        ),
      );
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

    const totalSecrets = new Set([...Object.keys(pinned), ...Object.keys(localHashes)]).size;

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
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
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
      let prefix: string;
      let desc: string;

      if (failureLabel) {
        prefix = '?';
        desc = failureLabel;
      } else if (diff.type === 'new') {
        prefix = '+';
        if (diff.remote && !diff.pinned) desc = '(new on remote)';
        else if (diff.local && !diff.pinned) desc = '(new locally)';
        else desc = '(new)';
      } else if (diff.type === 'deleted') {
        prefix = '-';
        if (!diff.remote && diff.pinned) desc = '(missing from remote)';
        else if (!diff.local && diff.pinned) desc = '(missing locally)';
        else desc = '(missing)';
      } else {
        prefix = '~';
        if (diff.local !== diff.pinned && diff.remote === diff.pinned) desc = '(changed locally)';
        else if (diff.remote !== diff.pinned && diff.local === diff.pinned) desc = '(changed on remote)';
        else desc = '(changed)';
      }

      console.log(`  ${prefix} ${diff.variable.padEnd(20)} ${desc}`);
    }

    console.log('');
    if (remoteFailure === 'access_denied') {
      console.log(`  If you have already been invited, run ${B('capy redeem [invite-code]')} to access these secrets.`);
    } else {
      console.log(`  Run ${B('capy')} to sync these changes.`);
    }

    if (!this.terse) {
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    }
    process.exit(0);
  }
}
