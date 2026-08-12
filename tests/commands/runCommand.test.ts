import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCipheriv, createHash, randomBytes, hkdfSync } from 'crypto';
import { createServer, Server } from 'http';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../../src/crypto/deployCrypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `capy-run-test-${process.pid}`);
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function deriveResourceId(key: string, varName: string): string {
  const hash = createHash('sha256').update(`${key}:${varName}`).digest();
  let id = '';
  for (let i = 0; i < 5; i++) id += ALPHABET[hash[i] % ALPHABET.length];
  return id;
}

function encrypt(value: string, key: string, varName: string = 'SECRET'): string {
  const derivedKey = createHash('sha256').update(key).digest().subarray(0, KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  const resourceId = deriveResourceId(key, varName);
  return `capy:${resourceId}:${combined.toString('base64')}`;
}

/**
 * Run `capy run` via the built CLI entry point in a subprocess.
 *
 * Async (Promise-based) rather than spawnSync because deployed-mode tests run
 * a fake HTTP server in the test's own event loop — spawnSync would block
 * that loop and the server could never answer the subprocess's fetch.
 */
function capy(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(__dirname, '../../dist/index.js');
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, 'run', ...args], {
      cwd: opts.cwd ?? TEST_DIR,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code: number | null) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('capy run', () => {
  test('passes plaintext env vars through unchanged', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'PLAIN_VAR=hello-world\n');

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.PLAIN_VAR)']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-world');
  });

  test('forwards subprocess exit code', async () => {
    const result = await capy(['--', 'node', '-e', 'process.exit(42)']);
    expect(result.exitCode).toBe(42);
  });

  test('exits 1 with usage message when no args given', async () => {
    const result = await capy([]);
    expect(result.exitCode).not.toBe(0);
  });

  test('exits 1 with clean error for nonexistent command', async () => {
    const result = await capy(['--', 'nonexistent-command-xyz']);
    expect(result.exitCode).toBe(1);
  });

  test('works with no .env file (passes process.env through)', async () => {
    // No .env written to TEST_DIR
    const result = await capy(['--', 'node', '-e', 'console.log("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('exits 1 with clean error when keep.lock is missing for encrypted values', async () => {
    const encValue = encrypt('secret', 'some-key', 'SECRET');
    writeFileSync(join(TEST_DIR, '.env'), `SECRET=${encValue}\n`);

    // No keep.lock → can't resolve project key via server.
    const result = await capy(['--', 'echo', 'should-not-reach']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/keep\.lock/);
  });

  test('.env with zero encrypted values needs no key', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'DB_HOST=localhost\nDB_PORT=5432\n');

    const result = await capy([
      '--', 'node', '-e',
      'console.log(process.env.DB_HOST + ":" + process.env.DB_PORT)',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('localhost:5432');
  });
});

// ---------------------------------------------------------------------------
// Deployed-mode tests
//
// The variable NAME selects the path (CAP-411/CAP-424), never the value:
//   _CAPY_SECRETS_BLOB + _CAPY_DEPLOY_KEY  → DT path (current generation)
//   SECRETS_BLOB + PROJECT_KEY             → legacy PK path
//   neither pair                           → local mode
//   anything else                          → hard error
//
// Both deployed paths: parse the blob, POST to /deploy/:id/decrypt (the real
// service always returns service_key + inner_blob + project_id, regardless of
// generation — see deployRuntime.fetchDeployDecryptMaterial). Legacy mode
// already holds PK and uses only service_key. DT mode recovers PK in memory
// via deployInnerUnwrap(inner_blob, dt, project_id) first. Both then derive
// DECRYPT_KEY = HKDF(pk || service_key, deployId, "capy:deploy:decrypt") and
// AES-256-GCM decrypt the env vars before spawning the child.
// ---------------------------------------------------------------------------

function buildDeployedFixture(envVars: Record<string, string>) {
  const projectId = 'test-proj-' + randomBytes(4).toString('hex');
  const pk = randomBytes(32);
  const dt = generateDerivationToken();
  const deployId = generateDeployId();

  const innerBlob = deployInnerWrap(pk, dt, projectId);
  const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);
  // Simulate KMS outer wrap as a passthrough (local dev KMS fallback path).
  // The fake server uses the same innerBlob bytes to derive service_key so
  // consumer-side derivation matches.
  const outerBlob = innerBlob;
  const secretsBlob = buildSecretsBlob(deployId, outerBlob, encryptedVars);

  const salt = projectId + deployId.toString('hex');
  const serviceKeyHex = Buffer.from(
    hkdfSync('sha256', Buffer.from(innerBlob, 'base64'), salt, 'capy:deploy:service-key', 32),
  ).toString('hex');

  return { projectId, pk, dt, deployId, innerBlob, secretsBlob, serviceKeyHex };
}

/**
 * Starts a minimal HTTP server that answers POST /deploy/:id/decrypt the way
 * the real service does: service_key + inner_blob + project_id together,
 * regardless of which credential generation the caller holds (the real route
 * computes all three unconditionally — see service/src/routes/deploy.ts).
 * Legacy-mode tests only read `.service_key` off the response; DT-mode tests
 * need all three. Returns { url, close }.
 */
async function startFakeService(
  material: { serviceKeyHex: string; innerBlob?: string; projectId?: string },
): Promise<{ url: string; close: () => void; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && /^\/deploy\/[0-9a-f]+\/decrypt$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service_key: material.serviceKeyHex,
        inner_blob: material.innerBlob ?? '',
        project_id: material.projectId ?? '',
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  const url = `http://127.0.0.1:${addr.port}`;
  return { url, close: () => server.close(), server };
}

describe('capy run (deployed mode)', () => {
  let fake: { url: string; close: () => void } | null = null;

  afterEach(() => {
    if (fake) {
      fake.close();
      fake = null;
    }
  });

  test('legacy path: decrypts SECRETS_BLOB via fetched service_key using PROJECT_KEY directly', async () => {
    const envVars = { API_KEY: 'sk-test-xyz', DATABASE_URL: 'postgres://h/d' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex });

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.API_KEY, "|", process.env.DATABASE_URL)'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('sk-test-xyz | postgres://h/d');
  });

  test('legacy path: writes .capy/next-env.js with decrypted keys', async () => {
    const envVars = { VERCEL_SECRET: 'v1', STRIPE: 'sk_1' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex });

    const result = await capy(['--', 'node', '-e', 'console.log("ok")'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });
    expect(result.exitCode).toBe(0);

    const nextEnvPath = join(TEST_DIR, '.capy', 'next-env.js');
    expect(existsSync(nextEnvPath)).toBe(true);
    const content = readFileSync(nextEnvPath, 'utf-8');
    expect(content).toContain('"VERCEL_SECRET"');
    expect(content).toContain('"STRIPE"');
    expect(content).toContain('process.env["VERCEL_SECRET"]');
  });

  test('exits 1 if SECRETS_BLOB set but PROJECT_KEY missing (legacy half-set)', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { SECRETS_BLOB: 'anything', PROJECT_KEY: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('exits 1 if PROJECT_KEY set but SECRETS_BLOB missing (legacy half-set)', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { PROJECT_KEY: 'a'.repeat(64), SECRETS_BLOB: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('exits 1 with clean error when service is unreachable', async () => {
    const envVars = { X: 'y' };
    const { pk, secretsBlob } = buildDeployedFixture(envVars);
    // Point at a port nothing is listening on
    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: 'http://127.0.0.1:1',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Cannot reach|Deploy decrypt failed/);
  });

  test('exits 1 with mismatch hint when deploy token is unknown (404)', async () => {
    const envVars = { X: 'y' };
    const { pk, secretsBlob } = buildDeployedFixture(envVars);
    // Service that 404s the decrypt route — simulates a token minted against
    // a different Capy service than the one the build is pointed at.
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
    fake = { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };

    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found on .* different Capy service/);
  });

  test('shell-set env overrides decrypted value (dotenv precedence)', async () => {
    const envVars = { OVERRIDDEN: 'from-secrets-blob' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex });

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.OVERRIDDEN)'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
        OVERRIDDEN: 'from-shell',
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('from-shell');
  });
});

// ---------------------------------------------------------------------------
// CAP-411 — DT path (current generation): _CAPY_SECRETS_BLOB + _CAPY_DEPLOY_KEY.
//
// The artifact holds DT, never the project key. `capy run` recovers PK in
// memory via deployInnerUnwrap(inner_blob, dt, project_id) — inner_blob and
// project_id both come back from the service's /decrypt response, which is
// revocation-gated exactly like the legacy path's service_key.
// ---------------------------------------------------------------------------

describe('capy run (deployed mode, DT path)', () => {
  let fake: { url: string; close: () => void } | null = null;

  afterEach(() => {
    if (fake) {
      fake.close();
      fake = null;
    }
  });

  test('decrypts _CAPY_SECRETS_BLOB via recovered PK (dt never appears in the child env)', async () => {
    const envVars = { API_KEY: 'sk-test-xyz', DATABASE_URL: 'postgres://h/d' };
    const { dt, secretsBlob, serviceKeyHex, innerBlob, projectId } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex, innerBlob, projectId });

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.API_KEY, "|", process.env.DATABASE_URL)'], {
      env: {
        _CAPY_SECRETS_BLOB: secretsBlob,
        _CAPY_DEPLOY_KEY: dt.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('sk-test-xyz | postgres://h/d');
  });

  test('writes .capy/next-env.js with decrypted keys', async () => {
    const envVars = { VERCEL_SECRET: 'v1', STRIPE: 'sk_1' };
    const { dt, secretsBlob, serviceKeyHex, innerBlob, projectId } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex, innerBlob, projectId });

    const result = await capy(['--', 'node', '-e', 'console.log("ok")'], {
      env: {
        _CAPY_SECRETS_BLOB: secretsBlob,
        _CAPY_DEPLOY_KEY: dt.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });
    expect(result.exitCode).toBe(0);

    const nextEnvPath = join(TEST_DIR, '.capy', 'next-env.js');
    expect(existsSync(nextEnvPath)).toBe(true);
    const content = readFileSync(nextEnvPath, 'utf-8');
    expect(content).toContain('"VERCEL_SECRET"');
    expect(content).toContain('"STRIPE"');
  });

  test('wrong DT (right blob, wrong key) fails loudly rather than decrypting garbage', async () => {
    const envVars = { X: 'y' };
    const { secretsBlob, serviceKeyHex, innerBlob, projectId } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex, innerBlob, projectId });

    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        _CAPY_SECRETS_BLOB: secretsBlob,
        _CAPY_DEPLOY_KEY: generateDerivationToken().toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });
    expect(result.exitCode).toBe(1);
  });

  test('exits 1 if _CAPY_SECRETS_BLOB set but _CAPY_DEPLOY_KEY missing (current-gen half-set)', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { _CAPY_SECRETS_BLOB: 'anything', _CAPY_DEPLOY_KEY: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('exits 1 if _CAPY_DEPLOY_KEY set but _CAPY_SECRETS_BLOB missing (current-gen half-set)', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { _CAPY_DEPLOY_KEY: 'a'.repeat(64), _CAPY_SECRETS_BLOB: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });
});

// ---------------------------------------------------------------------------
// CAP-411/CAP-424 — the selection table's cross-generation cells.
//
// Both generations set at once, or a name from each, must hard-error rather
// than guess. Never resolved by inspecting the VALUES (DT and PK are both
// 64-char hex, structurally indistinguishable) — only by which NAMES are
// present, so these fixtures use garbage values on purpose: if the guard ever
// regressed into trial decryption, garbage would surface as a decrypt error
// instead of this loud, pre-network refusal.
// ---------------------------------------------------------------------------

describe('capy run (deploy credential selection: both generations / cross-generation)', () => {
  test('both generations fully set at once → hard error, no guessing', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        _CAPY_SECRETS_BLOB: 'x',
        _CAPY_DEPLOY_KEY: 'y',
        SECRETS_BLOB: 'a',
        PROJECT_KEY: 'b',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('cross-generation mix (_CAPY_SECRETS_BLOB + legacy PROJECT_KEY) → hard error', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        _CAPY_SECRETS_BLOB: 'x',
        PROJECT_KEY: 'b',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('cross-generation mix (legacy SECRETS_BLOB + _CAPY_DEPLOY_KEY) → hard error', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        SECRETS_BLOB: 'a',
        _CAPY_DEPLOY_KEY: 'y',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ambiguous deploy credentials/);
  });

  test('neither pair present → local mode, not an error', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'PLAIN_VAR=hello\n');
    const result = await capy(['--', 'node', '-e', 'console.log(process.env.PLAIN_VAR)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// CAP-423 — reserved runtime variables must not reach the child process.
//
// `capy run` has already consumed the deploy credentials by the time it
// spawns; the child is the process whose environment leaks (framework debug
// pages, phpinfo(), error-tracker SDKs that capture env by default,
// /proc/<pid>/environ, crash dumps), and every grandchild inherits it.
// ---------------------------------------------------------------------------

describe('capy run (reserved runtime variables)', () => {
  let fake: { url: string; close: () => void } | null = null;

  afterEach(() => {
    if (fake) {
      fake.close();
      fake = null;
    }
  });

  // Dumps the names the child can actually see, one per line, so an assertion
  // failure names the offender instead of just failing a boolean.
  const DUMP = 'console.log(Object.keys(process.env).join("\\n"))';

  test('deployed mode: child sees neither SECRETS_BLOB nor PROJECT_KEY', async () => {
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture({ API_KEY: 'sk-test-xyz' });
    fake = await startFakeService({ serviceKeyHex });

    const result = await capy(['--', 'node', '-e', DUMP], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    const names = result.stdout.trim().split('\n');
    expect(names).not.toContain('SECRETS_BLOB');
    expect(names).not.toContain('PROJECT_KEY');
    // The whole point of the command still works: decrypted values arrive.
    expect(names).toContain('API_KEY');
  });

  test('deployed mode: decrypted values are unchanged by the strip', async () => {
    const envVars = { API_KEY: 'sk-test-xyz', DATABASE_URL: 'postgres://h/d' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService({ serviceKeyHex });

    const result = await capy(
      ['--', 'node', '-e', 'console.log(process.env.API_KEY, "|", process.env.DATABASE_URL)'],
      {
        env: {
          SECRETS_BLOB: secretsBlob,
          PROJECT_KEY: pk.toString('hex'),
          CAPY_API_URL: fake.url,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('sk-test-xyz | postgres://h/d');
  });

  test('grandchildren do not see them either', async () => {
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture({ API_KEY: 'sk-test-xyz' });
    fake = await startFakeService({ serviceKeyHex });

    // The app spawns a worker — the realistic shape (queue workers, cron,
    // migration scripts). Inheritance means stripping once at the child covers
    // this, but it is the case that actually bites, so pin it.
    const spawnGrandchild =
      'require("child_process").execFileSync(process.execPath,["-e",' +
      JSON.stringify(DUMP) +
      '],{stdio:"inherit"})';

    const result = await capy(['--', 'node', '-e', spawnGrandchild], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    const names = result.stdout.trim().split('\n');
    expect(names).not.toContain('SECRETS_BLOB');
    expect(names).not.toContain('PROJECT_KEY');
    expect(names).toContain('API_KEY');
  });

  test('local mode strips them too', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'PLAIN_VAR=hello\n');

    // No blob/key pair, so this is the plaintext local path — but a machine
    // that ran a deploy earlier can still have them in its shell.
    const result = await capy(['--', 'node', '-e', DUMP], {
      env: { SECRETS_BLOB: undefined as any, PROJECT_KEY: undefined as any, _CAPY_LEFTOVER: 'x' },
    });

    expect(result.exitCode).toBe(0);
    const names = result.stdout.trim().split('\n');
    expect(names).not.toContain('_CAPY_LEFTOVER');
    expect(names).toContain('PLAIN_VAR');
  });

  test('the _CAPY_ prefix reserves future runtime vars with no code change', async () => {
    // _CAPY_SECRETS_BLOB / _CAPY_DEPLOY_KEY are now the REAL current-generation
    // pair (CAP-411), so this uses a genuine working DT fixture rather than
    // garbage values — the run actually boots via the DT path — alongside a
    // hypothetical _CAPY_SOMETHING_UNINVENTED to prove the prefix rule covers
    // a variable nobody has written the reservation for yet.
    const { dt, secretsBlob, serviceKeyHex, innerBlob, projectId } = buildDeployedFixture({
      API_KEY: 'sk-test-xyz',
    });
    fake = await startFakeService({ serviceKeyHex, innerBlob, projectId });

    const result = await capy(['--', 'node', '-e', DUMP], {
      env: {
        _CAPY_SECRETS_BLOB: secretsBlob,
        _CAPY_DEPLOY_KEY: dt.toString('hex'),
        _CAPY_SOMETHING_UNINVENTED: 'z',
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    const names = result.stdout.trim().split('\n');
    expect(names.filter((n) => n.startsWith('_CAPY_'))).toEqual([]);
    expect(names).toContain('API_KEY');
  });

  test('bare DEPLOY_KEY is NOT reserved — it is a plausible application name', async () => {
    // CAP-424 resolved this deliberately: reserving a generic word steals it
    // from users, and tests/sync/spliceKeepBranch.test.ts already uses
    // DEPLOY_KEY as an ordinary variable. The real credential is
    // _CAPY_DEPLOY_KEY, which the prefix rule covers.
    writeFileSync(join(TEST_DIR, '.env'), 'DEPLOY_KEY=my-own-app-value\n');

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.DEPLOY_KEY)']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('my-own-app-value');
  });
});
