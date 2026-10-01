/**
 * `capy remove NAME [NAME...]` (CAP-686).
 *
 * Three layers, tested at the layer where they're cheapest to prove:
 *  - the pure helpers (`computeDrift`, `deployTargetWarnings`,
 *    `confirmationMessage`, `pinnedHashesFor`) — plain unit tests, no I/O;
 *  - `removeAndSync` (`connectors/shared.ts`) — the actual push mechanics,
 *    exercised the same way `writeImportedAndSync`'s own tests
 *    (`connectDokploy.test.ts`) do: a hand-built `ResolvedContext` with a
 *    mocked `serviceClient.pushSecrets` and a real `FileManager` writing
 *    into a throwaway directory, so `.env`'s layout survives for real;
 *  - `RemoveCommand.execute`'s local-only refusals (VAR_NOT_FOUND, the
 *    non-interactive/--json confirmation gate) and `proceedWithRemoval`'s
 *    drift refusal / deploy-target warning / --json purity — driven end to
 *    end against a real temp project directory, the same pattern
 *    `rotateRefusals.test.ts` uses, with no auth or network involved because
 *    every one of these paths returns before `resolveContext()` is reached.
 *
 * No `let`/mutation (house style, CARDINAL RULE 1): captured stdout/stderr,
 * exit codes and mock call args all come from the mock library's own
 * `.mock.calls` (its state, not ours) via pure rendering — see
 * `tests/commands/agentsCommand.test.ts`'s identical `capture`/`ExitSignal`
 * pattern, copied here rather than reinvented.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeDrift,
  deployTargetWarnings,
  confirmationMessage,
  pinnedHashesFor,
  proceedWithRemoval,
  previewRemoval,
  RemoveCommand,
} from '../../src/commands/removeCommand';
import { removeAndSync, ResolvedContext } from '../../src/commands/connectors/shared';
import { hashValue } from '../../src/commands/statusCommand';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { upsertTarget } from '../../src/deploy/config';
import { TargetConfig } from '../../src/deploy/adapter';
import type { KeepFile } from '../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-remove-cmd-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function baseTarget(over: Partial<TargetConfig> = {}): TargetConfig {
  return {
    name: 'prod',
    kind: 'cf-worker',
    branch: 'development',
    vars: [],
    options: {},
    ...over,
  };
}

/** Sentinel thrown by the mocked `process.exit`, carrying the exit code — never lets a test actually exit the runner. */
class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('process.exit called');
  }
}

/** Renders a spy's captured calls the way `console.log(...args)` would have joined and printed them. */
function renderCalls(calls: readonly unknown[][]): string {
  if (calls.length === 0) return '';
  return calls.map((args) => args.map(String).join(' ')).join('\n') + '\n';
}

/** Runs `fn`, returning the code passed to `process.exit`, or `undefined` if it never called it. */
async function exitCodeOf(fn: () => Promise<void>): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

/** Runs `fn`, capturing stdout/stderr and the exit code — never lets `process.exit` actually exit the test runner. */
async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const exitCode = await exitCodeOf(fn);
    return { exitCode, stdout: renderCalls(logSpy.mock.calls), stderr: renderCalls(errSpy.mock.calls) };
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── pure helpers ─────────────────────────────────────────────────────────

describe('computeDrift', () => {
  test('flags a value changed locally, a new-locally value, and a pinned value missing from .env', () => {
    const pinned = { CHANGED: hashValue('old'), MISSING: hashValue('gone'), INSYNC: hashValue('same') };
    const local = { CHANGED: 'new', NEW_LOCAL: 'brand-new', INSYNC: 'same' };
    expect(computeDrift(pinned, local, [])).toEqual(['CHANGED', 'MISSING', 'NEW_LOCAL']);
  });

  test('excludes the names being removed even when they themselves are drifted', () => {
    const pinned = { REMOVED: hashValue('old') };
    const local = { REMOVED: 'changed-but-being-removed-anyway' };
    expect(computeDrift(pinned, local, ['REMOVED'])).toEqual([]);
  });

  test('nothing drifted → empty array', () => {
    const pinned = { A: hashValue('a'), B: hashValue('b') };
    const local = { A: 'a', B: 'b' };
    expect(computeDrift(pinned, local, [])).toEqual([]);
  });
});

describe('deployTargetWarnings', () => {
  test('names every target whose vars include a removed name', () => {
    upsertTarget(TEST_DIR, baseTarget({ name: 'prod', vars: ['STRIPE_KEY', 'OTHER'] }));
    upsertTarget(TEST_DIR, baseTarget({ name: 'staging', vars: ['STRIPE_KEY'] }));
    upsertTarget(TEST_DIR, baseTarget({ name: 'unrelated', vars: ['OTHER'] }));

    const warnings = deployTargetWarnings(TEST_DIR, ['STRIPE_KEY']);
    expect(warnings.toSorted((a, b) => a.target.localeCompare(b.target))).toEqual([
      { target: 'prod', variable: 'STRIPE_KEY' },
      { target: 'staging', variable: 'STRIPE_KEY' },
    ]);
  });

  test('no deploy.json at all → no warnings', () => {
    expect(deployTargetWarnings(TEST_DIR, ['ANYTHING'])).toEqual([]);
  });

  test('no target references the removed name → no warnings', () => {
    upsertTarget(TEST_DIR, baseTarget({ name: 'prod', vars: ['OTHER'] }));
    expect(deployTargetWarnings(TEST_DIR, ['STRIPE_KEY'])).toEqual([]);
  });
});

describe('confirmationMessage', () => {
  test('names the variables and the branch', () => {
    expect(confirmationMessage(['A', 'B'], 'development', false)).toBe('Remove A, B from development?');
  });

  test('says explicitly when it clears the whole branch', () => {
    expect(confirmationMessage(['A'], 'development', true)).toBe(
      'Remove A from development — this removes EVERY variable on this branch?',
    );
  });
});

describe('pinnedHashesFor', () => {
  test('picks each variable\'s entry for the given branch, ignoring other branches', () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        A: [
          { resource_id: 'r1', branch: 'development', value_hash: 'hash-dev' },
          { resource_id: 'r1b', branch: 'staging', value_hash: 'hash-staging' },
        ],
        B: [{ resource_id: 'r2', branch: 'staging', value_hash: 'hash-b-staging' }],
      },
    };
    expect(pinnedHashesFor(keep, 'development')).toEqual({ A: 'hash-dev' });
  });
});

// ── removeAndSync — the actual push mechanics ───────────────────────────

describe('removeAndSync', () => {
  function ctxWith(over: Partial<ResolvedContext>): ResolvedContext {
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    return {
      pm: { readSyncState: () => null },
      orgId: 'o',
      projectId: 'p',
      branch: 'development',
      userId: 'u',
      projectKey: 'test-key',
      keep,
      localPlaintext: {},
      ...over,
    } as unknown as ResolvedContext;
  }

  /** Isolates `writeKeepCache`'s (best-effort) disk write from this developer's real ~/.capy — same pattern connectDokploy.test.ts uses for the identical push:true path. */
  async function withIsolatedGlobalDir(tag: string, fn: () => Promise<void>): Promise<void> {
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = `.capy-test-${process.pid}-${Date.now()}-${tag}`;
    try {
      await fn();
    } finally {
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
    }
  }

  test('happy path: the pushed blob lacks the removed names, keep.lock drops the branch entry, other branches survive, and .env keeps comments', async () => {
    await withIsolatedGlobalDir('happy', async () => {
      const envPath = join(TEST_DIR, '.env');
      writeFileSync(
        envPath,
        [
          '# --- Infra ---',
          'FOO=foo-value',
          'BAR=bar-value # keep this note',
          '',
          '# --- Other ---',
          'BAZ=baz-value',
          '',
        ].join('\n'),
        'utf-8',
      );

      const keep: KeepFile = {
        version: '3.0',
        org_id: 'o',
        project_id: 'p',
        project_name: 'demo',
        variables: {
          FOO: [
            { resource_id: 'r1', branch: 'development', value_hash: hashValue('foo-value') },
            { resource_id: 'r1b', branch: 'staging', value_hash: 'staging-hash-untouched' },
          ],
          BAR: [{ resource_id: 'r2', branch: 'development', value_hash: hashValue('bar-value') }],
          BAZ: [{ resource_id: 'r3', branch: 'development', value_hash: hashValue('baz-value') }],
        },
      };

      const pushSecrets = mock(async () => ({ keep_hash: 'h'.repeat(16) }));

      const ctx = ctxWith({
        pm: new ProjectManager(TEST_DIR) as unknown as ResolvedContext['pm'],
        fileManager: new FileManager(TEST_DIR) as unknown as ResolvedContext['fileManager'],
        serviceClient: { pushSecrets } as unknown as ResolvedContext['serviceClient'],
        keep,
        localPlaintext: { FOO: 'foo-value', BAR: 'bar-value', BAZ: 'baz-value' },
      });

      await removeAndSync(ctx, ['BAR']);

      expect(pushSecrets.mock.calls.length).toBe(1);
      const [, pushedKeepFile, pushedEnvBlob] = pushSecrets.mock.calls[0];
      // The pushed keep.lock carries FOO and BAZ; BAR's branch entry is gone
      // entirely (it had no other-branch entries to fall back to).
      const pushedKeep = JSON.parse(pushedKeepFile as string) as KeepFile;
      expect(Object.keys(pushedKeep.variables).toSorted()).toEqual(['BAZ', 'FOO']);
      // FOO's staging entry — a DIFFERENT branch — survives untouched.
      expect(pushedKeep.variables.FOO.find((e) => e.branch === 'staging')?.value_hash).toBe(
        'staging-hash-untouched',
      );
      // The pushed env blob has no BAR entry at all.
      expect(pushedEnvBlob as string).not.toContain('BAR=');
      expect(pushedEnvBlob as string).toContain('FOO=');
      expect(pushedEnvBlob as string).toContain('BAZ=');

      // keep.lock on disk: BAR is gone, FOO/BAZ remain.
      const writtenKeep = JSON.parse(readFileSync(join(TEST_DIR, 'keep.lock'), 'utf-8')) as KeepFile;
      expect(writtenKeep.variables.BAR).toBeUndefined();
      expect(writtenKeep.variables.FOO).toBeDefined();
      expect(writtenKeep.variables.BAZ).toBeDefined();

      // .env on disk: BAR's line is gone; the comments/dividers/blank lines
      // and FOO/BAZ's positions survive (envUpsert.ts).
      const envText = readFileSync(envPath, 'utf-8');
      expect(envText).toContain('# --- Infra ---');
      expect(envText).toContain('# --- Other ---');
      expect(envText).not.toMatch(/^BAR=/m);
    });
  });

  test('removing every variable on the branch leaves keep.lock with none of them', async () => {
    await withIsolatedGlobalDir('all', async () => {
      const envPath = join(TEST_DIR, '.env');
      writeFileSync(envPath, 'ONLY_ONE=value\n', 'utf-8');

      const keep: KeepFile = {
        version: '3.0',
        org_id: 'o',
        project_id: 'p',
        project_name: 'demo',
        variables: {
          ONLY_ONE: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('value') }],
        },
      };

      const pushSecrets = mock(async (_projectId: string, _keepFile: string, envBlob: string) => {
        expect(envBlob).toBe('');
        return { keep_hash: 'h'.repeat(16) };
      });

      const ctx = ctxWith({
        pm: new ProjectManager(TEST_DIR) as unknown as ResolvedContext['pm'],
        fileManager: new FileManager(TEST_DIR) as unknown as ResolvedContext['fileManager'],
        serviceClient: { pushSecrets } as unknown as ResolvedContext['serviceClient'],
        keep,
        localPlaintext: { ONLY_ONE: 'value' },
      });

      await removeAndSync(ctx, ['ONLY_ONE']);

      expect(pushSecrets.mock.calls.length).toBe(1);
      const pushedKeep = JSON.parse(pushSecrets.mock.calls[0][1] as string) as KeepFile;
      expect(Object.keys(pushedKeep.variables)).toEqual([]);
    });
  });
});

// ── proceedWithRemoval — drift refusal, deploy warning, --json purity ──

describe('proceedWithRemoval', () => {
  function ctxWith(over: Partial<ResolvedContext>): ResolvedContext {
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    return {
      pm: { readSyncState: () => null },
      fileManager: { writeKeepFile: () => {}, writeEncryptedEnvFile: () => {}, writeSyncState: () => {} },
      serviceClient: { pushSecrets: async () => ({ keep_hash: 'h'.repeat(16) }) },
      orgId: 'o',
      projectId: 'p',
      branch: 'development',
      userId: 'u',
      projectKey: 'test-key',
      keep,
      localPlaintext: {},
      ...over,
    } as unknown as ResolvedContext;
  }

  test('refuses with REMOVE_LOCAL_DRIFT when another variable has an unpushed local change', async () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('target-value') }],
        OTHER: [{ resource_id: 'r2', branch: 'development', value_hash: hashValue('old-other-value') }],
      },
    };
    const ctx = ctxWith({
      keep,
      localPlaintext: { TARGET: 'target-value', OTHER: 'a-changed-value-not-yet-pushed' },
    });

    const r = await capture(() => proceedWithRemoval(ctx, ['TARGET'], { json: false, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('OTHER');
    expect(r.stderr).toContain('unpushed local changes');
  });

  test('--json drift refusal is coded and pure JSON on stdout', async () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('target-value') }],
        OTHER: [{ resource_id: 'r2', branch: 'development', value_hash: hashValue('old') }],
      },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'target-value', OTHER: 'new-unpushed' } });

    const r = await capture(() => proceedWithRemoval(ctx, ['TARGET'], { json: true, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toEqual({ ok: false, code: 'REMOVE_LOCAL_DRIFT', error: expect.any(String), drifted: ['OTHER'] });
  });

  test('warns (stderr) about a deploy target still listing a removed variable, in human mode', async () => {
    upsertTarget(TEST_DIR, baseTarget({ name: 'prod', vars: ['TARGET', 'OTHER'] }));
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'v' } });

    const r = await capture(() => proceedWithRemoval(ctx, ['TARGET'], { json: false, cwd: TEST_DIR }));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('prod');
    expect(r.stderr).toContain('TARGET');
  });

  test('--json output is pure: a deploy-target warning lands in the `warnings` array, not on stdout as prose', async () => {
    upsertTarget(TEST_DIR, baseTarget({ name: 'prod', vars: ['TARGET'] }));
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'v' } });

    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await proceedWithRemoval(ctx, ['TARGET'], { json: true, cwd: TEST_DIR });
      // Exactly one console.log call, and it parses as JSON.
      expect(logSpy.mock.calls.length).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(parsed.removed).toEqual(['TARGET']);
      expect(parsed.branch).toBe('development');
      expect(parsed.warnings).toEqual([expect.stringContaining('prod')]);
      // Pure stdout: the warning never leaks onto stderr as prose under --json.
      expect(errSpy.mock.calls.length).toBe(0);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ── previewRemoval — CAP-659 dry-run half of proceedWithRemoval ─────────

describe('previewRemoval', () => {
  function ctxWith(over: Partial<ResolvedContext>): ResolvedContext {
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    return {
      pm: { readSyncState: () => null },
      fileManager: { writeKeepFile: () => {}, writeEncryptedEnvFile: () => {}, writeSyncState: () => {} },
      serviceClient: { pushSecrets: async () => ({ keep_hash: 'h'.repeat(16) }) },
      orgId: 'o',
      projectId: 'p',
      branch: 'development',
      userId: 'u',
      projectKey: 'test-key',
      keep,
      localPlaintext: {},
      ...over,
    } as unknown as ResolvedContext;
  }

  test('--yes: nothing unanswered (exit 0), one change per name, reversible:false', async () => {
    const keep: KeepFile = {
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'v' } });

    const r = await capture(() => previewRemoval(ctx, ['TARGET'], { json: true, yes: true, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({
      ok: true,
      dry_run: true,
      command: 'remove',
      changes: [{ where: 'capy_service', action: 'remove variable', target: 'TARGET (development)', reversible: false }],
      unanswered: [],
    });
  });

  test('no --yes: confirm is unanswered (exit 3), the change list is still populated', async () => {
    const keep: KeepFile = {
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'v' } });

    const r = await capture(() => previewRemoval(ctx, ['TARGET'], { json: true, yes: false, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.unanswered).toEqual([{ id: 'confirm', flag: '-y, --yes' }]);
    expect(parsed.changes).toEqual([{ where: 'capy_service', action: 'remove variable', target: 'TARGET (development)', reversible: false }]);
  });

  test('never calls removeAndSync-equivalent writes (no fileManager/serviceClient write mock ever gets called)', async () => {
    const writeKeepFile = () => { throw new Error('must not write keep.lock in a dry run'); };
    const writeEncryptedEnvFile = () => { throw new Error('must not write .env in a dry run'); };
    const pushSecrets = async () => { throw new Error('must not push in a dry run'); };
    const keep: KeepFile = {
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({
      keep,
      localPlaintext: { TARGET: 'v' },
      fileManager: { writeKeepFile, writeEncryptedEnvFile, writeSyncState: () => {} },
      serviceClient: { pushSecrets },
    } as any);

    const r = await capture(() => previewRemoval(ctx, ['TARGET'], { json: true, yes: true, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(0);
  });

  test('drift refusal fires exactly as it does for real — same code, same exit, same stream', async () => {
    const keep: KeepFile = {
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo',
      variables: {
        TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('target-value') }],
        OTHER: [{ resource_id: 'r2', branch: 'development', value_hash: hashValue('old') }],
      },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'target-value', OTHER: 'new-unpushed' } });

    const r = await capture(() => previewRemoval(ctx, ['TARGET'], { json: true, yes: true, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: false, code: 'REMOVE_LOCAL_DRIFT', error: expect.any(String), drifted: ['OTHER'] });
  });

  test('a deploy-target warning still prints to stderr, alongside the preview', async () => {
    upsertTarget(TEST_DIR, baseTarget({ name: 'prod', vars: ['TARGET'] }));
    const keep: KeepFile = {
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo',
      variables: { TARGET: [{ resource_id: 'r1', branch: 'development', value_hash: hashValue('v') }] },
    };
    const ctx = ctxWith({ keep, localPlaintext: { TARGET: 'v' } });

    const r = await capture(() => previewRemoval(ctx, ['TARGET'], { json: false, yes: true, cwd: TEST_DIR }));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('prod');
  });
});

// ── RemoveCommand.execute — local-only refusals (no auth reached) ──────

describe('RemoveCommand.execute local refusals', () => {
  function writeFixture(opts: { branch?: string; vars: Array<{ name: string; branch: string }> }) {
    const variables: KeepFile['variables'] = Object.fromEntries(
      opts.vars.map((v) => [v.name, [{ resource_id: `r-${v.name}`, branch: v.branch, value_hash: `h-${v.name}` }]]),
    );
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables };
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
    if (opts.branch) {
      mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.capy', 'branch'), opts.branch, 'utf-8');
    }
  }

  function run(names: string[], opts: Record<string, unknown>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
    return capture(() => new RemoveCommand(false).execute(names, opts as never));
  }

  test('VAR_NOT_FOUND lists exactly the missing names, in human mode', async () => {
    writeFixture({
      branch: 'development',
      vars: [
        { name: 'DATABASE_URL', branch: 'development' },
        { name: 'API_KEY', branch: 'development' },
      ],
    });
    process.chdir(TEST_DIR);

    const r = await run(['NOPE', 'API_KEY'], { yes: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('NOPE');
    expect(r.stderr).not.toContain('API_KEY is not');
  });

  test('VAR_NOT_FOUND under --json is coded and pure JSON on stdout', async () => {
    writeFixture({ branch: 'development', vars: [{ name: 'DATABASE_URL', branch: 'development' }] });
    process.chdir(TEST_DIR);

    const r = await run(['NOPE'], { yes: true, json: true });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('VAR_NOT_FOUND');
    expect(parsed.missing).toEqual(['NOPE']);
    expect(parsed.available).toEqual(['DATABASE_URL']);
  });

  test('--json without --yes is refused as REMOVE_NEEDS_TTY, never prompts', async () => {
    writeFixture({ branch: 'development', vars: [{ name: 'DATABASE_URL', branch: 'development' }] });
    process.chdir(TEST_DIR);

    const r = await run(['DATABASE_URL'], { json: true });
    expect(r.exitCode).toBe(3); // EXIT_NEEDS_INPUT
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.code).toBe('REMOVE_NEEDS_TTY');
  });

  test('non-interactive (--non-tty) without --yes is refused the same way, in human mode', async () => {
    writeFixture({ branch: 'development', vars: [{ name: 'DATABASE_URL', branch: 'development' }] });
    process.chdir(TEST_DIR);

    const r = await run(['DATABASE_URL'], { nonTty: true });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('needs confirmation');
  });

  test('no keep.lock at all → NO_KEEP_FILE, before anything else', async () => {
    process.chdir(TEST_DIR);
    const r = await run(['ANY'], { yes: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No keep.lock');
  });
});
