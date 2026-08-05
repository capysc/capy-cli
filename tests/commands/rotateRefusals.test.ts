/**
 * `capy rotate --web` refuses onto a PAGE, not into a terminal nobody reads.
 *
 * Rotate had six exits above its first `--web` branch — no keep.lock, no
 * active branch, nothing managed under `--all`, an unknown variable, no
 * variables at all, no connectors registered. Every one of them was
 * `console.error(…)` + `process.exit(1)`. The exit code was right and the
 * sentence was right, and under `--web` neither reached a surface: the flag
 * exists because the caller is an agent, so the stream those lines went to has
 * nobody on the other end. `capy rotate NOPE --web` was the one-line
 * demonstration — a run that produced no output an agent could see, and no
 * page, and no way to find out that the name was simply wrong.
 *
 * WHY THIS FILE AND NOT A SOURCE GUARD. `webContextThreading.test.ts` reads
 * the source because the defect there is a missing ARGUMENT, which has no
 * runtime signature short of driving a deploy. This defect does have one: a
 * loopback URL gets printed and a page gets served, or it does not. So these
 * tests run the real command against a real keep.lock, take the URL out of its
 * own output, and fetch it — which is exactly what an agent would do, and the
 * only check that cannot pass while the page is undeliverable.
 *
 * The other half of the contract is here too: a run WITHOUT `--web` must not
 * grow a browser window, and must not hold itself open waiting for one.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWebMode } from '../../src/ui/webMode';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';

// The suite's own backstop is in `run-tests.sh`, but this file drives command
// code that opens a browser on the way to its ending page. A single-file run
// (`bun test tests/commands/rotateRefusals.test.ts`) must not launch the
// developer's Chrome, so set it here as well as there.
process.env.CAPY_WEB_NO_OPEN = '1';

const TEST_DIR = join(tmpdir(), `capy-rotate-refusals-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

/** The loopback address an ending page prints — `ScreenServer`'s `/s/<token>`. */
const PRINTED_URL = /http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+/;

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

interface Refusal {
  /** The served document, fetched the way a browser would. */
  page: string;
  url: string;
  exitCode: number | undefined;
  /** Everything the run wrote to a terminal, both streams. */
  output: string;
}

async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Run a `--web` command that is expected to refuse, and hand back its page.
 *
 * The fetch is not optional and not merely an assertion: `serveEndingPage`
 * holds the run open until the browser has the document, so a caller that
 * never collects it is the same as a browser that never came. Fetching is what
 * lets the command reach its exit at all.
 */
async function refusalUnderWeb(run: () => Promise<void>): Promise<Refusal> {
  setWebMode(true);
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
    const done = run().catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.startsWith('__exit_')) throw err;
    });
    const url = await until(() => out.match(PRINTED_URL)?.[0], 'the run to print a loopback URL');
    const page = await (await fetch(url)).text();
    await done;
    return { page, url, exitCode, output: out };
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    setWebMode(false);
  }
}

/** The same, with no `--web`: nothing should be served and nothing awaited. */
async function refusalInTerminal(run: () => Promise<void>): Promise<Omit<Refusal, 'page' | 'url'>> {
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
  setWebMode(false);
});

describe('every early refusal in rotate reaches a page under --web', () => {
  test('an unknown variable names itself, its branch, and the names that would have worked', async () => {
    // `capy rotate NOPE --web`. The demonstration case.
    writeFixture({
      branch: 'development',
      vars: [
        { name: 'DATABASE_URL', branch: 'development' },
        { name: 'STRIPE_SECRET_KEY', branch: 'development', managed: true },
      ],
    });

    const r = await refusalUnderWeb(() => rotate('NOPE', { web: true }));

    expect(r.page).toContain('window.__CAPY_DATA__');
    // The code, because the reader is usually not a person.
    expect(r.page).toContain('VARIABLE_NOT_FOUND');
    expect(r.page).toContain('Variable not found');
    expect(r.page).toContain('NOPE is not in your environment on branch development.');
    // The alternatives, which is the part that lets a caller correct itself
    // instead of stopping.
    expect(r.page).toContain('DATABASE_URL, STRIPE_SECRET_KEY');
    // A refusal that ends on a page is still a refusal.
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a directory that was never initialised', async () => {
    // No keep.lock at all — the very first thing `execute` checks.
    const r = await refusalUnderWeb(() => rotate('ANY', { web: true }));
    expect(r.page).toContain('NO_KEEP_FILE');
    expect(r.page).toContain('No keep.lock file found');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a keep.lock whose branch cannot be derived', async () => {
    // Two branches and nothing that picks between them: no `.env` header, no
    // `.capy/branch`, no sync state. `deriveActiveBranch` returns null rather
    // than inventing a default, and rotate must say so somewhere visible.
    writeFixture({
      vars: [
        { name: 'A', branch: 'development' },
        { name: 'B', branch: 'staging' },
      ],
    });
    const r = await refusalUnderWeb(() => rotate('A', { web: true }));
    expect(r.page).toContain('NO_ACTIVE_BRANCH');
    expect(r.page).toContain('No active branch');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('--all with nothing managed on the branch', async () => {
    writeFixture({
      branch: 'development',
      vars: [{ name: 'DATABASE_URL', branch: 'development' }],
    });
    const r = await refusalUnderWeb(() => rotate(undefined, { web: true, all: true }));
    expect(r.page).toContain('NO_MANAGED_KEYS');
    expect(r.page).toContain('No managed keys to rotate on this branch');
    expect(r.page).toContain('development');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('a branch with no variables at all', async () => {
    // The picker's own precondition. Reached with no variable named, which is
    // the invocation an agent makes when it wants to be offered a list.
    writeFixture({
      branch: 'development',
      vars: [{ name: 'A', branch: 'staging' }],
    });
    const r = await refusalUnderWeb(() => rotate(undefined, { web: true }));
    expect(r.page).toContain('NO_VARIABLES');
    expect(r.page).toContain('No variables on this branch yet');
    expect(r.exitCode).toBe(1);
  }, 30_000);

  test('no page carries a secret, only names and codes', async () => {
    // Every one of these refusals happens before anything is decrypted, and
    // the payload is built from keep.lock — which holds hashes and
    // fingerprints, never values. Worth pinning: an "available variables" list
    // is one careless join away from being an environment dump.
    writeFixture({
      branch: 'development',
      vars: [{ name: 'STRIPE_SECRET_KEY', branch: 'development', managed: true }],
    });
    const r = await refusalUnderWeb(() => rotate('NOPE', { web: true }));
    expect(r.page).toContain('STRIPE_SECRET_KEY');
    expect(r.page).not.toContain('h-STRIPE_SECRET_KEY');
    expect(r.page).not.toContain('value_hash');
  }, 30_000);

  test('no ANSI escape reaches the document', async () => {
    // The CLI bolds its own sentences on the way to a terminal, and those
    // codes render as a literal `[1m` inside a page.
    writeFixture({ branch: 'development', vars: [{ name: 'A', branch: 'development' }] });
    const r = await refusalUnderWeb(() => rotate('NOPE', { web: true }));
    expect(r.page.includes(String.fromCharCode(27))).toBe(false);
    expect(r.page.includes('[1m')).toBe(false);
  }, 30_000);
});

describe('a run without --web grows no window', () => {
  test('the sentence still goes to the terminal, and nothing is served', async () => {
    // The other half of the contract. This must not turn every terminal
    // failure into a browser window, and must not hold a plain run open
    // waiting for a browser nobody asked for.
    writeFixture({
      branch: 'development',
      vars: [{ name: 'DATABASE_URL', branch: 'development' }],
    });
    const r = await refusalInTerminal(() => rotate('NOPE', {}));
    // Stripped, because the terminal half is allowed its bold — that is the
    // whole difference between the two surfaces.
    const text = r.output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('NOPE is not in your environment on branch development.');
    expect(text).toContain('Available: DATABASE_URL');
    expect(PRINTED_URL.test(r.output)).toBe(false);
    expect(r.exitCode).toBe(1);
  }, 30_000);
});
