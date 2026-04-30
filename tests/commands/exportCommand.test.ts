import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import {
  dotenvEscape,
  shellEscape,
  formatExport,
} from '../../src/commands/exportCommand';

const TEST_DIR = join(tmpdir(), `capy-export-test-${process.pid}`);

function capy(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(__dirname, '../../dist/index.js');
  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, ...args], {
      cwd: opts.cwd ?? TEST_DIR,
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('dotenvEscape', () => {
  test('leaves simple identifiers unquoted', () => {
    expect(dotenvEscape('hello')).toBe('hello');
    expect(dotenvEscape('https://api.example.com:8080/path')).toBe(
      'https://api.example.com:8080/path',
    );
    expect(dotenvEscape('a-b_c.d+e/f@g,h')).toBe('a-b_c.d+e/f@g,h');
  });

  test('quotes values with spaces', () => {
    expect(dotenvEscape('hello world')).toBe('"hello world"');
  });

  test('escapes embedded quotes and backslashes', () => {
    expect(dotenvEscape('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test('escapes newlines and CRs', () => {
    expect(dotenvEscape('line1\nline2\rend')).toBe('"line1\\nline2\\rend"');
  });

  test('quotes values with shell metachars', () => {
    expect(dotenvEscape('$VAR')).toBe('"$VAR"');
    expect(dotenvEscape('a#comment')).toBe('"a#comment"');
    expect(dotenvEscape('a=b')).toBe('"a=b"');
  });
});

describe('shellEscape', () => {
  test('single-quotes simple values', () => {
    expect(shellEscape('hello')).toBe(`'hello'`);
  });

  test('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe(`'it'\\''s'`);
  });

  test('preserves shell metachars literally', () => {
    expect(shellEscape('$VAR; rm -rf /')).toBe(`'$VAR; rm -rf /'`);
  });
});

describe('formatExport', () => {
  test('dotenv format sorts keys and applies quoting', () => {
    const out = formatExport({ B: 'b', A: 'has space', C: 'c' }, 'dotenv');
    expect(out).toBe(`A="has space"\nB=b\nC=c\n`);
  });

  test('json format sorts keys and pretty-prints', () => {
    const out = formatExport({ B: 'b', A: 'a' }, 'json');
    expect(out).toBe(`{\n  "A": "a",\n  "B": "b"\n}\n`);
  });

  test('shell format emits export statements', () => {
    const out = formatExport({ FOO: 'bar', BAZ: "it's" }, 'shell');
    expect(out).toBe(`export BAZ='it'\\''s'\nexport FOO='bar'\n`);
  });

  test('empty input', () => {
    expect(formatExport({}, 'dotenv')).toBe('\n');
    expect(formatExport({}, 'json')).toBe('{}\n');
    expect(formatExport({}, 'shell')).toBe('\n');
  });
});

describe('capy export — plaintext .env (no decryption needed)', () => {
  test('default format is dotenv', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'FOO=bar\nBAZ=qux\n');
    const r = await capy(['export']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('BAZ=qux\nFOO=bar\n');
    expect(r.stderr).toBe('');
  });

  test('--format=json', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'FOO=bar\n');
    const r = await capy(['export', '--format=json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`{\n  "FOO": "bar"\n}\n`);
  });

  test('--format=shell', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'FOO=bar\n');
    const r = await capy(['export', '--format=shell']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`export FOO='bar'\n`);
  });

  test('--vars filters subset', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'A=1\nB=2\nC=3\n');
    const r = await capy(['export', '--vars=A,C']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('A=1\nC=3\n');
  });

  test('--vars with missing name fails non-zero', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'A=1\n');
    const r = await capy(['export', '--vars=A,MISSING']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MISSING');
  });

  test('unknown format fails', async () => {
    writeFileSync(join(TEST_DIR, '.env'), 'A=1\n');
    const r = await capy(['export', '--format=yaml']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown format');
  });
});
