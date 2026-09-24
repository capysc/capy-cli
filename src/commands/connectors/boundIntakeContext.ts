/** Strict consumer adapter; ordinary interactive Add context and paid behavior stay unchanged. */
import { AuthService, silentAuthFailureMessage } from '../../auth/authService';
import { createGrantResolutionOps } from '../../auth/deviceKey/grantResolver';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { ServiceClient } from '../../service/serviceClient';
import { SyncEngine } from '../../sync/syncEngine';
import { resolveConfiguredProjectKey } from '../../sync/projectKeyResolver';
import { CapyError, ERROR_CODES, type KeepFile } from '../../types';
import type { ResolvedContext } from './shared';
import type { RepositoryTarget } from '../flowSetupCommand';

export async function resolveBoundIntakeContext(input: {
  readonly target: RepositoryTarget; readonly expectedUserId: string;
  readonly auth: AuthService; readonly service: ServiceClient;
}): Promise<ResolvedContext> {
  const { target, auth, service } = input;
  const pm = new ProjectManager();
  const fileManager = new FileManager();
  const localKeep = pm.readKeepFile();
  if (!localKeep || localKeep.org_id !== target.org_id || localKeep.project_id !== target.project_id
    || pm.deriveActiveBranch() !== target.branch) {
    throw new CapyError('Repository binding changed.', ERROR_CODES.PERMISSION_DENIED);
  }
  const localValuesRaw = fileManager.readEnvFile();
  const localMeta = fileManager.readEnvMeta();
  if (Object.values(localValuesRaw).some((value) => value.startsWith('capy:'))
    && (localMeta.org_id !== target.org_id || localMeta.project_id !== target.project_id || localMeta.branch !== target.branch)) {
    throw new CapyError('The encrypted environment belongs to another target.', ERROR_CODES.PERMISSION_DENIED);
  }
  const identity = await auth.authenticateSilent(target.org_id);
  if (!identity.success || identity.user_id !== input.expectedUserId || identity.organization_id !== target.org_id) {
    console.error(`bound intake: ${silentAuthFailureMessage(identity)}`);
    throw new CapyError('Resume sign-in for this account.', ERROR_CODES.AUTH_FAILED);
  }
  const projectKey = await resolveConfiguredProjectKey(target.org_id, target.project_id, input.expectedUserId, {
    coDecrypt: (org, ciphertext) => service.coDecrypt(org, ciphertext).then((result) => result.plaintext),
    wrapOuterLayer: (org, plaintext) => service.wrapOuterLayer(org, plaintext).then((result) => result.ciphertext),
  }, createGrantResolutionOps(service, auth));
  const remote = await service.getDecryptData(target.project_id, target.branch, undefined, true);
  const remoteKeep = remote.keep_file ? JSON.parse(remote.keep_file) as KeepFile : null;
  if (remoteKeep && (remoteKeep.org_id !== target.org_id || remoteKeep.project_id !== target.project_id)) {
    throw new CapyError('Remote project changed.', ERROR_CODES.PERMISSION_DENIED);
  }
  if (remoteKeep && SyncEngine.computeKeepHash(localKeep, target.branch) !== SyncEngine.computeKeepHash(remoteKeep, target.branch)) {
    throw new CapyError('The local Keep manifest is stale. Sync it before adding secrets.', ERROR_CODES.STALE_KEEP_HASH);
  }
  const decrypt = (values: Readonly<Record<string, string>>): Readonly<Record<string, string>> => Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      try { return [name, value.startsWith('capy:') ? fileManager.decryptValue(value, projectKey) : value]; }
      catch { throw new CapyError('A stored value cannot be decrypted for this project.', ERROR_CODES.PERMISSION_DENIED); }
    }),
  );
  const remoteValues = remote.env_content ? decrypt(fileManager.parseEnvContent(remote.env_content)) : {};
  const localValues = decrypt(localValuesRaw);
  return { pm, fileManager, authService: auth, serviceClient: service, orgId: target.org_id,
    projectId: target.project_id, branch: target.branch, userId: input.expectedUserId, projectKey, keep: localKeep,
    localPlaintext: { ...remoteValues, ...localValues }, lockless: false,
    base_keep_hash: remoteKeep ? SyncEngine.computeKeepHash(remoteKeep, target.branch)
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    remoteKeepExists: remoteKeep !== null };
}
