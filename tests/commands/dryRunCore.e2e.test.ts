/**
 * CAP-659 Phase 2 / CAP-520 — the "core" group: bare `capy`, `push`,
 * `branch` (incl. `-D`), `checkout` (incl. `-b`), `edit`, `status`.
 *
 * Same hermetic harness as `dryRunGuard.e2e.test.ts`: a throwaway HOME per
 * suite, a profile pointing the service at a closed loopback port (so any
 * call that reaches the network fails fast rather than touching
 * api.capy.sc), and a throwaway fixture directory per test.
 *
 * Two HOME fixtures: `FAKE_HOME` carries a cached, non-expired session for
 * `org-test` (auth succeeds locally, no network); `NO_SESSION_HOME` carries
 * none at all, so even the SILENT auth attempt fails — proving every
 * dry-run path refuses rather than opening a browser when there is nothing
 * to continue with.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-dryrun-core-${process.pid}-${Date.now()}`);
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:9'; // discard port — refused at once
const FAKE_SESSION_EXPIRES_AT = Date.UTC(2100, 0, 1);
const CLI_TIMEOUT_MS = 20_000;

function makeHome(withSession: boolean): string {
  const home = mkdtempSync(join(tmpdir(), `capy-dryrun-core-home-${withSession ? 'y' : 'n'}-`));
  mkdirSync(join(home, '.capy', 'auth'), { recursive: true });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: UNREACHABLE_SERVICE_URL } } }),
  );
  if (withSession) {
    writeFileSync(
      join(home, '.capy', 'auth', 'session.json'),
      JSON.stringify({
        version: 2,
        user_id: 'user-test',
        user_email: 'dry-run-core-test@example.com',
        refresh_token: 'fake-refresh-token',
        organizations: [{ id: 'org-test', workos_org_id: 'org_workos_test', name: 'test' }],
        sessions: { 'org-test': { access_token: 'fake.e30.token', expires_at: FAKE_SESSION_EXPIRES_AT } },
      }),
    );
  }
  return home;
}

const FAKE_HOME = makeHome(true);
const NO_SESSION_HOME = makeHome(false);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(NO_SESSION_HOME, { recursive: true, force: true });
});

function capy(args: string[], home: string, cwd: string = ROOT): { stdout: string; stderr: string; code: number } {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CAPY_WEB_NO_OPEN: '1',
    CAPY_NO_AUTOCOMMIT: '1',
  };
  const r = spawnSync('node', [CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(dir: string, variables: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// bare `capy --dry-run` (CAP-412)
// ---------------------------------------------------------------------------
describe('bare `capy --dry-run`', () => {
  test('uninitialized directory, no usable session: refuses AUTH_FAILED, never writes keep.lock', () => {
    const r = capy(['--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('AUTH_FAILED');
    expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
  });

  test('uninitialized directory, usable session: reports the organization stop unanswered, exit 3, never writes', () => {
    const r = capy(['--dry-run'], FAKE_HOME);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('organization');
    expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
  });

  test('already-initialized directory, no usable session: refuses AUTH_FAILED, never touches keep.lock/.env', () => {
    writeKeep(ROOT);
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy', 'branch'), 'development');
    writeFileSync(join(ROOT, '.env'), 'FOO=bar\n');
    const beforeKeep = readFileSync(join(ROOT, 'keep.lock'), 'utf-8');
    const beforeEnv = readFileSync(join(ROOT, '.env'), 'utf-8');

    const r = capy(['--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('AUTH_FAILED');
    expect(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')).toBe(beforeKeep);
    expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toBe(beforeEnv);
  });

  test('already-initialized, no local branch signal yet: reports the branch stop unanswered, exit 3, never writes', () => {
    writeKeep(ROOT);
    const r = capy(['--dry-run'], FAKE_HOME);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('branch');
    expect(existsSync(join(ROOT, '.env'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `push --dry-run`
// ---------------------------------------------------------------------------
describe('push --dry-run', () => {
  test('uninitialized directory: exit 1, same as the real run, nothing written', () => {
    const r = capy(['push', '--dry-run'], FAKE_HOME);
    expect(r.code).toBe(1);
    expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
  });

  test('initialized, no usable session: refuses AUTH_FAILED rather than opening a browser, no writes', () => {
    writeKeep(ROOT);
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy', 'branch'), 'development');
    writeFileSync(join(ROOT, '.env'), 'FOO=bar\n');
    const beforeKeep = readFileSync(join(ROOT, 'keep.lock'), 'utf-8');

    const r = capy(['push', '--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('AUTH_FAILED');
    expect(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')).toBe(beforeKeep);
    expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toBe('FOO=bar\n');
  });

  test('initialized, session usable but service unreachable (key resolution fails): refuses, never hangs, never writes', () => {
    writeKeep(ROOT);
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy', 'branch'), 'development');
    writeFileSync(join(ROOT, '.env'), 'FOO=bar\n');
    const beforeKeep = readFileSync(join(ROOT, 'keep.lock'), 'utf-8');

    const r = capy(['push', '--dry-run'], FAKE_HOME);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')).toBe(beforeKeep);
    expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toBe('FOO=bar\n');
  });
});

// ---------------------------------------------------------------------------
// `checkout -b --dry-run` — fully local, no auth/network at all
// ---------------------------------------------------------------------------
describe('checkout -b <name> --dry-run (create mode — needs no auth/network)', () => {
  test('neither --protected nor --no-protected: unanswered "protection", exit 3, never writes', () => {
    writeKeep(ROOT);
    const r = capy(['checkout', '-b', 'feature-x', '--dry-run', '--json'], NO_SESSION_HOME);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: true, dry_run: true, command: 'checkout', changes: [], unanswered: [{ id: 'protection', flag: '--protected or --no-protected' }] });
    expect(existsSync(join(ROOT, 'keep.lock'))).toBe(true); // keep.lock untouched, still the fixture's
  });

  test('--protected given: names the create + seeds every current .env NAME (never a value), exit 0', () => {
    writeKeep(ROOT);
    writeFileSync(join(ROOT, '.env'), 'STRIPE_KEY=sk_live_super_secret_value\nOTHER=plain\n');
    const r = capy(['checkout', '-b', 'feature-x', '--protected', '--dry-run', '--json'], NO_SESSION_HOME);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.unanswered).toEqual([]);
    expect(parsed.changes).toEqual(
      expect.arrayContaining([
        { where: 'capy_service', action: 'create branch', target: 'feature-x', reversible: true },
        { where: 'local_file', action: 'seed variable onto new branch (unpushed)', target: 'STRIPE_KEY', reversible: true },
        { where: 'local_file', action: 'seed variable onto new branch (unpushed)', target: 'OTHER', reversible: true },
      ]),
    );
    // Never a value, anywhere in the output.
    expect(r.stdout).not.toContain('sk_live_super_secret_value');
    expect(existsSync(join(ROOT, '.env'))).toBe(true);
    expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toContain('sk_live_super_secret_value'); // untouched
  });

  test('human output (no --json) still refuses/previews the same way, exit code matches', () => {
    writeKeep(ROOT);
    const r = capy(['checkout', '-b', 'feature-y', '--no-protected', '--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('feature-y');
  });
});

describe('checkout -b <name> (no --dry-run) — protection prompt TTY gate (CAP-520)', () => {
  test('no TTY, neither --protected/--no-protected: coded refusal exit 3, before any auth/network', () => {
    writeKeep(ROOT);
    const r = capy(['checkout', '-b', 'feature-z'], NO_SESSION_HOME);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('CHECKOUT_PROTECTION_NEEDS_TTY');
  });

  test('--protected given: does not hit the TTY gate (fails later, on the network, instead)', () => {
    writeKeep(ROOT);
    const r = capy(['checkout', '-b', 'feature-z', '--protected'], NO_SESSION_HOME);
    expect(r.stderr).not.toContain('CHECKOUT_PROTECTION_NEEDS_TTY');
  });
});

describe('checkout <branch> --dry-run (switch mode)', () => {
  test('no usable session: refuses AUTH_FAILED, never writes .env', () => {
    writeKeep(ROOT);
    mkdirSync(join(ROOT, '.capy'), { recursive: true });
    writeFileSync(join(ROOT, '.capy', 'branch'), 'development');
    const r = capy(['checkout', 'staging', '--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('AUTH_FAILED');
    expect(existsSync(join(ROOT, '.env'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `branch -D <name>`
// ---------------------------------------------------------------------------
describe('branch -D <name>', () => {
  test('--dry-run, no usable session: refuses AUTH_FAILED, never deletes, never confirms', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '-D', 'doomed', '--dry-run'], NO_SESSION_HOME);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('AUTH_FAILED');
  });

  test('no --dry-run, no --yes, no TTY: coded refusal exit 3, before the network existence check', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '-D', 'doomed'], FAKE_HOME);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('BRANCH_DELETE_NEEDS_TTY');
  });

  test('--yes given: does not hit the confirm gate (fails later, on the network, instead)', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '-D', 'doomed', '--yes'], FAKE_HOME);
    expect(r.stderr).not.toContain('BRANCH_DELETE_NEEDS_TTY');
  });
});

describe('branch (list/switch), no -D', () => {
  test('--json still lists without ever reaching the switch picker (no TTY needed)', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '--json'], FAKE_HOME);
    // Fails on the network list call (unreachable service) rather than a
    // TTY-only picker — never BRANCH_SWITCH_NEEDS_TTY for a --json run.
    expect(r.stderr).not.toContain('BRANCH_SWITCH_NEEDS_TTY');
  });
});

// ---------------------------------------------------------------------------
// `edit` — CAP-520: refuses before the TUI is ever drawn
// ---------------------------------------------------------------------------
describe('edit — no TTY', () => {
  test('uninitialized directory, no --web: EDIT_NEEDS_TTY, exit 3, before even the keep.lock check', () => {
    const r = capy(['edit'], NO_SESSION_HOME);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('EDIT_NEEDS_TTY');
    // Proves the gate ran BEFORE the "No keep.lock" check below it in
    // editCommand.ts — that message never appears.
    expect(r.stderr).not.toContain('No keep.lock');
  });

  test('--web: does not hit the TTY gate (fails later, on project state, instead)', () => {
    const r = capy(['edit', '--web'], NO_SESSION_HOME);
    expect(r.stderr).not.toContain('EDIT_NEEDS_TTY');
  });

  test('--non-tty: same coded refusal as a genuinely closed stdin', () => {
    const r = capy(['edit', '--non-tty'], FAKE_HOME);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('EDIT_NEEDS_TTY');
  });
});

// ---------------------------------------------------------------------------
// `status --json` — coded error instead of a silent exit 0
// ---------------------------------------------------------------------------
describe('status --json error path (CAP-520)', () => {
  test('no keep.lock at all: still the old git-hook-friendly silent success (no error to report)', () => {
    const r = capy(['status', '--json'], NO_SESSION_HOME);
    expect(r.code).toBe(0);
  });

  test('corrupt keep.lock (internal error): emits {ok:false, code}, not a bare silent exit', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{not valid json');
    const r = capy(['status', '--json'], NO_SESSION_HOME);
    expect(r.code).toBe(0); // CAP-520 keeps the hook-friendly exit code
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.code).toBe('string');
    expect(parsed.code.length).toBeGreaterThan(0);
  });

  test('non-json path on the same corrupt keep.lock: still silent exit 0, no output', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{not valid json');
    const r = capy(['status'], NO_SESSION_HOME);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
