import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes, hkdfSync } from 'crypto';
import { createServer, Server } from 'http';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../../src/crypto/deployCrypto';

// ---------------------------------------------------------------------------
// Tests for the `_SECRETS_BLOB` / `_PROJECT_KEY` runtime pair (CAP-657):
// additive alongside `SECRETS_BLOB` / `PROJECT_KEY`, with the OPPOSITE
// precedence — decrypted values win over a same-named platform env var,
// because Capy deploys are meant to be reversible (Capy doesn't delete a
// user's stale plaintext copy when it adds its two vars to a platform).
//
// Harness copied from tests/commands/runCommand.test.ts — same subprocess
// pattern against the built CLI, same fixture builder for a real
// SECRETS_BLOB, same fake decrypt service.
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `capy-run-deployed-names-test-${process.pid}`);

function capy(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(__dirname, '../../dist/index.js');
  const { spawn } = require('child_process');

  // Prod entrypoint pins itself to api.capy.sc and ignores an ambient
  // CAPY_API_URL (src/config/prodPins.ts); retarget it the way a BYOC
  // operator does — a profile on disk, under a throwaway HOME.
  const { CAPY_API_URL: fakeServiceUrl, ...restEnv } = opts.env ?? {};
  const fakeHome = mkdtempSync(join(tmpdir(), 'capy-run-deployed-names-home-'));
  if (fakeServiceUrl) {
    mkdirSync(join(fakeHome, '.capy'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.capy', 'config.json'),
      JSON.stringify({ default: 'test', profiles: { test: { url: fakeServiceUrl } } }),
    );
  }

  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, 'run', ...args], {
      cwd: opts.cwd ?? TEST_DIR,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...restEnv },
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

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function buildDeployedFixture(envVars: Record<string, string>) {
  const projectId = 'test-proj-' + randomBytes(4).toString('hex');
  const pk = randomBytes(32);
  const dt = generateDerivationToken();
  const deployId = generateDeployId();

  const innerBlob = deployInnerWrap(pk, dt, projectId);
  const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);
  // Simulate KMS outer wrap as a passthrough (local dev KMS fallback path).
  const outerBlob = innerBlob;
  const secretsBlob = buildSecretsBlob(deployId, outerBlob, encryptedVars);

  const salt = projectId + deployId.toString('hex');
  const serviceKeyHex = Buffer.from(
    hkdfSync('sha256', Buffer.from(innerBlob, 'base64'), salt, 'capy:deploy:service-key', 32),
  ).toString('hex');

  return { projectId, pk, deployId, innerBlob, secretsBlob, serviceKeyHex };
}

async function startFakeService(serviceKeyHex: string): Promise<{ url: string; close: () => void; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && /^\/deploy\/[0-9a-f]+\/decrypt$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service_key: serviceKeyHex }));
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

describe('capy run (deployed mode: _SECRETS_BLOB/_PROJECT_KEY vs SECRETS_BLOB/PROJECT_KEY)', () => {
  let fake: { url: string; close: () => void } | null = null;

  afterEach(() => {
    if (fake) {
      fake.close();
      fake = null;
    }
  });

  test('new pair: decrypted value wins over a same-name platform env var', async () => {
    const envVars = { OVERRIDDEN: 'from-secrets-blob' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService(serviceKeyHex);

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.OVERRIDDEN)'], {
      env: {
        _SECRETS_BLOB: secretsBlob,
        _PROJECT_KEY: pk.toString('hex'),
        CAPY_API_URL: fake.url,
        OVERRIDDEN: 'from-shell',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('from-secrets-blob');
  });

  test('old pair: same-name env var still wins (unchanged precedence)', async () => {
    const envVars = { OVERRIDDEN: 'from-secrets-blob' };
    const { pk, secretsBlob, serviceKeyHex } = buildDeployedFixture(envVars);
    fake = await startFakeService(serviceKeyHex);

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

  test('both full pairs set: new pair is used', async () => {
    const newVars = { WHICH: 'new-pair' };
    const oldVars = { WHICH: 'old-pair' };
    const newFixture = buildDeployedFixture(newVars);
    const oldFixture = buildDeployedFixture(oldVars);

    // Both blobs decrypt via the same fake service regardless of deployId,
    // since the fake just echoes back whichever service_key it was built
    // with per-fixture. Run two separate fake services isn't necessary here
    // because the CLI only ever calls fetchServiceKey once, for whichever
    // pair wins — so point CAPY_API_URL at a service that can answer both.
    const server = createServer((req, res) => {
      const match = /^\/deploy\/([0-9a-f]+)\/decrypt$/.exec(req.url ?? '');
      if (req.method === 'POST' && match) {
        const deployIdHex = match[1];
        const serviceKeyHex =
          deployIdHex === newFixture.deployId.toString('hex')
            ? newFixture.serviceKeyHex
            : oldFixture.serviceKeyHex;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service_key: serviceKeyHex }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
    fake = { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };

    const result = await capy(['--', 'node', '-e', 'console.log(process.env.WHICH)'], {
      env: {
        _SECRETS_BLOB: newFixture.secretsBlob,
        _PROJECT_KEY: newFixture.pk.toString('hex'),
        SECRETS_BLOB: oldFixture.secretsBlob,
        PROJECT_KEY: oldFixture.pk.toString('hex'),
        CAPY_API_URL: fake.url,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('new-pair');
  });

  test('exits 1 if _SECRETS_BLOB set but _PROJECT_KEY missing, naming the new pair', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { _SECRETS_BLOB: 'anything', _PROJECT_KEY: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/must both be set/);
    expect(result.stderr).toContain('_SECRETS_BLOB');
    expect(result.stderr).toContain('_PROJECT_KEY');
  });

  test('exits 1 if _PROJECT_KEY set but _SECRETS_BLOB missing, naming the new pair', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { _PROJECT_KEY: 'a'.repeat(64), _SECRETS_BLOB: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/must both be set/);
    expect(result.stderr).toContain('_SECRETS_BLOB');
    expect(result.stderr).toContain('_PROJECT_KEY');
  });

  test('exits 1 if only half the old pair is set, even with the new pair absent (regression guard)', async () => {
    const result = await capy(['--', 'echo', 'unreached'], {
      env: { SECRETS_BLOB: 'anything', PROJECT_KEY: undefined as any },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/must both be set/);
    expect(result.stderr).toContain('SECRETS_BLOB');
    expect(result.stderr).toContain('PROJECT_KEY');
  });

  test('half the new pair refuses even when the old pair is fully (validly) set', async () => {
    const envVars = { X: 'y' };
    const { pk, secretsBlob } = buildDeployedFixture(envVars);

    const result = await capy(['--', 'echo', 'unreached'], {
      env: {
        SECRETS_BLOB: secretsBlob,
        PROJECT_KEY: pk.toString('hex'),
        _SECRETS_BLOB: 'half-set',
        _PROJECT_KEY: undefined as any,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('_SECRETS_BLOB');
    expect(result.stderr).toContain('_PROJECT_KEY');
  });
});
