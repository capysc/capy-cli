/**
 * E2E coverage for the Stripe connector's safety machinery.
 *
 * Scope: things that must NEVER break, even in unrelated refactors:
 *   - Dev-mode (`capy-dev`) hard-blocks `--live` connects before any auth.
 *   - Dev-mode hard-blocks rotating a `mode:'live'` managed key (single var).
 *   - Dev-mode `--all` skips live entries with a warning, continues with test.
 *   - validateRestrictedKey shape + mode-match guard (kept exported as a
 *     guard for any future code path that handles a Stripe key value).
 *
 * The connect/rotate happy paths against real Stripe + real service live in
 * `tests/e2e/stripe-connector.sh` (manual runbook). They're hard to mock
 * faithfully (auth + WorkOS + S3 + browser-based stripe login + inquirer
 * prompts) and the manual runbook covers the same ground against the real
 * stack with higher fidelity.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProjectManager } from '../../src/core/projectManager';
import { ConnectorMetadata, KeepFile } from '../../src/types/index';
import { validateRestrictedKey } from '../../src/commands/connectors/stripe';

const TEST_DIR = join(tmpdir(), `capy-stripe-e2e-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function writeFixture(opts: {
  liveConnector?: boolean;
  testConnector?: boolean;
  branch?: string;
}) {
  const branch = opts.branch ?? 'development';
  const variables: KeepFile['variables'] = {};

  if (opts.testConnector) {
    const connector: ConnectorMetadata = {
      provider: 'stripe',
      source: 'cli',
      mode: 'test',
      account_id: 'acct_test',
      created_at: 1700000000,
      fingerprint: 'rk_…tst',
    };
    variables.STRIPE_TEST_KEY = [{
      resource_id: 'r-test', branch, value_hash: 'h-test', connector,
    }];
  }
  if (opts.liveConnector) {
    const connector: ConnectorMetadata = {
      provider: 'stripe',
      source: 'cli',
      mode: 'live',
      account_id: 'acct_live',
      created_at: 1700000000,
      fingerprint: 'rk_…lve',
    };
    variables.STRIPE_LIVE_KEY = [{
      resource_id: 'r-live', branch, value_hash: 'h-live', connector,
    }];
  }

  const keep: KeepFile = {
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    variables,
  };

  mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
  writeFileSync(join(TEST_DIR, '.capy', 'branch'), branch, 'utf-8');
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('live-mode firewall (capy-dev)', () => {
  test('ConnectCommand(devMode=true) with --live exits before any auth or precheck', async () => {
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`__exit_${code}__`);
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { ConnectCommand } = await import('../../src/commands/connectCommand');
      await new ConnectCommand(true).execute('stripe', { live: true });
    } catch (err: any) {
      // expected: process.exit threw
      if (!String(err.message).startsWith('__exit_')) throw err;
    }

    expect(exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorOutput).toContain('Live mode is not allowed in dev mode');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('RotateCommand(devMode=true) on a single live var exits before precheck', async () => {
    writeFixture({ liveConnector: true });

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`__exit_${code}__`);
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { RotateCommand } = await import('../../src/commands/rotateCommand');
      await new RotateCommand(true).execute('STRIPE_LIVE_KEY', {});
    } catch (err: any) {
      if (!String(err.message).startsWith('__exit_')) throw err;
    }

    expect(exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorOutput).toContain('configured for live mode');
    expect(errorOutput).toContain('production `capy` binary');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('RotateCommand(devMode=true) --all skips live entries when only live keys exist', async () => {
    writeFixture({ liveConnector: true });

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`__exit_${code}__`);
    });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { RotateCommand } = await import('../../src/commands/rotateCommand');
      await new RotateCommand(true).execute(undefined, { all: true });
    } catch (err: any) {
      if (!String(err.message).startsWith('__exit_')) throw err;
    }

    // Should warn about skipping the live entry, then exit because nothing left.
    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const errorOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('skipping STRIPE_LIVE_KEY');
    expect(logOutput).toContain('live mode');
    expect(errorOutput).toContain('All managed keys are live-mode');
    expect(exitCode).toBe(1);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('mode-matched paste validation', () => {
  test('rejects a live key when test mode is selected', () => {
    const result = validateRestrictedKey('rk_live_abcdefgh', 'test');
    expect(typeof result).toBe('string');
    expect(result).toContain('live-mode key');
  });

  test('rejects a test key when live mode is selected', () => {
    const result = validateRestrictedKey('rk_test_abcdefgh', 'live');
    expect(typeof result).toBe('string');
    expect(result).toContain('test-mode key');
  });

  test('accepts a matched test key', () => {
    expect(validateRestrictedKey('rk_test_abcdefgh', 'test')).toBe(true);
  });

  test('accepts a matched live key', () => {
    expect(validateRestrictedKey('rk_live_abcdefgh', 'live')).toBe(true);
  });

  test('without a mode hint, only checks prefix', () => {
    expect(validateRestrictedKey('rk_test_abcdefgh')).toBe(true);
    expect(validateRestrictedKey('rk_live_abcdefgh')).toBe(true);
    expect(typeof validateRestrictedKey('garbage')).toBe('string');
  });
});

describe('keep.lock connector schema', () => {
  test('listManagedKeys returns the entries on the active branch', async () => {
    writeFixture({ testConnector: true, liveConnector: true });
    const { listManagedKeys } = await import('../../src/commands/connectors/shared');
    const pm = new ProjectManager(TEST_DIR);
    const keep = pm.readKeepFile();
    expect(keep).not.toBeNull();
    const managed = listManagedKeys(keep!, pm.readActiveBranch());
    const names = managed.map((m) => m.varName).sort();
    expect(names).toEqual(['STRIPE_LIVE_KEY', 'STRIPE_TEST_KEY']);
  });
});
