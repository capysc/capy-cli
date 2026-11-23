import { describe, test, expect } from 'bun:test';
import { givenSetupFlags, pendingDisagreements, pendingSetupOf } from '../../src/core/pendingSetup';
import type { PendingSetup, SyncState } from '../../src/types/index';

const PENDING: PendingSetup = { org_id: 'org-1', project_id: 'proj-1', branch: 'development', protected: false };
const LINKED = { projectId: 'proj-1', projectName: 'demo' };
const STATE: SyncState = { last_sync: '', synced_variables: [] };

describe('pendingSetupOf', () => {
  test('a sync state written before the marker existed has none', () => {
    expect(pendingSetupOf(null)).toBeUndefined();
    expect(pendingSetupOf(STATE)).toBeUndefined();
    expect(pendingSetupOf({ ...STATE, user_id: 'u', org_id: 'o', keep_hash: { main: 'h' } })).toBeUndefined();
  });

  test('a complete marker is read back', () => {
    expect(pendingSetupOf({ ...STATE, pending_setup: PENDING })).toEqual(PENDING);
  });

  test('anything that is not a complete marker is none', () => {
    const broken = (pending_setup: unknown): SyncState => ({ ...STATE, pending_setup: pending_setup as PendingSetup });
    expect(pendingSetupOf(broken('yes'))).toBeUndefined();
    expect(pendingSetupOf(broken({ ...PENDING, protected: 'no' }))).toBeUndefined();
    expect(pendingSetupOf(broken({ org_id: 'o', project_id: 'p', branch: 'b' }))).toBeUndefined();
    expect(pendingSetupOf(broken({ ...PENDING, project_id: 7 }))).toBeUndefined();
  });
});

describe('givenSetupFlags', () => {
  test('lists the typed flags in a fixed order, spelled as typed on the command line', () => {
    expect(givenSetupFlags({})).toEqual([]);
    expect(givenSetupFlags({ protectedAnswer: 'no', name: 'demo', org: 'Acme', branch: 'main', project: 'new' })).toEqual(['--org', '--project', '--name', '--branch', '--protected']);
  });
});

describe('pendingDisagreements', () => {
  test('nothing typed, or only what agrees, disagrees with nothing', () => {
    expect(pendingDisagreements({}, PENDING, LINKED)).toEqual([]);
    expect(pendingDisagreements({ name: 'demo', branch: 'development', protectedAnswer: 'no', project: 'new' }, PENDING, LINKED)).toEqual([]);
    expect(pendingDisagreements({ project: 'proj-1' }, PENDING, LINKED)).toEqual([]);
    expect(pendingDisagreements({ project: 'demo' }, PENDING, LINKED)).toEqual([]);
  });

  test('each typed flag that differs is named', () => {
    expect(pendingDisagreements({ name: 'other' }, PENDING, LINKED)).toEqual(['--name']);
    expect(pendingDisagreements({ project: 'web' }, PENDING, LINKED)).toEqual(['--project']);
    expect(pendingDisagreements({ branch: 'main' }, PENDING, LINKED)).toEqual(['--branch']);
    expect(pendingDisagreements({ protectedAnswer: 'yes' }, PENDING, LINKED)).toEqual(['--protected']);
    expect(pendingDisagreements({ protectedAnswer: 'maybe' }, PENDING, LINKED)).toEqual(['--protected']);
    expect(pendingDisagreements({ protectedAnswer: 'no' }, { ...PENDING, protected: true }, LINKED)).toEqual(['--protected']);
  });
});
