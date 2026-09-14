import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { getSyncKeepHash, CapyError, ERROR_CODES } from '../types';
import { resolveContext, type ResolvedContext } from './connectors/shared';

export type FixedRotationTarget = Readonly<{ orgId: string; projectId: string; userId: string; branch: 'development' }>;

export function readFreeRotationTarget(pm: ProjectManager, expectedUserId?: string): FixedRotationTarget | undefined {
  if (pm.readKeepFile()) return undefined;
  const sync = pm.readSyncState();
  if (sync?.sync_mode !== 'free') return undefined;
  if ( sync.project_name !== 'default' || !sync.org_id || !sync.project_id
    || !sync.user_id || pm.deriveActiveBranch() !== 'development' || !getSyncKeepHash(sync, 'development')) {
    throw new CapyError('Rotation requires completed first sync for this project.', ERROR_CODES.SYNC_NOT_INITIALIZED);
  }
  if (expectedUserId && expectedUserId !== sync.user_id) throw new CapyError('The requesting account does not match this project.', ERROR_CODES.PERMISSION_DENIED);
  return { orgId: sync.org_id, projectId: sync.project_id, userId: sync.user_id, branch: 'development' };
}

export async function resolveFixedRotationContext(target: FixedRotationTarget, devMode: boolean): Promise<ResolvedContext> {
  const authService = new AuthService(undefined, devMode, target.userId);
  const authResult = await authService.authenticateSilent(target.orgId);
  if (!authResult.success || authResult.user_id !== target.userId || authResult.organization_id !== target.orgId) {
    throw new CapyError('The paired account no longer has the approved rotation target.', ERROR_CODES.PERMISSION_DENIED);
  }
  const serviceClient = new ServiceClient(undefined, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  const billing = await serviceClient.getBillingStatus();
  if (billing.tier !== 'free' || billing.grandfathered) throw new CapyError('The project mode changed; restart rotation.', ERROR_CODES.PLAN_CHANGED);
  const context = await resolveContext({ devMode, forceLockless: true, existingKeyOnly: true, nonInteractive: true,
    authService, authResult, serviceClient });
  if (!context.remoteKeepExists || context.userId !== target.userId || context.orgId !== target.orgId
    || context.projectId !== target.projectId || context.branch !== target.branch
    || context.keep.org_id !== target.orgId || context.keep.project_id !== target.projectId) {
    throw new CapyError('The authoritative project no longer matches the approved rotation target.', ERROR_CODES.PERMISSION_DENIED);
  }
  return context;
}
