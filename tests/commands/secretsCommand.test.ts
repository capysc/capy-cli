import { describe, it, expect, spyOn, mock, afterAll, afterEach, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { rowIdOf } from '../../src/commands/secretsRowId';

/**
 * `capy secrets` — CLI-layer wiring only. CAP-680 removed the static human
 * table entirely: the command now has exactly two outputs, `--json` and the
 * interactive screen, and a non-TTY caller that didn't ask for `--json` gets
 * the JSON anyway (never blocks on a prompt it can't answer, never gets raw
 * ANSI on stdout). This file covers: the mode rule itself (TTY vs. not,
 * `--json` vs. not), `--project`/`--branch` filters in every mode, the
 * skipped-projects stderr note, an empty org, a service failure surfacing as
 * a coded error on every non-interactive surface (JSON) vs. prose on a real
 * terminal, and that `--no-interactive` is gone from both entrypoints.
 *
 * `resolveOrgContext` (auth + org resolution), the spinner, and — new here —
 * the interactive screen's own driver + value-decryptor factory are mocked;
 * none of those are this file's concern, exactly like `projectsCommand.test.ts`.
 */

interface FakeService {
  provider: string;
  name?: string;
  dokploy_project?: string;
  environment?: string;
  compose_id?: string;
}
interface FakeLocation {
  project_id: string;
  project_name: string;
  branch: string;
  protected: boolean;
  changed_at?: string;
  service: FakeService | null;
}
interface FakeUser {
  user_id: string;
  email: string;
}
interface FakeRow {
  name: string;
  value_hash: string;
  locations: FakeLocation[];
  users: FakeUser[];
}
interface FakeIndex {
  org_id: string;
  rows: FakeRow[];
  skipped: Array<{ project_id: string; project_name: string; code: string }>;
}

const getSecretIndexImpl = mock(async (): Promise<FakeIndex> => ({ org_id: 'org_1', rows: [], skipped: [] }));

const fakeServiceClient = {
  getSecretIndex: (...args: [string]) => getSecretIndexImpl(...args),
};

mock.module('../../src/ui/spinner', () => ({
  Spinner: class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
    start() {
      return this;
    }
    succeed() {}
    fail() {}
    stop() {}
  },
}));

mock.module('../../src/core/orgContext', () => ({
  resolveOrgContext: mock(async () => ({
    orgId: 'org_1',
    userId: 'user_1',
    userEmail: 'a@example.com',
    authService: {},
    serviceClient: fakeServiceClient,
  })),
}));

// The interactive screen's two dynamic imports (`secretsCommand.ts` only
// reaches these when it decides to go interactive) — mocked so a
// TTY-mode test never actually takes over the terminal or touches a real
// decryptor.
const runSecretsScreenImpl = mock(async (..._args: unknown[]) => {});
mock.module('../../src/ui/secretsScreenDriver', () => ({
  runSecretsScreen: runSecretsScreenImpl,
}));

const createLocationDecryptorImpl = mock((..._args: unknown[]) => async () => ({ ok: false as const, code: 'UNREACHABLE' }));
mock.module('../../src/commands/secretsValueDecryptor', () => ({
  createLocationDecryptor: createLocationDecryptorImpl,
}));

afterAll(() => mock.restore());

// Top-level `await import` (not a lazily-assigned `let`, guarded per-test) —
// this only works because every `mock.module(...)` call above already ran by
// the time this line executes, so the mocks are in place before the real
// module (and its own imports) resolve. `tests/ui/deployDeadline.test.ts`
// uses the same pattern for the same reason.
const { SecretsCommand } = await import('../../src/commands/secretsCommand');

/** Distinguishes the intentional `process.exit()` throw from a real bug, without parsing any message text. */
class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

/** Runs `fn`, capturing stdout/stderr/exit code — never lets `process.exit` actually exit the test runner. Mirrors `projectsCommand.test.ts`'s helper exactly. */
async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});

  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);

  const stdout = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  const exitCalls = exitSpy.mock.calls;
  const exitCode = exitCalls.length > 0 ? (exitCalls[exitCalls.length - 1][0] as number | undefined) : undefined;

  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();

  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode, stdout, stderr };
}

/** Sets BOTH `process.stdout.isTTY` and `process.stdin.isTTY` — the command only treats a run as "a real terminal" when both are true. */
function setTTY(stdoutIsTty: boolean, stdinIsTty: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTty, configurable: true, writable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTty, configurable: true, writable: true });
}

const loc = (over: Partial<FakeLocation> = {}): FakeLocation => ({
  project_id: 'p1',
  project_name: 'web',
  branch: 'production',
  protected: false,
  service: null,
  ...over,
});

const user = (email: string): FakeUser => ({ user_id: email, email });

const row = (over: Partial<FakeRow> = {}): FakeRow => ({
  name: 'API_KEY',
  value_hash: 'hash1',
  locations: [loc()],
  users: [user('a@example.com')],
  ...over,
});

describe('SecretsCommand', () => {
  beforeEach(async () => {
    getSecretIndexImpl.mockReset();
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [], skipped: [] }));
    runSecretsScreenImpl.mockClear();
    createLocationDecryptorImpl.mockClear();
    // The bun test process itself is not a TTY on either stream, but a
    // previous test may have flipped one — start every test from the same
    // known-false baseline.
    setTTY(false, false);
  });
  afterEach(() => setTTY(false, false));

  it('--json: pure {ok, org_id, rows, skipped} shape, exactly the server payload plus ok:true', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_9',
      rows: [row({ name: 'X' })],
      skipped: [],
    }));

    const { stdout, stderr, exitCode } = await capture(() => new SecretsCommand().execute({ json: true }));

    expect(exitCode).toBeUndefined();
    expect(stderr).toBe('');
    const payload = JSON.parse(stdout);
    expect(payload).toEqual({
      ok: true,
      org_id: 'org_9',
      // The fields this command adds to each server row: `row_id` (CAP-698) and `status` (CAP-702; `unknown` because this fixture's server sent no targets).
      rows: [{ ...row({ name: 'X' }), row_id: rowIdOf('X', row({ name: 'X' }).value_hash), status: 'unknown' }],
      skipped: [],
    });
  });

  it('non-TTY, no --json: emits the IDENTICAL JSON payload automatically — never a table, never blocks on a prompt', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_9',
      rows: [
        row({
          name: 'DATABASE_URL',
          locations: [
            loc({ project_name: 'web', branch: 'production', protected: true, service: { provider: 'dokploy', name: 'web-prod' } }),
            loc({ project_name: 'web', branch: 'staging', service: { provider: 'dokploy', compose_id: 'compose_9' } }),
          ],
          users: [user('a@example.com'), user('b@example.com')],
        }),
      ],
      skipped: [],
    }));

    const autoJson = await capture(() => new SecretsCommand().execute({}));
    const explicitJson = await capture(() => new SecretsCommand().execute({ json: true }));

    expect(autoJson.exitCode).toBeUndefined();
    expect(runSecretsScreenImpl).not.toHaveBeenCalled();
    expect(JSON.parse(autoJson.stdout)).toEqual(JSON.parse(explicitJson.stdout));
  });

  it('two rows sharing a NAME with different values both appear in the JSON, distinguished by value_hash', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'SHARED', value_hash: 'aaaaaaaaaaaaaaaa' }),
        row({ name: 'SHARED', value_hash: 'bbbbbbbbbbbbbbbb', locations: [loc({ project_id: 'p2', project_name: 'api' })] }),
      ],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true }));
    const payload = JSON.parse(stdout);
    expect(payload.rows.map((r: FakeRow) => r.name)).toEqual(['SHARED', 'SHARED']);
    expect(payload.rows.map((r: FakeRow) => r.value_hash)).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  });

  it('--project filters to rows with a location in that project (both --json and the non-TTY auto fallback)', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'IN_WEB', locations: [loc({ project_name: 'web' })] }),
        row({ name: 'IN_API', locations: [loc({ project_name: 'api' })] }),
      ],
      skipped: [],
    }));

    const explicitJson = await capture(() => new SecretsCommand().execute({ json: true, project: 'web' }));
    expect(JSON.parse(explicitJson.stdout).rows.map((r: FakeRow) => r.name)).toEqual(['IN_WEB']);

    const autoJson = await capture(() => new SecretsCommand().execute({ project: 'web' }));
    expect(JSON.parse(autoJson.stdout).rows.map((r: FakeRow) => r.name)).toEqual(['IN_WEB']);
  });

  it('--branch filters to rows with a location on that branch', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'ON_PROD', locations: [loc({ branch: 'production' })] }),
        row({ name: 'ON_STAGING', locations: [loc({ branch: 'staging' })] }),
      ],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true, branch: 'staging' }));
    const payload = JSON.parse(stdout);
    expect(payload.rows.map((r: FakeRow) => r.name)).toEqual(['ON_STAGING']);
  });

  it('skipped projects: a stderr note names them + their codes, on every surface (--json and the auto fallback)', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row()],
      skipped: [{ project_id: 'p2', project_name: 'legacy', code: 'PERMISSION_DENIED' }],
    }));

    const autoJson = await capture(() => new SecretsCommand().execute({}));
    expect(autoJson.stderr).toContain('legacy');
    expect(autoJson.stderr).toContain('PERMISSION_DENIED');
    // stdout stays pure JSON even though the skipped note also goes to stderr.
    expect(() => JSON.parse(autoJson.stdout)).not.toThrow();

    const asJson = await capture(() => new SecretsCommand().execute({ json: true }));
    expect(() => JSON.parse(asJson.stdout)).not.toThrow();
    expect(asJson.stderr).toContain('legacy');
  });

  it('empty org: both --json and the non-TTY auto fallback emit an empty rows array', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [], skipped: [] }));

    const autoJson = await capture(() => new SecretsCommand().execute({}));
    expect(JSON.parse(autoJson.stdout)).toEqual({ ok: true, org_id: 'org_1', rows: [], skipped: [] });

    const jsonResult = await capture(() => new SecretsCommand().execute({ json: true }));
    expect(JSON.parse(jsonResult.stdout)).toEqual({ ok: true, org_id: 'org_1', rows: [], skipped: [] });
  });

  it('service error under --json: coded JSON on stdout, exit 1, no partial data', async () => {
    getSecretIndexImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stdout, exitCode } = await capture(() => new SecretsCommand().execute({ json: true }));

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      code: ERROR_CODES.SERVICE_ERROR,
      error: 'Service unavailable',
    });
  });

  it('service error, non-TTY without --json: the SAME coded JSON on stdout as --json, exit 1 (never prose, never a hang)', async () => {
    getSecretIndexImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stdout, exitCode } = await capture(() => new SecretsCommand().execute({}));

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      code: ERROR_CODES.SERVICE_ERROR,
      error: 'Service unavailable',
    });
  });

  it('service error while genuinely interactive (both streams TTYs, no --json): prose on stderr, exit 1, nothing on stdout', async () => {
    setTTY(true, true);
    getSecretIndexImpl.mockImplementation(async () => {
      throw new CapyError('Service unavailable', ERROR_CODES.SERVICE_ERROR);
    });

    const { stderr, stdout, exitCode } = await capture(() => new SecretsCommand().execute({}));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Service unavailable');
    expect(stdout).toBe('');
  });

  it('never prints a value — only names, hashes, emails, locations', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ name: 'SECRET_TOKEN', value_hash: 'deadbeefdeadbeef' })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true }));
    // The hash is fine to show (never a value) — just prove nothing beyond
    // the fake row's own known-safe fields made it into the payload.
    const payload = JSON.parse(stdout);
    expect(payload.rows[0].value_hash).toBe('deadbeefdeadbeef');
    expect(Object.keys(payload.rows[0])).toEqual(['name', 'value_hash', 'locations', 'users', 'row_id', 'status']);
  });

  it('CAP-702: --json gives each row a STATUS and each target `up_to_date`', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({
          name: 'BEHIND',
          locations: [
            loc({ targets: [{ provider: 'dokploy', target: 'prod', stale: true }, { provider: 'vercel', target: 'main', stale: false }] }),
            loc({ branch: 'staging', targets: [{ provider: 'dokploy', target: 'staging', stale: false }] }),
          ],
        }),
        row({ name: 'CURRENT', locations: [loc({ targets: [{ provider: 'dokploy', target: 'prod', stale: false }] })] }),
        row({ name: 'NO_TARGETS', locations: [loc({ targets: [] })] }),
      ],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true }));
    const payload = JSON.parse(stdout);
    const [behind, current, noTargets] = payload.rows;
    expect(behind.status).toBe('not deployed');
    expect(behind.targets_not_deployed).toBe(1);
    expect(behind.targets_total).toBe(3);
    expect(behind.locations[0].targets.map((t: { up_to_date: boolean }) => t.up_to_date)).toEqual([false, true]);
    expect(current.status).toBe('deployed');
    expect(current.targets_not_deployed).toBeUndefined();
    expect(current.locations[0].targets[0].up_to_date).toBe(true);
    expect(noTargets.status).toBe('no target');
  });
});

describe('SecretsCommand — interactive launch (CAP-680: full TTY, no --json)', () => {
  beforeEach(async () => {
    getSecretIndexImpl.mockReset();
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [], skipped: [] }));
    runSecretsScreenImpl.mockClear();
    createLocationDecryptorImpl.mockClear();
    setTTY(false, false);
  });
  afterEach(() => setTTY(false, false));

  it('launches the interactive screen when BOTH stdout and stdin are TTYs', async () => {
    setTTY(true, true);
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [row({ name: 'X' })], skipped: [] }));

    const { stdout, exitCode } = await capture(() => new SecretsCommand().execute({}));

    expect(exitCode).toBeUndefined();
    expect(runSecretsScreenImpl).toHaveBeenCalledTimes(1);
    expect(createLocationDecryptorImpl).toHaveBeenCalledTimes(1);
    // The screen owns the terminal — this command never itself console.logs
    // anything once it hands off.
    expect(stdout).toBe('');
  });

  it('does NOT launch the interactive screen when only ONE of stdout/stdin is a TTY — falls back to JSON instead', async () => {
    setTTY(true, false);
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [row()], skipped: [] }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));

    expect(runSecretsScreenImpl).not.toHaveBeenCalled();
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('does NOT launch the interactive screen under --json, even on a full TTY', async () => {
    setTTY(true, true);
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [row()], skipped: [] }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true }));

    expect(runSecretsScreenImpl).not.toHaveBeenCalled();
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('--project/--branch filters apply to the rows handed to the interactive screen too', async () => {
    setTTY(true, true);
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'IN_WEB', locations: [loc({ project_name: 'web' })] }),
        row({ name: 'IN_API', locations: [loc({ project_name: 'api' })] }),
      ],
      skipped: [],
    }));

    await capture(() => new SecretsCommand().execute({ project: 'web' }));

    expect(runSecretsScreenImpl).toHaveBeenCalledTimes(1);
    const passedRows = runSecretsScreenImpl.mock.calls[0]?.[0] as FakeRow[] | undefined;
    expect(passedRows?.map((r) => r.name)).toEqual(['IN_WEB']);
  });
});

describe('`--no-interactive` is gone from both entrypoints (CAP-680)', () => {
  const CLI_ROOT = resolve(import.meta.dir, '../..');

  /** The `secrets` command's own `.command('secrets')...` chain, isolated from the rest of the file by slicing up to the next `.command(` call — mirrors `entrypointParity.test.ts`'s own source-reading approach. Reading source rather than actually invoking Commander: `src/index.ts` calls `program.parse(process.argv)` unconditionally at module load, so importing it directly in a test would run the real CLI against the test runner's own argv — a source check is the safe way to prove the option (and the `allowUnknownOption()` escape hatch that would otherwise silence Commander's default rejection of it) are both gone. */
  function secretsCommandBlock(relativeFile: string): string {
    const source = readFileSync(resolve(CLI_ROOT, relativeFile), 'utf8');
    const start = source.indexOf(".command('secrets')");
    expect(start).toBeGreaterThan(-1);
    const nextCommandStart = source.indexOf('.command(', start + 1);
    return source.slice(start, nextCommandStart === -1 ? source.length : nextCommandStart);
  }

  it('src/index.ts: no `--no-interactive` option, and no `allowUnknownOption()` to silence Commander rejecting it', () => {
    const block = secretsCommandBlock('src/index.ts');
    expect(block).not.toContain('--no-interactive');
    expect(block).not.toContain('allowUnknownOption');
    expect(block).not.toContain('noInteractive');
  });

  it('src/index-dev.ts: same — never had the option, still does not opt out of Commander\'s default rejection', () => {
    const block = secretsCommandBlock('src/index-dev.ts');
    expect(block).not.toContain('--no-interactive');
    expect(block).not.toContain('allowUnknownOption');
    expect(block).not.toContain('noInteractive');
  });
});
