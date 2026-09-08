import { CapyError, ERROR_CODES, getSyncKeepHash, type AuthResult, type KeepFile, type SyncState } from '../types/index';
import { SyncEngine } from '../sync/syncEngine';
import { findUncommittedEnvChange, syncAndWriteBranch, type BranchSyncOutcome } from './checkoutCommand';
import { requireListIdentity } from './listMetadata';
import type { ServiceClient } from '../service/serviceClient';
import type { FileManager } from '../files/fileManager';

export interface CheckoutJsonOptions {
  readonly expectedUserId?: string;
  readonly expectedOrgId?: string;
  readonly expectedProjectId?: string;
  readonly nonTty?: boolean;
  readonly create?: boolean;
  readonly refresh?: boolean;
  readonly protected?: boolean;
}
export interface CheckoutJsonDeps {
  readonly readKeep: () => KeepFile | null;
  readonly activeBranch: () => string | null;
  readonly envBranch: () => string | undefined;
  readonly syncState: () => SyncState | null;
  readonly authenticate: (orgId?: string) => Promise<AuthResult>;
  readonly branches: (projectId: string) => Promise<readonly { readonly name: string }[]>;
  readonly resolveKey: (keep: KeepFile, userId: string) => Promise<string>;
  readonly localValues: (key: string) => Record<string, string>;
  readonly apply: (keep: KeepFile, branch: string, key: string, recheck: () => void) => Promise<BranchSyncOutcome>;
}

/** Existing-branch switch only: no creation, refresh override, browser or auth fallback. */
export async function checkoutJson(branch: string, options: CheckoutJsonOptions, deps: CheckoutJsonDeps) {
  const refuse = (code: string, message: string) => ({ ok: false as const, code, message });
  if (!branch || branch.includes('\0') || options.create || options.refresh || options.protected !== undefined) {
    return refuse('CHECKOUT_OPTIONS_UNSUPPORTED', 'This non-interactive path switches an existing branch only. Creation and refresh require their own reviewed operation.');
  }
  if (options.nonTty && (!options.expectedUserId || !options.expectedOrgId || !options.expectedProjectId)) {
    return refuse('CHECKOUT_TARGET_REQUIRED', 'The hosted command must identify the expected account, organization and project.');
  }
  try {
    const keep = deps.readKeep();
    if (!keep?.project_id || !keep.org_id) return refuse('NO_KEEP_FILE', 'This repository has no keep.lock project binding. Complete project setup before switching branches.');
    if ((options.expectedProjectId && keep.project_id !== options.expectedProjectId)
      || (options.expectedOrgId && keep.org_id !== options.expectedOrgId)) {
      return refuse('CHECKOUT_PROJECT_MISMATCH', 'This repository is bound to a different organization or project. Run the command in the intended repository.');
    }
    const auth = await requireListIdentity(deps, options.expectedUserId, keep.org_id);
    if (auth.organization_id !== keep.org_id) return refuse('CHECKOUT_ORG_MISMATCH', 'The active session does not match this repository organization.');
    if (!(await deps.branches(keep.project_id)).some((candidate) => candidate.name === branch)) {
      return refuse('BRANCH_NOT_FOUND', 'That branch does not exist in this project. Select an existing branch.');
    }
    const key = await deps.resolveKey(keep, auth.user_id!);
    const active = deps.activeBranch();
    const header = deps.envBranch();
    const dirtyBranch = header || active;
    if (!dirtyBranch) return refuse('BRANCH_NOT_FOUND', 'The local branch is unknown. Restore the repository state before switching.');
    const keepBytes = JSON.stringify(keep);
    const syncBytes = JSON.stringify(deps.syncState());
    const recheck = () => {
      if (JSON.stringify(deps.readKeep()) !== keepBytes || deps.activeBranch() !== active
        || deps.envBranch() !== header || JSON.stringify(deps.syncState()) !== syncBytes) {
        throw new CapyError('Repository state changed during checkout.', ERROR_CODES.SYNC_CONFLICT);
      }
      const savedHash = getSyncKeepHash(deps.syncState(), dirtyBranch);
      if (savedHash != null && savedHash !== SyncEngine.computeKeepHash(keep, dirtyBranch)) {
        throw new CapyError('keep.lock changed outside Capy.', ERROR_CODES.STALE_KEEP_HASH);
      }
      // Unreadable ciphertext is a refusal, never permission to discard local changes.
      if (findUncommittedEnvChange(deps.localValues(key), keep.variables, dirtyBranch) !== null) {
        throw new CapyError('Local environment changes must be resolved first.', ERROR_CODES.SYNC_CONFLICT);
      }
    };
    recheck();
    const outcome = await deps.apply(keep, branch, key, recheck);
    if (outcome.kind === 'forbidden') return refuse('PERMISSION_DENIED', 'This account cannot access that branch. Nothing was switched.');
    if (outcome.kind !== 'ok') return refuse('BRANCH_SWITCH_FAILED', 'The branch switch could not complete. Inspect repository status before retrying.');
    return { ok: true as const, code: 'BRANCH_SWITCHED', project_id: keep.project_id, branch, variable_count: outcome.varCount };
  } catch (error: unknown) {
    return refuse(error instanceof CapyError ? error.code : 'BRANCH_SWITCH_FAILED',
      'Checkout stopped. Verify the matching session, existing device access and local repository state before retrying.');
  }
}

/** Bind a fetched snapshot to its target before the shared writer touches any files. */
export function guardedCheckoutSnapshot(
  service: Pick<ServiceClient, 'getDecryptData'>,
  files: Pick<FileManager, 'parseEnvContent' | 'decryptValue'>,
  keep: KeepFile,
  key: string,
  recheck: () => void,
): ServiceClient['getDecryptData'] {
  return async (...args) => {
    const [projectId, branch] = args;
    if (projectId !== keep.project_id || !branch) throw new CapyError('Invalid checkout target.', ERROR_CODES.PERMISSION_DENIED);
    const snapshot = await service.getDecryptData(...args).catch((error: unknown) => {
      recheck();
      // ServiceClient already returns ordinary empty branches as successful
      // snapshots. A propagated 404 is a missing target, never permission to
      // invoke the legacy writer's empty-branch fallback.
      if (error instanceof CapyError && error.details?.status === 404) {
        throw new CapyError('The requested snapshot is unavailable.', error.code);
      }
      throw error;
    });
    const remote: KeepFile = snapshot.keep_file ? JSON.parse(snapshot.keep_file) : keep;
    if (remote.org_id !== keep.org_id || remote.project_id !== keep.project_id) {
      throw new CapyError('Remote project mismatch.', ERROR_CODES.PERMISSION_DENIED);
    }
    const expectedHeader: Readonly<Record<string, string>> = { org_id: keep.org_id, project_id: keep.project_id, branch };
    if ([...snapshot.env_content.matchAll(/^# capy:(org_id|project_id|branch)=(.*)$/gm)]
      .some((match) => match[2]?.trimEnd() !== expectedHeader[match[1]!])) {
      throw new CapyError('Remote branch metadata mismatch.', ERROR_CODES.PERMISSION_DENIED);
    }
    const values = Object.fromEntries(Object.entries(files.parseEnvContent(snapshot.env_content)).map(([name, value]) => {
      // The legacy decoder returns malformed short capy: envelopes unchanged.
      // Never reinterpret one as legitimate plaintext and re-encrypt it.
      if (value.startsWith('capy:') && !/^capy:[^:]+:.+$/.test(value)) {
        throw new CapyError('Invalid encrypted envelope.', ERROR_CODES.INVALID_FORMAT);
      }
      return [name, files.decryptValue(value, key)];
    }));
    if (findUncommittedEnvChange(values, remote.variables, branch) !== null) {
      throw new CapyError('Snapshot values do not match the target branch pins.', ERROR_CODES.INVALID_FORMAT);
    }
    recheck();
    return snapshot;
  };
}

export async function runCheckoutJsonCommand(branch: string, options: CheckoutJsonOptions, devMode = false): Promise<number> {
  const { ProjectManager } = await import('../core/projectManager');
  const { FileManager } = await import('../files/fileManager');
  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveStatusProjectKey } = await import('./statusKey');
  const pm = new ProjectManager();
  const fm = new FileManager();
  const auth = new AuthService(undefined, devMode, options.expectedUserId);
  const service = new ServiceClient(undefined, devMode);
  service.setTokenProvider(() => auth.getValidToken());
  const outcome = await checkoutJson(branch, options, {
    readKeep: () => pm.readKeepFile(), activeBranch: () => pm.readActiveBranch(), envBranch: () => fm.readEnvMeta().branch,
    syncState: () => pm.readSyncState(), authenticate: (orgId) => auth.authenticateSilent(orgId),
    branches: (projectId) => service.listBranches(projectId),
    resolveKey: (keep, userId) => resolveStatusProjectKey(keep.org_id, keep.project_id, userId, service, auth),
    localValues: (key) => fm.readEncryptedEnvFile(key),
    apply: async (keep, target, key, recheck) => syncAndWriteBranch({ projectManager: pm, fileManager: fm,
      serviceClient: { getDecryptData: guardedCheckoutSnapshot(service, fm, keep, key, recheck) },
    }, keep.project_id, target, key, false),
  });
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}
