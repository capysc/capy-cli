/**
 * `backupPlaintextEnv` never writes its backup onto the file it is copying, whatever the env file is called.
 * Real files in a temp directory (no fs mocks).
 */
import { describe, test, expect, afterAll, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileManager } from '../../src/files/fileManager';

const SOURCE = 'API_KEY=sentinel-plain-value\nDB_URL=two\n';

describe('backupPlaintextEnv backup path', () => {
  // One parent directory for the whole file; each test gets a fresh folder inside it, and the parent goes at the end.
  const parent = mkdtempSync(join(tmpdir(), 'capy-backup-path-'));
  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });
  const freshRoot = () => mkdtempSync(join(parent, 'case-'));
  const gitignore = (root: string) => readFileSync(join(root, '.gitignore'), 'utf-8');

  test('a plain .env keeps its backup at .env.pre-capy.old and leaves the source untouched', () => {
    const root = freshRoot();
    const envPath = join(root, '.env');
    writeFileSync(envPath, SOURCE);
    const said = jest.fn();
    expect(new FileManager(root).backupPlaintextEnv(envPath, said)).toBe(true);
    const backup = join(root, '.env.pre-capy.old');
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# API_KEY=sentinel-plain-value');
    expect(said.mock.calls).toEqual([[`Saved plaintext backup to ${backup}`]]);
    expect(gitignore(root)).toBe('\n# Capy\n.env.pre-capy.old\n');
  });

  test('.env.local is backed up beside itself, not onto itself', () => {
    const root = freshRoot();
    const envPath = join(root, '.env.local');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    const backup = join(root, '.env.local.pre-capy.old');
    expect(backup).not.toBe(envPath);
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# API_KEY=sentinel-plain-value');
    // The backup holds plaintext, so it is ignored by git too.
    expect(gitignore(root)).toContain('.env.local.pre-capy.old');
  });

  test('a nested custom path is backed up in its own folder', () => {
    const root = freshRoot();
    mkdirSync(join(root, 'config'));
    const envPath = join(root, 'config', 'prod.env');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    const backup = join(root, 'config', 'prod.env.pre-capy.old');
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# DB_URL=two');
    expect(existsSync(join(root, '.env.pre-capy.old'))).toBe(false);
    expect(gitignore(root)).toContain('prod.env.pre-capy.old');
  });

  test('a name with no .env in it at all is not overwritten either', () => {
    const root = freshRoot();
    const envPath = join(root, 'secrets.txt');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(existsSync(join(root, 'secrets.txt.pre-capy.old'))).toBe(true);
  });
});
