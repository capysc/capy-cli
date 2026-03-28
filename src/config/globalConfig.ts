import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GLOBAL_CAPY_DIR = join(homedir(), '.capy');

export function getGlobalCapyDir(): string {
  return GLOBAL_CAPY_DIR;
}

export function getAuthSessionPath(): string {
  return join(GLOBAL_CAPY_DIR, 'auth', 'session.json');
}

export function getOrgKeyPath(orgId: string): string {
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

export function saveMasterKey(orgId: string, encryptedBlob: string): void {
  const keyPath = getOrgKeyPath(orgId);
  const data = {
    version: '1.0',
    org_id: orgId,
    encrypted_master_key: encryptedBlob,
    wrapping_method: 'auth_token' as const,
    created_at: new Date().toISOString(),
  };
  writeSecureFile(keyPath, JSON.stringify(data, null, 2));
}

export function readMasterKey(orgId: string): string | null {
  const content = readFileOrNull(getOrgKeyPath(orgId));
  if (!content) return null;
  const data = JSON.parse(content);
  return data.encrypted_master_key;
}

export function hasOrgKey(orgId: string): boolean {
  return existsSync(getOrgKeyPath(orgId));
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

export function saveAuthSession(token: object): void {
  writeSecureFile(getAuthSessionPath(), JSON.stringify(token, null, 2));
}

export function readAuthSession(): object | null {
  const content = readFileOrNull(getAuthSessionPath());
  if (!content) return null;
  return JSON.parse(content);
}
