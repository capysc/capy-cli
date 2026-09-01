import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquirePairAttemptLease,
  releasePairAttemptLease,
} from '../../../src/auth/pairing/pairAttemptLease';
import { ERROR_CODES } from '../../../src/types/index';

function withLeasePath(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'capy-pair-lease-'));
  const path = join(directory, 'auth', 'pair-in-progress.json');
  try {
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('pair attempt lease', () => {
  test('rejects an overlapping ceremony while the owner process is live', () => {
    withLeasePath((path) => {
      const first = acquirePairAttemptLease({
        path,
        pid: 101,
        now: () => new Date('2026-09-01T00:00:00.000Z'),
        nonce: () => 'first',
        isProcessAlive: (pid) => pid === 101,
      });

      expect(() => acquirePairAttemptLease({
        path,
        pid: 202,
        now: () => new Date('2026-09-01T00:01:00.000Z'),
        nonce: () => 'second',
        isProcessAlive: (pid) => pid === 101,
      })).toThrow(expect.objectContaining({ code: ERROR_CODES.PAIR_ALREADY_IN_PROGRESS }));
      expect(JSON.parse(readFileSync(path, 'utf8')).nonce).toBe('first');
      expect(releasePairAttemptLease(first)).toBe(true);
    });
  });

  test('reclaims a dead owner and prevents the old owner from deleting the replacement', () => {
    withLeasePath((path) => {
      const first = acquirePairAttemptLease({
        path,
        pid: 101,
        nonce: () => 'first',
        isProcessAlive: () => true,
      });
      const replacement = acquirePairAttemptLease({
        path,
        pid: 202,
        nonce: () => 'replacement',
        isProcessAlive: () => false,
      });

      expect(replacement.pid).toBe(202);
      expect(releasePairAttemptLease(first)).toBe(false);
      expect(JSON.parse(readFileSync(path, 'utf8')).nonce).toBe('replacement');
      expect(releasePairAttemptLease(replacement)).toBe(true);
    });
  });
});
