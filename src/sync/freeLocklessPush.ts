/**
 * CAP-629 — explicit push for the free, manifest-less default project.
 *
 * Billing is the only authority for entering this path. Existing paid/local
 * projects return `false` before any free-project lookup or write, leaving the
 * established manifest PushCommand byte-for-byte authoritative.
 */
import { createHash } from 'crypto';
import type { ProjectManager } from '../core/projectManager';
import type { FileManager } from '../files/fileManager';
import type { AuthService } from '../auth/authService';
import type { BillingStatus, ServiceClient } from '../service/serviceClient';
import { resolveFreeSyncProjectKey } from './freeSyncKeyResolver';
import type { GrantResolutionOps } from '../auth/deviceKey/grantResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { Encryptor } from '../crypto/encryptor';
import { SyncEngine } from './syncEngine';
import { writeKeepCache } from '../config/globalConfig';
import { installGitHooks } from '../git/installGitHooks';
import { CapyError, ERROR_CODES, type KeepFile, setSyncKeepHash } from '../types/index';

export interface FreeLocklessPushPlan {
  readonly localVariableNames: readonly string[];
  readonly remoteVariableNames: readonly string[];
  readonly deletedRemoteVariableNames: readonly string[];
  readonly requiresDestructiveConfirmation: boolean;
}

function sorted(values: readonly string[]): readonly string[] {
  return values.reduce<readonly string[]>((ordered, value) => {
    const insertionIndex = ordered.findIndex((candidate) => candidate.localeCompare(value) > 0);
    return insertionIndex < 0
      ? [...ordered, value]
      : [...ordered.slice(0, insertionIndex), value, ...ordered.slice(insertionIndex)];
  }, []);
}

/**
 * Explicit free push replaces the remote development snapshot. The initial
 * product contract warns only when that replacement removes multiple values;
 * per-value conflict resolution remains intentionally out of scope.
 */
export function planFreeLocklessPush(
  localVariableNames: readonly string[],
  remoteVariableNames: readonly string[],
): FreeLocklessPushPlan {
  const local = new Set(localVariableNames);
  const deleted = remoteVariableNames.filter((name) => !local.has(name));
  return {
    localVariableNames: sorted(localVariableNames),
    remoteVariableNames: sorted(remoteVariableNames),
    deletedRemoteVariableNames: sorted(deleted),
    requiresDestructiveConfirmation: deleted.length > 1,
  };
}

export function selectFreeLocklessPushMode(input: {
  readonly initialized: boolean;
  readonly billing: BillingStatus;
}): 'existing_manifest' | 'paid_manifest_required' | 'free_lockless' {
  if (input.initialized) return 'existing_manifest';
  return input.billing.tier === 'free' && !input.billing.grandfathered
    ? 'free_lockless'
    : 'paid_manifest_required';
}

type ProjectManagerDependency = Pick<
  ProjectManager,
  'detectProjectState' | 'readSyncState' | 'writeActiveBranch'
>;
type FileManagerDependency = Pick<
  FileManager,
  | 'readEnvMeta'
  | 'readEnvFile'
  | 'decryptValue'
  | 'ensureCapyGitignore'
  | 'backupPlaintextEnv'
  | 'writeEncryptedEnvFile'
  | 'writeSyncState'
>;
type AuthServiceDependency = Pick<AuthService, 'setSessionUserId' | 'authenticateSilent' | 'getValidToken'>;
type ServiceClientDependency = Pick<
  ServiceClient,
  | 'getBillingStatus'
  | 'listProjects'
  | 'getDecryptData'
  | 'pushSecrets'
  | 'coDecrypt'
  | 'wrapOuterLayer'
>;

export interface FreeLocklessPushDependencies {
  readonly projectManager: ProjectManagerDependency;
  readonly fileManager: FileManagerDependency;
  readonly authService: AuthServiceDependency;
  readonly serviceClient: ServiceClientDependency;
  readonly devMode: boolean;
  readonly confirmDestructivePush?: (plan: FreeLocklessPushPlan) => Promise<boolean>;
  readonly resolveProjectKey?: typeof resolveFreeSyncProjectKey;
  readonly grantResolutionOps: GrantResolutionOps;
  readonly cacheRemote?: typeof writeKeepCache;
  readonly installHooks?: typeof installGitHooks;
  readonly report?: (message: string) => void;
}

async function defaultDestructiveConfirmation(plan: FreeLocklessPushPlan): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const inquirer = (await import('inquirer')).default;
  const names = plan.deletedRemoteVariableNames.join(', ');
  const answer = await inquirer.prompt<{ readonly ok: boolean }>([
    {
      type: 'confirm',
      name: 'ok',
      message: `This push will delete ${plan.deletedRemoteVariableNames.length} remote values (${names}). Continue?`,
      default: false,
    },
  ]);
  return answer.ok;
}

function branchVariableNames(keep: KeepFile, branch: string): readonly string[] {
  return Object.entries(keep.variables)
    .filter(([, entries]) => entries.some((entry) => entry.branch === branch))
    .map(([name]) => name);
}

/**
 * Attempt the free lockless push. `false` means the caller must continue into
 * the existing paid/local manifest command; `true` means this function fully
 * handled the free push. No local keep.lock is ever read or written here.
 */
export async function tryFreeLocklessPush(deps: FreeLocklessPushDependencies): Promise<boolean> {
  const projectState = await deps.projectManager.detectProjectState();
  if (projectState.initialized) return false;

  const syncState = deps.projectManager.readSyncState();
  const envMeta = deps.fileManager.readEnvMeta();
  const orgHint = syncState?.org_id ?? envMeta.org_id;
  if (syncState?.user_id) deps.authService.setSessionUserId(syncState.user_id);
  const auth = await deps.authService.authenticateSilent(orgHint);
  if (!auth.success || !auth.user_id) {
    throw new CapyError(auth.error ?? 'No valid session on this machine.', ERROR_CODES.AUTH_FAILED);
  }

  const billing = await deps.serviceClient.getBillingStatus();
  if (selectFreeLocklessPushMode({ initialized: false, billing }) !== 'free_lockless') return false;

  const orgId = orgHint
    ?? auth.organization_id
    ?? (auth.organizations?.length === 1 ? auth.organizations[0]?.id : undefined);
  if (!orgId) {
    throw new CapyError('Could not determine the active organization for free push.', ERROR_CODES.ORG_AMBIGUOUS);
  }
  const projects = await deps.serviceClient.listProjects();
  const project = projects.find((candidate) => candidate.organization_id === orgId && candidate.name === 'default');
  if (!project) {
    throw new CapyError('Free push requires the server-provisioned default project.', ERROR_CODES.PROJECT_NOT_FOUND);
  }

  const branch = SyncEngine.DEFAULT_BRANCH;
  const remote = await deps.serviceClient.getDecryptData(project.id, branch, undefined, true);
  if (!remote.keep_file) {
    throw new CapyError(
      'The free default project has not completed its first sync. Run capy setup --json.',
      ERROR_CODES.SYNC_NOT_INITIALIZED,
    );
  }
  const remoteKeep: KeepFile = {
    ...(JSON.parse(remote.keep_file) as KeepFile),
    org_id: orgId,
    project_id: project.id,
    project_name: project.name,
  };
  const localRaw = deps.fileManager.readEnvFile();
  const plan = planFreeLocklessPush(Object.keys(localRaw), branchVariableNames(remoteKeep, branch));
  if (plan.requiresDestructiveConfirmation) {
    const confirmed = await (deps.confirmDestructivePush ?? defaultDestructiveConfirmation)(plan);
    if (!confirmed) {
      throw new CapyError(
        `Push aborted: it would delete ${plan.deletedRemoteVariableNames.length} remote values.`,
        ERROR_CODES.SYNC_CONFLICT,
        { names: plan.deletedRemoteVariableNames },
      );
    }
  }

  const keyOps = {
    coDecrypt: (candidateOrgId: string, ciphertext: string) => deps.serviceClient.coDecrypt(candidateOrgId, ciphertext).then((result) => result.plaintext),
    wrapOuterLayer: (candidateOrgId: string, plaintext: string) => deps.serviceClient.wrapOuterLayer(candidateOrgId, plaintext).then((result) => result.ciphertext),
  };
  const encryptionKey = await (deps.resolveProjectKey ?? resolveFreeSyncProjectKey)(
    orgId,
    project.id,
    auth.user_id,
    keyOps,
    deps.grantResolutionOps,
  );
  const localEntries = Object.entries(localRaw).map(([name, value]) => {
    if (!value.startsWith('capy:')) return { ok: true as const, name, value };
    try {
      return { ok: true as const, name, value: deps.fileManager.decryptValue(value, encryptionKey) };
    } catch {
      return { ok: false as const, name };
    }
  });
  const foreignNames = localEntries.filter((entry) => !entry.ok).map((entry) => entry.name);
  if (foreignNames.length > 0) {
    throw new CapyError(
      "This .env holds values encrypted with a different project's key.",
      ERROR_CODES.PERMISSION_DENIED,
      { names: foreignNames },
    );
  }
  const localPlaintext = Object.fromEntries(
    localEntries.flatMap((entry) => entry.ok ? [[entry.name, entry.value] as const] : []),
  );
  const built = Object.entries(localPlaintext).reduce<{
    readonly encrypted: Readonly<Record<string, string>>;
    readonly pushedVariables: Readonly<Record<string, { readonly resource_id: string; readonly value_hash: string }>>;
  }>(
    (acc, [name, value]) => {
      const resourceId = deriveResourceId(branch, name);
      return {
        encrypted: { ...acc.encrypted, [name]: `capy:${resourceId}:${Encryptor.encrypt(value, encryptionKey)}` },
        pushedVariables: {
          ...acc.pushedVariables,
          [name]: {
            resource_id: resourceId,
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          },
        },
      };
    },
    { encrypted: {}, pushedVariables: {} },
  );
  const replacementKeep = new SyncEngine().mergeWithKeep(
    { ...remoteKeep, variables: {} },
    { ...built.pushedVariables },
    branch,
  );
  const updatedKeep = SyncEngine.spliceKeepBranch(remoteKeep, replacementKeep, branch);
  const envBlob = Object.entries(built.encrypted).map(([name, value]) => `${name}=${value}`).join('\n');
  const baseKeepHash = SyncEngine.computeKeepHash(remoteKeep, branch);
  const pushed = await deps.serviceClient.pushSecrets(
    project.id,
    JSON.stringify(updatedKeep),
    envBlob,
    branch,
    baseKeepHash,
  );
  const adoptedKeep = SyncEngine.adoptServerKeep(pushed.keep_file, updatedKeep, branch);
  const keepHash = pushed.keep_hash || SyncEngine.computeKeepHash(adoptedKeep, branch);

  (deps.cacheRemote ?? writeKeepCache)(orgId, project.id, keepHash, envBlob);
  deps.projectManager.writeActiveBranch(branch);
  deps.fileManager.ensureCapyGitignore();
  deps.fileManager.backupPlaintextEnv(undefined, true);
  deps.fileManager.writeEncryptedEnvFile(localPlaintext, encryptionKey, undefined, adoptedKeep, branch);
  deps.fileManager.writeSyncState({
    ...syncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(localPlaintext),
    user_id: auth.user_id,
    org_id: orgId,
    project_id: project.id,
    project_name: project.name,
    sync_mode: 'free',
    keep_hash: setSyncKeepHash(syncState, branch, keepHash),
  });
  (deps.installHooks ?? installGitHooks)(deps.devMode);
  (deps.report ?? console.log)(
    `Pushed ${Object.keys(localPlaintext).length} secret(s) to Keep${plan.deletedRemoteVariableNames.length > 0
      ? `; deleted ${plan.deletedRemoteVariableNames.length} remote value(s)`
      : ''}.`,
  );
  return true;
}
