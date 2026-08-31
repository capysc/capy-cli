/**
 * `capy sync --json` — docs/cli-setup-json.md. JSON-mode sync for either an
 * existing paid/project-aware keep.lock or the free account's authoritative
 * remote default project. It is the counterpart to `capy setup --json`'s
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
 * Paid/project-aware sync stays deliberately conservative: any local `.env`
 * value that disagrees with Keep refuses `SYNC_CONFLICT`. Free sync uses its
 * simpler contract: pull means replace local with remote, and no local
 * keep.lock is created. Billing — never file presence — selects the mode.
 */
import { existsSync } from 'fs';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { installGitHooks } from '../git/installGitHooks';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { resolveBranchFromLocalState, branchesFromKeep } from '../core/branchResolver';
import { writeKeepCache } from '../config/globalConfig';
import { resolveBillingSyncAuthority } from '../sync/billingSyncAuthority';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { AuthResult, CapyError, ERROR_CODES, KeepFile, ProjectState, setSyncKeepHash } from '../types/index';

export interface SyncCommandOptions {
  readonly envPath?: string;
}

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

interface FreeSyncContext {
  readonly authResult: AuthResult;
  readonly org: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string; readonly organization_id: string };
}

export class SyncCommand {
  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly devMode: boolean;
  private readonly cliOptions: { readonly envPath?: string };

  constructor(cliOptions: { readonly envPath?: string } = {}, devMode: boolean = false) {
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

  async execute(): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      try {
        await this.syncFreeWithoutLocalKeep();
      } catch (err) {
        refuse(codeOf(err), detailOf(err));
      }
      return;
    }

    try {
      await this.sync(projectState);
    } catch (err) {
      refuse(codeOf(err), detailOf(err));
    }
  }

  /**
   * Resolve the free personal-environment identity without treating the
   * absence of keep.lock as evidence of entitlement. Billing is queried
   * first and is the only mode authority; paid accounts retain the existing
   * manifest-initialization refusal below.
   */
  private async resolveFreeContext(): Promise<FreeSyncContext | null> {
    const syncState = this.projectManager.readSyncState();
    const envMeta = this.fileManager.readEnvMeta(this.cliOptions.envPath);
    const orgHint = syncState?.org_id ?? envMeta.org_id;
    if (syncState?.user_id) this.authService.setSessionUserId(syncState.user_id);

    const authResult = await this.authService.authenticateSilent(orgHint);
    if (!authResult.success || !authResult.user_id) {
      throw new CapyError(authResult.error ?? 'no valid session on this machine', ERROR_CODES.AUTH_FAILED);
    }

    const billing = await this.serviceClient.getBillingStatus();
    if (billing.tier === 'business' || billing.grandfathered) return null;

    const orgId = orgHint
      ?? authResult.organization_id
      ?? (authResult.organizations?.length === 1 ? authResult.organizations[0]?.id : undefined);
    if (!orgId) {
      throw new CapyError('could not determine the active organization for free sync', ERROR_CODES.ORG_AMBIGUOUS);
    }

    const projects = await this.serviceClient.listProjects();
    const project = projects.find((candidate) => candidate.organization_id === orgId && candidate.name === 'default');
    if (!project) {
      throw new CapyError(
        'free sync requires the server-provisioned default project; run capy setup --json',
        ERROR_CODES.PROJECT_NOT_FOUND,
      );
    }

    const authority = resolveBillingSyncAuthority(billing, orgId, project, SyncEngine.DEFAULT_BRANCH);
    if (authority.mode !== 'free') return null;
    const orgName = authResult.organizations?.find((candidate) => candidate.id === orgId)?.name ?? orgId;
    return { authResult, org: { id: orgId, name: orgName }, project };
  }

  /**
   * Free default-project pull. The remote keep is authoritative, but remains
   * remote: this replaces local `.env` and runtime metadata without ever
   * creating a local keep.lock or a second conflict corpus.
   */
  private async syncFreeWithoutLocalKeep(): Promise<void> {
    const context = await this.resolveFreeContext();
    if (!context) {
      refuse(ERROR_CODES.SYNC_NOT_INITIALIZED, 'no keep.lock in this directory', { remedy: 'capy setup --json' });
      return;
    }

    const { authResult, org, project } = context;
    const branch = SyncEngine.DEFAULT_BRANCH;
    const encryptionKey = await resolveProjectKey(org.id, project.id, authResult.user_id!, this.keyServiceOps());
    const decryptData = await this.serviceClient.getDecryptData(project.id, branch, undefined, true);
    if (!decryptData.keep_file) {
      refuse(
        ERROR_CODES.SYNC_NOT_INITIALIZED,
        'the default project has not completed its first sync',
        { remedy: 'capy setup --json' },
      );
      return;
    }

    const remoteKeep: KeepFile = {
      ...(JSON.parse(decryptData.keep_file) as KeepFile),
      org_id: org.id,
      project_id: project.id,
      project_name: project.name,
    };
    const remotePlaintext = Object.fromEntries(
      Object.entries(this.fileManager.parseEnvContent(decryptData.env_content ?? ''))
        .flatMap(([name, value]) => {
          try {
            return [[name, this.fileManager.decryptValue(value, encryptionKey)] as const];
          } catch {
            return [];
          }
        }),
    );
    const keepHash = SyncEngine.computeKeepHash(remoteKeep, branch);

    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();
    this.fileManager.writeEncryptedEnvFile(remotePlaintext, encryptionKey, this.cliOptions.envPath, remoteKeep, branch);
    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(remotePlaintext),
      user_id: authResult.user_id,
      org_id: org.id,
      project_id: project.id,
      project_name: project.name,
      sync_mode: 'free',
      keep_hash: setSyncKeepHash(this.projectManager.readSyncState(), branch, keepHash),
    });
    writeKeepCache(org.id, project.id, keepHash, decryptData.env_content ?? '');
    installGitHooks(this.devMode);

    printResult({
      ok: true,
      action: 'sync',
      sync_mode: 'free',
      sync_action: 'fetch_remote',
      org,
      project: { id: project.id, name: project.name },
      branch,
      keep_lock_path: null,
      pulled_variables: Object.keys(remotePlaintext).length,
      local_drift_resolved: 0,
    });
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
      if (local.rebuildBranchFile) this.projectManager.writeActiveBranch(local.branch);
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
        this.projectManager.writeActiveBranch(local.envBranch);
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
      this.projectManager.writeActiveBranch(pinned[0]!);
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

  private async sync(projectState: ProjectState): Promise<void> {
    const branchResolution = await this.resolveActiveBranch(projectState);
    if (!branchResolution.ok) {
      refuse(branchResolution.code, branchResolution.detail, {}, branchResolution.needsInput ? EXIT_NEEDS_INPUT : 1);
      return;
    }
    const branch = branchResolution.branch;

    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }
    const authResult = await this.authService.authenticateSilent(projectState.organizationId);
    if (!authResult.success || !authResult.user_id) {
      refuse(ERROR_CODES.AUTH_FAILED, authResult.error ?? 'no valid session on this machine');
      return;
    }

    const orgId = projectState.organizationId!;
    const projectId = projectState.projectId!;
    const orgName = authResult.organizations?.find((o) => o.id === orgId)?.name ?? orgId;

    const encryptionKey = await resolveProjectKey(orgId, projectId, authResult.user_id, this.keyServiceOps());
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
      refuse(
        ERROR_CODES.SYNC_CONFLICT,
        'local .env holds values that differ from Keep — resolve interactively (capy) or push explicitly (capy push)',
        { names: drift },
        EXIT_NEEDS_INPUT,
      );
      return;
    }

    this.fileManager.writeKeepFile(serverKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();
    this.fileManager.writeEncryptedEnvFile(serverPlaintext, encryptionKey, this.cliOptions.envPath, serverKeep, branch);
    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(serverPlaintext),
      user_id: authResult.user_id,
      keep_hash: setSyncKeepHash(this.projectManager.readSyncState(), branch, SyncEngine.computeKeepHash(serverKeep, branch)),
    });
    installGitHooks(this.devMode);

    printResult({
      ok: true,
      action: 'sync',
      org: { id: orgId, name: orgName },
      project: { id: projectId, name: projectState.projectName ?? '' },
      branch,
      pulled_variables: Object.keys(serverPlaintext).length,
      local_drift_resolved: 0,
    });
  }
}
