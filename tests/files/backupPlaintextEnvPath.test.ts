/**
 * `backupPlaintextEnv` never writes its backup onto the file it is copying, whatever the env file is called.
 * Real files in a temp directory (no fs mocks).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileManager } from '../../src/files/fileManager';

const SOURCE = 'API_KEY=sentinel-plain-value\nDB_URL=two\n';

describe('backupPlaintextEnv backup path', () => {
  const state = { root: '' };
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'capy-backup-path-'));
  });
  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  const gitignore = () => readFileSync(join(state.root, '.gitignore'), 'utf-8');

  test('a plain .env keeps its backup at .env.pre-capy.old and leaves the source untouched', () => {
    const envPath = join(state.root, '.env');
    writeFileSync(envPath, SOURCE);
    const said: string[] = [];
    expect(new FileManager(state.root).backupPlaintextEnv(envPath, (l) => said.push(l))).toBe(true);
    const backup = join(state.root, '.env.pre-capy.old');
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# API_KEY=sentinel-plain-value');
    expect(said).toEqual([`Saved plaintext backup to ${backup}`]);
    expect(gitignore()).toBe('\n# Capy\n.env.pre-capy.old\n');
  });

  test('.env.local is backed up beside itself, not onto itself', () => {
    const envPath = join(state.root, '.env.local');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(state.root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    const backup = join(state.root, '.env.local.pre-capy.old');
    expect(backup).not.toBe(envPath);
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# API_KEY=sentinel-plain-value');
    // The backup holds plaintext, so it is ignored by git too.
    expect(gitignore()).toContain('.env.local.pre-capy.old');
  });

  test('a nested custom path is backed up in its own folder', () => {
    mkdirSync(join(state.root, 'config'));
    const envPath = join(state.root, 'config', 'prod.env');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(state.root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    const backup = join(state.root, 'config', 'prod.env.pre-capy.old');
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(readFileSync(backup, 'utf-8')).toContain('# DB_URL=two');
    expect(existsSync(join(state.root, '.env.pre-capy.old'))).toBe(false);
    expect(gitignore()).toContain('prod.env.pre-capy.old');
  });

  test('a name with no .env in it at all is not overwritten either', () => {
    const envPath = join(state.root, 'secrets.txt');
    writeFileSync(envPath, SOURCE);
    expect(new FileManager(state.root).backupPlaintextEnv(envPath, () => undefined)).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe(SOURCE);
    expect(existsSync(join(state.root, 'secrets.txt.pre-capy.old'))).toBe(true);
  });
});
