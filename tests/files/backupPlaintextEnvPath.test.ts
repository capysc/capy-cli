/**
 * `backupPlaintextEnv` prints its "Saved plaintext backup" line through the `say` it is given.
 * Real files in a temp directory (no fs mocks).
 */
import { describe, test, expect, afterAll, jest } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileManager } from '../../src/files/fileManager';

const SOURCE = 'API_KEY=sentinel-plain-value\nDB_URL=two\n';

describe('backupPlaintextEnv say', () => {
  // One parent directory for the whole file; each test gets a fresh folder inside it, and the parent goes at the end.
  const parent = mkdtempSync(join(tmpdir(), 'capy-backup-path-'));
  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });
  const freshRoot = () => mkdtempSync(join(parent, 'case-'));
  const gitignore = (root: string) => readFileSync(join(root, '.gitignore'), 'utf-8');

  test('a plain .env keeps its backup at .env.pre-capy.old, leaves the source untouched and prints through say', () => {
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
});
