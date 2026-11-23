// Laravel regression: Docker Compose reads .env before anything runs and
// interpolates `$`/`${`. The plaintext preview Capy splices around the
// ciphertext used to copy `${` from values like `"${PUSHER_APP_KEY}"`, so every
// `docker compose` command failed with "Invalid template".
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileManager } from '../../src/files/fileManager';
import { healPreview, safePreview, snippetWithEncryption } from '../../src/files/valuePreview';

const KEY = 'a'.repeat(64);
const UNSAFE = /[$"'`\\#{}\s]/;

const LARAVEL = {
  APP_NAME: 'Laravel',
  VITE_APP_NAME: '${APP_NAME}',
  VITE_PUSHER_APP_KEY: '${PUSHER_APP_KEY}',
  VITE_PUSHER_HOST: '${PUSHER_HOST}',
  VITE_PUSHER_PORT: '${PUSHER_PORT}',
  TEST_REF: ' {APP_NAME}',
  DOLLAR: 'pa$$word',
  HASH: 'abc #not-a-comment',
  QUOTES: `it's "quoted"`,
};

describe('encrypted .env previews are inert to .env readers', () => {
  let dir: string;
  let envPath: string;
  let fm: FileManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capy-preview-'));
    envPath = join(dir, '.env');
    fm = new FileManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes no $, {, }, #, quotes or spaces into any value', () => {
    fm.writeEncryptedEnvFile(LARAVEL, KEY, envPath, null, 'main');
    const values = readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.slice(l.indexOf('=') + 1));
    expect(values.length).toBe(Object.keys(LARAVEL).length);
    for (const v of values) expect(v).not.toMatch(UNSAFE);
  });

  it('round-trips every value byte-for-byte', () => {
    fm.writeEncryptedEnvFile(LARAVEL, KEY, envPath, null, 'main');
    expect(fm.readEncryptedEnvFile(KEY, envPath)).toEqual(LARAVEL);
  });

  it('heals a file written before the fix on the next write', () => {
    fm.writeEncryptedEnvFile({ VITE_PUSHER_APP_KEY: '${PUSHER_APP_KEY}' }, KEY, envPath, null, 'main');
    const line = readFileSync(envPath, 'utf-8').split('\n').find((l) => l.startsWith('VITE_PUSHER_APP_KEY='))!;
    // Recreate the old, broken preview around the same ciphertext.
    const broken = line.replace(/:([^:.]*)\.\.\.([^.]+)\.\.\.(.*)$/, ':${...$2...P_KEY}');
    expect(broken).toContain('${');
    writeFileSync(envPath, broken + '\n');

    const existing = fm.readEnvFile(envPath);
    fm.writeEncryptedEnvFile(existing, KEY, envPath, null, 'main');

    const healed = readFileSync(envPath, 'utf-8');
    expect(healed).not.toContain('${');
    expect(fm.readEncryptedEnvFile(KEY, envPath).VITE_PUSHER_APP_KEY).toBe('${PUSHER_APP_KEY}');
  });
});

describe('preview helpers', () => {
  it('masks unsafe characters and keeps safe ones', () => {
    expect(safePreview('${A}')).toBe('**A*');
    expect(safePreview('ab-c_d/e+f=g@h,i:j')).toBe('ab-c_d/e+f=g@h,i:j');
  });

  it('never adds a separator to the ciphertext', () => {
    const v = snippetWithEncryption('ends with...', 'CIPHER');
    expect(v.split('...').length).toBe(3);
    expect(v.split('...')[1]).toBe('CIPHER');
  });

  it('heals both preview shapes and leaves the ciphertext alone', () => {
    expect(healPreview('capy:abc:${...CT+/=...P_KEY}')).toBe('capy:abc:**...CT+/=...P_KEY*');
    expect(healPreview('capy:abc:CT+/=...}')).toBe('capy:abc:CT+/=...*');
  });
});
