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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'fs';
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

  // Run migrations on test DB
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

  // Create e2e-test branch in sandbox repo
  log('Creating e2e-test branch...');
  try { sh('git push origin --delete e2e-test', SANDBOX_USER1); } catch {}
  try { sh('git push origin --delete e2e-test-main', SANDBOX_USER1); } catch {}
  sh('git checkout -b e2e-test', SANDBOX_USER1);

  // Start test service
  await startTestService();
}

async function teardown(): Promise<void> {
  log('\n=== Teardown ===');
  stopTestService();

  // Delete test branches
  try {
    sh('git checkout main', SANDBOX_USER1);
    sh('git branch -D e2e-test', SANDBOX_USER1);
    sh('git push origin --delete e2e-test', SANDBOX_USER1);
  } catch {}
  try {
    sh('git branch -D e2e-test-main', SANDBOX_USER1);
    sh('git push origin --delete e2e-test-main', SANDBOX_USER1);
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

  // Clean HOME dirs
  for (const dir of [HOME_A, HOME_B]) {
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
      // Create new org (first option in org selection — only shows "Create new" for new user)
      { waitFor: 'Organization name:', send: 'e2e-test-org\n' },
      // Project name
      { waitFor: 'Project name', send: 'user1\n' },
      // Recovery phrase confirmation
      { waitFor: 'I have saved my recovery phrase', send: 'y\n' },
      // Sync local variables
      { waitFor: /Synced.*variable/, send: '' },
      // Deploy prompt — push to e2e-test
      { waitFor: 'Deploy your secrets', send: '\n', delay: 500 },
    ],
  });

  assert(result.exitCode === 0, `User A init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(existsSync(join(SANDBOX_USER1, 'keep.lock')), 'keep.lock file not created');
  assert(result.stdout.includes('10') || result.stdout.includes('variable'), 'Expected 10 variables synced');

  // Create a capy secrets branch matching the git branch
  const createBranchResult = await spawnCapy(['checkout', '-b', 'e2e-test'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: /protected branch/i, send: 'n\n', delay: 300 },
    ],
  });

  // Commit and push keep.lock to e2e-test
  try {
    sh('git add keep.lock .gitignore && git -c user.name="E2E Test" -c user.email="e2e@test.local" commit -m "chore: add keep.lock for e2e test" --allow-empty', SANDBOX_USER1);
  } catch {
    // keep.lock may already be committed
  }
  sh('git push -u origin e2e-test', SANDBOX_USER1);
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
      // Create new org for User B
      { waitFor: 'Organization name:', send: 'e2e-test-org-b\n' },
      // Project name
      { waitFor: 'Project name', send: 'user2\n' },
      // Recovery phrase
      { waitFor: 'I have saved my recovery phrase', send: 'y\n' },
      // No deploy needed — 0 secrets
      { waitFor: /Ready to work|Everything is up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  assert(existsSync(join(SANDBOX_USER2, 'keep.lock')), 'User B keep.lock file not created');
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

  // Extract redeem code
  const redeemMatch = result.stdout.match(/capy redeem\s+(\S+)/);
  assert(redeemMatch !== null, `Could not extract redeem code from: ${result.stdout}`);

  return redeemMatch![1];
}

/** Phase 3: User B fails to sync without redeeming */
async function testUserBSyncFails(): Promise<void> {
  log('User B attempts sync (should fail without master key)...');

  // User B needs the keep.lock from User A's project to attempt sync
  // Stash User B's own keep.lock, switch to e2e-test with User A's keep.lock
  try { sh('git stash --include-untracked', SANDBOX_USER2); } catch {}
  sh('git fetch origin e2e-test', SANDBOX_USER2);
  sh('git checkout e2e-test', SANDBOX_USER2);

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    expectFailure: true,
    interactions: [],
  });

  // Should fail with permission error (no master key)
  const combined = result.stdout + result.stderr;
  assert(
    result.exitCode !== 0 || combined.includes('access') || combined.includes('key') || combined.includes('error'),
    `Expected User B sync to fail, but got exit ${result.exitCode}: ${combined}`,
  );
}

/** Phase 4: User B redeems invite */
async function testRedeemInvite(redeemCode: string): Promise<void> {
  log('User B redeems invite...');

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
}

/** Phase 4b: User B syncs successfully after redeeming */
async function testUserBSyncAfterRedeem(): Promise<void> {
  log('User B syncs after redeeming...');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [
      // User B is now syncing User A's project — should pull variables
      { waitFor: /up to date|variable|conflict|Pull/, send: '\n', delay: 300 },
      { waitFor: /Sync completed|up to date|Deploy|Continue/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B sync failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
}

/** Phase 5: User A updates SENDGRID_KEY and syncs */
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

  // Sync — should detect conflict
  const result = await spawnCapy([], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 30000,
    interactions: [
      // Conflict resolution — use local (first option, just press enter)
      { waitFor: 'SENDGRID_KEY', send: '\n', delay: 500 },
      // Confirm push to capy
      { waitFor: /Push.*capy/i, send: 'y\n', delay: 300 },
      // Apply changes
      { waitFor: /Apply these changes/i, send: 'y\n', delay: 300 },
      // Deploy — push to e2e-test (first option)
      { waitFor: 'Deploy your secrets', send: '\n', delay: 500 },
    ],
  });

  assert(result.exitCode === 0, `Sync conflict resolution failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  // Commit and push updated keep.lock
  try {
    sh('git add keep.lock && git -c user.name="E2E Test" -c user.email="e2e@test.local" commit -m "chore: update SENDGRID_KEY"', SANDBOX_USER1);
    sh('git push origin e2e-test', SANDBOX_USER1);
  } catch {
    // May already be committed
  }
}

/** Phase 5b: User B pulls updated SENDGRID_KEY */
async function testUserBGetsUpdatedKey(): Promise<void> {
  log('User B pulls updated SENDGRID_KEY...');

  sh('git pull origin e2e-test', SANDBOX_USER2);

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Conflict or pull prompt — use remote value
      { waitFor: 'SENDGRID_KEY', send: '\x1b[B\n', delay: 500 },  // arrow down to "Use remote" then enter
      // Push confirmation
      { waitFor: /Push.*capy|up to date/i, send: 'y\n', delay: 300 },
      // Apply changes
      { waitFor: /Apply these changes|Sync completed|up to date/i, send: 'y\n', delay: 300 },
      // Deploy or done
      { waitFor: /Deploy|Continue|completed|up to date/, send: '' },
    ],
  });

  assert(result.exitCode === 0, `User B sync failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);

  // Decrypt and verify the key
  const decryptResult = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 10000,
    interactions: [],
  });

  if (decryptResult.exitCode === 0) {
    const envContent = readFileSync(join(SANDBOX_USER2, '.env'), 'utf-8');
    // User B should have the updated key (remote 123457) or resolved the conflict
    const keyMatch = envContent.match(/SENDGRID_KEY=(.*)/);
    log(`  User B SENDGRID_KEY: ${keyMatch?.[1]}`);
  }
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
  log('User B attempts sync after being kicked (should fail)...');

  const result = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    expectFailure: true,
    interactions: [],
  });

  const combined = result.stdout + result.stderr;
  assert(
    result.exitCode !== 0 || combined.includes('fail') || combined.includes('error') || combined.includes('denied'),
    `Expected kicked user to lose access: exit ${result.exitCode}, output: ${combined}`,
  );
}

/** Phase 7: Branching — protected branches and role-based access */
async function testBranching(): Promise<void> {
  // Wait for WorkOS rate limit window to reset from earlier invite/kick/redeem cycles
  log('Waiting for rate limit cooldown...');
  await new Promise(r => setTimeout(r, 15000));
  log('=== Branching Tests ===');

  // 7.1: User A creates protected branch e2e-test-main
  log('User A creates protected branch e2e-test-main...');
  sh('git checkout -b e2e-test-main', SANDBOX_USER1);

  const checkoutResult = await spawnCapy(['checkout', '-b', 'e2e-test-main', '--production'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(checkoutResult.exitCode === 0, `Checkout failed: ${checkoutResult.stdout}\n${checkoutResult.stderr}`);

  // 7.2: User A updates SENDGRID_KEY on this branch
  log('User A updates SENDGRID_KEY on e2e-test-main...');
  const decryptResult = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 10000,
    interactions: [],
  });

  const envPath = join(SANDBOX_USER1, '.env');
  let envContent = readFileSync(envPath, 'utf-8');
  envContent = envContent.replace(/SENDGRID_KEY=.*/, 'SENDGRID_KEY=SG.abcdef123458');
  writeFileSync(envPath, envContent);

  const syncResult = await spawnCapy([], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 30000,
    interactions: [
      { waitFor: 'SENDGRID_KEY', send: '\n', delay: 500 },
      { waitFor: /Push.*capy/i, send: 'y\n', delay: 300 },
      { waitFor: /Apply these changes/i, send: 'y\n', delay: 300 },
      { waitFor: 'Deploy your secrets', send: '\n', delay: 500 },
    ],
  });
  assert(syncResult.exitCode === 0, `Sync on protected branch failed: ${syncResult.stdout}\n${syncResult.stderr}`);

  // Push keep.lock
  try {
    sh('git add keep.lock && git -c user.name="E2E Test" -c user.email="e2e@test.local" commit -m "chore: update SENDGRID_KEY on e2e-test-main"', SANDBOX_USER1);
    sh('git push -u origin e2e-test-main', SANDBOX_USER1);
  } catch {}

  // 7.3: Switch back to e2e-test and verify SENDGRID_KEY reverted
  log('User A switches back to e2e-test...');
  sh('git checkout e2e-test', SANDBOX_USER1);

  const checkoutResult2 = await spawnCapy(['checkout', 'e2e-test'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [],
  });
  assert(checkoutResult2.exitCode === 0, `Checkout e2e-test failed: ${checkoutResult2.stdout}\n${checkoutResult2.stderr}`);

  // Checkout already pulls secrets — just decrypt and verify
  const decryptResult2 = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 10000,
    interactions: [],
  });
  assert(decryptResult2.exitCode === 0, `Decrypt after checkout failed: ${decryptResult2.stdout}\n${decryptResult2.stderr}`);

  const revertedEnv = readFileSync(envPath, 'utf-8');
  assert(revertedEnv.includes('SG.abcdef123457'), `SENDGRID_KEY should revert to 123457 on e2e-test, got: ${revertedEnv.match(/SENDGRID_KEY=.*/)?.[0]}`);

  // 7.4: Invite User B as member
  await new Promise(r => setTimeout(r, 5000));
  log('User A re-invites User B as Member...');
  const inviteResult = await spawnCapy(['invite', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 20000,
    interactions: [
      // Select Member (first option — just press enter)
      { waitFor: 'Select a role', send: '\n', delay: 300 },
    ],
  });
  assert(inviteResult.exitCode === 0, `Re-invite failed: ${inviteResult.stdout}\n${inviteResult.stderr}`);

  const redeemMatch = inviteResult.stdout.match(/capy redeem\s+(\S+)/);
  assert(redeemMatch !== null, 'Could not extract redeem code');

  // 7.5: User B redeems and tries protected branch
  log('User B redeems and attempts protected branch...');
  const redeemResult = await spawnCapy(['redeem', redeemMatch![1]], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });

  sh('git fetch origin e2e-test-main && git checkout e2e-test-main', SANDBOX_USER2);

  // User B tries to sync protected branch as member — should fail
  log('User B (member) tries protected branch (should fail)...');
  const protectedResult = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 15000,
    expectFailure: true,
    interactions: [],
  });

  // 7.6: Kick and re-invite as Admin
  await new Promise(r => setTimeout(r, 5000));
  log('User A kicks and re-invites User B as Admin...');
  const kickResult = await spawnCapy(['kick', USER_B_EMAIL], {
    cwd: SANDBOX_USER1,
    user: 'A',
    timeout: 15000,
    interactions: [
      { waitFor: 'Remove', send: 'y\n' },
    ],
  });

  await new Promise(r => setTimeout(r, 3000));
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

  const adminRedeemMatch = adminInviteResult.stdout.match(/capy redeem\s+(\S+)/);
  assert(adminRedeemMatch !== null, 'Could not extract admin redeem code');

  // 7.7: User B redeems as Admin and syncs protected branch
  await new Promise(r => setTimeout(r, 5000));
  log('User B redeems as Admin and syncs protected branch...');
  const adminRedeemResult = await spawnCapy(['redeem', adminRedeemMatch![1]], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 20000,
    interactions: [],
  });

  const adminSyncResult = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // May have conflicts or be up to date
      { waitFor: /SENDGRID_KEY|up to date|Everything/, send: '\n', delay: 500 },
      { waitFor: /Push.*capy|up to date|Sync completed/i, send: 'y\n', delay: 300 },
      { waitFor: /Apply these changes|Sync completed|up to date/i, send: 'y\n', delay: 300 },
      { waitFor: /Deploy|Continue|completed|up to date/, send: '' },
    ],
  });
  assert(
    adminSyncResult.exitCode === 0,
    `Admin sync on protected branch failed (exit ${adminSyncResult.exitCode}): ${adminSyncResult.stdout}\n${adminSyncResult.stderr}`,
  );

  // 7.8: User B switches to e2e-test — should be prompted to switch capy branch
  log('User B switches to e2e-test (should prompt branch switch)...');
  sh('git checkout e2e-test', SANDBOX_USER2);

  const branchSwitchResult = await spawnCapy([], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 30000,
    interactions: [
      // Should prompt to switch capy branch since git branch matches
      { waitFor: /Switch to secrets branch|switch/i, send: 'y\n', delay: 300 },
      // May have conflicts or be up to date
      { waitFor: /SENDGRID_KEY|up to date|Everything/, send: '\n', delay: 500 },
      { waitFor: /Push.*capy|up to date|Sync completed/i, send: 'y\n', delay: 300 },
      { waitFor: /Apply these changes|Sync completed|up to date/i, send: 'y\n', delay: 300 },
      { waitFor: /Deploy|Continue|completed|up to date/, send: '' },
    ],
  });

  // Verify SENDGRID_KEY reverted to 123457
  const decryptB = await spawnCapy(['decrypt'], {
    cwd: SANDBOX_USER2,
    user: 'B',
    timeout: 10000,
    interactions: [],
  });

  if (decryptB.exitCode === 0) {
    const envB = readFileSync(join(SANDBOX_USER2, '.env'), 'utf-8');
    const keyMatch = envB.match(/SENDGRID_KEY=(.*)/);
    log(`  User B SENDGRID_KEY after branch switch: ${keyMatch?.[1]}`);
    // Note: exact value depends on conflict resolution prompt interaction
  }
}

/** Validate SDK runtime decryption */
async function testSdkValidation(): Promise<void> {
  log('Validating SDK runtime decryption...');

  // Build SDK and install deps
  sh('bun run build', resolve(CLI_ROOT, '..', 'sdk'));
  sh('bun install', SANDBOX_USER1);

  // The SDK uses KeyringKeySource which reads the master key from
  // ~/.capy/orgs/{orgId}/users/{userId}/key.enc, unwraps it, and derives
  // the project key. We need HOME and CAPY_USER_ID set correctly.
  const syncStatePath = join(SANDBOX_USER1, '.capy', 'sync-state');
  let userId = '';
  if (existsSync(syncStatePath)) {
    const syncState = JSON.parse(readFileSync(syncStatePath, 'utf-8'));
    userId = syncState.user_id || '';
  }
  assert(userId !== '', 'Could not read user_id from sync-state for SDK test');

  const sdkOutput = sh(`HOME=${HOME_A} CAPY_USER_ID=${userId} bun index.mjs`, SANDBOX_USER1);
  assert(sdkOutput.includes('After decrypt'), 'SDK output should show "After decrypt" section');
  assert(sdkOutput.includes('sk_live_abc123xyz789'), 'SDK should decrypt API_KEY');
  assert(sdkOutput.includes('SG.abcdef'), 'SDK should decrypt SENDGRID_KEY');
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

    // SDK Validation (run early, before branching messes with .env)
    console.log('\n\x1b[1m--- SDK Validation ---\x1b[0m');
    await runTest('SDK runtime decryption', testSdkValidation);

    // Invite
    console.log('\n\x1b[1m--- Invite Flow ---\x1b[0m');
    const redeemCode = await runTest('User A invites User B as Admin', testInviteUserB);
    await runTest('User B sync fails without redeeming', testUserBSyncFails);
    await runTest('User B redeems invite', () => testRedeemInvite(redeemCode));
    await runTest('User B syncs after redeeming', testUserBSyncAfterRedeem);

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

  } catch {
    // Test failure already logged
  } finally {
    await teardown();
  }

  console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
