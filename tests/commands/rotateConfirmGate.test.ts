/**
 * `capy rotate`'s plan confirm gate (CAP-659 / CAP-520).
 *
 * The gate at the bottom of `RotateCommand.planAndRotate` used to be
 * `if (!opts.skipPrompts && web) {…} else if (!opts.skipPrompts && isTTY) {…}`
 * with no `else`. A piped run with no `--web` and no `--yes` — exactly the
 * shape of every agent/CI invocation — satisfied neither branch and fell
 * straight through to `rotateMany()`: the credential was rotated, pushed and
 * (if a target was configured) deployed, with nothing having asked "Proceed?"
 * and nothing having answered it.
 *
 * This file proves the fixed, exhaustive gate from the outside, the same way
 * `rotatePromotesThenRotates.test.ts` does: mock the two collaborators either
 * side of the decision (the provider's `rotate()`, and `resolveContext`/
 * `writeAndSync`) and drive `RotateCommand.execute()` for real.
 *
 * Uses `mock.module()` — must run isolated (see `tests/run-tests.sh`).
 */
import { mock, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';
// Imported for real, BEFORE the mock below is registered — see
// `rotatePromotesThenRotates.test.ts` for why (the partial mock spreads it).
import * as realShared from '../../src/commands/connectors/shared';

const TEST_DIR = join(tmpdir(), `capy-rotate-confirm-gate-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

const CONNECTOR: ConnectorMetadata = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_1234',
  created_at: 1700000000,
  fingerprint: 'rk_…tst',
};

const KEEP_CONTENTS = JSON.stringify(
  {
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'demo',
    variables: {
      STRIPE_SECRET_KEY: [
        { resource_id: 'r-1', branch: 'development', value_hash: 'h-1', connector: CONNECTOR },
      ],
    },
  } satisfies KeepFile,
  null,
  2,
);

const ENV_CONTENTS = '# capy-managed\nSTRIPE_SECRET_KEY=enc:unchanged\n';

/** What the two mocked collaborators either side of the gate saw. */
const seen = {
  rotated: [] as string[],
  resolvedContext: 0,
  written: [] as Array<{ varName: string; value: string | undefined }>,
  deployed: [] as string[],
};

let promptAnswer = { proceed: true };

// The provider: its `rotate()` is the one call that must never happen while
// the gate is unanswered.
mock.module(join(import.meta.dir, '../../src/commands/connectors/registry.ts'), () => ({
  listProviders: () => [{ name: 'stripe', description: 'Stripe' }],
  loadProvider: async () => ({
    name: 'stripe',
    description: 'Stripe',
    requiresAuth: true,
    rotate: async (_ctx: unknown, varName: string) => {
      seen.rotated.push(varName);
      return { value: 'example-rotated-value-not-a-secret', entry: { ...CONNECTOR, rotated_at: 1 } };
    },
  }),
}));

// `resolveContext` is the first network-shaped call `rotateMany` makes —
// counting it is how "zero provider calls" is proven for the refusal cases.
mock.module(join(import.meta.dir, '../../src/commands/connectors/shared.ts'), () => ({
  ...realShared,
  resolveContext: async () => {
    seen.resolvedContext += 1;
    return { keep: readKeep(), branch: 'development', localPlaintext: {} };
  },
  writeAndSync: async (_ctx: unknown, varName: string, value: string | undefined) => {
    seen.written.push({ varName, value });
  },
}));

mock.module(join(import.meta.dir, '../../src/commands/deployCommand.ts'), () => ({
  deployCommand: async (name: string) => {
    seen.deployed.push(name);
    return 0;
  },
  // Only reached by the `web || isTTY` branch of target resolution (no
  // deploy target is configured in this fixture). A fixed target keeps the
  // TTY tests inside the gate this file is about, instead of inside the
  // deploy-target setup wizard.
  ensureDeployTarget: async () => ({
    name: 'prod',
    kind: 'cf-worker',
    branch: 'development',
    vars: [],
    options: {},
  }),
}));

// Only loaded by the TTY branch — a canned answer, never rendered.
mock.module('inquirer', () => ({
  default: { prompt: async () => promptAnswer },
}));

function readKeep(): KeepFile {
  return JSON.parse(readFileSync(join(TEST_DIR, 'keep.lock'), 'utf-8'));
}

function writeFixture(): void {
  writeFileSync(join(TEST_DIR, 'keep.lock'), KEEP_CONTENTS, 'utf-8');
  writeFileSync(join(TEST_DIR, '.env'), ENV_CONTENTS, 'utf-8');
  mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
  writeFileSync(join(TEST_DIR, '.capy', 'branch'), 'development', 'utf-8');
}

/** Sentinel thrown by the mocked `process.exit`, carrying the code. */
class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`__exit_${code}__`);
  }
}

async function rotate(opts: Record<string, unknown>): Promise<{ exitCode?: number; stderr: string }> {
  let out = '';
  const record = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(record as never);
  try {
    const { RotateCommand } = await import('../../src/commands/rotateCommand');
    await new RotateCommand(false).execute('STRIPE_SECRET_KEY', opts as never);
    return { exitCode: undefined, stderr: out };
  } catch (err) {
    if (err instanceof ExitSignal) return { exitCode: err.code, stderr: out };
    throw err;
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  writeFixture();
  seen.rotated = [];
  seen.resolvedContext = 0;
  seen.written = [];
  seen.deployed = [];
  promptAnswer = { proceed: true };
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

describe('piped run, no --yes, no --web', () => {
  test('refuses with exit 3 and makes zero provider/push/deploy calls', async () => {
    // Piped stdin: no real TTY, and the caller passed neither --non-tty nor
    // --yes — the exact shape of the bug (`capy rotate KEY | cat`, or any
    // agent spawn with inherited pipes).
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    const keepBefore = readFileSync(join(TEST_DIR, 'keep.lock'));
    const envBefore = readFileSync(join(TEST_DIR, '.env'));

    const r = await rotate({});

    expect(r.exitCode).toBe(3); // EXIT_NEEDS_INPUT
    expect(r.stderr).toContain('non-interactive');
    expect(r.stderr.toLowerCase()).toContain('confirm');
    expect(r.stderr).toContain('--yes');

    expect(seen.rotated).toEqual([]);
    expect(seen.resolvedContext).toBe(0);
    expect(seen.written).toEqual([]);
    expect(seen.deployed).toEqual([]);

    // Nothing on disk moved either.
    expect(readFileSync(join(TEST_DIR, 'keep.lock'))).toEqual(keepBefore);
    expect(readFileSync(join(TEST_DIR, '.env'))).toEqual(envBefore);
  });
});

describe('--non-tty, no --yes', () => {
  test('refuses the same way, even if stdin happens to report a TTY', async () => {
    // `--non-tty` has to win over a real terminal, the same as every other
    // non-interactive gate in this file (`isInteractive(opts.nonTty)`).
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const r = await rotate({ nonTty: true });

    expect(r.exitCode).toBe(3);
    expect(seen.rotated).toEqual([]);
    expect(seen.resolvedContext).toBe(0);
    expect(seen.written).toEqual([]);
    expect(seen.deployed).toEqual([]);
  });
});

describe('--yes (or --skip-prompts)', () => {
  test('proceeds exactly as before: no prompt, no refusal, the key is rotated', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

    const r = await rotate({ skipPrompts: true });

    expect(r.exitCode).toBeUndefined();
    expect(seen.rotated).toEqual(['STRIPE_SECRET_KEY']);
    // Once to build the rotate context, once more for the fresh write after
    // — that's `rotateSequentially`'s own shape, unrelated to this gate.
    expect(seen.resolvedContext).toBe(2);
    expect(seen.written).toEqual([
      { varName: 'STRIPE_SECRET_KEY', value: 'example-rotated-value-not-a-secret' },
    ]);
    // No deploy target is configured in this fixture, so none is attempted —
    // a separate fact from the gate this file is about.
    expect(seen.deployed).toEqual([]);
  });
});

describe('a real TTY, no --yes', () => {
  test('still asks inquirer, and still honours "no" — unchanged by the fix', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    promptAnswer = { proceed: false };

    const r = await rotate({});

    expect(r.exitCode).toBeUndefined(); // declining is `return`, not an exit
    expect(seen.rotated).toEqual([]);
    expect(seen.resolvedContext).toBe(0);
  });

  test('and still honours "yes"', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    promptAnswer = { proceed: true };

    const r = await rotate({});

    expect(r.exitCode).toBeUndefined();
    expect(seen.rotated).toEqual(['STRIPE_SECRET_KEY']);
  });
});
