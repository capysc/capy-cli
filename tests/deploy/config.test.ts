import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readDeployConfig,
  writeDeployConfig,
  upsertTarget,
  removeTarget,
  getTarget,
  listTargets,
  deployConfigPath,
} from '../../src/deploy/config';
import { TargetConfig } from '../../src/deploy/adapter';

const ROOT = join(tmpdir(), `capy-deploy-config-test-${process.pid}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

const T1: TargetConfig = {
  name: 'worker-prod',
  kind: 'cf-worker',
  branch: 'production',
  vars: ['SUPABASE_URL', 'STRIPE_SECRET_KEY'],
  options: { workerName: 'my-worker', workerDir: 'worker' },
};

const T2: TargetConfig = {
  name: 'worker-staging',
  kind: 'cf-worker',
  branch: 'staging',
  vars: ['SUPABASE_URL'],
  options: { workerName: 'my-worker-staging', workerDir: 'worker' },
};

describe('deploy/config', () => {
  test('readDeployConfig returns null when file is missing', () => {
    expect(readDeployConfig(ROOT)).toBeNull();
  });

  test('upsertTarget creates the file and round-trips', () => {
    upsertTarget(ROOT, T1);
    expect(existsSync(deployConfigPath(ROOT))).toBe(true);
    const cfg = readDeployConfig(ROOT);
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe('1');
    expect(cfg!.targets['worker-prod']).toEqual(T1);
  });

  test('makes deploy.json portable while all other .capy state stays ignored', () => {
    spawnSync('git', ['init', '--quiet'], { cwd: ROOT });
    writeFileSync(join(ROOT, '.gitignore'), '.capy\n');
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy', 'branch'), 'development\n');
    writeFileSync(join(ROOT, '.capy', 'sync-state'), '{}\n');

    writeDeployConfig(ROOT, { version: '1', targets: { [T1.name]: T1 } });

    const deployIgnored = spawnSync(
      'git',
      ['check-ignore', '--quiet', '.capy/deploy.json'],
      { cwd: ROOT },
    );
    const branchIgnored = spawnSync(
      'git',
      ['check-ignore', '--quiet', '.capy/branch'],
      { cwd: ROOT },
    );
    const syncStateIgnored = spawnSync(
      'git',
      ['check-ignore', '--quiet', '.capy/sync-state'],
      { cwd: ROOT },
    );
    const status = spawnSync(
      'git',
      ['status', '--short', '--untracked-files=all'],
      { cwd: ROOT, encoding: 'utf-8' },
    );

    expect(deployIgnored.status).toBe(1);
    expect(branchIgnored.status).toBe(0);
    expect(syncStateIgnored.status).toBe(0);
    expect(status.stdout).toContain('?? .capy/deploy.json');
    expect(status.stdout).not.toContain('.capy/branch');
    expect(status.stdout).not.toContain('.capy/sync-state');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf-8')).toContain(
      '!/.capy/\n/.capy/*\n!/.capy/deploy.json\n',
    );
  });

  test('reading an existing legacy deploy config repairs its ignore rules', () => {
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.gitignore'), '.capy/\n');
    writeFileSync(
      join(ROOT, '.capy', 'deploy.json'),
      JSON.stringify({ version: '1', targets: { [T1.name]: T1 } }),
    );

    expect(readDeployConfig(ROOT)?.targets[T1.name]).toEqual(T1);
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf-8')).toContain(
      '!/.capy/\n/.capy/*\n!/.capy/deploy.json\n',
    );
  });

  test('upsertTarget replaces an existing entry', () => {
    upsertTarget(ROOT, T1);
    const updated = { ...T1, vars: ['FOO'] };
    upsertTarget(ROOT, updated);
    const cfg = readDeployConfig(ROOT)!;
    expect(cfg.targets['worker-prod'].vars).toEqual(['FOO']);
  });

  test('multiple targets coexist', () => {
    upsertTarget(ROOT, T1);
    upsertTarget(ROOT, T2);
    const targets = listTargets(ROOT);
    expect(new Set(targets.map((t) => t.name))).toEqual(
      new Set(['worker-prod', 'worker-staging']),
    );
  });

  test('getTarget by name', () => {
    upsertTarget(ROOT, T1);
    expect(getTarget(ROOT, 'worker-prod')).toEqual(T1);
    expect(getTarget(ROOT, 'missing')).toBeNull();
  });

  test('removeTarget', () => {
    upsertTarget(ROOT, T1);
    upsertTarget(ROOT, T2);
    expect(removeTarget(ROOT, 'worker-prod')).toBe(true);
    expect(removeTarget(ROOT, 'worker-prod')).toBe(false); // already gone
    expect(listTargets(ROOT).map((t) => t.name)).toEqual(['worker-staging']);
  });

  test('rejects unsupported version', () => {
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(
      join(ROOT, '.capy/deploy.json'),
      JSON.stringify({ version: '99', targets: {} }),
    );
    expect(() => readDeployConfig(ROOT)).toThrow(/Unsupported deploy.json/);
  });

  test('throws on malformed JSON', () => {
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy/deploy.json'), '{ not json');
    expect(() => readDeployConfig(ROOT)).toThrow(/malformed/);
  });
});
