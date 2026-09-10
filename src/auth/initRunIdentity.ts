import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { getGlobalCapyDir } from '../config/globalConfig';
import { CapyError } from '../types';
import { readProtectedJson, saveProtectedJson } from '../commands/flowPairCommand';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface InitRunIdentity {
  readonly runtimeId: string;
  readonly repositoryFingerprint: string;
  readonly repositoryRoot: string;
  readonly machineName: string;
}

const refuse = (code: string): never => {
  throw new CapyError('Hosted initialization cannot establish its local binding', code);
};

function runtimeIdPath(): string {
  return join(getGlobalCapyDir(), 'auth', 'authentication-flows', 'runtime-id.json');
}

export interface InitRunIdentityStorage {
  readonly read: (path: string) => Readonly<{ id: string }> | null;
  readonly save: (path: string, value: Readonly<{ id: string }>) => void;
}

const defaultStorage: InitRunIdentityStorage = {
  read: (path) => readProtectedJson<{ readonly id: string }>(path),
  save: saveProtectedJson,
};

function resolveRuntimeId(path: string, storage: InitRunIdentityStorage): string {
  const existing = storage.read(path);
  if (existing) return UUID.test(existing.id) ? existing.id : refuse('INIT_RUNTIME_ID_INVALID');
  const id = randomUUID();
  storage.save(path, { id });
  return id;
}

function resolveRepositoryRoot(cwd: string): string {
  const discovered = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  })();
  if (!discovered) return refuse('INIT_REPOSITORY_REQUIRED');
  return realpathSync(discovered);
}

/** Frozen identity shared with the existing pairing/setup executors. */
export function resolveInitRunIdentity(
  cwd: string = process.cwd(),
  identityPath: string = runtimeIdPath(),
  storage: InitRunIdentityStorage = defaultStorage,
): InitRunIdentity {
  const repositoryRoot = resolveRepositoryRoot(cwd);
  return {
    runtimeId: resolveRuntimeId(identityPath, storage),
    repositoryFingerprint: `sha256:${createHash('sha256').update(repositoryRoot).digest('hex')}`,
    repositoryRoot,
    machineName: hostname(),
  };
}
