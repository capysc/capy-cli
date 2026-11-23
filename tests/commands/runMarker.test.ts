import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes, hkdfSync } from 'crypto';
import { createServer } from 'http';
import { spawn } from 'child_process';
import {
  generateDeployId,
  generateInnerSecret,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../../src/crypto/deployCrypto';
import { runChildThenSettle, withRunMarker } from '../../src/commands/runCommand';

// `capy run` tells the command it starts that it runs under `capy run`:
// CAPY_RUN=1 in the child's environment, on every path that starts it, and
// never in capy's own process.env.

const NODE = process.execPath;
const PRINT_MARKER = 'process.stdout.write(String(process.env.CAPY_RUN))';

type RunResult = { readonly stdout: string; readonly exitCode: number };

/** Runs the built CLI (`dist/index.js run -- …`) under a throwaway HOME, like the other run tests. */
function capyRun(args: readonly string[], opts: { readonly cwd: string; readonly env?: Record<string, string> }): Promise<RunResult> {
  const cliPath = join(__dirname, '../../dist/index.js');
  const { CAPY_API_URL: serviceUrl, ...restEnv } = opts.env ?? {};
  const fakeHome = mkdtempSync(join(tmpdir(), 'capy-run-marker-home-'));
  if (serviceUrl) {
    mkdirSync(join(fakeHome, '.capy'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.capy', 'config.json'),
      JSON.stringify({ default: 'test', profiles: { test: { url: serviceUrl } } }),
    );
  }
  const child = spawn('node', [cliPath, 'run', ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...restEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const stdout = Array.fromAsync(child.stdout as AsyncIterable<Buffer>).then((parts) => Buffer.concat(parts).toString());
  const exitCode = new Promise<number>((resolve) => {
    child.on('close', (code: number | null) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
  return Promise.all([stdout, exitCode]).then(([out, code]) => {
    clearTimeout(killer);
    rmSync(fakeHome, { recursive: true, force: true });
    return { stdout: out, exitCode: code };
  });
}

function deployedFixture(envVars: Record<string, string>) {
  const projectId = 'test-proj-' + randomBytes(4).toString('hex');
  const pk = randomBytes(32);
  const deployId = generateDeployId();
  const innerBlob = generateInnerSecret();
  const secretsBlob = buildSecretsBlob(deployId, innerBlob, encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId));
  const salt = projectId + deployId.toString('hex');
  const serviceKeyHex = Buffer.from(
    hkdfSync('sha256', Buffer.from(innerBlob, 'base64'), salt, 'capy:deploy:service-key', 32),
  ).toString('hex');
  return { pk, secretsBlob, serviceKeyHex };
}

/** Runs `fn` with a fresh temp directory, removed afterwards. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-run-marker-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `fn` against a fake decrypt service, closed afterwards. */
async function withFakeService<T>(serviceKeyHex: string, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    const ok = req.method === 'POST' && /^\/deploy\/[0-9a-f]+\/decrypt$/.test(req.url ?? '');
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(ok ? JSON.stringify({ service_key: serviceKeyHex }) : '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

describe('withRunMarker', () => {
  test('returns a new map with CAPY_RUN=1 and leaves the input and process.env alone', () => {
    const input = { A: '1' };
    const before = process.env.CAPY_RUN;
    const out = withRunMarker(input);
    expect(out).toEqual({ A: '1', CAPY_RUN: '1' });
    expect(input).toEqual({ A: '1' });
    expect(process.env.CAPY_RUN).toBe(before);
  });

  test('capy wins over a CAPY_RUN the environment already carries', () => {
    expect(withRunMarker({ CAPY_RUN: '0' }).CAPY_RUN).toBe('1');
  });
});

describe('runChildThenSettle (the spawn behind local-encrypted and compose-forwarding runs)', () => {
  const writesMarkerTo = (file: string): string[] => [
    NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.env.CAPY_RUN))`,
  ];

  test('the child has CAPY_RUN=1 even when the given env lacks it or sets another value; process.env is unchanged', () =>
    withTempDir(async (dir) => {
      const before = process.env.CAPY_RUN;
      const absent = join(dir, 'absent');
      const overridden = join(dir, 'overridden');
      await runChildThenSettle(writesMarkerTo(absent), { PATH: process.env.PATH }, undefined);
      await runChildThenSettle(writesMarkerTo(overridden), { PATH: process.env.PATH, CAPY_RUN: '0' }, undefined);
      expect(readFileSync(absent, 'utf-8')).toBe('1');
      expect(readFileSync(overridden, 'utf-8')).toBe('1');
      expect(process.env.CAPY_RUN).toBe(before);
    }));

  test('compose path (child started with the override pipe) also has CAPY_RUN=1', () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'piped');
      const code = await runChildThenSettle(writesMarkerTo(file), { PATH: process.env.PATH }, undefined, '{"services":{}}');
      expect(code).toBe(0);
      expect(readFileSync(file, 'utf-8')).toBe('1');
    }));
});

describe('capy run, built CLI', () => {
  test('local mode, plaintext .env: CAPY_RUN=1, a CAPY_RUN in .env loses, and nothing is written', () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, '.env'), 'PLAIN=value\nCAPY_RUN=0\n');
      const result = await capyRun(['--', NODE, '-e', PRINT_MARKER], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1');
      expect(existsSync(join(dir, '.capy'))).toBe(false);
      expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('PLAIN=value\nCAPY_RUN=0\n');
    }));

  test('deployed mode, new pair (_SECRETS_BLOB/_PROJECT_KEY): CAPY_RUN=1', () => {
    const { pk, secretsBlob, serviceKeyHex } = deployedFixture({ SOME: 'v' });
    return withTempDir((dir) =>
      withFakeService(serviceKeyHex, async (url) => {
        const result = await capyRun(['--', NODE, '-e', PRINT_MARKER], {
          cwd: dir,
          env: { _SECRETS_BLOB: secretsBlob, _PROJECT_KEY: pk.toString('hex'), CAPY_API_URL: url, CAPY_RUN: '0' },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('1');
      }),
    );
  });

  test('deployed mode, old pair (SECRETS_BLOB/PROJECT_KEY): CAPY_RUN=1', () => {
    const { pk, secretsBlob, serviceKeyHex } = deployedFixture({ SOME: 'v' });
    return withTempDir((dir) =>
      withFakeService(serviceKeyHex, async (url) => {
        const result = await capyRun(['--', NODE, '-e', PRINT_MARKER], {
          cwd: dir,
          env: { SECRETS_BLOB: secretsBlob, PROJECT_KEY: pk.toString('hex'), CAPY_API_URL: url, CAPY_RUN: '0' },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('1');
      }),
    );
  });
});
