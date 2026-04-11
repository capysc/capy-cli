import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GLOBAL_CAPY_DIR = join(homedir(), '.capy');

export function getGlobalCapyDir(): string {
  return GLOBAL_CAPY_DIR;
}

export function getAuthSessionPath(userId?: string): string {
  if (userId) {
    return join(GLOBAL_CAPY_DIR, 'auth', 'sessions', `${userId}.json`);
  }
  return join(GLOBAL_CAPY_DIR, 'auth', 'session.json');
}

export function getOrgKeyPath(orgId: string, userId?: string): string {
  if (userId) {
    return join(GLOBAL_CAPY_DIR, 'orgs', orgId, 'users', userId, 'key.enc');
  }
  return join(GLOBAL_CAPY_DIR, 'orgs', orgId, 'key.enc');
}

export function getProjectKeyCachePath(orgId: string, projectId: string): string {
  return join(GLOBAL_CAPY_DIR, 'orgs', orgId, 'projects', projectId, 'key.cache');
}

export function getGlobalConfigPath(): string {
  return join(GLOBAL_CAPY_DIR, 'config.json');
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

function writeSecureFile(filePath: string, content: string): void {
  ensureDir(join(filePath, '..'));
  writeFileSync(filePath, content, { mode: 0o600 });
}

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function saveMasterKey(orgId: string, encryptedBlob: string, userId?: string): void {
  const keyPath = getOrgKeyPath(orgId, userId);
  const data = {
    version: '1.0',
    org_id: orgId,
    encrypted_master_key: encryptedBlob,
    wrapping_method: 'auth_token' as const,
    created_at: new Date().toISOString(),
  };
  writeSecureFile(keyPath, JSON.stringify(data, null, 2));
}

export function readMasterKey(orgId: string, userId?: string): string | null {
  const content = readFileOrNull(getOrgKeyPath(orgId, userId));
  if (!content) return null;
  const data = JSON.parse(content);
  return data.encrypted_master_key;
}

export function hasOrgKey(orgId: string, userId?: string): boolean {
  return existsSync(getOrgKeyPath(orgId, userId));
}

export function saveProjectKeyCache(
  orgId: string,
  projectId: string,
  keyHex: string,
): void {
  const cachePath = getProjectKeyCachePath(orgId, projectId);
  writeSecureFile(cachePath, keyHex);
}

export function readProjectKeyCache(
  orgId: string,
  projectId: string,
): string | null {
  return readFileOrNull(getProjectKeyCachePath(orgId, projectId));
}

export function saveAuthSession(token: object, userId?: string): void {
  writeSecureFile(getAuthSessionPath(userId), JSON.stringify(token, null, 2));
}

export function readAuthSession(userId?: string): object | null {
  const content = readFileOrNull(getAuthSessionPath(userId));
  if (!content) return null;
  return JSON.parse(content);
}

// --- Local keep cache (~/.capy/keep/) ---

export function getKeepCachePath(keepHash: string): string {
  return join(GLOBAL_CAPY_DIR, 'keep', keepHash);
}

export function writeKeepCache(keepHash: string, envBlob: string): void {
  try {
    writeSecureFile(getKeepCachePath(keepHash), envBlob);
  } catch {
    // Best-effort — silent on error
  }
}

export function readKeepCache(keepHash: string): string | null {
  return readFileOrNull(getKeepCachePath(keepHash));
}

export async function fetchSecretsWithCache(
  serviceClient: { getSecrets(projectId: string, keepHash: string): Promise<{ env_file: string } | null> },
  projectId: string,
  keepHash: string,
): Promise<{ env_file: string } | null> {
  const cached = readKeepCache(keepHash);
  if (cached !== null) {
    return { env_file: cached };
  }
  const result = await serviceClient.getSecrets(projectId, keepHash);
  if (result?.env_file) {
    writeKeepCache(keepHash, result.env_file);
  }
  return result;
}
