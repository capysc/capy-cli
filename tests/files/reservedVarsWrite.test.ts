/**
 * CAP-424 — the write path must leave reserved runtime variables plaintext and
 * on disk.
 *
 * ISOLATED (registered in tests/run-tests.sh): these touch the real
 * filesystem, and several files in the batch install a process-wide
 * `mock.module('fs')` that would otherwise answer these reads.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileManager } from '../../src/files/fileManager';

function withTempDir(fn: (dir: string) => void): () => void {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-reserved-write-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('writeEncryptedEnvFile never encrypts reserved runtime variables', () => {
  test(
    'PROJECT_KEY stays plaintext while a real secret is encrypted',
    withTempDir((dir) => {
      const fm = new FileManager(dir);
      const envPath = join(dir, '.env');

      fm.writeEncryptedEnvFile(
        { PROJECT_KEY: 'a'.repeat(64), SECRETS_BLOB: 'blob-value', REAL: 'sensitive' },
        'k'.repeat(64),
        envPath,
      );

      const written = readFileSync(envPath, 'utf-8');
      // Encrypting the project key with itself and pushing it would hand the
      // raw key to every member on their next sync — they hold exactly the key
      // it was encrypted under, so it decrypts for all of them.
      expect(written).toContain(`PROJECT_KEY=${'a'.repeat(64)}`);
      expect(written).toContain('SECRETS_BLOB=blob-value');
      expect(written).not.toContain('REAL=sensitive');
      expect(written).toMatch(/REAL=capy:/);
    }),
  );

  test(
    'a read/modify/write round trip does not drop them from disk',
    withTempDir((dir) => {
      // The hazard that decided where the filter goes. Hiding reserved names
      // in the READER would have been tidier, but then any read/modify/write
      // caller would delete the machine's deploy credential from .env and it
      // would stop booting. The writer preserves instead.
      const fm = new FileManager(dir);
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'SECRETS_BLOB=keep-me\nREAL=plain\n');

      const read = fm.readEnvFile(envPath);
      fm.writeEncryptedEnvFile(read, 'k'.repeat(64), envPath);

      expect(readFileSync(envPath, 'utf-8')).toContain('SECRETS_BLOB=keep-me');
    }),
  );

  test(
    'a future _CAPY_ runtime variable is preserved with no code change',
    withTempDir((dir) => {
      const fm = new FileManager(dir);
      const envPath = join(dir, '.env');

      fm.writeEncryptedEnvFile(
        { _CAPY_SOMETHING_UNINVENTED: 'v', REAL: 'sensitive' },
        'k'.repeat(64),
        envPath,
      );

      const written = readFileSync(envPath, 'utf-8');
      expect(written).toContain('_CAPY_SOMETHING_UNINVENTED=v');
      expect(written).toMatch(/REAL=capy:/);
    }),
  );
});
