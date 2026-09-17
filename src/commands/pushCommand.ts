import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { authenticatePush, verifyPushIdentity, type PushAuthPolicy } from '../auth/pushAuthentication';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { debugLine } from '../ui/debug';
import { createHash } from 'crypto';
import {
  CapyError,
  ERROR_CODES,
  setSyncKeepHash,
  getSyncKeepHash,
  type AuthResult,
  KeepFile,
} from '../types/index';
import type { KeyServiceOps } from '../crypto/keyResolver';
import { resolveConfiguredProjectKey } from '../sync/projectKeyResolver';
import { createGrantResolutionOps } from '../auth/deviceKey/grantResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { writeKeepCache, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly, resolveActiveUrl } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { pushKeepWithRetry, conflictOverwriteQuestion } from './connectors/shared';
import { assertSupportedKeepMode } from '../sync/legacyKeepMode';
import { buildPushReview, pushCompleted, pushNoop, pushReviewDecision, type PushReviewOptions, type PushReviewResult, type PushReviewScope } from '../sync/pushReview';
import { realpathSync } from 'fs';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface PushJsonReviewOptions extends PushReviewOptions {
  readonly expectedUserId: string;
  readonly serviceOrigin: string;
}

type PushReviewExecution = PushReviewOptions & PushReviewScope;

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new CapyError('A valid service origin is required for a reviewed push.', 'PUSH_REVIEW_ARGUMENT_INVALID');
  }
}

export class PushCommand {
  constructor(
    private readonly devMode: boolean = false,
    private readonly projectManager: ProjectManager = new ProjectManager(),
    private readonly fileManager: FileManager = new FileManager(),
    private readonly authService: AuthService = new AuthService(undefined, devMode),
    private readonly serviceClient: ServiceClient = new ServiceClient(undefined, devMode),
  ) {
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

  async execute(options: PushAuthPolicy = {}): Promise<void> {
    const authPolicy = { ...options, nonInteractive: options.nonInteractive === true || !process.stdin.isTTY };
    try {
      await this._execute(undefined, authPolicy);
    } catch (error: unknown) {
      this.debugError('push execute caught', error);
      if (authPolicy.nonInteractive) throw error;
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /**
   * The noninteractive agent surface. A plan hash binds the reviewed target
   * and values; it does not itself represent a human approval. The hosted
   * bridge owns that consent before it returns an exact `--confirm` value.
   */
  async executeJsonReview(options: PushJsonReviewOptions): Promise<PushReviewResult> {
    if (isLocalOnly()) {
      throw new CapyError('A reviewed push requires a connected CLI account.', ERROR_CODES.AUTH_FAILED);
    }
    const authPolicy = { nonInteractive: true, expectedUserId: options.expectedUserId } as const;
    const authenticated = await authenticatePush(this.authService, undefined, authPolicy);
    const activeOrigin = normalizedOrigin(resolveActiveUrl(this.devMode));
    if (normalizedOrigin(options.serviceOrigin) !== activeOrigin) {
      throw new CapyError('The reviewed push origin does not match this CLI environment.', 'PUSH_ENVIRONMENT_MISMATCH');
    }
    const review: PushReviewExecution = {
      repository: realpathSync(process.cwd()),
      serviceOrigin: activeOrigin,
      plan: options.plan,
      confirm: options.confirm,
    };
    const result = await this._execute(authenticated, authPolicy, review);
    if (result) return result;
    throw new CapyError('Reviewed push completed without a structured result.', ERROR_CODES.SERVICE_ERROR);
  }

  private async resolvePushIdentity(input: {
    readonly localMode: boolean;
    readonly organizationId: string;
    readonly projectId: string;
    readonly projectUserId?: string;
    readonly authResult?: AuthResult;
    readonly authPolicy?: PushAuthPolicy;
  }): Promise<{ readonly userId: string; readonly encryptionKey: string }> {
    if (input.localMode) {
      return {
        userId: LOCAL_USER_ID,
        encryptionKey: await resolveLocalProjectKey(input.projectId),
      };
    }
    const policy = input.authPolicy ?? {};
    const expectedUser = policy.expectedUserId ?? input.projectUserId;
    if (expectedUser) this.authService.setSessionUserId(expectedUser);
    const spinner = policy.nonInteractive ? null : ora('Authenticating...').start();
    const authResult = await (async () => {
      try {
        return verifyPushIdentity(input.authResult ?? await authenticatePush(this.authService, input.organizationId, policy), policy);
      } finally {
        spinner?.stop();
      }
    })();
    this.debug('authResult', {
      success: authResult.success,
      user_id: authResult.user_id,
      _auth_method: authResult._auth_method,
    });
    if (!authResult.success || !authResult.user_id) {
      spinner?.fail('Authentication failed');
      throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
    }
    const keyOps: KeyServiceOps = {
      coDecrypt: (oid, ct) => this.serviceClient.coDecrypt(oid, ct).then((result) => result.plaintext),
      wrapOuterLayer: (oid, pt) => this.serviceClient.wrapOuterLayer(oid, pt).then((result) => result.ciphertext),
    };
    return {
      userId: authResult.user_id,
      // Paid push shares pairing custody with setup and sync. The existing
      // resolver preserves legacy unpaired behavior and fails closed when a
      // configured runtime grant is unavailable; local-only mode exits above.
      encryptionKey: await resolveConfiguredProjectKey(
        input.organizationId, input.projectId, authResult.user_id, keyOps,
        createGrantResolutionOps(this.serviceClient, this.authService),
      ),
    };
  }

  private async _execute(
    preauthenticated?: AuthResult,
    authPolicy: PushAuthPolicy = {},
    reviewOptions?: PushReviewExecution,
  ): Promise<PushReviewResult | void> {
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
      assertSupportedKeepMode(this.projectManager.readSyncState());
      // THROW, never console.error + process.exit. `execute()`'s catch routes to
      // `displayErrorAndExit`, which serves the command-error page under `--web`.
      // `push` takes no `web` option and needs none: that function reads web mode
      // itself. Exiting here never threw, so the catch never ran and a --web
      // caller got a refusal on a stream with nobody on the other end.
      throw new CapyError(
        `No keep.lock file found. Run ${B('capy')} first to initialize.`,
        ERROR_CODES.PROJECT_NOT_INITIALIZED,
      );
    }

    // Local-only mode: no auth, no server push. `capy push` becomes a local
    // commit — the local writes below ARE the commit. serviceClient is unused.
    const localMode = isLocalOnly();

    const identity = await this.resolvePushIdentity({
      localMode,
      organizationId: projectState.organizationId!,
      projectId: projectState.projectId!,
      projectUserId: projectState.userId,
      authResult: preauthenticated,
      authPolicy,
    });
    const { userId, encryptionKey } = identity;
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
      // THROW, never console.error + process.exit. `execute()`'s catch routes to
      // `displayErrorAndExit`, which serves the command-error page under `--web`.
      // `push` takes no `web` option and needs none: that function reads web mode
      // itself. Exiting here never threw, so the catch never ran and a --web
      // caller got a refusal on a stream with nobody on the other end.
      throw new CapyError('No keep.lock file found.', ERROR_CODES.NO_KEEP_FILE);
    }

    const branch = projectState.activeBranch;
    this.debug('active branch', branch);
    if (!branch) {
      if (reviewOptions) {
        throw new CapyError('The reviewed push target has no active branch.', ERROR_CODES.SYNC_CONFLICT);
      }
      console.error('No active branch. Run capy to select a branch before pushing.');
      process.exit(1);
    }

    // Read and encrypt .env file
    const pushSpinner = reviewOptions ? null : ora(localMode ? 'Storing secrets locally...' : 'Pushing secrets to Keep...').start();

    const rawLocal = this.fileManager.readEnvFile();
    this.debug('.env raw keys', Object.keys(rawLocal));
    const baseKeepHash = getSyncKeepHash(this.projectManager.readSyncState(), branch);
    const reviewInput = reviewOptions ? {
      ...reviewOptions,
      mode: localMode ? 'local_only' as const : 'paid_merge' as const,
      userId,
      organizationId: projectState.organizationId!,
      projectId: projectState.projectId!,
      branch,
      keep,
      baseKeepHash,
      localRaw: rawLocal,
      projectKey: encryptionKey,
    } : null;
    const review = reviewInput ? buildPushReview(reviewInput) : null;
    const reviewDecision = review && reviewOptions ? pushReviewDecision(review, reviewOptions) : null;
    if (reviewDecision) return reviewDecision;
    if (Object.keys(rawLocal).length === 0) {
      if (review) return pushNoop(review);
      pushSpinner?.fail('No .env file to push');
      return;
    }

    // Encrypt all values
    const { Encryptor } = await import('../crypto/encryptor');
    const encrypted = Object.fromEntries(
      Object.entries(rawLocal).map(([key, value]) => {
        if (value.startsWith('capy:')) {
          this.debug(`${key}: already encrypted, passing through`);
          return [key, value] as const;
        }
        const enc = Encryptor.encrypt(value, encryptionKey);
        const resourceId = deriveResourceId(branch, key);
        this.debug(`${key}: encrypted`, { resourceId, encLength: enc.length });
        return [key, `capy:${resourceId}:${enc}`] as const;
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
        return [key, {
          resource_id: deriveResourceId(branch, key),
          value_hash: createHash('sha256').update(plaintext).digest('hex').slice(0, 16),
        }] as const;
      }),
    );
    this.debug('pushedVars', { names: Object.keys(pushedVars), count: Object.keys(pushedVars).length });

    const syncEngine = new SyncEngine();
    const buildUpdatedKeep = (base: KeepFile): KeepFile => syncEngine.mergeWithKeep(base, pushedVars, branch);

    const assertReviewedTargetUnchanged = async (): Promise<void> => {
      if (!review || !reviewInput) return;
      const currentProject = await this.projectManager.detectProjectState();
      const currentKeep = this.projectManager.readKeepFile();
      const currentBaseKeepHash = getSyncKeepHash(this.projectManager.readSyncState(), branch);
      if (!currentProject.initialized || currentProject.organizationId !== projectState.organizationId
        || currentProject.projectId !== projectState.projectId || currentProject.activeBranch !== branch
        || currentProject.userId !== userId || !currentKeep) {
        throw new CapyError('The reviewed push target changed before submission.', ERROR_CODES.SYNC_CONFLICT);
      }
      const currentReview = buildPushReview({
        ...reviewInput,
        keep: currentKeep,
        baseKeepHash: currentBaseKeepHash,
        localRaw: this.fileManager.readEnvFile(),
      });
      if (currentReview.plan_hash !== review.plan_hash) {
        throw new CapyError('The reviewed push changed before submission.', ERROR_CODES.SYNC_CONFLICT);
      }
    };

    // Push to Keep. `baseKeepHash` is this branch's last-known keep_hash
    // (sync-state, when this machine has recorded one) — the CAS
    // precondition (single-user lock-less mode). On a 409 STALE_KEEP_HASH
    // the retry rebases onto the server's current keep_file and pushes
    // again. `capy push` has no `--web`/non-interactive mode of its own, so
    // a same-key conflict — one of THIS push's own vars changed server-side
    // since sync-state was last updated — gets the same TTY inquirer confirm
    // `capy add` uses (message + context lines); off a TTY it refuses rather
    // than clobbering it. The spinner is paused for the question and resumed
    // only if the answer is yes — the throw path below leaves it stopped.
    this.debug('pushSecrets request', {
      projectId: projectState.projectId,
      branch,
      envBlobLength: envBlob.length,
    });
    const confirmOverwrite = async (changedNames: string[], contextLines: string[]): Promise<boolean> => {
      if (authPolicy.nonInteractive || !process.stdin.isTTY) return false;
      pushSpinner?.stop();
      for (const line of contextLines) console.log(line);
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'ok',
          message: conflictOverwriteQuestion(changedNames),
          default: false,
        },
      ]);
      if (ok) pushSpinner?.start();
      return ok;
    };
    await assertReviewedTargetUnchanged();
    const pushOutcome = localMode
      ? { result: null, finalKeep: buildUpdatedKeep(keep), pushedEnvBlob: envBlob }
      : await pushKeepWithRetry({
          serviceClient: this.serviceClient,
          projectId: projectState.projectId!,
          branch,
          baseKeep: keep,
          baseHash: baseKeepHash,
          buildEnvBlob: (extraLines) => (extraLines.length > 0 ? [envBlob, ...extraLines].join('\n') : envBlob),
          localVarNames: Object.keys(rawLocal),
          buildFinalKeep: buildUpdatedKeep,
          primaryVarNames: Object.keys(rawLocal),
          confirmOverwrite,
          beforePush: review ? assertReviewedTargetUnchanged : undefined,
          maxRetries: review ? 0 : undefined,
        }).then((result) => ({ result, finalKeep: result.finalKeep, pushedEnvBlob: result.envBlob }));
    const { result: pushResult, finalKeep, pushedEnvBlob } = pushOutcome;
    // keep_hash is computed locally from what was actually pushed (after any
    // CAS rebase); the server returns the same value on a push. In
    // local-only mode there is no push.
    const localKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
    const cacheKeepHash = pushResult ? pushResult.keep_hash : localKeepHash;
    this.debug('push complete', { localMode, cacheKeepHash });
    await assertReviewedTargetUnchanged();

    // Cache encrypted blob locally
    writeKeepCache(
      projectState.organizationId!,
      projectState.projectId!,
      cacheKeepHash,
      pushedEnvBlob,
    );
    this.debug('keep cache written');

    // Update keep.lock with new state, preferring the server's copy (it
    // carries server-assigned changed_at timestamps)
    this.fileManager.writeKeepFile(SyncEngine.adoptServerKeep(pushResult?.keep_file, finalKeep, branch));
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

    pushSpinner?.succeed(
      localMode
        ? `Stored ${Object.keys(rawLocal).length} secret(s) locally (local-only mode)`
        : `Pushed ${Object.keys(rawLocal).length} secret(s) to Keep`
    );

    // The push is only visible to teammates' pins once keep.lock is in git.
    const { autoCommitKeep } = await import('../git/autoCommitKeep');
    if (review) autoCommitKeep(branch, undefined, () => undefined);
    else autoCommitKeep(branch);

    if (!review) {
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    }
    if (review) return pushCompleted(review);
  }
}
