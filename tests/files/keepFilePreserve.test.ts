import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { KeepFile, ConnectorMetadata } from '../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-keepfile-preserve-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('FileManager.writeKeepFile preserves extras', () => {
  test('connector field round-trips through write/read', () => {
    const connector: ConnectorMetadata = {
      provider: 'stripe',
      source: 'cli',
      mode: 'test',
      account_id: 'acct_1Abc',
      expires_at: 1717000000,
      created_at: 1700000000,
      rotated_at: 1714400000,
      fingerprint: 'rk_…xyz',
    };
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        STRIPE_SECRET_KEY: [
          { resource_id: 'r1', branch: 'main', value_hash: 'h1', connector },
        ],
        UNTOUCHED: [{ resource_id: 'r2', branch: 'main', value_hash: 'h2' }],
      },
    };

    const fm = new FileManager(TEST_DIR);
    fm.writeKeepFile(keep);

    const pm = new ProjectManager(TEST_DIR);
    const round = pm.readKeepFile();
    expect(round).not.toBeNull();
    const entry = round!.variables.STRIPE_SECRET_KEY[0];
    expect(entry.connector).toEqual(connector);
    expect(round!.variables.UNTOUCHED[0].connector).toBeUndefined();
  });

  test('changed_at round-trips through write/read per branch entry', () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        API_KEY: [
          { resource_id: 'r1', branch: 'development', value_hash: 'hd', changed_at: '2026-06-10T12:00:00.000Z' },
          { resource_id: 'r2', branch: 'prod', value_hash: 'hp', changed_at: '2026-01-15T08:30:00.000Z' },
          { resource_id: 'r3', branch: 'staging', value_hash: 'hs' },
        ],
      },
    };

    const fm = new FileManager(TEST_DIR);
    fm.writeKeepFile(keep);

    const pm = new ProjectManager(TEST_DIR);
    const round = pm.readKeepFile()!;
    const byBranch = Object.fromEntries(round.variables.API_KEY.map((e) => [e.branch, e]));
    expect(byBranch.development.changed_at).toBe('2026-06-10T12:00:00.000Z');
    expect(byBranch.prod.changed_at).toBe('2026-01-15T08:30:00.000Z');
    expect(byBranch.staging.changed_at).toBeUndefined();
  });

  test('multiple branch entries each keep their connector independently', () => {
    const devConnector: ConnectorMetadata = {
      provider: 'stripe', source: 'cli', mode: 'test',
      created_at: 1700000000, fingerprint: 'rk_…aaa',
    };
    const mainConnector: ConnectorMetadata = {
      provider: 'stripe', source: 'cli', mode: 'live',
      created_at: 1700000000, fingerprint: 'rk_…bbb',
    };
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        STRIPE_KEY: [
          { resource_id: 'r1', branch: 'development', value_hash: 'hd', connector: devConnector },
          { resource_id: 'r1', branch: 'main', value_hash: 'hm', connector: mainConnector },
        ],
      },
    };

    const fm = new FileManager(TEST_DIR);
    fm.writeKeepFile(keep);

    const pm = new ProjectManager(TEST_DIR);
    const round = pm.readKeepFile()!;
    const byBranch = Object.fromEntries(
      round.variables.STRIPE_KEY.map((e) => [e.branch, e]),
    );
    expect(byBranch.development.connector).toEqual(devConnector);
    expect(byBranch.main.connector).toEqual(mainConnector);
  });
});
