// CAP-702: honest deploy wording, and the behind status in `capy edit`.
// Capy pushes values to the target's store; it never claims a release ran.
import { describe, it, expect } from 'bun:test';
import { buildDeployPrBody, pushedLine } from '../../src/commands/deployCommand';
import { reclassifyRow, withDeployStatus, type EditRow } from '../../src/ui/editScreen';
import { hashValue } from '../../src/commands/statusCommand';
import type { TargetConfig } from '../../src/deploy/adapter';

function target(kind: string, over: Partial<TargetConfig> = {}): TargetConfig {
  return { name: `${kind}-prod`, kind, branch: 'production', vars: ['API_KEY'], options: {}, ...over };
}

describe('deploy PR body (CAP-702)', () => {
  for (const kind of ['dokploy', 'vercel', 'aws-ssm', 'cf-worker']) {
    it(`${kind}: says the values are already in the vendor, and never calls merging "the deploy signal"`, () => {
      const body = buildDeployPrBody(target(kind, { gitBaseBranch: 'main' }));
      expect(body).toContain('The next release of this branch will use them.');
      expect(body).toMatch(/The new values are already in .+\. The next release/);
      expect(body).toMatch(/Merging this PR records them in keep\.lock, and it starts a release if .+ builds on merge\./);
      expect(body).not.toContain('deploy signal');
    });
  }
});

describe('capy deploy result line (CAP-702)', () => {
  it('a push names the target, never "deployed"', () => {
    expect(pushedLine(target('dokploy'), false)).toBe('pushed to dokploy-prod');
  });
  it('--no-deploy says the release was not triggered', () => {
    expect(pushedLine(target('dokploy'), true)).toBe('pushed, release not triggered');
  });
});

describe('capy edit STATUS: behind (CAP-702)', () => {
  const value = 'fake-value-one';
  const row = (over: Partial<EditRow> = {}): EditRow => ({
    key: 'API_KEY',
    localValue: value,
    remoteValue: value,
    status: 'in sync',
    updatedLabel: '—',
    ...over,
  });
  const server = { remoteAvailable: true };

  it('in sync with every target current stays in sync', () => {
    expect(reclassifyRow(row({ deployedHashes: [hashValue(value)] }), server)).toBe('in sync');
  });

  it('in sync, no targets, stays in sync', () => {
    expect(reclassifyRow(row({ deployedHashes: [] }), server)).toBe('in sync');
    expect(reclassifyRow(row(), server)).toBe('in sync');
  });

  it('in sync but one target holds an older value reads behind', () => {
    expect(reclassifyRow(row({ deployedHashes: [hashValue(value), hashValue('older')] }), server)).toBe('behind');
  });

  it('a value edited in the session becomes behind once committed, since no target has it yet', () => {
    const edited = row({ localValue: 'fake-new', remoteValue: 'fake-new', deployedHashes: [hashValue(value)] });
    expect(reclassifyRow(edited, server)).toBe('behind');
  });

  it('conflict, local and remote outrank behind', () => {
    const behind = [hashValue('older')];
    expect(reclassifyRow(row({ localValue: 'a', remoteValue: 'b', deployedHashes: behind }), server)).toBe('conflict');
    expect(reclassifyRow(row({ remoteValue: undefined, deployedHashes: behind }), server)).toBe('local');
    expect(reclassifyRow(row({ localValue: undefined, deployedHashes: behind }), server)).toBe('remote');
    expect(withDeployStatus(row({ deployedHashes: behind }), 'unknown')).toBe('unknown');
  });

  it('remote unavailable stays unknown', () => {
    expect(reclassifyRow(row({ deployedHashes: [hashValue('older')] }), { remoteAvailable: false })).toBe('unknown');
  });
});
