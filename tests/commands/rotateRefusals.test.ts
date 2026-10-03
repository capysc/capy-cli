/**
 * `capy rotate`'s early refusals: no keep.lock, no active branch, nothing
 * managed under `--all`, an unknown variable, no variables at all.
 *
 * Each one prints its sentence to the terminal, exits 1, and opens nothing:
 * the tests run the real command against a real keep.lock and read what it
 * wrote.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-rotate-refusals-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

/** The loopback address a page would print. No refusal may print one. */
const PRINTED_URL = /http:\/\/127\.0\.0\.1:\d+\//;

const stripeConnector: ConnectorMetadata = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_test',
  created_at: 1700000000,
  fingerprint: 'rk_…tst',
};

/**
 * A project on disk. `branch` writes `.capy/branch`; leaving it out is how the
 * "no active branch" case is reached, since `deriveActiveBranch` falls back to
 * a SOLE branch in keep.lock and only gives up when there are several.
 */
function writeFixture(opts: {
  branch?: string;
  vars?: Array<{ name: string; branch: string; managed?: boolean }>;
}) {
  const variables: KeepFile['variables'] = {};
  for (const v of opts.vars ?? []) {
    variables[v.name] = [
      {
        resource_id: `r-${v.name}`,
        branch: v.branch,
        value_hash: `h-${v.name}`,
        ...(v.managed ? { connector: stripeConnector } : {}),
      },
    ];
  }
  const keep: KeepFile = {
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    variables,
  };
  writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
  if (opts.branch) {
    mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.capy', 'branch'), opts.branch, 'utf-8');
  }
}

/** Runs a command that is expected to refuse; hands back its exit code and everything it wrote. */
async function refusalInTerminal(run: () => Promise<void>): Promise<{ exitCode: number | undefined; output: string }> {
  let exitCode: number | undefined;
  let out = '';
  const record =
    () =>
    (...args: unknown[]) => {
      out += args.map(String).join(' ') + '\n';
    };
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(record());
  const errSpy = spyOn(console, 'error').mockImplementation(record());
  try {
    await run().catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.startsWith('__exit_')) throw err;
    });
    return { exitCode, output: out };
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

async function rotate(varName: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const { RotateCommand } = await import('../../src/commands/rotateCommand');
  await new RotateCommand(false).execute(varName, opts as never);
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

/** The terminal half is allowed its bold; the words are what matter. */
const plain = (output: string): string => output.replace(/\x1b\[[0-9;]*m/g, '');

describe('every early refusal in rotate reaches the terminal and exits 1', () => {
  test('an unknown variable names itself, its branch, and the names that would have worked', async () => {
    writeFixture({
      branch: 'development',
      vars: [
        { name: 'DATABASE_URL', branch: 'development' },
        { name: 'STRIPE_SECRET_KEY', branch: 'development', managed: true },
      ],
    });

    const r = await refusalInTerminal(() => rotate('NOPE', {}));
    const text = plain(r.output);

    expect(text).toContain('Variable not found');
    expect(text).toContain('NOPE is not in your environment on branch development.');
    // The alternatives, which is the part that lets a caller correct itself
    // instead of stopping.
    expect(text).toContain('Available: DATABASE_URL, STRIPE_SECRET_KEY');
    expect(PRINTED_URL.test(r.output)).toBe(false);
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a directory that was never initialised', async () => {
    // No keep.lock at all — the very first thing `execute` checks.
    const r = await refusalInTerminal(() => rotate('ANY', {}));
    expect(plain(r.output)).toContain('No keep.lock file found');
    expect(PRINTED_URL.test(r.output)).toBe(false);
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a keep.lock whose branch cannot be derived', async () => {
    // Two branches and nothing that picks between them: no `.env` header, no
    // `.capy/branch`, no sync state. `deriveActiveBranch` returns null rather
    // than inventing a default, and rotate must say so.
    writeFixture({
      vars: [
        { name: 'A', branch: 'development' },
        { name: 'B', branch: 'staging' },
      ],
    });
    const r = await refusalInTerminal(() => rotate('A', {}));
    expect(plain(r.output)).toContain('No active branch');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('--all with nothing managed on the branch', async () => {
    writeFixture({
      branch: 'development',
      vars: [{ name: 'DATABASE_URL', branch: 'development' }],
    });
    const r = await refusalInTerminal(() => rotate(undefined, { all: true }));
    expect(plain(r.output)).toContain('No managed keys to rotate on this branch');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a branch with no variables at all', async () => {
    // The picker's own precondition. Reached with no variable named, which is
    // the invocation an agent makes when it wants to be offered a list.
    writeFixture({
      branch: 'development',
      vars: [{ name: 'A', branch: 'staging' }],
    });
    const r = await refusalInTerminal(() => rotate(undefined, {}));
    expect(plain(r.output)).toContain('No variables on this branch yet');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('no refusal carries a secret, only names and codes', async () => {
    // Every one of these refusals happens before anything is decrypted, and
    // the text is built from keep.lock — which holds hashes and fingerprints,
    // never values.
    writeFixture({
      branch: 'development',
      vars: [{ name: 'STRIPE_SECRET_KEY', branch: 'development', managed: true }],
    });
    const r = await refusalInTerminal(() => rotate('NOPE', {}));
    expect(r.output).toContain('STRIPE_SECRET_KEY');
    expect(r.output).not.toContain('h-STRIPE_SECRET_KEY');
    expect(r.output).not.toContain('value_hash');
  }, 30_000);
});
