/**
 * Resolve the configured Keep project key from the runtime's configured
 * custody source. A persisted runtime-pair record is an explicit instruction
 * to use its live in-memory grant; only runtimes without that record use the
 * existing disk-backed resolver.
 *
 * This keeps sync aligned with `capy run`: a stale or
 * unavailable configured grant fails closed instead of silently falling back
 * to unrelated durable key material.
 */
import { configuredGrantSocketPath } from '../auth/deviceKey/ephemeral';
import { fetchGrantedKLocal } from '../auth/deviceKey/grantHolder';
import { resolveProjectKeyFromGrant, type GrantResolutionOps } from '../auth/deviceKey/grantResolver';
import { resolveProjectKey, type KeyServiceOps } from '../crypto/keyResolver';

export async function resolveConfiguredProjectKey(
  orgId: string,
  projectId: string,
  userId: string,
  keyServiceOps: KeyServiceOps,
  grantResolutionOps: GrantResolutionOps,
): Promise<string> {
  const grantSocket = configuredGrantSocketPath();
  if (!grantSocket) return resolveProjectKey(orgId, projectId, userId, keyServiceOps);

  const grant = await fetchGrantedKLocal(grantSocket, userId);
  return resolveProjectKeyFromGrant(grant.kLocal, orgId, projectId, userId, grantResolutionOps);
}
