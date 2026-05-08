import { describe, test, expect } from 'bun:test';
import {
  dotenvEscape,
  shellEscape,
  formatExport,
} from '../../src/commands/exportCommand';

// `capy export` is no longer a public CLI command — exposing decrypted
// secrets to stdout was a security smell. The format helpers stay as
// internal library exports for connector adapters and any future
// callers, and are unit-tested directly here.

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

