// CAP-702: a target configured in `.capy/deploy.json` on the default branch,
// that never received a push, counts as behind — in `capy edit` (read
// directly) and in `capy secrets` (via a placeholder record on the server).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  missingTargetRecords,
  readDefaultBranchTargets,
  recordConfiguredTargets,
  withPlaceholderRecords,
  type ConfiguredTargetsClient,
} from '../../src/deploy/configuredTargets';
import { anyTargetBehind, deployedHashesFor } from '../../src/core/deployStatus';
import { staleTargets } from '../../src/deploy/targetsGate';
import type { TargetConfig } from '../../src/deploy/adapter';
import type { KeepFile } from '../../src/types/index';

const target = (name: string, vars: string[], branch = 'production'): TargetConfig => ({
  name,
  kind: 'dokploy',
  branch,
  vars,
  options: {},
});

function keepWith(variables: KeepFile['variables']): KeepFile {
  return { version: '3', project_id: 'p1', project_name: 'web', variables } as unknown as KeepFile;
}

const KEEP = keepWith({
  API_KEY: [
    { resource_id: 'r1', branch: 'production', value_hash: 'h-api', targets: [{ provider: 'dokploy', target: 'backend', deployed_value_hash: 'h-api', deployed_at: '2026-10-01T00:00:00.000Z' }] },
    { resource_id: 'r1', branch: 'staging', value_hash: 'h-api-stg' },
  ],
  DB_URL: [{ resource_id: 'r2', branch: 'production', value_hash: 'h-db' }],
});

describe('missingTargetRecords / withPlaceholderRecords', () => {
  const targets = [target('backend', ['API_KEY', 'DB_URL', 'NOT_IN_CAPY']), target('worker', ['API_KEY'])];

  it('lists each configured (variable, target) that Capy has but no record for — never a variable Capy lacks', () => {
    expect(missingTargetRecords(targets, KEEP, 'production')).toEqual([
      { varName: 'DB_URL', provider: 'dokploy', target: 'backend' },
      { varName: 'API_KEY', provider: 'dokploy', target: 'worker' },
    ]);
  });

  it('only looks at targets on that branch', () => {
    expect(missingTargetRecords(targets, KEEP, 'staging')).toEqual([]);
  });

  it('adds hashless placeholders that read as stale, and leaves existing records and other branches alone', () => {
    const next = withPlaceholderRecords(KEEP, 'production', missingTargetRecords(targets, KEEP, 'production'));
    const api = next.variables.API_KEY.find((e) => e.branch === 'production')!;
    expect(api.targets).toEqual([
      KEEP.variables.API_KEY[0].targets![0],
      { provider: 'dokploy', target: 'worker' },
    ]);
    expect(staleTargets(api).map((t) => t.target)).toEqual(['worker']);
    expect(next.variables.API_KEY[1]).toBe(KEEP.variables.API_KEY[1]);
    expect(missingTargetRecords(targets, next, 'production')).toEqual([]); // idempotent
    expect(KEEP.variables.API_KEY[0].targets).toHaveLength(1); // input untouched
  });

  it('returns the same keep when nothing is missing', () => {
    expect(withPlaceholderRecords(KEEP, 'production', [])).toBe(KEEP);
  });
});

describe('capy edit: a configured target with no record is behind', () => {
  it('counts a never-pushed configured target as behind', () => {
    const hashes = deployedHashesFor(KEEP, 'DB_URL', 'production', [target('backend', ['DB_URL'])]);
    expect(hashes).toEqual([null]);
    expect(anyTargetBehind(hashes, 'h-db')).toBe(true);
  });

  it('a recorded, current target is not behind', () => {
    const hashes = deployedHashesFor(KEEP, 'API_KEY', 'production', [target('backend', ['API_KEY'])]);
    expect(hashes).toEqual(['h-api']);
    expect(anyTargetBehind(hashes, 'h-api')).toBe(false);
  });
});

describe('readDefaultBranchTargets / recordConfiguredTargets (real git)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capy-configured-')));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();
  const deployJson = (targets: TargetConfig[]) =>
    JSON.stringify({ version: '1', targets: Object.fromEntries(targets.map((t) => [t.name, t])) });

  beforeAll(() => {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
    mkdirSync(join(work, '.capy'), { recursive: true });
    writeFileSync(join(work, '.capy', 'deploy.json'), deployJson([target('backend', ['DB_URL'])]));
    git(work, 'checkout', '-q', '-b', 'main');
    git(work, 'add', '.capy/deploy.json');
    git(work, 'commit', '-q', '-m', 'targets');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    git(work, 'remote', 'set-head', 'origin', 'main');
    // An unmerged change (like a --discover PR) adds a target only in the working tree.
    writeFileSync(join(work, '.capy', 'deploy.json'), deployJson([target('backend', ['DB_URL']), target('unmerged', ['DB_URL'])]));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads targets from origin/<default>, not the working tree — an unmerged target never counts', () => {
    expect(readDefaultBranchTargets(work).map((t) => t.name)).toEqual(['backend']);
  });

  it('no default branch or no file → no targets', () => {
    expect(readDefaultBranchTargets(root)).toEqual([]);
  });

  function fakeClient(keep: KeepFile): ConfiguredTargetsClient & { pushes: { keepFile: string; envBlob: string; branch?: string }[] } {
    const pushes: { keepFile: string; envBlob: string; branch?: string }[] = [];
    return {
      pushes,
      getLatestSecrets: async () => ({ env_file: 'ENCRYPTED_BLOB', keep_hash: 'kh', keep_file: JSON.stringify(keep) }),
      pushSecrets: async (_p, keepFile, envBlob, branch) => {
        pushes.push({ keepFile, envBlob, branch });
        return {};
      },
    };
  }

  it('pushes one placeholder per missing record onto the SERVER keep, re-sending the blob unchanged', async () => {
    const client = fakeClient(KEEP);
    const result = await recordConfiguredTargets({ cwd: work, projectId: 'p1', client, dryRun: false });
    expect(result.recorded).toBe(1);
    expect(client.pushes).toHaveLength(1);
    expect(client.pushes[0].envBlob).toBe('ENCRYPTED_BLOB');
    expect(client.pushes[0].branch).toBe('production');
    const pushed = JSON.parse(client.pushes[0].keepFile) as KeepFile;
    expect(pushed.variables.DB_URL[0].targets).toEqual([{ provider: 'dokploy', target: 'backend' }]);
    expect(pushed.variables.API_KEY).toEqual(KEEP.variables.API_KEY); // server-only records kept
  });

  it('writes nothing when every configured target already has a record', async () => {
    const recorded = withPlaceholderRecords(KEEP, 'production', [{ varName: 'DB_URL', provider: 'dokploy', target: 'backend' }]);
    const client = fakeClient(recorded);
    expect((await recordConfiguredTargets({ cwd: work, projectId: 'p1', client, dryRun: false })).recorded).toBe(0);
    expect(client.pushes).toHaveLength(0);
  });

  it('writes nothing on a dry run', async () => {
    const client = fakeClient(KEEP);
    expect((await recordConfiguredTargets({ cwd: work, projectId: 'p1', client, dryRun: true })).recorded).toBe(0);
    expect(client.pushes).toHaveLength(0);
  });

  it('a failing server call never throws', async () => {
    const client: ConfiguredTargetsClient = {
      getLatestSecrets: async () => {
        throw new Error('boom');
      },
      pushSecrets: async () => ({}),
    };
    expect((await recordConfiguredTargets({ cwd: work, projectId: 'p1', client, dryRun: false })).recorded).toBe(0);
  });
});
