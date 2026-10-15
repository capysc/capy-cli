import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { commitFolder, localChanges, pinnedHashes } from '../sync/commit';
import { debugLine } from '../ui/debug';
import { CapyError, ERROR_CODES } from '../types/index';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { reportRepoLinkForCommand } from '../core/repoLinkReporter';

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
    debugLine(`push: ${msg}`, data);
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

  async execute(): Promise<void> {
    try {
      await this._execute();
    } catch (error: any) {
      this.debugError('push execute caught', error);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
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

      // Authenticate — try silent first (scoped, then any session), then interactive.
      const spinner = ora('Authenticating...').start();
      const authResult = await (async () => {
        const scoped = await this.authService.authenticateSilent(projectState.organizationId);
        if (scoped.success) return scoped;
        const anySession = await this.authService.authenticateSilent();
        if (anySession.success) return anySession;
        return this.authService.authenticate(projectState.organizationId);
      })();
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

    // CAP-697: report which repo/folder holds this keep.lock (never blocks past its budget).
    if (!localMode) {
      await reportRepoLinkForCommand({
        cwd: process.cwd(),
        orgId: projectState.organizationId!,
        projectId: projectState.projectId!,
        projectName: keep.project_name,
        client: this.serviceClient,
      });
    }

    const pushSpinner = ora(localMode ? 'Storing secrets locally...' : 'Pushing secrets to Keep...').start();

    const rawLocal = this.fileManager.readEnvFile();
    this.debug('.env raw keys', Object.keys(rawLocal));
    if (Object.keys(rawLocal).length === 0) {
      pushSpinner.fail('No .env file to push');
      return;
    }

    // What this folder has to commit is what it CHANGED: a value that differs from the one
    // keep.lock pins (an edit, or a new name). Values it merely still holds from an older
    // sync are not pushed, so a stale folder cannot revert what someone else saved since.
    const localPlaintext = Object.fromEntries(
      Object.entries(rawLocal).map(([key, value]) => [key, value.startsWith('capy:') ? this.fileManager.decryptValue(value, encryptionKey) : value]),
    );
    const changes = localChanges(localPlaintext, pinnedHashes(keep, branch), { removals: false });
    this.debug('local edits', Object.keys(changes.set));

    const committed = await commitFolder(
      {
        pm: this.projectManager,
        fileManager: this.fileManager,
        serviceClient: localMode ? undefined : this.serviceClient,
        orgId: projectState.organizationId!,
        projectId: projectState.projectId!,
        branch,
        userId,
        projectKey: encryptionKey,
        keep,
        localPlaintext,
      },
      changes,
    );
    this.debug('push complete', { localMode, uploaded: committed.uploaded, written: committed.written });

    const count = Object.keys(changes.set).length;
    pushSpinner.succeed(
      localMode
        ? `Stored ${count} secret(s) locally (local-only mode)`
        : `Pushed ${count} secret(s) to Keep`
    );

    const { printExpiryWarnings } = await import('./connectors/shared');
    printExpiryWarnings();
  }
}
