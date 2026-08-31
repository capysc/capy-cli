import type { BillingStatus } from '../service/serviceClient';
import type { BillingResolvedSyncMode } from './canonicalSyncPolicy';

export interface BillingSyncProject {
  readonly id: string;
  readonly name: string;
  readonly organization_id: string;
}

/**
 * Convert the service's billing verdict into the canonical sync authority.
 * Grandfathered organizations retain the paid/project-aware corpus even
 * though the billing UI labels them free; their exemption is the durable
 * server-side signal that they predate single-project free mode.
 */
export function resolveBillingSyncAuthority(
  billing: BillingStatus,
  orgId: string,
  project: BillingSyncProject,
  branch: string,
): BillingResolvedSyncMode {
  if (billing.tier === 'business' || billing.grandfathered) {
    return {
      source: 'billing',
      mode: 'paid',
      orgId,
      projectId: project.id,
      branch,
    };
  }

  return {
    source: 'billing',
    mode: 'free',
    orgId,
    projectId: project.id,
    projectName: 'default',
    branch: 'development',
  };
}
