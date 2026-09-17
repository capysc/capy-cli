/**
 * `capy sync --json` — docs/cli-setup-json.md. JSON-mode sync for either an
 * existing Keep project. It is the counterpart to `capy setup --json`'s
 * first-sync plan/confirm. No TTY, no browser, no `human()`.
 *
 * NOT a root `--json` flag on bare `capy`, despite `docs/cli-setup-json.md`'s
 * original design: Commander 11 (this CLI's version, `package.json`)
 * attributes a flag declared on BOTH a parent command and one of its
 * children to neither reliably — verified with a minimal repro against this
 * exact commander version, and confirmed for real by `capy --json` silently
 * emptying `flowCancelCommand`'s own `--json` handling in the full test
 * suite the moment a root-level `--json` was added. Fifteen existing
 * subcommands (`status`, `branch`, `deploy`, `flow cancel`, ...) already
 * declare their own local `--json`; making the root `capy` itself carry one
 * is incompatible with that many existing, tested, additive-only surfaces.
 * `capy sync --json` gets the identical JSON contract as its own new,
 * uncontested subcommand instead — see the spec doc's amendment note.
 *
 * Sync stays deliberately conservative: any local `.env` value that disagrees
 * with Keep refuses `SYNC_CONFLICT`.
 */
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { resolveActiveUrl } from '../config/profileConfig';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { installGitHooks } from '../git/installGitHooks';
import type { KeyServiceOps } from '../crypto/keyResolver';
import { resolveBranchFromLocalState, branchesFromKeep } from '../core/branchResolver';
import { writeKeepCache } from '../config/globalConfig';
import { resolveConfiguredProjectKey } from '../sync/projectKeyResolver';
import { createGrantResolutionOps } from '../auth/deviceKey/grantResolver';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { assertSupportedKeepMode } from '../sync/legacyKeepMode';
import { CapyError, ERROR_CODES, KeepFile, ProjectState, setSyncKeepHash } from '../types/index';

export interface SyncCommandOptions {
  readonly envPath?: string;
  readonly org?: string;
  readonly project?: string;
  readonly expectedUserId?: string;
}
export interface SyncConsentOptions { readonly plan?: boolean; readonly confirm?: string }

function printResult(body: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(body, null, 2));
}

function refuse(code: string, detail: string, extra: Readonly<Record<string, unknown>> = {}, exitCode: number = 1): void {
  printResult({ ok: false, code, detail, ...extra });
  process.exitCode = exitCode;
}

function codeOf(err: unknown): string {
  return err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type BranchResolution = { readonly ok: true; readonly branch: string } | { readonly ok: false; readonly code: string; readonly detail: string; readonly needsInput?: boolean };

export class SyncCommand {
  private printResult(body: Readonly<Record<string, unknown>>): void {
    (this.reporter ?? printResult)(body);
  }

  private refuse(code: string, detail: string, extra: Readonly<Record<string, unknown>> = {}, exitCode = 1): void {
    if (!this.reporter) { refuse(code, detail, extra, exitCode); return; }
    this.reporter({ ok: false, code, detail, ...extra });
  }

  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly devMode: boolean;
  private readonly cliOptions: SyncCommandOptions;

  constructor(cliOptions: SyncCommandOptions = {}, devMode: boolean = false, private readonly reporter?: (body: Readonly<Record<string, unknown>>) => void) {
    this.cliOptions = cliOptions;
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);
    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  private keyServiceOps(): KeyServiceOps {
    return {
      coDecrypt: (orgId, ciphertext) => this.serviceClient.coDecrypt(orgId, ciphertext).then((r) => r.plaintext),
      wrapOuterLayer: (orgId, plaintext) => this.serviceClient.wrapOuterLayer(orgId, plaintext).then((r) => r.ciphertext),
    };
  }

  async execute(consent: SyncConsentOptions = {}): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      try {
        assertSupportedKeepMode(this.projectManager.readSyncState());
        this.refuse(ERROR_CODES.SYNC_NOT_INITIALIZED, 'no keep.lock in this directory', { remedy: 'capy setup --json' });
      } catch (err) {
        this.refuse(codeOf(err), detailOf(err));
      }
      return;
    }

    try {
      await this.sync(projectState, consent);
    } catch (err) {
      this.refuse(codeOf(err), detailOf(err));
    }
  }

  /**
   * Pure local read — no server call, no prompt — mirroring
   * `capyCommand.ts`'s `resolveActiveBranch` local-signal logic (same
   * `resolveBranchFromLocalState` helper) but refusing, coded, wherever the
   * TTY/`--web` path would render a question. The one exception is the
   * stale-`.capy/branch` self-heal `reconcileBranchConflict` already does
   * (an unknown branch name silently loses to the `.env` header) — kept
   * here too since it resolves the conflict rather than asking anyone
   * anything.
   */
  private async resolveActiveBranch(projectState: ProjectState): Promise<BranchResolution> {
    const envMeta = this.fileManager.readEnvMeta(this.cliOptions.envPath);
    const local = resolveBranchFromLocalState({
      envBranch: envMeta.branch,
      fileBranch: this.projectManager.readActiveBranch() ?? undefined,
    });

    if (local.kind === 'resolved') {
      return { ok: true, branch: local.branch };
    }

    if (local.kind === 'conflict') {
      const fileBranchIsReal = await (async (): Promise<boolean> => {
        try {
          const branches = await this.serviceClient.listBranches(projectState.projectId!);
          return branches.some((b) => b.name === local.fileBranch);
        } catch {
          return true; // offline — can't verify, so treat the conflict as genuine (same call `reconcileBranchConflict` makes)
        }
      })();
      if (!fileBranchIsReal) {
        return { ok: true, branch: local.envBranch };
      }
      return {
        ok: false,
        code: ERROR_CODES.CONFLICT_RESOLUTION,
        detail: `.capy/branch says ${local.fileBranch}, but .env was encrypted for ${local.envBranch} — run capy checkout <branch> to resolve`,
      };
    }

    // No local signal — keep.lock pins the branch(es) this project tracks.
    const pinned = branchesFromKeep(this.projectManager.readKeepFile());
    if (pinned.length === 1) {
      return { ok: true, branch: pinned[0]! };
    }
    return {
      ok: false,
      code: ERROR_CODES.SYNC_CONFLICT,
      detail:
        pinned.length === 0
          ? 'no branch is checked out and keep.lock names none'
          : `no branch is checked out and keep.lock pins ${pinned.length}: ${pinned.join(', ')}`,
      needsInput: true,
    };
  }

  private async sync(projectState: ProjectState, consent: SyncConsentOptions): Promise<void> {
    if ((this.cliOptions.org && this.cliOptions.org !== projectState.organizationId)
      || (this.cliOptions.project && this.cliOptions.project !== projectState.projectId)) {
      this.refuse(ERROR_CODES.PERMISSION_DENIED, 'keep.lock does not match the approved project.'); return;
    }
    const branchResolution = await this.resolveActiveBranch(projectState);
    if (!branchResolution.ok) {
      this.refuse(branchResolution.code, branchResolution.detail, {}, branchResolution.needsInput ? EXIT_NEEDS_INPUT : 1);
      return;
    }
    const branch = branchResolution.branch;

    if (this.cliOptions.expectedUserId ?? projectState.userId) {
      this.authService.setSessionUserId(this.cliOptions.expectedUserId ?? projectState.userId!);
    }
    const authResult = await this.authService.authenticateSilent(projectState.organizationId);
    if (!authResult.success || !authResult.user_id || (this.cliOptions.expectedUserId && authResult.user_id !== this.cliOptions.expectedUserId)) {
      this.refuse(ERROR_CODES.AUTH_FAILED, authResult.error ?? 'no valid session on this machine');
      return;
    }

    const orgId = projectState.organizationId!;
    const projectId = projectState.projectId!;
    const orgName = authResult.organizations?.find((o) => o.id === orgId)?.name ?? orgId;

    // Pairing custody is independent of billing mode. Use the configured
    // grant-aware resolver; only unpaired runtimes use its
    // legacy disk-key path. A missing configured grant must never fall back.
    const encryptionKey = await resolveConfiguredProjectKey(
      orgId, projectId, authResult.user_id, this.keyServiceOps(),
      createGrantResolutionOps(this.serviceClient, this.authService),
    );
    const decryptData = await this.serviceClient.getDecryptData(projectId, branch, undefined, true);

    const serverKeep: KeepFile = decryptData.keep_file
      ? { ...(JSON.parse(decryptData.keep_file) as KeepFile), org_id: orgId, project_id: projectId, project_name: projectState.projectName ?? '' }
      : { version: '3.0', org_id: orgId, project_id: projectId, project_name: projectState.projectName ?? '', variables: {} };

    const serverPlaintext: Readonly<Record<string, string>> = Object.fromEntries(
      Object.entries(this.fileManager.parseEnvContent(decryptData.env_content ?? ''))
        .flatMap(([key, value]) => {
          try {
            return [[key, this.fileManager.decryptValue(value, encryptionKey)] as const];
          } catch {
            // Not decryptable with this key (no variable-level permission) — same skip `bootstrapExistingProject` makes.
            return [];
          }
        }),
    );

    // Local drift check: anything on disk that disagrees with what Keep just
    // returned is a decision this sync has no consent gate to make blind.
    const localEnvPath = this.projectManager.getEnvPath(this.cliOptions.envPath);
    const drift: readonly string[] = existsSync(localEnvPath)
      ? Object.entries(this.fileManager.readEnvFile(this.cliOptions.envPath)).reduce<readonly string[]>((acc, [key, value]) => {
          const localPlaintext = value.startsWith('capy:')
            ? ((): string | undefined => {
                try {
                  return this.fileManager.decryptValue(value, encryptionKey);
                } catch {
                  return undefined;
                }
              })()
            : value;
          const isDrift = localPlaintext === undefined || serverPlaintext[key] !== localPlaintext;
          return isDrift ? [...acc, key] : acc;
        }, [])
      : [];
    if (drift.length > 0) {
      this.refuse(
        ERROR_CODES.SYNC_CONFLICT,
        'local .env holds values that differ from Keep — resolve interactively (capy) or push explicitly (capy push)',
        { names: drift },
        EXIT_NEEDS_INPUT,
      );
      return;
    }

    const shouldWriteLocalEnv = existsSync(localEnvPath) || Object.keys(serverPlaintext).length > 0;
    if (!this.checkConsent(consent, { org: { id: orgId, name: orgName },
      project: { id: projectId, name: projectState.projectName ?? '' }, branch,
      sync_action: 'fetch_remote', env_variable_names: Object.keys(this.fileManager.readEnvFile(this.cliOptions.envPath)),
      remote_variable_names: Object.keys(serverPlaintext), will_write: shouldWriteLocalEnv ? ['keep.lock', '.env'] : ['keep.lock'] })) return;
    this.fileManager.writeKeepFile(serverKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();
    if (shouldWriteLocalEnv) this.fileManager.writeEncryptedEnvFile(serverPlaintext, encryptionKey, this.cliOptions.envPath, serverKeep, branch);
    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(serverPlaintext),
      user_id: authResult.user_id,
      keep_hash: setSyncKeepHash(this.projectManager.readSyncState(), branch, SyncEngine.computeKeepHash(serverKeep, branch)),
    });
    installGitHooks(this.devMode);

    this.printResult({
      ok: true,
      action: 'sync',
      org: { id: orgId, name: orgName },
      project: { id: projectId, name: projectState.projectName ?? '' },
      branch,
      pulled_variables: Object.keys(serverPlaintext).length,
      local_drift_resolved: 0,
    });
  }

  /** Consent describes the existing operation; canonical sync conflict checks above remain authoritative. */
  private checkConsent(options: SyncConsentOptions, facts: Readonly<Record<string, unknown>>): boolean {
    const hash = `sha256:${createHash('sha256').update(JSON.stringify({ cwd: process.cwd(),
      env_path: resolve(this.cliOptions.envPath ?? '.env'), service: resolveActiveUrl(this.devMode), ...facts })).digest('hex')}`;
    if (options.plan) { this.printResult({ ok: true, action: 'sync', ...facts, plan_hash: hash, removed_remote_variable_names: [] }); return false; }
    if (options.confirm !== undefined && options.confirm !== hash) {
      this.refuse(ERROR_CODES.PLAN_CHANGED, 'The sync plan changed. Ask your agent to show the updated plan for approval.'); return false;
    }
    return true;
  }
}
