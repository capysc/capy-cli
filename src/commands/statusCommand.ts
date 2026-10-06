import { createHash } from 'crypto';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService, silentAuthFailureMessage } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { CapyError, ERROR_CODES, KeepFile } from '../types/index';
import { fetchSecretsWithCache, readSecretsLocal } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

type RemoteFailure = 'access_denied' | 'network_error' | 'no_data';

/** Why the remote column is missing: the sentence a person reads, and the verdict the report branches on. */
interface RemoteSkip {
  reason: string;
  kind: RemoteFailure;
}

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

    // Silent reconcile (CAP-307): no pinned baseline yet, but local and remote
    // already agree. There is nothing to push (remote already holds this exact
    // value) and nothing to pull — so don't report a diff and don't let this
    // variable flip the showLocal/showRemote direction hints. The pin is adopted
    // naturally via the "Everything is up to date!" path when no other variable
    // differs. Scoped tightly: only when pinned is absent AND local === remote
    // (both present); genuine divergence (local !== remote) still surfaces below.
    if (!pinnedHash && localHash !== undefined && localHash === remoteHash) {
      continue;
    }

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

  /** The project key, or why it could not be had. Never throws. */
  private async resolveEncryptionKey(
    projectState: { userId?: string; organizationId?: string; projectId?: string },
    localMode: boolean,
  ): Promise<{ encryptionKey: string } | { skip: RemoteSkip }> {
    try {
      if (localMode) {
        return { encryptionKey: await resolveLocalProjectKey(projectState.projectId!) };
      }
      if (projectState.userId) {
        this.authService.setSessionUserId(projectState.userId);
      }
      const { resolveProjectKey } = await import('../crypto/keyResolver');
      const authResult = await this.authService.authenticateSilent(projectState.organizationId);
      // The message becomes the skip reason, which the report shows.
      // "auth failed" told the reader nothing about whether to sign in again or
      // check the network.
      if (!authResult.success) throw new Error(silentAuthFailureMessage(authResult));

      const keyOps = {
        coDecrypt: (oid: string, ct: string, transportId?: string) => this.serviceClient.coDecrypt(oid, ct, undefined, transportId).then(r => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      return {
        encryptionKey: await resolveProjectKey(
          projectState.organizationId!,
          projectState.projectId!,
          authResult.user_id!,
          keyOps,
        ),
      };
    } catch (err: any) {
      // Auth or key resolution failed — compare pinned vs local only
      return { skip: { reason: err?.message || 'auth or key resolution failed', kind: classifyRemoteFailure(err) } };
    }
  }

  /** Hashes of the local .env values; a value this key cannot decrypt is left out. */
  private hashLocalEnv(encryptionKey: string): Record<string, string> {
    const rawLocal = this.fileManager.readEnvFile();
    return Object.fromEntries(
      Object.entries(rawLocal).flatMap(([key, value]) => {
        if (!(value.startsWith('capy:') && encryptionKey)) return [[key, hashValue(value)] as const];
        try {
          return [[key, hashValue(this.fileManager.decryptValue(value, encryptionKey))] as const];
        } catch {
          return [];
        }
      }),
    );
  }

  /** The key (when there is one) and the hashes of the local .env, or the reason the comparison is local-only. */
  private async readLocalState(
    projectState: { userId?: string; organizationId?: string; projectId?: string },
    localMode: boolean,
  ): Promise<{ encryptionKey: string | undefined; localHashes: Record<string, string>; skip: RemoteSkip | undefined }> {
    const keyed = await this.resolveEncryptionKey(projectState, localMode);
    if ('skip' in keyed) return { encryptionKey: undefined, localHashes: {}, skip: keyed.skip };
    try {
      return { encryptionKey: keyed.encryptionKey, localHashes: this.hashLocalEnv(keyed.encryptionKey), skip: undefined };
    } catch (err: any) {
      return {
        encryptionKey: keyed.encryptionKey,
        localHashes: {},
        skip: { reason: err?.message || 'auth or key resolution failed', kind: classifyRemoteFailure(err) },
      };
    }
  }

  /** Hashes of the remote (Keep) values for the pinned keep, or why there are none to show. */
  private async fetchRemoteHashes(args: {
    keep: KeepFile;
    branch: string;
    pinned: Record<string, string>;
    encryptionKey: string;
    organizationId: string;
    projectId: string;
    localMode: boolean;
  }): Promise<{ remoteHashes: Record<string, string>; skip: RemoteSkip | undefined }> {
    const { keep, branch, pinned, encryptionKey, organizationId, projectId, localMode } = args;
    try {
      const hasVariables = Object.keys(pinned).length > 0;
      if (!hasVariables) return { remoteHashes: {}, skip: undefined };
      const keepHash = SyncEngine.computeKeepHash(keep, branch);
      const blob = localMode
        ? readSecretsLocal(organizationId, projectId, keepHash)
        : await fetchSecretsWithCache(this.serviceClient, organizationId, projectId, keepHash);
      if (!blob?.env_file) {
        // Known here, so recorded here. Nothing downstream re-reads the
        // sentence to work out what this line already knew.
        return { remoteHashes: {}, skip: { reason: 'no data at this keep_hash', kind: 'no_data' } };
      }
      const encrypted = this.fileManager.parseEnvContent(blob.env_file);
      const remoteHashes = Object.fromEntries(
        Object.entries(encrypted).flatMap(([key, value]) => {
          try {
            return [[key, hashValue(this.fileManager.decryptValue(value, encryptionKey))] as const];
          } catch {
            return []; // Skip values we can't decrypt
          }
        }),
      );
      return { remoteHashes, skip: undefined };
    } catch (err: any) {
      return { remoteHashes: {}, skip: { reason: err?.message || 'network error', kind: classifyRemoteFailure(err) } };
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
    const pinned: Record<string, string> = Object.fromEntries(
      Object.entries(keep.variables).flatMap(([varName, entries]) => {
        const entry = entries.find(e => e.branch === branch);
        return entry ? [[varName, entry.value_hash] as const] : [];
      }),
    );

    // Build local hashes from .env. Two facts, deliberately separate: the
    // sentence a person reads, and the verdict the report branches on.
    // Deriving the second from the first is what this pair replaces.
    const localMode = isLocalOnly();
    const local = await this.readLocalState(projectState, localMode);
    const { encryptionKey, localHashes } = local;

    // Build remote hashes (fetch from Keep)
    const remote = encryptionKey
      ? await this.fetchRemoteHashes({
          keep,
          branch,
          pinned,
          encryptionKey,
          organizationId: projectState.organizationId!,
          projectId: projectState.projectId!,
          localMode,
        })
      : { remoteHashes: {} as Record<string, string>, skip: undefined };
    const { remoteHashes } = remote;
    // The remote step's skip, when it has one, is the later write and wins.
    const skip = remote.skip ?? local.skip;
    const remoteSkipReason = skip?.reason;

    const hasRemote = Object.keys(remoteHashes).length > 0;
    const remoteFailure: RemoteFailure | undefined =
      !hasRemote && remoteSkipReason ? (skip?.kind ?? 'network_error') : undefined;
    const { diffs, showLocal, showRemote } = compareSecrets(pinned, localHashes, remoteHashes);

    // ONE report object, rendered two ways. `--json` prints it, and the TTY
    // draws the same numbers below — so what a person reads and what a script
    // parses cannot describe different states. diffs carry value HASHES only
    // (sha256 prefix), never plaintext.
    const totalSecrets = new Set([...Object.keys(pinned), ...Object.keys(localHashes)]).size;
    const report = {
      projectName: keep.project_name,
      branch,
      totalSecrets,
      inSync: diffs.length === 0,
      localMatchesPinned: !showLocal,
      remoteMatchesPinned: !showRemote,
      remoteFailure: remoteFailure ?? null,
      diffs,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
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
      const { prefix, desc } = describeDiff(diff, failureLabel);
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

/** The marker and the wording for one diff row. `failureLabel` replaces both when the remote could not be read. */
function describeDiff(diff: DiffResult, failureLabel: string | undefined): { prefix: string; desc: string } {
  if (failureLabel) return { prefix: '?', desc: failureLabel };
  if (diff.type === 'new') {
    if (diff.remote && !diff.pinned) return { prefix: '+', desc: '(new on remote)' };
    if (diff.local && !diff.pinned) return { prefix: '+', desc: '(new locally)' };
    return { prefix: '+', desc: '(new)' };
  }
  if (diff.type === 'deleted') {
    if (!diff.remote && diff.pinned) return { prefix: '-', desc: '(missing from remote)' };
    if (!diff.local && diff.pinned) return { prefix: '-', desc: '(missing locally)' };
    return { prefix: '-', desc: '(missing)' };
  }
  if (diff.local !== diff.pinned && diff.remote === diff.pinned) return { prefix: '~', desc: '(changed locally)' };
  if (diff.remote !== diff.pinned && diff.local === diff.pinned) return { prefix: '~', desc: '(changed on remote)' };
  return { prefix: '~', desc: '(changed)' };
}
