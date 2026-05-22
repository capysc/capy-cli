import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KeepFile, ConnectorMetadata } from '../../../src/types/index';
import { checkExpiringKeys } from '../../../src/commands/connectors/shared';

const TEST_DIR = join(tmpdir(), `capy-expiry-test-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

const baseConnector: ConnectorMetadata = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_1Abc',
  created_at: 1700000000,
  fingerprint: 'rk_…xyz',
};

function writeProject(keep: KeepFile, branch: string = 'development') {
  mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
  writeFileSync(join(TEST_DIR, '.capy', 'branch'), branch, 'utf-8');
}

function makeKeep(connectors: Record<string, ConnectorMetadata | undefined>, branch: string = 'development'): KeepFile {
  const variables: KeepFile['variables'] = {};
  for (const [name, c] of Object.entries(connectors)) {
    variables[name] = [{
      resource_id: 'r-' + name,
      branch,
      value_hash: 'hash-' + name,
      ...(c ? { connector: c } : {}),
    }];
  }
  return {
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    variables,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  // checkExpiringKeys() uses a default ProjectManager() which reads cwd.
  process.chdir(TEST_DIR);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('checkExpiringKeys', () => {
  test('returns empty when no keep.lock exists', () => {
    expect(checkExpiringKeys()).toEqual([]);
  });

  test('returns empty when no entry has a connector', () => {
    writeProject(makeKeep({ FOO: undefined }));
    expect(checkExpiringKeys()).toEqual([]);
  });

  test('returns empty when connector has no expires_at', () => {
    writeProject(makeKeep({ STRIPE_KEY: { ...baseConnector } }));
    expect(checkExpiringKeys()).toEqual([]);
  });

  test('skips entries far from expiry', () => {
    const farFuture = Math.floor(Date.now() / 1000) + 30 * 86400;
    writeProject(makeKeep({ STRIPE_KEY: { ...baseConnector, expires_at: farFuture } }));
    expect(checkExpiringKeys()).toEqual([]);
  });

  test('flags entries within the 7-day default window', () => {
    const inFiveDays = Math.floor(Date.now() / 1000) + 5 * 86400;
    writeProject(makeKeep({ STRIPE_SECRET_KEY: { ...baseConnector, expires_at: inFiveDays } }));
    const result = checkExpiringKeys();
    expect(result).toHaveLength(1);
    expect(result[0].varName).toBe('STRIPE_SECRET_KEY');
    expect(result[0].provider).toBe('stripe');
    expect(result[0].expiresIn).toBeGreaterThanOrEqual(4);
    expect(result[0].expiresIn).toBeLessThanOrEqual(5);
  });

  test('flags already-expired entries with negative expiresIn', () => {
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    writeProject(makeKeep({ STRIPE_KEY: { ...baseConnector, expires_at: oneDayAgo } }));
    const result = checkExpiringKeys();
    expect(result).toHaveLength(1);
    expect(result[0].expiresIn).toBeLessThan(0);
  });

  test('respects a custom window', () => {
    const inTenDays = Math.floor(Date.now() / 1000) + 10 * 86400;
    writeProject(makeKeep({ K: { ...baseConnector, expires_at: inTenDays } }));
    expect(checkExpiringKeys(7)).toEqual([]);
    expect(checkExpiringKeys(14)).toHaveLength(1);
  });

  test('returns multiple expiring keys', () => {
    const inThree = Math.floor(Date.now() / 1000) + 3 * 86400;
    const inFive = Math.floor(Date.now() / 1000) + 5 * 86400;
    writeProject(
      makeKeep({
        A: { ...baseConnector, expires_at: inThree },
        B: { ...baseConnector, expires_at: inFive },
      }),
    );
    const result = checkExpiringKeys();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.varName).sort()).toEqual(['A', 'B']);
  });

  test('only considers connectors on the active branch', () => {
    const inThree = Math.floor(Date.now() / 1000) + 3 * 86400;
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        ON_DEV: [
          { resource_id: 'r1', branch: 'development', value_hash: 'h', connector: { ...baseConnector, expires_at: inThree } },
        ],
        ON_OTHER: [
          { resource_id: 'r2', branch: 'main', value_hash: 'h', connector: { ...baseConnector, expires_at: inThree } },
        ],
      },
    };
    writeProject(keep, 'development');
    const result = checkExpiringKeys();
    expect(result.map((r) => r.varName)).toEqual(['ON_DEV']);
  });
});
