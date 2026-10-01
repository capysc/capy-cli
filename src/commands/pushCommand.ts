import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { debugLine } from '../ui/debug';
import { createHash } from 'crypto';
import {
  CapyError,
  ERROR_CODES,
  setSyncKeepHash,
  KeepFile,
} from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { writeKeepCache, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { hashValue } from './statusCommand';
import { computePushDiff, pushPlan } from '../core/pushPlan';
import { dryRunOk, dryRunRefused, dryRunExitCode, printDryRunResultHuman, printDryRunResultJson } from '../core/dryRun';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface PushOptions {
  json?: boolean;
  dryRun?: boolean;
}

export class PushCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);

    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  private debug(msg: string, data?: unknown): void {
    debugLine(`push: ${msg}`, data);
  }

  /** Prints a `DryRunResult` on the shared printer and exits per CAP-659's rule — never returns. */
  private printDryRun(result: ReturnType<typeof dryRunRefused> | ReturnType<typeof dryRunOk>, json: boolean): never {
    if (json) printDryRunResultJson(result);
    else printDryRunResultHuman(result);
    process.exit(dryRunExitCode(result));
  }

  /**
   * `capy push --dry-run` — names that would be added/changed/removed,
   * compared against the last-known (pinned) state in keep.lock. No
   * network fetch: push only ever travels local → Keep, so the pinned
   * hashes already on disk are exactly the baseline the real push diffs
   * against (`SyncEngine.mergeWithKeep`). Never encrypts-and-writes, never
   * POSTs — reading `.env` here is only to hash it for the diff, the same
   * read `pushCommand`'s real run does before it ever reaches `Encryptor`.
   */
  private previewPush(keep: KeepFile, branch: string, encryptionKey: string, json: boolean): void {
    const pinned: Record<string, string> = {};
    for (const [varName, entries] of Object.entries(keep.variables)) {
      const entry = entries.find((e) => e.branch === branch);
      if (entry) pinned[varName] = entry.value_hash;
    }

    const rawLocal = this.fileManager.readEnvFile();
    if (Object.keys(rawLocal).length === 0) {
      // Mirrors the real run's own early-out (`pushSpinner.fail('No .env
      // file to push'); return;`): an empty `.env` pushes nothing — it does
      // NOT merge an empty set and remove every pinned variable.
      this.printDryRun(dryRunOk('push', []), json);
      return;
    }
    const localHashes = Object.fromEntries(
      Object.entries(rawLocal).map(([key, value]) => {
        const plaintext = value.startsWith('capy:') ? this.fileManager.decryptValue(value, encryptionKey) : value;
        return [key, hashValue(plaintext)];
      }),
    );

    const diffs = computePushDiff(pinned, localHashes);
    this.printDryRun(dryRunOk('push', pushPlan(diffs)), json);
  }

  private debugError(label: string, err: unknown): void {
    if (err instanceof CapyError) {
      this.debug(`${label}: CapyError`, {
        message: err.message,
        code: err.code,
        details: err.details,
        stack: err.stack,
      });
    } else if (err instanceof Error) {
      this.debug(`${label}: ${err.name}`, { message: err.message, stack: err.stack });
    } else {
      this.debug(`${label}: unknown`, String(err));
    }
  }

  async execute(options: PushOptions = {}): Promise<void> {
    try {
      await this._execute(options);
    } catch (error: any) {
      this.debugError('push execute caught', error);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  private async _execute(options: PushOptions = {}): Promise<void> {
    this.debug('starting push command');
    this.debug('cwd', process.cwd());

    const projectState = await this.projectManager.detectProjectState();
    this.debug('projectState', {
      initialized: projectState.initialized,
      organizationId: projectState.organizationId,
      projectId: projectState.projectId,
      activeBranch: projectState.activeBranch,
      userId: projectState.userId,
    });
    if (!projectState.initialized) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }

    // Local-only mode: no auth, no server push. `capy push` becomes a local
    // commit — the local writes below ARE the commit. serviceClient is unused.
    const localMode = isLocalOnly();

    const { userId, encryptionKey } = await (async (): Promise<{ userId: string; encryptionKey: string }> => {
      if (localMode) {
        return {
          userId: LOCAL_USER_ID,
          encryptionKey: await resolveLocalProjectKey(projectState.projectId!),
        };
      }

      if (projectState.userId) {
        this.authService.setSessionUserId(projectState.userId);
      }

      // Authenticate — try silent first (scoped, then any session), then
      // interactive. Under `--dry-run`, a preview never starts a new
      // sign-in (that flow is owned by `fix/auth-needs-tty`) — only the
      // silent attempts run, and a dry run with no usable session refuses
      // with the SAME code the real run would eventually give if auth
      // failed outright (AUTH_FAILED), rather than opening a browser.
      const spinner = ora('Authenticating...').start();
      const authResult = await (async () => {
        const scoped = await this.authService.authenticateSilent(projectState.organizationId);
        if (scoped.success) return scoped;
        const anySession = await this.authService.authenticateSilent();
        if (anySession.success) return anySession;
        if (options.dryRun) return anySession;
        return this.authService.authenticate(projectState.organizationId);
      })();
      this.debug('authResult', {
        success: authResult.success,
        user_id: authResult.user_id,
        _auth_method: authResult._auth_method,
      });
      if (!authResult.success) {
        spinner.fail('Authentication failed');
        if (options.dryRun) {
          this.printDryRun(dryRunRefused('push', ERROR_CODES.AUTH_FAILED), options.json === true);
        }
        throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
      }

      spinner.stop();

      const keyOps: KeyServiceOps = {
        coDecrypt: (oid, ct) => this.serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
        wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      const resolvedKey = await resolveProjectKey(
        projectState.organizationId!,
        projectState.projectId!,
        authResult.user_id!,
        keyOps,
      );
      return { userId: authResult.user_id!, encryptionKey: resolvedKey };
    })();
    this.debug('encryptionKey resolved', { length: encryptionKey.length });

    // Read keep.lock
    const keep = this.projectManager.readKeepFile();
    this.debug('keep.lock', keep ? {
      version: keep.version,
      org_id: keep.org_id,
      project_id: keep.project_id,
      variableCount: Object.keys(keep.variables).length,
      variables: Object.keys(keep.variables),
    } : 'NOT FOUND');
    if (!keep) {
      console.error('No keep.lock file found.');
      process.exit(1);
    }

    const branch = projectState.activeBranch;
    this.debug('active branch', branch);
    if (!branch) {
      console.error('No active branch. Run capy to select a branch before pushing.');
      process.exit(1);
    }

    if (options.dryRun) {
      this.previewPush(keep, branch, encryptionKey, options.json === true);
      return;
    }

    // Read and encrypt .env file
    const pushSpinner = ora(localMode ? 'Storing secrets locally...' : 'Pushing secrets to Keep...').start();

    const rawLocal = this.fileManager.readEnvFile();
    this.debug('.env raw keys', Object.keys(rawLocal));
    if (Object.keys(rawLocal).length === 0) {
      pushSpinner.fail('No .env file to push');
      return;
    }

    // Encrypt all values
    const { Encryptor } = await import('../crypto/encryptor');
    const encrypted = Object.fromEntries(
      Object.entries(rawLocal).map(([key, value]) => {
        if (value.startsWith('capy:')) {
          this.debug(`${key}: already encrypted, passing through`);
          return [key, value]; // Already encrypted
        }
        const enc = Encryptor.encrypt(value, encryptionKey);
        const resourceId = deriveResourceId(branch, key);
        this.debug(`${key}: encrypted`, { resourceId, encLength: enc.length });
        return [key, `capy:${resourceId}:${enc}`];
      }),
    );

    const envBlob = Object.entries(encrypted)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    this.debug('envBlob length', envBlob.length);

    // Update keep.lock hashes for the active branch
    const pushedVars = Object.fromEntries(
      Object.entries(rawLocal).map(([key, value]) => {
        const plaintext = value.startsWith('capy:')
          ? this.fileManager.decryptValue(value, encryptionKey)
          : value;
        const valueHash = createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
        const resourceId = deriveResourceId(branch, key);
        return [key, { resource_id: resourceId, value_hash: valueHash }];
      }),
    );
    this.debug('pushedVars', pushedVars);

    const syncEngine = new SyncEngine();
    const updatedKeep = syncEngine.mergeWithKeep(keep, pushedVars, branch);

    // Push to Keep
    const keepFileContent = JSON.stringify(updatedKeep);
    this.debug('pushSecrets request', {
      projectId: projectState.projectId,
      branch,
      keepFileLength: keepFileContent.length,
      envBlobLength: envBlob.length,
    });
    // keep_hash is computed locally; the server returns the same value on a
    // push. In local-only mode there is no push.
    const localKeepHash = SyncEngine.computeKeepHash(updatedKeep, branch);
    const pushResult = localMode
      ? null
      : await this.serviceClient.pushSecrets(
          projectState.projectId!,
          keepFileContent,
          envBlob,
          branch,
        );
    const cacheKeepHash = pushResult ? pushResult.keep_hash : localKeepHash;
    this.debug('push complete', { localMode, cacheKeepHash });

    // Cache encrypted blob locally
    writeKeepCache(
      projectState.organizationId!,
      projectState.projectId!,
      cacheKeepHash,
      envBlob,
    );
    this.debug('keep cache written');

    // Update keep.lock with new state, preferring the server's copy (it
    // carries server-assigned changed_at timestamps)
    this.fileManager.writeKeepFile(SyncEngine.adoptServerKeep(pushResult?.keep_file, updatedKeep, branch));
    this.debug('keep.lock written to disk');

    // Update sync state with keep_hash so direction detection works
    const existingSyncState = this.projectManager.readSyncState();
    this.fileManager.writeSyncState({
      ...existingSyncState,
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(rawLocal),
      user_id: userId,
      keep_hash: setSyncKeepHash(existingSyncState, branch, localKeepHash),
    });

    pushSpinner.succeed(
      localMode
        ? `Stored ${Object.keys(rawLocal).length} secret(s) locally (local-only mode)`
        : `Pushed ${Object.keys(rawLocal).length} secret(s) to Keep`
    );

    const { printExpiryWarnings } = await import('./connectors/shared');
    printExpiryWarnings();
  }
}
