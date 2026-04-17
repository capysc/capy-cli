import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCipheriv, createHash, randomBytes } from 'crypto';

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

/** Run `capy run` via the built CLI entry point in a subprocess */
function capy(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const cliPath = join(__dirname, '../../dist/index.js');
  // Use spawnSync to avoid shell interpretation of parentheses etc.
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [cliPath, 'run', ...args], {
    cwd: opts.cwd ?? TEST_DIR,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    exitCode: result.status ?? 1,
  };
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
  test('decrypts capy: values and passes them to subprocess', () => {
    // CAPY_KEY must be a valid 64-char hex string (32 bytes).
    // The encrypt helper derives the AES key via SHA256(key), so we need to
    // use the same hex string as both the CAPY_KEY env var and the encrypt key.
    const hexKey = 'a'.repeat(64);
    const encValue = encrypt('my-secret-value', hexKey, 'SECRET');
    writeFileSync(join(TEST_DIR, '.env'), `SECRET=${encValue}\nPLAIN=hello\n`);

    const result = capy(['--', 'node', '-e', 'console.log(process.env.SECRET)'], {
      env: { CAPY_KEY: hexKey },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('my-secret-value');
  });

  test('passes plaintext env vars through unchanged', () => {
    writeFileSync(join(TEST_DIR, '.env'), 'PLAIN_VAR=hello-world\n');

    const result = capy(['--', 'node', '-e', 'console.log(process.env.PLAIN_VAR)']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-world');
  });

  test('forwards subprocess exit code', () => {
    const result = capy(['--', 'node', '-e', 'process.exit(42)']);
    expect(result.exitCode).toBe(42);
  });

  test('exits 1 with usage message when no args given', () => {
    const result = capy([]);
    expect(result.exitCode).not.toBe(0);
  });

  test('exits 1 with clean error for nonexistent command', () => {
    const result = capy(['--', 'nonexistent-command-xyz']);
    expect(result.exitCode).toBe(1);
  });

  test('works with no .env file (passes process.env through)', () => {
    // No .env written to TEST_DIR
    const result = capy(['--', 'node', '-e', 'console.log("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('exits 1 with clean error when key is missing for encrypted values', () => {
    const encValue = encrypt('secret', 'some-key', 'SECRET');
    writeFileSync(join(TEST_DIR, '.env'), `SECRET=${encValue}\n`);

    // No CAPY_KEY, no keyring, no .capy/decrypt — key resolution should fail
    const result = capy(['--', 'echo', 'should-not-reach'], {
      env: { CAPY_KEY: undefined as any },
    });

    expect(result.exitCode).toBe(1);
  });

  test('.env with zero encrypted values needs no key', () => {
    writeFileSync(join(TEST_DIR, '.env'), 'DB_HOST=localhost\nDB_PORT=5432\n');

    const result = capy([
      '--', 'node', '-e',
      'console.log(process.env.DB_HOST + ":" + process.env.DB_PORT)',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('localhost:5432');
  });
});
