import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/**
 * `capy secrets` — CLI-layer wiring only. Covers: human table rendering
 * (multi-location + multi-user rows, singular "1 user", the Dokploy
 * `dokploy:<compose_id>` fallback, the protected marker), `--json` shape
 * (`{ok:true, org_id, rows, skipped}`), `--project`/`--branch` filters, the
 * skipped-projects stderr note, an empty org, and a service failure
 * surfacing as a coded error rather than a crash.
 *
 * `resolveOrgContext` (auth + org resolution) and the spinner are mocked —
 * neither is this file's concern, exactly like `projectsCommand.test.ts`.
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

afterAll(() => mock.restore());

let SecretsCommand: typeof import('../../src/commands/secretsCommand').SecretsCommand;
const importCommand = async () => {
  const mod = await import('../../src/commands/secretsCommand');
  SecretsCommand = mod.SecretsCommand;
};

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

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
    if (!SecretsCommand) await importCommand();
    getSecretIndexImpl.mockReset();
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [], skipped: [] }));
  });

  it('human output: multi-location + multi-user row renders NAME/USERS/BRANCH/SERVICE aligned', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
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

    const { stdout, exitCode } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);

    expect(exitCode).toBeUndefined();
    expect(plain).toContain('DATABASE_URL');
    expect(plain).toContain('2 users');
    expect(plain).toContain('a@example.com');
    expect(plain).toContain('b@example.com');
    expect(plain).toContain('web · production');
    expect(plain).toContain('(protected)');
    expect(plain).toContain('web · staging');
    expect(plain).toContain('web-prod');
    // No name → falls back to `dokploy:<compose_id>`.
    expect(plain).toContain('dokploy:compose_9');
    expect(plain).toContain('1 secret across 1 project');
  });

  it('singular "1 user" (not "1 users")', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ users: [user('solo@example.com')] })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);
    expect(plain).toContain('1 user');
    expect(plain).not.toContain('1 users');
  });

  it('a location with no service renders "—"', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ locations: [loc({ service: null })] })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    expect(stripAnsi(stdout)).toContain('—');
  });

  it('SERVICE column: dokploy_project + name renders "<project> / <name>"', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ locations: [loc({ service: { provider: 'dokploy', name: 'main', dokploy_project: 'slidespeak' } })] })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);
    expect(plain).toContain('slidespeak / main');
  });

  it('SERVICE column: name with no dokploy_project renders bare "<name>"', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ locations: [loc({ service: { provider: 'dokploy', name: 'web-prod' } })] })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);
    expect(plain).toContain('web-prod');
    expect(plain).not.toContain('undefined / web-prod');
  });

  it('SERVICE column: no name (even with dokploy_project) falls back to "dokploy:<compose_id>"', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row({ locations: [loc({ service: { provider: 'dokploy', dokploy_project: 'slidespeak', compose_id: 'compose_9' } })] })],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);
    expect(plain).toContain('dokploy:compose_9');
    expect(plain).not.toContain('slidespeak');
  });

  it('two rows sharing a NAME with a different value are both shown, disambiguated by hash', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'SHARED', value_hash: 'aaaaaaaaaaaaaaaa' }),
        row({ name: 'SHARED', value_hash: 'bbbbbbbbbbbbbbbb', locations: [loc({ project_id: 'p2', project_name: 'api' })] }),
      ],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({}));
    const plain = stripAnsi(stdout);
    expect(plain.match(/SHARED/g)?.length).toBeGreaterThanOrEqual(2);
    expect(plain).toContain('aaaaaaaa');
    expect(plain).toContain('bbbbbbbb');
    expect(plain).toContain('2 secrets across 2 projects');
  });

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
      rows: [row({ name: 'X' })],
      skipped: [],
    });
  });

  it('--project filters to rows with a location in that project', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [
        row({ name: 'IN_WEB', locations: [loc({ project_name: 'web' })] }),
        row({ name: 'IN_API', locations: [loc({ project_name: 'api' })] }),
      ],
      skipped: [],
    }));

    const { stdout } = await capture(() => new SecretsCommand().execute({ json: true, project: 'web' }));
    const payload = JSON.parse(stdout);
    expect(payload.rows.map((r: FakeRow) => r.name)).toEqual(['IN_WEB']);
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

  it('skipped projects: a stderr note names them + their codes, on both surfaces', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({
      org_id: 'org_1',
      rows: [row()],
      skipped: [{ project_id: 'p2', project_name: 'legacy', code: 'PERMISSION_DENIED' }],
    }));

    const human = await capture(() => new SecretsCommand().execute({}));
    expect(human.stderr).toContain('legacy');
    expect(human.stderr).toContain('PERMISSION_DENIED');

    const asJson = await capture(() => new SecretsCommand().execute({ json: true }));
    // stdout stays pure JSON even though the skipped note also goes to stderr.
    expect(() => JSON.parse(asJson.stdout)).not.toThrow();
    expect(asJson.stderr).toContain('legacy');
  });

  it('empty org: human message and empty --json rows array', async () => {
    getSecretIndexImpl.mockImplementation(async () => ({ org_id: 'org_1', rows: [], skipped: [] }));

    const humanResult = await capture(() => new SecretsCommand().execute({}));
    expect(humanResult.stdout).toContain('No secrets found');

    const jsonResult = await capture(() => new SecretsCommand().execute({ json: true }));
    expect(JSON.parse(jsonResult.stdout)).toEqual({ ok: true, org_id: 'org_1', rows: [], skipped: [] });
  });

  it('service error: coded JSON on stdout, exit 1, no partial data', async () => {
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

  it('service error in human mode: prose on stderr, exit 1, nothing on stdout', async () => {
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
    expect(Object.keys(payload.rows[0])).toEqual(['name', 'value_hash', 'locations', 'users']);
  });
});
