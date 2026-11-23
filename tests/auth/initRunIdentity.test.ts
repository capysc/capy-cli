import { describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { resolveInitRunIdentity } from '../../src/auth/initRunIdentity';

function repository(): Readonly<{ root: string; child: string }> {
  const root = mkdtempSync(join(tmpdir(), 'capy-init-identity-'));
  const child = join(root, 'child');
  mkdirSync(child, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return { root, child };
}

describe('resolveInitRunIdentity', () => {
  test('reuses the paired runtime identity and hashes the canonical repository root', () => {
    const fixture = repository();
    try {
      const save = jest.fn();
      const storage = {
        read: jest.fn(() => save.mock.calls.at(-1)?.[1] ?? null),
        save,
      };
      const path = join(fixture.root, '.fixture-state', 'runtime-id.json');
      const first = resolveInitRunIdentity(fixture.root, path, storage);
      const second = resolveInitRunIdentity(fixture.root, path, storage);
      expect(second.runtimeId).toBe(first.runtimeId);
      expect(save).toHaveBeenCalledTimes(1);
      const canonicalRoot = realpathSync(fixture.root);
      expect(first.repositoryRoot).toBe(canonicalRoot);
      expect(first.repositoryFingerprint).toBe(`sha256:${createHash('sha256').update(canonicalRoot).digest('hex')}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('binds a subdirectory to its git root and refuses a non-repository', () => {
    const fixture = repository();
    const outside = mkdtempSync(join(tmpdir(), 'capy-init-no-repo-'));
    try {
      const storage = { read: () => null, save: jest.fn() };
      const nested = resolveInitRunIdentity(fixture.child, join(fixture.root, '.state.json'), storage);
      const canonicalRoot = realpathSync(fixture.root);
      expect(nested.repositoryRoot).toBe(canonicalRoot);
      expect(nested.repositoryFingerprint).toBe(`sha256:${createHash('sha256').update(canonicalRoot).digest('hex')}`);
      expect(() => resolveInitRunIdentity(outside, join(outside, '.state.json'), storage)).toThrow('Hosted initialization cannot establish its local binding');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
