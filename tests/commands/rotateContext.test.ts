import { describe, expect, test } from 'bun:test';
import { readFreeRotationTarget } from '../../src/commands/rotateContext';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types';

const keep: KeepFile = { version: '3.0', org_id: 'org_free', project_id: 'project_default', project_name: 'default', variables: {} };
const sync = { sync_mode: 'free' as const, project_name: 'default', org_id: 'org_free', project_id: 'project_default',
  user_id: 'user_free', keep_hash: { development: 'a'.repeat(64) } };
const manager = (input: Readonly<{ keep?: KeepFile | null; sync?: unknown; branch?: string | null }>) => ({
  readKeepFile: () => input.keep ?? null,
  readSyncState: () => input.sync ?? sync,
  deriveActiveBranch: () => input.branch ?? 'development',
}) as any;

describe('readFreeRotationTarget', () => {
  test('keeps paid/local manifests on their existing path', () => {
    expect(readFreeRotationTarget(manager({ keep }))).toBeUndefined();
  });

  test('refuses a missing remote first-sync hash', () => {
    expect(() => readFreeRotationTarget(manager({ sync: { ...sync, keep_hash: {} } }))).toThrow(CapyError);
    try { readFreeRotationTarget(manager({ sync: { ...sync, keep_hash: {} } })); } catch (error) {
      expect((error as CapyError).code).toBe(ERROR_CODES.SYNC_NOT_INITIALIZED);
    }
  });

  test('refuses a requesting user that differs from the fixed free target', () => {
    expect(() => readFreeRotationTarget(manager({}), 'user_other')).toThrow(CapyError);
  });

  test('returns only the fixed development default target after completed free sync', () => {
    expect(readFreeRotationTarget(manager({}), 'user_free')).toEqual({
      orgId: 'org_free', projectId: 'project_default', userId: 'user_free', branch: 'development',
    });
  });
});
