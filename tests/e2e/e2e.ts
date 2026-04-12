#!/usr/bin/env bun
/**
 * Capy CLI E2E Test
 *
 * Exercises the full CLI flow with two test users against a real service instance.
 * Requires: Docker (postgres on 5433), WorkOS test env, bun.
 *
 * Usage: bun run tests/e2e/e2e.ts
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// ─── Config ───────────────────────────────────────────────────────────────────

const CLI_ROOT = resolve(__dirname, '..', '..');
const SERVICE_ROOT = resolve(CLI_ROOT, '..', '..', 'service');
const SANDBOX_ROOT = resolve(CLI_ROOT, '..', '..', 'sandbox');
const SANDBOX_USER1 = join(SANDBOX_ROOT, 'user1');
const SANDBOX_USER2 = join(SANDBOX_ROOT, 'user2');
const CAPY_DEV_BIN = join(CLI_ROOT, 'bin', 'capy-dev');

const TEST_PORT = 3001;
const TEST_API_URL = `http://localhost:${TEST_PORT}`;
const TEST_DB_URL = 'postgresql://capy:capy@localhost:5433/capy_test';

const USER_A_EMAIL = 'e2e-usera@capy.sc';
const USER_A_PASSWORD = 'E2eTestPass!123';
const USER_B_EMAIL = 'e2e-userb@capy.sc';
const USER_B_PASSWORD = 'E2eTestPass!456';

const HOME_A = join(tmpdir(), 'capy-e2e-userA');
const HOME_B = join(tmpdir(), 'capy-e2e-userB');
const TEMP_MULTIORG = join(tmpdir(), 'capy-e2e-multiorg');
const TEMP_EXFIL = join(tmpdir(), 'capy-e2e-exfil');
const TEMP_ORGPICKER = join(tmpdir(), 'capy-e2e-orgpicker');

// Read WorkOS credentials from service .env
const serviceEnv = readFileSync(join(SERVICE_ROOT, '.env'), 'utf-8');
const WORKOS_API_KEY = serviceEnv.match(/WORKOS_API_KEY=(.+)/)?.[1]?.trim() || '';
const WORKOS_CLIENT_ID = serviceEnv.match(/WORKOS_CLIENT_ID=(.+)/)?.[1]?.trim() || '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function log(message: string): void {
  console.log(`\x1b[90m[e2e]\x1b[0m ${message}`);
}

function logPass(name: string): void {
  passed++;
  console.log(`\x1b[32m  ✓ ${name}\x1b[0m`);
}

function logFail(name: string, error: Error): void {
  failed++;
  console.log(`\x1b[31m  ✗ ${name}\x1b[0m`);
  console.log(`\x1b[31m    ${error.message}\x1b[0m`);
}

/** Make a WorkOS Management API call */
async function workosApi(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.workos.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${WORKOS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (method === 'DELETE') return null;
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`WorkOS API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/** Create or reset a WorkOS user with a known password */
async function ensureWorkOSUser(email: string, password: string): Promise<string> {
  // Delete all existing users with this email
  const list = await workosApi('GET', `/user_management/users?email=${encodeURIComponent(email)}`);
  for (const user of list.data || []) {
    log(`  Deleting existing user ${user.id} (${user.email})`);
    await workosApi('DELETE', `/user_management/users/${user.id}`);
  }

  // Brief pause after deletion
  if (list.data?.length > 0) {
    await new Promise(r => setTimeout(r, 1000));
  }

  const user = await workosApi('POST', '/user_management/users', {
    email,
    password,
    email_verified: true,
  });
  log(`  Created user ${user.id} (${email})`);
  return user.id;
}

interface Interaction {
  /** Text pattern to wait for in stdout */
  waitFor: string | RegExp;
  /** What to send to stdin when matched */
  send: string;
  /** Delay in ms after match before sending (default: 200) */
  delay?: number;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn capy-dev with interactive prompt handling.
 * Watches stdout for patterns and sends keystrokes to stdin.
 */
function spawnCapy(
  args: string[],
  opts: {
    cwd: string;
    user: 'A' | 'B';
    interactions?: Interaction[];
    timeout?: number;
    expectFailure?: boolean;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const home = opts.user === 'A' ? HOME_A : HOME_B;
    const email = opts.user === 'A' ? USER_A_EMAIL : USER_B_EMAIL;
    const password = opts.user === 'A' ? USER_A_PASSWORD : USER_B_PASSWORD;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: home,
      CAPY_API_URL: TEST_API_URL,
      CAPY_TEST_EMAIL: email,
      CAPY_TEST_PASSWORD: password,
      FORCE_COLOR: '0',
      TERM: 'dumb',
      NODE_NO_WARNINGS: '1',
      // Git identity for commits made by capy-dev (deploy flow)
      GIT_AUTHOR_NAME: 'E2E Test',
      GIT_AUTHOR_EMAIL: 'e2e@test.local',
      GIT_COMMITTER_NAME: 'E2E Test',
      GIT_COMMITTER_EMAIL: 'e2e@test.local',
    };

    const proc = spawn('node', [CAPY_DEV_BIN, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const interactions = [...(opts.interactions || [])];
    let currentInteraction = interactions.shift();
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        reject(new Error(
          `Timeout after ${opts.timeout || 60000}ms.\n` +
          `stdout so far:\n${stdout}\n` +
          `stderr so far:\n${stderr}\n` +
          (currentInteraction ? `Waiting for: ${currentInteraction.waitFor}` : 'No pending interaction')
        ));
      }
    }, opts.timeout || 60000);

    const checkInteraction = () => {
      if (!currentInteraction || !proc.stdin.writable) return;

      const pattern = currentInteraction.waitFor;
      const matches = typeof pattern === 'string'
        ? stdout.includes(pattern)
        : pattern.test(stdout);

      if (matches) {
        const interaction = currentInteraction;
        currentInteraction = interactions.shift();
        const delay = interaction.delay ?? 200;

        setTimeout(() => {
          if (proc.stdin.writable) {
            proc.stdin.write(interaction.send);
          }
        }, delay);
      }
    };

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      checkInteraction();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Run a shell command and return stdout */
function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ─── Service Management ───────────────────────────────────────────────────────

let serviceProc: ChildProcess | null = null;

async function startTestService(): Promise<void> {
  log('Starting test service on port ' + TEST_PORT + '...');

  // Run migrations on test DB (drop all tables first to avoid column-rename conflicts)
  try {
    sh(`docker exec service-postgres-1 psql -U capy -d capy_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>&1`);
  } catch {}
  sh(`DATABASE_URL="${TEST_DB_URL}" bunx drizzle-kit push --force 2>&1`, SERVICE_ROOT);

  serviceProc = spawn('bun', ['run', 'src/server.ts'], {
    cwd: SERVICE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      ALLOW_PASSWORD_AUTH: 'true',
      PORT: String(TEST_PORT),
      WORKOS_API_KEY,
      WORKOS_CLIENT_ID,
      // LocalStack S3 credentials
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_REGION: 'us-east-1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Log service errors for debugging
  serviceProc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`\x1b[33m[service]\x1b[0m ${msg}`);
  });

  // Wait for health
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${TEST_API_URL}/health`);
      if (res.ok) {
        log('Service is healthy');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Test service failed to start');
}

function stopTestService(): void {
  if (serviceProc) {
    serviceProc.kill('SIGTERM');
    serviceProc = null;
  }
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  log('=== Setup ===');

  // Build CLI
  log('Building CLI...');
  sh('bun run build', CLI_ROOT);

  // Clean HOME dirs
  for (const dir of [HOME_A, HOME_B]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
  }

  // Truncate test DB via docker
  log('Truncating test DB...');
  try {
    sh(`docker exec service-postgres-1 psql -U capy -d capy_test -c "TRUNCATE user_permissions, audit_logs, branches, projects, organizations CASCADE;" 2>&1`);
  } catch {
    log('Warning: DB truncation failed (tables may not exist yet)');
  }

  // Create WorkOS test users
  log('Creating WorkOS test users...');
  await ensureWorkOSUser(USER_A_EMAIL, USER_A_PASSWORD);
  await ensureWorkOSUser(USER_B_EMAIL, USER_B_PASSWORD);

  // Reset sandboxes
  log('Resetting sandboxes...');
  // Force-clean both sandboxes back to main
  for (const dir of [SANDBOX_USER1, SANDBOX_USER2]) {
    try { sh('git reset --hard HEAD', dir); } catch {}
    try { sh('git checkout main', dir); } catch {}
    try { sh('git clean -fd', dir); } catch {}
    // Delete any leftover test branches
    try { sh('git branch -D e2e-test', dir); } catch {}
    try { sh('git branch -D e2e-test-main', dir); } catch {}
    // Delete capy/sync-* branches created by deploy flow
    try {
      const syncBranches = sh('git branch --list "capy/sync-*"', dir).trim();
      if (syncBranches) {
        for (const b of syncBranches.split('\n').map(s => s.trim()).filter(Boolean)) {
          try { sh(`git branch -D "${b}"`, dir); } catch {}
        }
      }
    } catch {}
  }

  // Run reset for both
  sh('bash reset.sh', SANDBOX_USER1);
  sh('bash reset.sh', SANDBOX_USER2);

  // Generate .env for user1 only (gen-env.sh is on main)
  sh('bash gen-env.sh', SANDBOX_USER1);

  // Remove .env from user2 (reset copies it, but spec says 0 secrets)
  if (existsSync(join(SANDBOX_USER2, '.env'))) {
    rmSync(join(SANDBOX_USER2, '.env'));
  }

  // Clean up remote test branches
  log('Cleaning remote test branches...');
  try {
    const remoteBranches = sh('git branch -r --list "origin/capy/sync-*" --list "origin/e2e-test*"', SANDBOX_USER1).trim();
    for (const rb of remoteBranches.split('\n').map(s => s.trim().replace('origin/', '')).filter(Boolean)) {
      try { sh(`git push origin --delete "${rb}"`, SANDBOX_USER1); } catch {}
    }
  } catch {}

  // Create e2e-test branch in sandbox repo
  log('Creating e2e-test branch...');
  sh('git checkout -b e2e-test', SANDBOX_USER1);

  // Create temp dirs for multi-org tests
  for (const dir of [TEMP_MULTIORG, TEMP_EXFIL, TEMP_ORGPICKER]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    sh('git init', dir);
    sh('git commit --allow-empty -m "init"', dir);
  }

  // Start test service
  await startTestService();
}

async function teardown(): Promise<void> {
  log('\n=== Teardown ===');
  stopTestService();

  // Delete test branches (local + remote)
  try { sh('git checkout main', SANDBOX_USER1); } catch {}
  try {
    // Delete all local capy/sync-*, e2e-test* branches
    const localBranches = sh('git branch --list "capy/sync-*" --list "e2e-test*"', SANDBOX_USER1).trim();
    for (const b of localBranches.split('\n').map(s => s.trim()).filter(Boolean)) {
      try { sh(`git branch -D "${b}"`, SANDBOX_USER1); } catch {}
    }
  } catch {}
  try {
    // Delete all remote capy/sync-*, e2e-test* branches
    sh('git fetch --prune', SANDBOX_USER1);
    const remoteBranches = sh('git branch -r --list "origin/capy/sync-*" --list "origin/e2e-test*"', SANDBOX_USER1).trim();
    for (const rb of remoteBranches.split('\n').map(s => s.trim().replace('origin/', '')).filter(Boolean)) {
      try { sh(`git push origin --delete "${rb}"`, SANDBOX_USER1); } catch {}
    }
  } catch {}

  // Clean up WorkOS users
  log('Cleaning up WorkOS users...');
  try {
    const listA = await workosApi('GET', `/user_management/users?email=${encodeURIComponent(USER_A_EMAIL)}`);
    if (listA.data?.[0]) await workosApi('DELETE', `/user_management/users/${listA.data[0].id}`);
  } catch {}
  try {
    const listB = await workosApi('GET', `/user_management/users?email=${encodeURIComponent(USER_B_EMAIL)}`);
    if (listB.data?.[0]) await workosApi('DELETE', `/user_management/users/${listB.data[0].id}`);
  } catch {}

  // Clean up WorkOS orgs created during test
  try {
    const orgs = await workosApi('GET', '/organizations?limit=100');
    for (const org of orgs.data || []) {
      if (org.name.startsWith('e2e-')) {
        await workosApi('DELETE', `/organizations/${org.id}`);
      }
    }
  } catch {}

  // Reset sandboxes
  for (const dir of [SANDBOX_USER1, SANDBOX_USER2]) {
    try { sh('git reset --hard HEAD', dir); } catch {}
    try { sh('git checkout main', dir); } catch {}
    try { sh('git clean -fd', dir); } catch {}
  }

  // Clean HOME dirs and temp dirs
  for (const dir of [HOME_A, HOME_B, TEMP_MULTIORG, TEMP_EXFIL, TEMP_ORGPICKER]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/** Phase 1: Initialize User A */
async function testInitUserA(): Promise<void> {
  log('Init User A in sandbox/user1...');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 30000,
    interactions: [
      // Create new org (user has 0 orgs)
      { waitFor: 'Organization name:', send: 'e2e-test-org\n' },
      // Recovery phrase confirmation (comes BEFORE project name)
      { waitFor: 'I have saved my recovery phrase', send: 'y\n' },
      // Project name (no existing projects in new org → picker is skipped)
      { waitFor: 'Project name', send: 'user1\n' },
      // First-run sync: commit all to development (default option)
      { waitFor: 'Commit all to development', send: '\n' },
      // Wait for completion
      { waitFor: /capy push|Ready to work/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User A init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(existsSync(join(SANDBOX_USER1, 'keep.lock')), 'keep.lock file not created');
  assert(result.stdout.includes('10') || result.stdout.includes('variable'), 'Expected 10 variables synced');
  assert(result.stdout.includes('capy push'), 'Expected push hint in output');
}

/** Verify branch was created */
async function testBranchExists(): Promise<void> {
  log('Verifying branch exists...');

  const result = await spawnCapy(['branch'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      // Stay on current branch
      { waitFor: 'Switch branch', send: '\x1b[B\n', delay: 300 },  // arrow down to "Stay" then enter
    ],
  });

  // branch command should list branches
  assert(result.stdout.includes('user1') || result.stdout.includes('Project'), 'Branch listing should show project');
}

/** Phase 1b: Initialize User B */
async function testInitUserB(): Promise<void> {
  log('Init User B in sandbox/user2...');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Create new org for User B (0 existing orgs)
      { waitFor: 'Organization name:', send: 'e2e-test-org-b\n' },
      // Recovery phrase (comes BEFORE project name)
      { waitFor: 'I have saved my recovery phrase', send: 'y\n' },
      // Project name (no existing projects → picker is skipped)
      { waitFor: 'Project name', send: 'user2\n' },
      // No deploy needed — 0 secrets
      { waitFor: /capy push|Ready to work|Everything is up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(existsSync(join(SANDBOX_USER2, 'keep.lock')), 'User B keep.lock file not created');
}

/** Phase 1c: Second run after init must use cached session.
 *  Regression test: init previously never wrote user_id to sync-state, so
 *  the next `capy` run could not find the user-scoped auth session and
 *  went back through the full login flow. */
async function testSessionCachedAfterInit(): Promise<void> {
  log('Second capy run after User B init should use cached session...');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    // No interactions — session should be cached and sync should complete silently
    interactions: [
      { waitFor: /Everything is up to date|up to date|keep\.lock updated|capy push/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `Second capy run failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    /\((cached|refreshed)\)/.test(result.stdout),
    `Expected cached/refreshed auth after init, got: ${result.stdout}`,
  );
}

/** Phase 2: User A invites User B as Admin */
async function testInviteUserB(): Promise<string> {
  log('User A invites User B as Admin...');

  const result = await spawnCapy(['invite', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 20000,
    interactions: [
      // Select Admin role (3rd option: Member, Project Admin, Admin)
      { waitFor: 'Select a role', send: '\x1b[B\x1b[B\n', delay: 300 },
    ],
  });

  assert(result.exitCode === 0, `Invite failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(result.stdout.includes('Invite created'), 'Expected invite creation message');

  // Extract redeem code (strip ANSI codes that wrap "capy" in bold)
  const stripped = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const redeemMatch = stripped.match(/capy redeem\s+(\S+)/);
  assert(redeemMatch !== null, `Could not extract redeem code from: ${stripped}`);

  return redeemMatch![1];
}

/** Phase 3: User B fails to sync without redeeming.
 *  Drops User A's keep.lock into User B's directory and runs capy as User B.
 *  User B has no master key for User A's org, so the auth check should fail. */
async function testUserBSyncFails(): Promise<void> {
  log('User B attempts sync of User A project (should fail without master key)...');

  // Drop User A's keep.lock into user2 dir (overwrites User B's own)
  copyFileSync(join(SANDBOX_USER1, 'keep.lock'), join(SANDBOX_USER2, 'keep.lock'));

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    expectFailure: true,
    interactions: [],
  });

  // Should fail — User B doesn't have access to User A's org master key yet
  const combined = result.stdout + result.stderr;
  assert(
    result.exitCode !== 0 || combined.includes('access') || combined.includes('key') || combined.includes('error') || combined.includes('permission'),
    `Expected User B sync to fail, but got exit ${result.exitCode}: ${combined}`,
  );
}

/** Phase 4: User B redeems invite — must switch from Org B to Org A */
async function testRedeemInvite(redeemCode: string): Promise<void> {
  log('User B redeems invite...');

  // Before redeem: User B is in e2e-test-org-b
  const keepBefore = JSON.parse(readFileSync(join(SANDBOX_USER2, 'keep.lock'), 'utf-8'));
  assert(
    keepBefore.project_name === 'user2',
    `Before redeem, expected User B in their own project, got: ${keepBefore.project_name}`,
  );

  const result = await spawnCapy(['redeem', redeemCode], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });

  assert(result.exitCode === 0, `Redeem failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  const combined = result.stdout + result.stderr;
  assert(
    combined.includes('redeemed') || combined.includes('access'),
    `Expected redeem success message: ${combined}`,
  );

  // After redeem: User B's session must know about BOTH orgs.
  // The redeem flow authenticates into Org A (the inviter's org),
  // so the session should now contain both e2e-test-org and e2e-test-org-b.
  const sessionFiles = readdirSync(join(HOME_B, '.capy', 'auth', 'sessions')).filter(f => f.endsWith('.json'));
  assert(sessionFiles.length > 0, 'No session file found after redeem');
  const session = JSON.parse(readFileSync(join(HOME_B, '.capy', 'auth', 'sessions', sessionFiles[0]), 'utf-8'));
  const orgNames = session.organizations.map((o: any) => o.name);
  assert(
    orgNames.includes('e2e-test-org') || orgNames.some((n: string) => n === 'e2e-test-org'),
    `Session missing inviter org after redeem. Orgs: ${orgNames.join(', ')}`,
  );
  assert(
    orgNames.includes('e2e-test-org-b'),
    `Session missing User B's own org after redeem. Orgs: ${orgNames.join(', ')}`,
  );
}

/** Phase 4b: User B bootstraps User A's project into an EMPTY directory after redeeming.
 *  This is the "no keep.lock" case — like a fresh git clone without committed keep.lock.
 *  User B should be prompted to pick the project from User A's org and pull all secrets. */
async function testUserBSyncAfterRedeem(): Promise<void> {
  log('User B bootstraps with no keep.lock after redeeming...');

  // Wipe user2 dir clean of any keep.lock or .env so the bootstrap path runs
  for (const f of ['keep.lock', '.env', '.capy']) {
    const p = join(SANDBOX_USER2, f);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // User B has 2 orgs now (their own + User A's via redeem) — pick User A's org
      // Org selection appears as a list — "e2e-test-org" is User A's. Use string match.
      { waitFor: 'Select organization', send: '\n', delay: 500 },
      // Project picker — User A's org has the "user1" project. First option.
      { waitFor: 'Which project do you want to use', send: '\n', delay: 500 },
      // Wait for bootstrap to finish
      { waitFor: /Pulled \d+ secret|capy push|Successfully/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B bootstrap failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    !result.stdout.includes('Cannot reach remote'),
    `User B bootstrap fell back to local-only: ${result.stdout}`,
  );

  // After bootstrap, user2 dir must have keep.lock and .env with User A's secrets
  assert(existsSync(join(SANDBOX_USER2, 'keep.lock')), 'keep.lock not created during bootstrap');
  const envPath = join(SANDBOX_USER2, '.env');
  assert(existsSync(envPath), '.env not created during bootstrap');

  const envContent = readFileSync(envPath, 'utf-8');
  const varCount = envContent.split('\n').filter(l => l.includes('=') && !l.startsWith('#')).length;
  assert(varCount >= 10, `User B should have at least 10 variables after bootstrap, got ${varCount}`);
}

/**
 * After redeem, User B has 2 orgs: e2e-test-org (from invite) and e2e-test-org-b (own).
 * Run `capy org` and verify BOTH orgs appear in the switcher, with e2e-test-org selected
 * (since that's where User B just synced to).
 */
async function testUserBSeesBothOrgsAfterRedeem(): Promise<void> {
  log('User B runs capy org — should see both orgs...');

  const result = await spawnCapy(['org'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    interactions: [
      // Org switcher shows — just pick current to exit cleanly
      { waitFor: /Switch organization|Already on/, send: '\n', delay: 300 },
    ],
  });

  assert(result.exitCode === 0, `capy org failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  const output = result.stdout;

  // Must NOT show "No other organizations available" — that means only 1 org was found
  assert(
    !output.includes('No other organizations available'),
    `capy org shows only 1 org — multi-org is broken. Output: ${output}`,
  );

  // Both org names must appear as distinct entries
  const hasOrgA = /e2e-test-org(?!-)/.test(output);
  const hasOrgB = output.includes('e2e-test-org-b');
  assert(hasOrgA, `capy org missing "e2e-test-org": ${output}`);
  assert(hasOrgB, `capy org missing "e2e-test-org-b": ${output}`);

  // e2e-test-org should be marked as current (User B just synced there)
  assert(
    output.includes('current'),
    `Expected current org marker in output: ${output}`,
  );
}

/** Phase 5: User A updates SENDGRID_KEY locally, syncs, then pushes */
async function testSyncConflict(): Promise<void> {
  log('User A updates SENDGRID_KEY and syncs...');

  // Decrypt .env first
  const decryptResult = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 10000,
    interactions: [],
  });
  assert(decryptResult.exitCode === 0, `Decrypt failed: ${decryptResult.stdout}\n${decryptResult.stderr}`);

  // Update SENDGRID_KEY in plaintext .env
  const envPath = join(SANDBOX_USER1, '.env');
  let envContent = readFileSync(envPath, 'utf-8');
  envContent = envContent.replace(/SENDGRID_KEY=.*/, 'SENDGRID_KEY=SG.abcdef123457');
  writeFileSync(envPath, envContent);

  // Sync — should detect local change vs pinned
  const result = await spawnCapy([], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 30000,
    interactions: [
      // Diff table appears — pick "Commit all local values" (default)
      { waitFor: /select value|Commit all local/, send: '\n', delay: 500 },
      // Wait for "keep.lock updated" / "capy push" hint
      { waitFor: /keep\.lock updated|capy push/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `Sync conflict resolution failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  // Push the new value to the service so User B can pull it
  const pushResult = await spawnCapy(['push'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(pushResult.exitCode === 0, `Push failed (exit ${pushResult.exitCode}): ${pushResult.stdout}\n${pushResult.stderr}`);
  assert(pushResult.stdout.includes('Pushed'), `Expected push confirmation: ${pushResult.stdout}`);
}

/** Phase 5b: User B pulls updated SENDGRID_KEY via stale keep.lock self-heal.
 *  At this point User B's keep.lock is stale (pre-update). User B runs capy
 *  WITHOUT manually copying keep.lock — the client must detect the staleness
 *  via the server's `keep_file` response and self-heal. */
async function testUserBGetsUpdatedKey(): Promise<void> {
  log('User B pulls updated SENDGRID_KEY via self-heal...');

  // Sanity: User B's keep.lock should already exist from the bootstrap step
  assert(existsSync(join(SANDBOX_USER2, 'keep.lock')), 'Pre-condition: User B should have a keep.lock from bootstrap');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Diff table shows true 3-way: Pinned (User B's old hash), Local (matches
      // pinned, unedited), Remote (User A's new value). showLocal=false,
      // showRemote=true. Menu order for !showLocal && showRemote:
      //   1. Retrieve all pinned values   (= old value, undo)
      //   2. Retrieve all remote values   (= User A's new value — what we want)
      //   3. Individually resolve
      // Arrow-down once, then Enter, to pick option 2.
      { waitFor: /select value/, send: '\x1b[B\n', delay: 500 },
      { waitFor: /keep\.lock updated|capy push|Encrypting/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B sync failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    !result.stdout.includes('Cannot reach remote'),
    `User B sync fell back to local-only mode: ${result.stdout}`,
  );

  // Decrypt and verify the key matches User A's update exactly
  const decryptResult = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 10000,
    interactions: [],
  });
  assert(decryptResult.exitCode === 0, `Decrypt failed: ${decryptResult.stdout}\n${decryptResult.stderr}`);

  const envContent = readFileSync(join(SANDBOX_USER2, '.env'), 'utf-8');
  const keyMatch = envContent.match(/SENDGRID_KEY=(.*)/);
  assert(keyMatch !== null, `SENDGRID_KEY not found in User B .env after pull`);
  assert(
    keyMatch![1] === 'SG.abcdef123457',
    `User B SENDGRID_KEY should be SG.abcdef123457 (User A's update), got: ${keyMatch![1]}`,
  );
}

/** Phase 6: User A kicks User B */
async function testKickUserB(): Promise<void> {
  log('User A kicks User B...');

  const result = await spawnCapy(['kick', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: 'Remove', send: 'y\n' },
    ],
  });

  assert(result.exitCode === 0, `Kick failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    result.stdout.includes('removed') || result.stdout.includes('deleted'),
    `Expected kick confirmation: ${result.stdout}`,
  );
}

/** Phase 6b: User B cannot sync after being kicked */
async function testKickedUserCantSync(): Promise<void> {
  log('User B attempts sync after being kicked (should fail and clean up)...');

  // Capture org ID before sync attempt (keep.lock still exists at this point)
  const userAKeep = JSON.parse(readFileSync(join(SANDBOX_USER1, 'keep.lock'), 'utf-8'));
  const orgAId = userAKeep.org_id;

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    expectFailure: true,
    interactions: [],
  });

  const combined = result.stdout + result.stderr;
  assert(
    result.exitCode !== 0 || combined.includes('denied') || combined.includes('removed'),
    `Expected kicked user to lose access: exit ${result.exitCode}, output: ${combined}`,
  );

  // Verify local org data was cleaned up
  assert(
    !existsSync(join(SANDBOX_USER2, 'keep.lock')),
    'keep.lock should be deleted after kicked sync attempt',
  );
  assert(
    !existsSync(join(HOME_B, '.capy', 'orgs', orgAId)),
    'Local org key directory should be deleted after kicked sync attempt',
  );
}

/** Phase 7: Branching — capy branches, isolation, and role-based access.
 *
 *  Capy branches are now decoupled from git branches, so this test uses ONLY
 *  capy commands and direct file operations — no git checkouts.
 *
 *  Starting state (from previous tests):
 *  - User A: development branch, SENDGRID_KEY=SG.abcdef123457, in user1 dir
 *  - User B: kicked from User A's org, has stale keep.lock in user2 dir
 */
async function testBranching(): Promise<void> {
  // Wait for WorkOS rate limit window to reset from earlier invite/kick cycles
  log('Waiting for rate limit cooldown...');
  await new Promise(r => setTimeout(r, 60000));
  log('=== Branching Tests ===');

  // 7.1: User A creates protected branch e2e-test-main on Capy
  log('User A creates protected capy branch e2e-test-main...');
  const checkoutResult = await spawnCapy(['checkout', '-b', 'e2e-test-main', '--protected'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(checkoutResult.exitCode === 0, `Checkout -b failed: ${checkoutResult.stdout}\n${checkoutResult.stderr}`);

  // 7.2: User A modifies SENDGRID_KEY on the new branch
  log('User A updates SENDGRID_KEY on e2e-test-main...');
  await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 10000,
    interactions: [],
  });

  const envPath = join(SANDBOX_USER1, '.env');
  let envContent = readFileSync(envPath, 'utf-8');
  envContent = envContent.replace(/SENDGRID_KEY=.*/, 'SENDGRID_KEY=SG.abcdef123458');
  writeFileSync(envPath, envContent);

  // Run capy on the new branch — keep.lock has no entries for e2e-test-main yet,
  // so this is a "no pinned values" case → menu has only "Commit and push all local"
  const syncResult = await spawnCapy([], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 30000,
    interactions: [
      { waitFor: /select value|Commit and push|Commit all local/, send: '\n', delay: 500 },
      { waitFor: /keep\.lock updated|capy push/, send: '' },
    ],
  });
  assert(syncResult.exitCode === 0, `Sync on protected branch failed: ${syncResult.stdout}\n${syncResult.stderr}`);

  // Push the new branch's secrets to the server so other users can pull
  const pushResult = await spawnCapy(['push'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(pushResult.exitCode === 0, `Push to protected branch failed: ${pushResult.stdout}\n${pushResult.stderr}`);

  // 7.3: User A switches back to development — SENDGRID_KEY should be the
  // development value (123457), proving branch isolation
  log('User A switches back to development...');
  const checkoutDev = await spawnCapy(['checkout', 'development'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(checkoutDev.exitCode === 0, `Checkout development failed: ${checkoutDev.stdout}\n${checkoutDev.stderr}`);

  await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 10000,
    interactions: [],
  });

  const devEnv = readFileSync(envPath, 'utf-8');
  const devKey = devEnv.match(/SENDGRID_KEY=(.*)/)?.[1];
  assert(
    devKey === 'SG.abcdef123457',
    `After switching back to development, SENDGRID_KEY should be SG.abcdef123457, got: ${devKey}`,
  );

  // 7.4: User A re-invites User B as Member (was kicked in earlier test)
  await new Promise(r => setTimeout(r, 5000));
  log('User A re-invites User B as Member...');
  const inviteResult = await spawnCapy(['invite', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 20000,
    interactions: [
      // Select Member (first option)
      { waitFor: 'Select a role', send: '\n', delay: 300 },
    ],
  });
  assert(inviteResult.exitCode === 0, `Re-invite failed: ${inviteResult.stdout}\n${inviteResult.stderr}`);

  const redeemStripped = inviteResult.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const redeemMatch = redeemStripped.match(/capy redeem\s+(\S+)/);
  assert(redeemMatch !== null, 'Could not extract redeem code');

  // 7.5: User B redeems and accesses the protected branch.
  // TODO: Protected branch enforcement on the service side is not implemented.
  // For now, this just verifies that the branch switch works and User B can
  // pull the value via self-heal in checkoutCommand.
  log('User B redeems and attempts protected branch as Member...');
  const redeemResult = await spawnCapy(['redeem', redeemMatch![1]], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });
  assert(redeemResult.exitCode === 0, `Redeem failed: ${redeemResult.stdout}\n${redeemResult.stderr}`);

  // User B's existing keep.lock (from earlier bootstrap) is on development.
  // They switch to e2e-test-main — checkoutCommand fetches latest from the
  // server and self-heals their keep.lock.
  const memberCheckout = await spawnCapy(['checkout', 'e2e-test-main'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });
  assert(
    memberCheckout.exitCode === 0,
    `Member checkout of e2e-test-main failed: ${memberCheckout.stdout}\n${memberCheckout.stderr}`,
  );

  // Verify User B got SENDGRID_KEY=123458 on the protected branch
  const memberDecrypt = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 10000,
    interactions: [],
  });
  assert(memberDecrypt.exitCode === 0, `Member decrypt failed: ${memberDecrypt.stdout}\n${memberDecrypt.stderr}`);

  const memberEnv = readFileSync(join(SANDBOX_USER2, '.env'), 'utf-8');
  const memberKey = memberEnv.match(/SENDGRID_KEY=(.*)/)?.[1];
  assert(
    memberKey === 'SG.abcdef123458',
    `User B (member) on e2e-test-main should see SENDGRID_KEY=SG.abcdef123458, got: ${memberKey}`,
  );

  // 7.6: User A kicks User B and re-invites as Admin
  await new Promise(r => setTimeout(r, 10000));
  log('User A kicks and re-invites User B as Admin...');
  const kickResult = await spawnCapy(['kick', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: 'Remove', send: 'y\n' },
    ],
  });
  assert(kickResult.exitCode === 0, `Kick failed: ${kickResult.stdout}\n${kickResult.stderr}`);

  await new Promise(r => setTimeout(r, 10000));
  const adminInviteResult = await spawnCapy(['invite', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 20000,
    interactions: [
      // Select Admin (3rd option)
      { waitFor: 'Select a role', send: '\x1b[B\x1b[B\n', delay: 300 },
    ],
  });
  assert(adminInviteResult.exitCode === 0, `Admin invite failed: ${adminInviteResult.stdout}\n${adminInviteResult.stderr}`);

  const adminStripped = adminInviteResult.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const adminRedeemMatch = adminStripped.match(/capy redeem\s+(\S+)/);
  assert(adminRedeemMatch !== null, 'Could not extract admin redeem code');

  // 7.7: User B redeems as Admin and accesses the protected branch
  await new Promise(r => setTimeout(r, 5000));
  log('User B redeems as Admin and accesses protected branch...');
  const adminRedeemResult = await spawnCapy(['redeem', adminRedeemMatch![1]], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });
  assert(adminRedeemResult.exitCode === 0, `Admin redeem failed: ${adminRedeemResult.stdout}\n${adminRedeemResult.stderr}`);

  const adminCheckout = await spawnCapy(['checkout', 'e2e-test-main'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });
  assert(
    adminCheckout.exitCode === 0,
    `Admin checkout of e2e-test-main failed: ${adminCheckout.stdout}\n${adminCheckout.stderr}`,
  );

  // 7.8: User B switches back to development — verify SENDGRID_KEY reverts
  log('User B switches back to development...');
  const switchDev = await spawnCapy(['checkout', 'development'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    interactions: [],
  });
  assert(switchDev.exitCode === 0, `Switch to development failed: ${switchDev.stdout}\n${switchDev.stderr}`);

  const decryptB = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 10000,
    interactions: [],
  });
  assert(decryptB.exitCode === 0, `Decrypt on development failed: ${decryptB.stdout}\n${decryptB.stderr}`);

  const finalEnv = readFileSync(join(SANDBOX_USER2, '.env'), 'utf-8');
  const finalKey = finalEnv.match(/SENDGRID_KEY=(.*)/)?.[1];
  assert(
    finalKey === 'SG.abcdef123457',
    `User B on development should see SENDGRID_KEY=SG.abcdef123457, got: ${finalKey}`,
  );
}

/** Validate SDK runtime decryption */
async function testSdkValidation(): Promise<void> {
  log('Validating SDK runtime decryption...');

  // Run `bun run setup` then `node index.mjs` — exactly as a user would
  sh('bun run setup', SANDBOX_USER1);
  const sdkOutput = sh(`HOME=${HOME_A} node index.mjs`, SANDBOX_USER1);
  assert(sdkOutput.includes('After decrypt'), 'SDK output should show "After decrypt" section');
  assert(sdkOutput.includes('sk_live_abc123xyz789'), 'SDK should decrypt API_KEY');
  assert(sdkOutput.includes('SG.abcdef'), 'SDK should decrypt SENDGRID_KEY');
}

// ─── Multi-Org Tests ─────────────────────────────────────────────────────────

/** capy org with a single org should show "no other organizations available" */
async function testOrgSingleOrg(): Promise<void> {
  log('User A runs capy org (single org)...');

  const result = await spawnCapy(['org'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });

  assert(result.exitCode === 0, `capy org failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    result.stdout.includes('No other organizations available'),
    `Expected "No other organizations available", got: ${result.stdout}`,
  );
  assert(result.stdout.includes('e2e-test-org'), `Expected org name in output: ${result.stdout}`);
}

/** capy org switch — User B switches from e2e-test-org to e2e-test-org-b */
async function testOrgSwitchFlow(): Promise<void> {
  log('User B switches org via capy org...');

  const result = await spawnCapy(['org'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [
      // Pick e2e-test-org-b (not the current org). Arrow down to find it.
      { waitFor: 'Switch organization', send: '\x1b[B\n', delay: 300 },
      // Pick project in e2e-test-org-b
      { waitFor: 'Select project', send: '\n', delay: 300 },
    ],
  });

  assert(result.exitCode === 0, `capy org switch failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    result.stdout.includes('Switched to'),
    `Expected "Switched to" in output: ${result.stdout}`,
  );

  // Verify keep.lock was updated
  const keepContent = readFileSync(join(SANDBOX_USER2, 'keep.lock'), 'utf-8');
  const keep = JSON.parse(keepContent);
  assert(
    keep.project_name === 'user2',
    `Expected keep.lock project_name=user2 after switch, got: ${keep.project_name}`,
  );
}

/** capy org picking the current org should short-circuit with "Already on" */
async function testOrgSelectCurrentOrg(): Promise<void> {
  log('User B selects current org (should short-circuit)...');

  const result = await spawnCapy(['org'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    interactions: [
      // Pick first item (current, marked with "← current")
      { waitFor: 'Switch organization', send: '\n', delay: 300 },
    ],
  });

  assert(result.exitCode === 0, `capy org current failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(
    result.stdout.includes('Already on'),
    `Expected "Already on" in output: ${result.stdout}`,
  );
}

/**
 * THE CRITICAL TEST: Multi-org invite → redeem → auto org switch.
 *
 * Simulates real onboarding: User B is working in e2e-test-org-b (their own org).
 * User A invites them to e2e-test-org. After redeem, `capy` should automatically
 * land in e2e-test-org without manual org picker fumbling.
 */
async function testMultiOrgInviteRedeem(): Promise<string> {
  // --- Setup: put User B in the "wrong" org state ---

  // 1. Kick User B from e2e-test-org
  log('Kicking User B from e2e-test-org for fresh invite test...');
  const kickResult = await spawnCapy(['kick', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: 'Remove', send: 'y\n' },
    ],
  });
  assert(kickResult.exitCode === 0, `Kick failed: ${kickResult.stdout}\n${kickResult.stderr}`);

  // 2. Delete User B's local org key for e2e-test-org so redeem actually does work.
  //    Find the org ID from User A's keep.lock.
  const userAKeep = JSON.parse(readFileSync(join(SANDBOX_USER1, 'keep.lock'), 'utf-8'));
  const orgAId = userAKeep.org_id;
  const orgKeyDir = join(HOME_B, '.capy', 'orgs', orgAId);
  if (existsSync(orgKeyDir)) rmSync(orgKeyDir, { recursive: true });

  // Also clear any project key cache for this org
  log(`Cleared org key for ${orgAId} from User B's HOME`);

  // 3. User B's keep.lock is on e2e-test-org-b from testOrgSwitchFlow — the "wrong" org

  // 4. Rate limit cooldown
  log('Waiting for rate limit cooldown...');
  await new Promise(r => setTimeout(r, 60000));

  // --- Invite + Redeem ---

  // 5. User A invites User B as Admin
  log('User A invites User B to e2e-test-org...');
  const inviteResult = await spawnCapy(['invite', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 20000,
    interactions: [
      // Select Admin (3rd option)
      { waitFor: 'Select a role', send: '\x1b[B\x1b[B\n', delay: 300 },
    ],
  });
  assert(inviteResult.exitCode === 0, `Invite failed: ${inviteResult.stdout}\n${inviteResult.stderr}`);

  const stripped = inviteResult.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const redeemMatch = stripped.match(/capy redeem\s+(\S+)/);
  assert(redeemMatch !== null, `Could not extract redeem code from: ${stripped}`);
  const redeemCode = redeemMatch![1];

  // 6. User B redeems while their context is on e2e-test-org-b
  log('User B redeems invite (context is on wrong org)...');
  const redeemResult = await spawnCapy(['redeem', redeemCode], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });
  assert(redeemResult.exitCode === 0, `Redeem failed (exit ${redeemResult.exitCode}): ${redeemResult.stdout}\n${redeemResult.stderr}`);

  // 7. Verify redeem DELETED the stale keep.lock (it pointed to e2e-test-org-b)
  const keepPath = join(SANDBOX_USER2, 'keep.lock');
  assert(!existsSync(keepPath), 'keep.lock should be deleted after redeem (was pointing to wrong org)');

  // 8. Verify sync-state has org hint pointing to the redeemed org
  const syncStatePath = join(SANDBOX_USER2, '.capy', 'sync-state');
  assert(existsSync(syncStatePath), 'sync-state should exist after redeem');
  const syncState = JSON.parse(readFileSync(syncStatePath, 'utf-8'));
  assert(
    syncState.org_id === orgAId,
    `sync-state org_id should be ${orgAId} (redeemed org), got: ${syncState.org_id}`,
  );

  // 9. Run capy — no keep.lock means init flow runs. The org hint in sync-state
  //    should auto-select e2e-test-org, and init writes a proper keep.lock.
  log('User B runs capy after redeem (init should auto-select redeemed org)...');
  const initResult = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Org picker — e2e-test-org should be pre-selected via org hint. Just Enter.
      { waitFor: /Select organization/, send: '\n', delay: 500 },
      // Project picker — pick user1
      { waitFor: /Which project do you want to use/, send: '\n', delay: 500 },
      // Wait for sync
      { waitFor: /Pulled \d+ secret|capy push|Successfully/, send: '' },
    ],
  });

  assert(initResult.exitCode === 0, `Init after redeem failed (exit ${initResult.exitCode}): ${initResult.stdout}\n${initResult.stderr}`);

  // Verify init wrote a proper keep.lock pointing to the redeemed org
  assert(existsSync(keepPath), 'keep.lock should be created by init after redeem');
  const keep = JSON.parse(readFileSync(keepPath, 'utf-8'));
  assert(
    keep.org_id === orgAId,
    `keep.lock org_id should be ${orgAId} (redeemed org), got: ${keep.org_id}`,
  );

  // Verify .env has secrets
  const envPath = join(SANDBOX_USER2, '.env');
  assert(existsSync(envPath), '.env not created after init');
  const envContent = readFileSync(envPath, 'utf-8');
  const varCount = envContent.split('\n').filter(l => l.includes('=') && !l.startsWith('#')).length;
  assert(varCount >= 10, `Expected 10+ variables after init, got ${varCount}`);

  return redeemCode;
}

/**
 * SECURITY TEST: A kicked user must NOT be able to re-use an old invite code
 * to regain access to an organization. The server-side co-decrypt must reject
 * the request, and the local org key must be deleted.
 */
async function testKickedInviteReuse(): Promise<void> {
  // User B is currently in e2e-test-org from testMultiOrgInviteRedeem.
  // We need the redeem code from that test (passed via runner).

  // 1. Kick User B from e2e-test-org
  log('Kicking User B to test invite code reuse...');
  const kickResult = await spawnCapy(['kick', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: 'Remove', send: 'y\n' },
    ],
  });
  assert(kickResult.exitCode === 0, `Kick failed: ${kickResult.stdout}\n${kickResult.stderr}`);

  // 2. Wait for rate limit
  await new Promise(r => setTimeout(r, 10000));

  // 3. User B tries to redeem the SAME invite code from before the kick
  log('User B attempts to re-use old invite code after being kicked...');
  const redeemResult = await spawnCapy(['redeem', kickedRedeemCode], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    expectFailure: true,
    interactions: [],
  });

  // 4. Must fail — server should reject co-decrypt for a kicked user
  const combined = redeemResult.stdout + redeemResult.stderr;
  assert(
    redeemResult.exitCode !== 0,
    `SECURITY VIOLATION: Kicked user was able to re-use invite code! exit ${redeemResult.exitCode}: ${combined}`,
  );
  assert(
    combined.includes('Co-decryption failed') || combined.includes('not be a member') || combined.includes('revoked'),
    `Expected membership rejection error, got: ${combined}`,
  );

  // 5. Verify the local org key was cleaned up
  const userAKeep = JSON.parse(readFileSync(join(SANDBOX_USER1, 'keep.lock'), 'utf-8'));
  const orgAId = userAKeep.org_id;
  const orgKeyPath = join(HOME_B, '.capy', 'orgs', orgAId);
  assert(
    !existsSync(join(orgKeyPath, 'users')) || !readdirSync(join(orgKeyPath, 'users')).length,
    `Local org key should be deleted after kicked redeem attempt`,
  );
}

// Module-level variable to pass redeem code between tests
let kickedRedeemCode = '';

/** Init in a fresh dir with multiple orgs and no org hint (tests session fallback scan) */
async function testInitMultiOrgNoCurrent(): Promise<void> {
  log('User B inits in fresh dir with multiple orgs (no org hint)...');

  const result = await spawnCapy([], {
    cwd: TEMP_MULTIORG,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Org picker — no hint, shows flat list. Pick first org.
      { waitFor: /Select organization/, send: '\n', delay: 500 },
      // Project picker
      { waitFor: /Which project do you want to use/, send: '\n', delay: 500 },
      // Wait for sync
      { waitFor: /Pulled \d+ secret|capy push|Successfully|Everything is up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `Multi-org init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  // Session fallback scan should have found existing session (no OAuth prompt)
  assert(
    /\((cached|refreshed)\)/.test(result.stdout),
    `Expected cached/refreshed auth (session fallback scan), got: ${result.stdout}`,
  );

  // Verify project was created
  assert(existsSync(join(TEMP_MULTIORG, 'keep.lock')), 'keep.lock not created in temp dir');
  assert(existsSync(join(TEMP_MULTIORG, '.env')), '.env not created in temp dir');
}

/** Cross-org exfiltration guard: .env with capy: values from wrong org is blocked */
async function testCrossOrgExfiltrationGuard(): Promise<void> {
  log('Testing cross-org exfiltration guard...');

  // Copy User A's encrypted .env into the temp dir
  copyFileSync(join(SANDBOX_USER1, '.env'), join(TEMP_EXFIL, '.env'));

  const result = await spawnCapy([], {
    cwd: TEMP_EXFIL,
    user: 'B',
    timeout: 30000,
    expectFailure: true,
    interactions: [
      // Pick e2e-test-org-b (User B's own org — wrong org for these encrypted values)
      { waitFor: /Select organization/, send: '\x1b[B\n', delay: 500 },
      // Need to select or create a project — pick "Create a new project"
      // The list shows existing projects + separator + "Create a new project"
      { waitFor: /Which project|Project name/, send: '\x1b[B\x1b[B\n', delay: 500 },
      // If prompted for project name
      { waitFor: /Project name/, send: 'exfil-test\n', delay: 300 },
    ],
  });

  const combined = result.stdout + result.stderr;
  assert(
    combined.includes('Cannot initialize') || combined.includes('encrypted with a different'),
    `Expected cross-org exfiltration error, got: ${combined}`,
  );
}

/** Create a new organization during init when user already has orgs */
async function testInitCreateNewOrgDuringInit(): Promise<void> {
  log('User B creates new org during init...');

  // Clean .env from exfiltration test
  const exfilEnv = join(TEMP_EXFIL, '.env');
  if (existsSync(exfilEnv)) rmSync(exfilEnv);
  // Also clean any .capy dir from previous test
  const exfilCapy = join(TEMP_EXFIL, '.capy');
  if (existsSync(exfilCapy)) rmSync(exfilCapy, { recursive: true });

  const result = await spawnCapy([], {
    cwd: TEMP_EXFIL,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Org picker — arrow past existing orgs + separator to "Create new organization +"
      // User B has 2 orgs, so: org1, org2, separator, Create new = 4 items, need 3 down arrows
      { waitFor: /Select organization/, send: '\x1b[B\x1b[B\x1b[B\n', delay: 500 },
      // Org name
      { waitFor: 'Organization name', send: 'e2e-test-org-c\n' },
      // Recovery phrase confirmation
      { waitFor: 'I have saved my recovery phrase', send: 'y\n' },
      // Project name (no existing projects in new org)
      { waitFor: 'Project name', send: 'multiorg-test\n' },
      // No .env to sync — 0 secrets
      { waitFor: /capy push|Ready to work|Everything is up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `Create new org failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(existsSync(join(TEMP_EXFIL, 'keep.lock')), 'keep.lock not created for new org');
  assert(
    result.stdout.includes('e2e-test-org-c'),
    `Expected new org name in output: ${result.stdout}`,
  );
}

/**
 * After creating a third org, init in a fresh dir and verify ALL THREE orgs
 * appear as separate entries in the org picker. This catches regressions where
 * loadSession or refreshForOrg prunes multi-org sessions.
 */
async function testOrgPickerShowsAllOrgs(): Promise<void> {
  log('User B inits in fresh dir — org picker must show all 3 orgs...');

  const result = await spawnCapy([], {
    cwd: TEMP_ORGPICKER,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Org picker appears — just pick the first one, we only care about what's shown
      { waitFor: /Select organization/, send: '\n', delay: 500 },
      // Project picker or project name
      { waitFor: /Which project|Project name/, send: '\n', delay: 500 },
      // Wait for sync
      { waitFor: /Pulled \d+ secret|capy push|Successfully|Everything is up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `Org picker test failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  // Count distinct org names in the output. The picker renders each org as a
  // line containing its name. We need all 3 to be present as separate matches.
  const output = result.stdout;
  const hasOrgB = output.includes('e2e-test-org-b');
  const hasOrgC = output.includes('e2e-test-org-c');
  // e2e-test-org is a substring of the other two, so match it as a standalone
  // word boundary: preceded by a list bullet/space, NOT followed by '-'
  const hasOrgA = /e2e-test-org(?!-)/.test(output);

  assert(hasOrgA, `Org picker missing "e2e-test-org": ${output}`);
  assert(hasOrgB, `Org picker missing "e2e-test-org-b": ${output}`);
  assert(hasOrgC, `Org picker missing "e2e-test-org-c": ${output}`);

  // Also verify `capy org` shows all 3 orgs in the org switcher
  log('User B runs capy org — must show all 3 orgs...');
  const orgResult = await spawnCapy(['org'], {
    cwd: TEMP_ORGPICKER,
    user: 'B',
    timeout: 15000,
    interactions: [
      // Just pick current org to exit cleanly
      { waitFor: /Switch organization|Already on/, send: '\n', delay: 300 },
    ],
  });

  const orgOutput = orgResult.stdout;
  const orgHasA = /e2e-test-org(?!-)/.test(orgOutput);
  const orgHasB = orgOutput.includes('e2e-test-org-b');
  const orgHasC = orgOutput.includes('e2e-test-org-c');

  assert(orgHasA, `capy org missing "e2e-test-org": ${orgOutput}`);
  assert(orgHasB, `capy org missing "e2e-test-org-b": ${orgOutput}`);
  assert(orgHasC, `capy org missing "e2e-test-org-c": ${orgOutput}`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTest(name: string, fn: () => Promise<any>): Promise<any> {
  try {
    const result = await fn();
    logPass(name);
    return result;
  } catch (error: any) {
    logFail(name, error);
    throw error; // Re-throw to stop sequential tests
  }
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== Capy CLI E2E Test ===\x1b[0m\n');

  try {
    await setup();
  } catch (setupError: any) {
    console.error(`\x1b[31mSetup failed: ${setupError.message}\x1b[0m`);
    if (setupError.stderr) console.error(setupError.stderr);
    await teardown();
    process.exit(1);
  }

  try {
    // Initialization
    console.log('\n\x1b[1m--- Initialization Flow ---\x1b[0m');
    await runTest('Init User A (10 secrets)', testInitUserA);
    await runTest('Verify branch exists', testBranchExists);
    await runTest('Init User B (0 secrets)', testInitUserB);
    await runTest('Second run after init uses cached session', testSessionCachedAfterInit);

    // SDK Validation (run early, before branching messes with .env)
    console.log('\n\x1b[1m--- SDK Validation ---\x1b[0m');
    await runTest('SDK runtime decryption', testSdkValidation);

    // Invite
    console.log('\n\x1b[1m--- Invite Flow ---\x1b[0m');
    const redeemCode = await runTest('User A invites User B as Admin', testInviteUserB);
    await runTest('User B sync fails without redeeming', testUserBSyncFails);
    await runTest('User B redeems invite', () => testRedeemInvite(redeemCode));
    await runTest('User B syncs after redeeming', testUserBSyncAfterRedeem);
    await runTest('User B sees both orgs in capy org after redeem', testUserBSeesBothOrgsAfterRedeem);

    // Syncing
    console.log('\n\x1b[1m--- Syncing ---\x1b[0m');
    await runTest('User A updates SENDGRID_KEY (conflict resolution)', testSyncConflict);
    await runTest('User B gets updated SENDGRID_KEY', testUserBGetsUpdatedKey);

    // Kicking
    console.log('\n\x1b[1m--- Kicking ---\x1b[0m');
    await runTest('User A kicks User B', testKickUserB);
    await runTest('Kicked User B cannot sync', testKickedUserCantSync);

    // Branching
    console.log('\n\x1b[1m--- Branching ---\x1b[0m');
    await runTest('Protected branches and role-based access', testBranching);

    // (SDK Validation already ran above)

    // Multi-Org
    console.log('\n\x1b[1m--- Multi-Org ---\x1b[0m');
    await runTest('capy org with single org (User A)', testOrgSingleOrg);
    await runTest('capy org switch flow (User B)', testOrgSwitchFlow);
    await runTest('capy org select current org (User B)', testOrgSelectCurrentOrg);
    kickedRedeemCode = await runTest('Multi-org invite redeem auto-switch', testMultiOrgInviteRedeem);
    await runTest('SECURITY: kicked user cannot re-use invite code', testKickedInviteReuse);
    await runTest('Init with multiple orgs + session scan', testInitMultiOrgNoCurrent);
    await runTest('Cross-org exfiltration guard', testCrossOrgExfiltrationGuard);
    await runTest('Create new org during init', testInitCreateNewOrgDuringInit);
    await runTest('Org picker + capy org show all 3 orgs', testOrgPickerShowsAllOrgs);

  } catch {
    // Test failure already logged
  } finally {
    await teardown();
  }

  console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
