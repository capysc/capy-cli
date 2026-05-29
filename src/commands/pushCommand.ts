import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { createHash } from 'crypto';
import {
  CapyError,
  ERROR_CODES,
  setSyncKeepHash,
} from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { writeKeepCache, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

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
    if (!this.devMode) return;
    const ts = new Date().toISOString();
    const prefix = `\x1b[90m[debug ${ts}]\x1b[0m`;
    if (data !== undefined) {
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      console.error(`${prefix} push: ${msg} ${serialized}`);
    } else {
      console.error(`${prefix} push: ${msg}`);
    }
  }

  private debugError(label: string, err: unknown): void {
    if (!this.devMode) return;
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

  async execute(): Promise<void> {
    try {
      await this._execute();
    } catch (error: any) {
      this.debugError('push execute caught', error);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  private async _execute(): Promise<void> {
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

    let userId: string;
    let encryptionKey: string;
    if (localMode) {
      userId = LOCAL_USER_ID;
      encryptionKey = await resolveLocalProjectKey(projectState.projectId!);
    } else {
      if (projectState.userId) {
        this.authService.setSessionUserId(projectState.userId);
      }

      // Authenticate
      const spinner = ora('Authenticating...').start();
      let authResult = await this.authService.authenticateSilent(projectState.organizationId);
      if (!authResult.success) authResult = await this.authService.authenticateSilent();
      if (!authResult.success) authResult = await this.authService.authenticate(projectState.organizationId);
      this.debug('authResult', {
        success: authResult.success,
        user_id: authResult.user_id,
        _auth_method: authResult._auth_method,
      });
      if (!authResult.success) {
        spinner.fail('Authentication failed');
        throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
      }

      spinner.stop();

      const keyOps: KeyServiceOps = {
        coDecrypt: (oid, ct) => this.serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
        wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      encryptionKey = await resolveProjectKey(
        projectState.organizationId!,
        projectState.projectId!,
        authResult.user_id!,
        keyOps,
      );
      userId = authResult.user_id!;
    }
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
    const encrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawLocal)) {
      if (value.startsWith('capy:')) {
        this.debug(`${key}: already encrypted, passing through`);
        encrypted[key] = value; // Already encrypted
      } else {
        const enc = Encryptor.encrypt(value, encryptionKey);
        const resourceId = deriveResourceId(branch, key);
        encrypted[key] = `capy:${resourceId}:${enc}`;
        this.debug(`${key}: encrypted`, { resourceId, encLength: enc.length });
      }
    }

    const envBlob = Object.entries(encrypted)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    this.debug('envBlob length', envBlob.length);

    // Update keep.lock hashes for the active branch
    const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
    for (const [key, value] of Object.entries(rawLocal)) {
      const plaintext = value.startsWith('capy:')
        ? this.fileManager.decryptValue(value, encryptionKey)
        : value;
      const valueHash = createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
      const resourceId = deriveResourceId(branch, key);
      pushedVars[key] = { resource_id: resourceId, value_hash: valueHash };
    }
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
    const cacheKeepHash = localMode
      ? localKeepHash
      : (await this.serviceClient.pushSecrets(
          projectState.projectId!,
          keepFileContent,
          envBlob,
          branch,
        )).keep_hash;
    this.debug('push complete', { localMode, cacheKeepHash });

    // Cache encrypted blob locally
    writeKeepCache(
      projectState.organizationId!,
      projectState.projectId!,
      cacheKeepHash,
      envBlob,
    );
    this.debug('keep cache written');

    // Update keep.lock with new state
    this.fileManager.writeKeepFile(updatedKeep);
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
