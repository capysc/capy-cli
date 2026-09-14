import type { OnboardingDeps } from './onboarding';
import { readLocalRoot, readMasterKey, saveMasterKey } from '../../config/globalConfig';
import { decryptMasterKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';
import { CapyError, ERROR_CODES } from '../../types';

/** Reuse custody already delivered by Pair. Never replace it or invoke PRF. */
export async function restoreFromLocalRoot(deps: OnboardingDeps, orgId: string, check = (): void => {}): Promise<boolean> {
  const root = readLocalRoot(orgId, deps.userId);
  if (!root) return false;
  if (readMasterKey(orgId, deps.userId)) return true;
  const wrappers = await deps.ops.listWrappers();
  const wrapper = wrappers.find(row => row.type === 'key_enc' && row.organization_id === orgId && !row.deleted_at);
  if (!wrapper) throw new CapyError('The organization key is unavailable for the linked account.', ERROR_CODES.WRAPPER_NOT_FOUND);
  const scoped = await deps.opsForOrg(orgId);
  if (!scoped) throw new CapyError('The linked account cannot access this organization.', ERROR_CODES.PERMISSION_DENIED);
  const blob = await scoped.fetchKeyEnc(wrapper.id);
  const inner = await scoped.coDecrypt(orgId, blob);
  decryptMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(deps.userId, orgId));
  check();
  const current = readLocalRoot(orgId, deps.userId);
  if (!current || !current.equals(root)) throw new CapyError('Device custody changed while loading the organization key.', ERROR_CODES.LOCAL_ROOT_CONFLICT);
  if (!readMasterKey(orgId, deps.userId)) saveMasterKey(orgId, blob, deps.userId);
  return true;
}
