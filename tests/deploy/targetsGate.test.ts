/**
 * Pure keep.lock `targets` helpers (CAP-679) — recording, stripping, and
 * staleness detection. No network, no filesystem: every function here is a
 * plain KeepFile → KeepFile transform.
 */
import { describe, test, expect } from 'bun:test';
import {
  recordTargetDeliveries,
  stripTargetsForDeployId,
  stripTargetsForProviderTarget,
  staleTargets,
  upsertTargetElement,
  isDeliveryDescriptor,
} from '../../src/deploy/targetsGate';
import { KeepFile } from '../../src/types/index';

function keep(vars: Record<string, Array<Record<string, unknown>>>): KeepFile {
  return {
    version: '3',
    org_id: 'o1',
    project_id: 'p1',
    project_name: 'proj',
    variables: vars as any,
  };
}

describe('isDeliveryDescriptor', () => {
  test('accepts a well-formed descriptor', () => {
    expect(isDeliveryDescriptor({ provider: 'dokploy', target: 'backend-preview' })).toBe(true);
  });
  test('rejects a stray string (the old 5th-argument slot)', () => {
    expect(isDeliveryDescriptor('2026-06-23T00:00:00.000Z')).toBe(false);
  });
  test('rejects undefined/null/partial shapes', () => {
    expect(isDeliveryDescriptor(undefined)).toBe(false);
    expect(isDeliveryDescriptor(null)).toBe(false);
    expect(isDeliveryDescriptor({ provider: 'dokploy' })).toBe(false);
  });
});

describe('upsertTargetElement', () => {
  test('replaces, never appends, for the same (provider, target)', () => {
    const existing = [
      { provider: 'dokploy', target: 'backend-preview', deployed_value_hash: 'old', deployed_at: 't0' },
    ];
    const next = upsertTargetElement(existing, { provider: 'dokploy', target: 'backend-preview' }, 'new', 't1');
    expect(next).toHaveLength(1);
    expect(next[0].deployed_value_hash).toBe('new');
    expect(next[0].deployed_at).toBe('t1');
  });

  test('a different target is a separate element', () => {
    const existing = [
      { provider: 'dokploy', target: 'backend-preview', deployed_value_hash: 'a', deployed_at: 't0' },
    ];
    const next = upsertTargetElement(existing, { provider: 'dokploy', target: 'backend-prod' }, 'b', 't1');
    expect(next).toHaveLength(2);
  });

  test('carries ref and deploy_id only when present', () => {
    const withRef = upsertTargetElement(undefined, { provider: 'dokploy', target: 't', ref: { composeId: 'c1' } }, 'h', 'at');
    expect(withRef[0].ref).toEqual({ composeId: 'c1' });
    const withoutRef = upsertTargetElement(undefined, { provider: 'dokploy', target: 't' }, 'h', 'at');
    expect(withoutRef[0]).not.toHaveProperty('ref');
    expect(withoutRef[0]).not.toHaveProperty('deploy_id');
  });

  test('never mutates the existing array', () => {
    const existing = [{ provider: 'dokploy', target: 'a', deployed_value_hash: 'x', deployed_at: 't0' }] as const;
    const frozen = Object.freeze([...existing]);
    expect(() => upsertTargetElement(frozen, { provider: 'dokploy', target: 'a' }, 'y', 't1')).not.toThrow();
    expect(frozen[0].deployed_value_hash).toBe('x');
  });
});

describe('recordTargetDeliveries', () => {
  const base = keep({
    DATABASE_URL: [{ resource_id: 'r1', branch: 'preview', value_hash: 'h1' }],
    STRIPE_KEY: [{ resource_id: 'r2', branch: 'preview', value_hash: 'h2' }],
    OTHER_BRANCH_VAR: [{ resource_id: 'r3', branch: 'production', value_hash: 'h3' }],
  });

  test('sets one element per delivered var, on the right branch only', () => {
    const next = recordTargetDeliveries(
      base,
      'preview',
      { provider: 'dokploy', target: 'backend-preview', ref: { composeId: 'c1' } },
      '2026-09-28T00:00:00.000Z',
      [{ name: 'DATABASE_URL', valueHash: 'h1' }, { name: 'STRIPE_KEY', valueHash: 'h2' }],
    );
    expect((next.variables.DATABASE_URL[0] as any).targets).toEqual([
      {
        provider: 'dokploy',
        target: 'backend-preview',
        ref: { composeId: 'c1' },
        deployed_value_hash: 'h1',
        deployed_at: '2026-09-28T00:00:00.000Z',
      },
    ]);
    expect((next.variables.STRIPE_KEY[0] as any).targets).toHaveLength(1);
    // A var on a different branch, or not delivered, is untouched.
    expect((next.variables.OTHER_BRANCH_VAR[0] as any).targets).toBeUndefined();
  });

  test('replaces an existing element for the same (provider, target), keeps others', () => {
    const withPrior = keep({
      DATABASE_URL: [
        {
          resource_id: 'r1',
          branch: 'preview',
          value_hash: 'h1new',
          targets: [
            { provider: 'dokploy', target: 'backend-preview', deployed_value_hash: 'h1old', deployed_at: 't0' },
            { provider: 'vercel', target: 'web-prod', deployed_value_hash: 'h1new', deployed_at: 't0' },
          ],
        },
      ],
    });
    const next = recordTargetDeliveries(
      withPrior,
      'preview',
      { provider: 'dokploy', target: 'backend-preview' },
      't1',
      [{ name: 'DATABASE_URL', valueHash: 'h1new' }],
    );
    const targets = (next.variables.DATABASE_URL[0] as any).targets;
    expect(targets).toHaveLength(2);
    expect(targets.find((t: any) => t.provider === 'dokploy').deployed_value_hash).toBe('h1new');
    expect(targets.find((t: any) => t.provider === 'vercel').deployed_value_hash).toBe('h1new'); // untouched
  });

  test('is pure: never mutates the input KeepFile', () => {
    const before = JSON.stringify(base);
    recordTargetDeliveries(base, 'preview', { provider: 'dokploy', target: 't' }, 'at', [
      { name: 'DATABASE_URL', valueHash: 'h1' },
    ]);
    expect(JSON.stringify(base)).toBe(before);
  });

  test('no values delivered → returns the same KeepFile (identity)', () => {
    expect(recordTargetDeliveries(base, 'preview', { provider: 'dokploy', target: 't' }, 'at', [])).toBe(base);
  });
});

describe('stripTargetsForProviderTarget', () => {
  const withTargets = keep({
    DATABASE_URL: [
      {
        resource_id: 'r1',
        branch: 'preview',
        value_hash: 'h1',
        targets: [
          { provider: 'dokploy', target: 'backend-preview', deployed_value_hash: 'h1', deployed_at: 't0' },
          { provider: 'vercel', target: 'web-prod', deployed_value_hash: 'h1', deployed_at: 't0' },
        ],
      },
    ],
    STRIPE_KEY: [
      {
        resource_id: 'r2',
        branch: 'preview',
        value_hash: 'h2',
        targets: [{ provider: 'dokploy', target: 'backend-preview', deployed_value_hash: 'h2', deployed_at: 't0' }],
      },
    ],
  });

  test('removes only the matching element, on every entry', () => {
    const next = stripTargetsForProviderTarget(withTargets, 'dokploy', 'backend-preview');
    const dbTargets = (next.variables.DATABASE_URL[0] as any).targets;
    expect(dbTargets).toEqual([{ provider: 'vercel', target: 'web-prod', deployed_value_hash: 'h1', deployed_at: 't0' }]);
    // Emptied out entirely — the field itself is dropped, not left as [].
    expect(next.variables.STRIPE_KEY[0]).not.toHaveProperty('targets');
  });

  test('is pure and a no-op returns without touching anything', () => {
    const before = JSON.stringify(withTargets);
    const next = stripTargetsForProviderTarget(withTargets, 'dokploy', 'nonexistent-target');
    expect(JSON.stringify(withTargets)).toBe(before);
    expect(next.variables.DATABASE_URL[0]).toEqual(withTargets.variables.DATABASE_URL[0]);
  });
});

describe('stripTargetsForDeployId', () => {
  test('strips only elements with the matching deploy_id', () => {
    const withTargets = keep({
      DATABASE_URL: [
        {
          resource_id: 'r1',
          branch: 'preview',
          value_hash: 'h1',
          targets: [
            { provider: 'dokploy', target: 'a', deployed_value_hash: 'h1', deployed_at: 't0', deploy_id: 'dep_1' },
            { provider: 'dokploy', target: 'b', deployed_value_hash: 'h1', deployed_at: 't0', deploy_id: 'dep_2' },
          ],
        },
      ],
    });
    const next = stripTargetsForDeployId(withTargets, 'dep_1');
    const targets = (next.variables.DATABASE_URL[0] as any).targets;
    expect(targets).toEqual([{ provider: 'dokploy', target: 'b', deployed_value_hash: 'h1', deployed_at: 't0', deploy_id: 'dep_2' }]);
  });
});

describe('staleTargets', () => {
  test('a target whose deployed_value_hash differs from the entry value_hash is stale', () => {
    const entry = {
      resource_id: 'r1',
      branch: 'preview',
      value_hash: 'NEW',
      targets: [
        { provider: 'dokploy', target: 'a', deployed_value_hash: 'OLD', deployed_at: 't0' },
        { provider: 'dokploy', target: 'b', deployed_value_hash: 'NEW', deployed_at: 't0' },
      ],
    } as any;
    const stale = staleTargets(entry);
    expect(stale).toHaveLength(1);
    expect(stale[0].target).toBe('a');
  });

  test('no targets → empty, never throws', () => {
    expect(staleTargets({ resource_id: 'r1', branch: 'preview', value_hash: 'h' } as any)).toEqual([]);
  });
});
