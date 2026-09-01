/**
 * One in-flight `capy pair` ceremony per environment home.
 *
 * A Codex turn can be interrupted while the spawned CLI keeps running. If a
 * replacement turn starts another pair, both long-pollers otherwise remain
 * live and the human sees two unrelated WorkOS/Keep requests. This lease is
 * metadata only: PID, creation time, and an ownership nonce. It contains no
 * authorization code, broker id, token, or key material.
 *
 * A live owner refuses overlap. A dead owner is reclaimed atomically on the
 * next attempt. Release is ownership-checked so an old process can never
 * remove a newer process's lease.
 */
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getGlobalCapyDir } from '../../config/globalConfig';
import { CapyError, ERROR_CODES } from '../../types/index';

export interface PairAttemptLease {
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly nonce: string;
  readonly path: string;
}

export interface PairAttemptLeaseDependencies {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test-only path override; production always uses the active Capy home. */
  readonly path?: string;
}

interface PairAttemptLeaseRecord {
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly nonce: string;
}

export function getPairAttemptLeasePath(): string {
  return join(getGlobalCapyDir(), 'auth', 'pair-in-progress.json');
}

function isLeaseRecord(value: unknown): value is PairAttemptLeaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.version === 1
    && typeof candidate.pid === 'number'
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid > 0
    && typeof candidate.startedAt === 'string'
    && typeof candidate.nonce === 'string'
    && candidate.nonce.length > 0;
}

function readLease(path: string): PairAttemptLeaseRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isLeaseRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function writeLeaseExclusive(path: string, record: PairAttemptLeaseRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function acquireRecoveryGuard(path: string): string {
  const guardPath = `${path}.recovery`;
  try {
    mkdirSync(guardPath, { mode: 0o700 });
    return guardPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new CapyError(
      'Another capy pair process is already recovering an interrupted ceremony. Try again after it finishes.',
      ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    );
  }
}

function replaceStaleLease(
  path: string,
  record: PairAttemptLeaseRecord,
  isProcessAlive: (pid: number) => boolean,
  attemptsRemaining: number,
): PairAttemptLease {
  const guardPath = acquireRecoveryGuard(path);
  try {
    const current = readLease(path);
    if (current !== null && isProcessAlive(current.pid)) {
      throw new CapyError(
        'Another capy pair ceremony is already active in this runtime. Finish or stop it before starting a replacement.',
        ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
      );
    }
    rmSync(path, { force: true });
    return acquireAttempt(path, record, isProcessAlive, attemptsRemaining - 1);
  } finally {
    rmSync(guardPath, { force: true, recursive: true });
  }
}

function acquireAttempt(
  path: string,
  record: PairAttemptLeaseRecord,
  isProcessAlive: (pid: number) => boolean,
  attemptsRemaining: number,
): PairAttemptLease {
  if (writeLeaseExclusive(path, record)) return { ...record, path };
  const existing = readLease(path);
  if (existing !== null && isProcessAlive(existing.pid)) {
    throw new CapyError(
      'Another capy pair ceremony is already active in this runtime. Finish or stop it before starting a replacement.',
      ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    );
  }
  if (attemptsRemaining <= 0) {
    throw new CapyError(
      'Could not safely replace a stale capy pair lease. Try again after the earlier process has stopped.',
      ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    );
  }
  return replaceStaleLease(path, record, isProcessAlive, attemptsRemaining);
}

export function acquirePairAttemptLease(
  dependencies: PairAttemptLeaseDependencies = {},
): PairAttemptLease {
  const record: PairAttemptLeaseRecord = {
    version: 1,
    pid: dependencies.pid ?? process.pid,
    startedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    nonce: (dependencies.nonce ?? randomUUID)(),
  };
  return acquireAttempt(
    dependencies.path ?? getPairAttemptLeasePath(),
    record,
    dependencies.isProcessAlive ?? processIsAlive,
    2,
  );
}

export function releasePairAttemptLease(lease: PairAttemptLease): boolean {
  const current = readLease(lease.path);
  if (!current || current.nonce !== lease.nonce) return false;
  try {
    rmSync(lease.path, { force: true });
    return true;
  } catch {
    return false;
  }
}
