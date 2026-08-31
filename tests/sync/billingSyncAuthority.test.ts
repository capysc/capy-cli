import { describe, expect, test } from 'bun:test';
import type { BillingStatus } from '../../src/service/serviceClient';
import { resolveBillingSyncAuthority } from '../../src/sync/billingSyncAuthority';

const PROJECT = { id: 'project_default', name: 'default', organization_id: 'org_personal' } as const;

const FREE_STATUS: BillingStatus = {
  tier: 'free',
  grandfathered: false,
  status: null,
  seats: null,
  member_count: 1,
  project_count: 1,
};

describe('resolveBillingSyncAuthority', () => {
  test('routes an ordinary free org to the keepless default-project corpus', () => {
    expect(resolveBillingSyncAuthority(FREE_STATUS, 'org_personal', PROJECT, 'feature/ignored')).toEqual({
      source: 'billing',
      mode: 'free',
      orgId: 'org_personal',
      projectId: 'project_default',
      projectName: 'default',
      branch: 'development',
    });
  });

  test('routes an active subscription to the existing manifest corpus', () => {
    expect(resolveBillingSyncAuthority({ ...FREE_STATUS, tier: 'business', status: 'active' }, 'org_team', PROJECT, 'feature/x')).toEqual({
      source: 'billing',
      mode: 'paid',
      orgId: 'org_team',
      projectId: 'project_default',
      branch: 'feature/x',
    });
  });

  test('grandfathered orgs retain project-aware behavior despite their free UI label', () => {
    expect(resolveBillingSyncAuthority({ ...FREE_STATUS, grandfathered: true }, 'org_legacy', PROJECT, 'main')).toMatchObject({
      source: 'billing',
      mode: 'paid',
      orgId: 'org_legacy',
      branch: 'main',
    });
  });
});
