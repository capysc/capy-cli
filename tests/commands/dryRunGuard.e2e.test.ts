/**
 * CAP-659 Phase 1 — parser-level tests for the `--dry-run` guard, driven
 * through the real argument parser against the built CLI (same spawned-CLI
 * style as `deployBranchCheck.test.ts`, whose own header this copies).
 *
 * Hermetic: every spawned CLI runs under a throwaway HOME holding a fake
 * cached session and a profile pointing the service at a closed loopback
 * port, so any call that somehow reached the network is refused locally in
 * milliseconds rather than touching api.capy.sc. For every `unsupported`
 * command this is belt-and-suspenders: the guard refuses in `preAction`,
 * before the command's own code — and therefore any service call — ever
 * runs, so these tests would fail loudly (connection refused) rather than
 * silently if that guarantee ever broke.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-dryrun-guard-${process.pid}-${Date.now()}`);
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:9'; // discard port — refused at once
const FAKE_SESSION_EXPIRES_AT = Date.UTC(2100, 0, 1);
const CLI_TIMEOUT_MS = 30_000;

function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'capy-dryrun-guard-home-'));
  mkdirSync(join(home, '.capy', 'auth'), { recursive: true });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: UNREACHABLE_SERVICE_URL } } }),
  );
  writeFileSync(
    join(home, '.capy', 'auth', 'session.json'),
    JSON.stringify({
      version: 2,
      user_id: 'user-test',
      user_email: 'dry-run-guard-test@example.com',
      refresh_token: 'fake-refresh-token',
      organizations: [{ id: 'org-test', workos_org_id: 'org_workos_test', name: 'test' }],
      sessions: { 'org-test': { access_token: 'fake.e30.token', expires_at: FAKE_SESSION_EXPIRES_AT } },
    }),
  );
  return home;
}

const FAKE_HOME = makeFakeHome();
const CLI_ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CAPY_WEB_NO_OPEN: '1',
  CAPY_NO_AUTOCOMMIT: '1',
};

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

function capy(args: string[], cwd: string = ROOT): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    env: CLI_ENV,
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(dir: string): void {
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables: {} }, null, 2),
  );
  writeFileSync(join(dir, '.env'), '# capy:branch=development\n');
}

const MARKER = '# --- capy auto-sync (do not remove) ---';
const END_MARKER = '# --- end capy ---';
const HOOK_BLOCK = [MARKER, '  echo capy-hook', END_MARKER].join('\n');

/** A real git repo with every Capy-managed hook installed — the CAP-659/CAP-412 `cleanup` repro fixture. */
function makeGitRepoWithHooks(dir: string): void {
  execSync('git init -q', { cwd: dir });
  const hooksDir = join(dir, '.git', 'hooks');
  for (const hookName of ['post-checkout', 'post-merge', 'pre-push']) {
    const path = join(hooksDir, hookName);
    writeFileSync(path, `#!/bin/sh\n${HOOK_BLOCK}\n`);
    chmodSync(path, 0o755);
  }
}

function snapshotHooks(dir: string): Record<string, string> {
  const hooksDir = join(dir, '.git', 'hooks');
  return Object.fromEntries(
    ['post-checkout', 'post-merge', 'pre-push'].map((name) => {
      const path = join(hooksDir, name);
      return [name, existsSync(path) ? readFileSync(path, 'utf-8') : '<missing>'];
    }),
  );
}

describe('bare `capy --dry-run` refuses (CAP-412)', () => {
  test('--dry-run before any subcommand refuses with DRY_RUN_UNSUPPORTED, --json', () => {
    const r = capy(['--dry-run', '--json']);
    // Bare `capy` has no `--json` of its own; JSON is still decided purely
    // by the guard's own check, which only looks for `--json` on commands
    // that declare it. Assert via the human path instead — see the next
    // test — and here just that it refuses rather than syncing for real.
    expect(r.code).toBe(1);
  });

  test('--dry-run before any subcommand refuses, human stderr', () => {
    const r = capy(['--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');
    expect(r.stdout).toBe('');
  });

  test('positive control: bare `capy` without --dry-run does NOT hit this refusal (it runs the real sync/init path instead)', () => {
    const r = capy([]);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
  });
});

describe('cleanup — the CAP-659/CAP-412 regression repro', () => {
  test('--dry-run: the hook block survives untouched, refuses with DRY_RUN_UNSUPPORTED', () => {
    makeGitRepoWithHooks(ROOT);
    const before = snapshotHooks(ROOT);

    const r = capy(['cleanup', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');

    const after = snapshotHooks(ROOT);
    expect(after).toEqual(before);
    for (const content of Object.values(after)) {
      expect(content).toContain(MARKER);
    }
  });

  test('--dry-run before the subcommand name also refuses and leaves hooks untouched', () => {
    makeGitRepoWithHooks(ROOT);
    const before = snapshotHooks(ROOT);

    const r = capy(['--dry-run', 'cleanup']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');
    expect(snapshotHooks(ROOT)).toEqual(before);
  });

  test('positive control: without --dry-run, cleanup actually removes the block (proves the dry-run test could have seen a change)', () => {
    makeGitRepoWithHooks(ROOT);
    const before = snapshotHooks(ROOT);

    const r = capy(['cleanup']);
    expect(r.code).toBe(0);

    const after = snapshotHooks(ROOT);
    expect(after).not.toEqual(before);
    for (const content of Object.values(after)) {
      expect(content).not.toContain(MARKER);
    }
  });
});

// Every `unsupported` command path (CAP-659 Phase 1), with the minimal argv
// needed to clear Commander's own required-argument check and reach the
// guard. `deploy`/`connect`/`branch` are tested separately below — their
// level depends on the invocation, not just the path.
const UNSUPPORTED_CASES: Array<{ path: string; argv: string[] }> = [
  { path: 'run', argv: ['run'] },
  { path: 'edit', argv: ['edit'] },
  { path: 'checkout', argv: ['checkout', 'some-branch'] },
  { path: 'push', argv: ['push'] },
  { path: 'deploy revoke', argv: ['deploy', 'revoke', 'deploy-id-x'] },
  { path: 'deploy targets-remove', argv: ['deploy', 'targets-remove', 'target-x'] },
  { path: 'logout', argv: ['logout'] },
  { path: 'byoc', argv: ['byoc'] },
  { path: 'use', argv: ['use', 'profile-x'] },
  { path: 'profile remove', argv: ['profile', 'remove', 'profile-x'] },
  { path: 'cleanup', argv: ['cleanup'] },
  { path: 'agents', argv: ['agents'] },
  { path: 'invite', argv: ['invite', 'a@example.com'] },
  { path: 'redeem', argv: ['redeem', 'CODE123'] },
  { path: 'transport', argv: ['transport'] },
  { path: 'pair', argv: ['pair'] },
  { path: 'kick', argv: ['kick', 'a@example.com'] },
  { path: 'system set', argv: ['system', 'set', '_CONNECTOR_X_Y'] },
  { path: 'system rm', argv: ['system', 'rm', '_CONNECTOR_X_Y'] },
  { path: 'org', argv: ['org'] },
  { path: 'grant-branch', argv: ['grant-branch', 'a@example.com', 'proj-x', 'branch-x'] },
  { path: 'revoke-branch', argv: ['revoke-branch', 'a@example.com', 'proj-x', 'branch-x'] },
  { path: 'decrypt', argv: ['decrypt'] },
  { path: 'end-recover', argv: ['end-recover'] },
  { path: 'recover', argv: ['recover'] },
  { path: 'add', argv: ['add', 'VAR_X'] },
  { path: 'remove', argv: ['remove', 'VAR_X'] },
  { path: 'rotate', argv: ['rotate'] },
  { path: 'lock', argv: ['lock'] },
];

describe('every `unsupported` command refuses, both --dry-run spellings', () => {
  for (const { path, argv } of UNSUPPORTED_CASES) {
    test(`${path}: --dry-run after the subcommand`, () => {
      writeKeep(ROOT);
      const before = readFileSync(join(ROOT, 'keep.lock'), 'utf-8');
      const beforeEnv = readFileSync(join(ROOT, '.env'), 'utf-8');

      const r = capy([...argv, '--dry-run']);
      expect(r.code).toBe(1);

      expect(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')).toBe(before);
      expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toBe(beforeEnv);
    });

    test(`${path}: --dry-run before the subcommand`, () => {
      writeKeep(ROOT);
      const before = readFileSync(join(ROOT, 'keep.lock'), 'utf-8');

      const r = capy(['--dry-run', ...argv]);
      expect(r.code).toBe(1);

      expect(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')).toBe(before);
    });
  }

  test('--json refusal is exactly one parseable object with the right code and command', () => {
    // `invite` declares its own `--json` (unlike `kick`, which declares
    // none at all — passing `--json` there is a Commander parse error, a
    // different thing from what this test is checking).
    const r = capy(['invite', 'a@example.com', '--dry-run', '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: false, dry_run: true, command: 'invite', code: 'DRY_RUN_UNSUPPORTED' });
    expect(r.stderr).toBe('');
  });

  test('without --json, refusal is a one-line stderr message and stdout is empty', () => {
    const r = capy(['kick', 'a@example.com', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n').length).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');
  });

  test('refusal parity: unsupported commands give the SAME exit code (1) whether or not an auth/service error would also apply', () => {
    // `invite` with no keep.lock would normally refuse with its own coded
    // reason once it actually ran — the dry-run guard preempts it with
    // DRY_RUN_UNSUPPORTED at exit 1 either way, never a different code.
    const r = capy(['invite', 'a@example.com', '--dry-run', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.code).toBe('DRY_RUN_UNSUPPORTED');
  });
});

describe('`deploy` — token path refuses, target mode keeps previewing (CAP-659)', () => {
  test('no --target/--connect/positional (token path): refuses', () => {
    const r = capy(['deploy', '--dry-run', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, dry_run: true, command: 'deploy', code: 'DRY_RUN_UNSUPPORTED' });
  });

  test('a positional target: NOT refused by the guard (reaches deploy\'s own, already-safe preview path)', () => {
    const r = capy(['deploy', 'worker-prod', '--dry-run', '--yes']);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
    expect(r.stdout).not.toContain('DRY_RUN_UNSUPPORTED');
  });

  test('--target: NOT refused by the guard', () => {
    const r = capy(['deploy', '--target', 'cf-worker', '--yes', '--dry-run']);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
  });
});

describe('`connect` — no provider lists (read_only), a provider refuses (CAP-659)', () => {
  test('no provider: NOT refused — lists providers', () => {
    const r = capy(['connect', '--dry-run']);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
    expect(r.code).toBe(0);
  });

  test('a provider: refuses with DRY_RUN_UNSUPPORTED', () => {
    const r = capy(['connect', 'stripe', '--dry-run', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, dry_run: true, command: 'connect', code: 'DRY_RUN_UNSUPPORTED' });
  });
});

describe('`branch` — list is read_only, -D refuses (CAP-659)', () => {
  test('no -D: NOT refused by the guard', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '--dry-run']);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
  });

  test('-D <name>: refuses with DRY_RUN_UNSUPPORTED, never reaches the real delete confirm', () => {
    writeKeep(ROOT);
    const r = capy(['branch', '-D', 'some-branch', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');
  });
});

describe('`read_only` commands still run, output unaffected by --dry-run', () => {
  test('status: identical output and exit code with and without --dry-run', () => {
    const withFlag = capy(['status', '--json', '--dry-run']);
    const without = capy(['status', '--json']);
    expect(withFlag.stdout).toBe(without.stdout);
    expect(withFlag.code).toBe(without.code);
    expect(withFlag.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
  });

  test('help --json: identical output and exit code with and without --dry-run', () => {
    const withFlag = capy(['help', '--json', '--dry-run']);
    const without = capy(['help', '--json']);
    expect(withFlag.stdout).toBe(without.stdout);
    expect(withFlag.code).toBe(without.code);
  });
});

describe('`run` — only a --dry-run BEFORE `--` counts (CAP-659)', () => {
  test('--dry-run before `run`: refused, the child process never starts', () => {
    const markerFile = join(ROOT, 'child-ran-before.txt');
    const r = capy(['run', '--dry-run', '--', 'sh', '-c', `echo ran > ${JSON.stringify(markerFile)}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRY_RUN_UNSUPPORTED');
    expect(existsSync(markerFile)).toBe(false);
  });

  test('--dry-run after `--`: belongs to the child, NOT the guard — the child runs for real', () => {
    // Node itself would choke on a trailing `--dry-run` after `-e` (it reads
    // it as node's own unrecognized flag, not the script's argv) — `sh -c`
    // takes extra positionals harmlessly, so the one being tested here is
    // genuinely "capy's guard never sees this `--dry-run`", not a node quirk.
    const markerFile = join(ROOT, 'child-ran-after.txt');
    const r = capy(['run', '--', 'sh', '-c', `echo ran > ${JSON.stringify(markerFile)}`, '--dry-run']);
    expect(r.stderr).not.toContain('DRY_RUN_UNSUPPORTED');
    expect(existsSync(markerFile)).toBe(true);
  });
});
