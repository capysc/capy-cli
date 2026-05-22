import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Resolved lazily so `capy-dev` can isolate its state at `~/.capy-dev/` by
// setting CAPY_GLOBAL_DIR_NAME at startup — without this, dev tooling like
// sandbox/*/nuke.sh would clobber the user's prod `~/.capy/` (recovery-equivalent
// state). Reading env on every call also keeps tests overriding HOME safe.
export function getGlobalCapyDir(): string {
  return join(homedir(), process.env.CAPY_GLOBAL_DIR_NAME || '.capy');
}

export function getAuthSessionPath(userId?: string): string {
  if (userId) {
    return join(getGlobalCapyDir(), 'auth', 'sessions', `${userId}.json`);
  }
  return join(getGlobalCapyDir(), 'auth', 'session.json');
}

export function getOrgKeyPath(orgId: string, userId?: string): string {
  if (userId) {
    return join(getGlobalCapyDir(), 'orgs', orgId, 'users', userId, 'key.enc');
  }
  return join(getGlobalCapyDir(), 'orgs', orgId, 'key.enc');
}

export function getProjectKeyCachePath(orgId: string, projectId: string): string {
  return join(getGlobalCapyDir(), 'orgs', orgId, 'projects', projectId, 'key.cache');
}

export function getGlobalConfigPath(): string {
  return join(getGlobalCapyDir(), 'config.json');
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

// --- Local keep cache (~/.capy/keep/{orgId}/{projectId}/{keepHash}) ---
//
// Path is scoped by org+project to mirror the S3 layout and prevent cross-org
// collisions: keep_hash is derived from plaintext variable names + value hashes,
// so two different orgs with overlapping variable sets would otherwise share a
// cache file.

export function getKeepCachePath(orgId: string, projectId: string, keepHash: string): string {
  return join(getGlobalCapyDir(), 'keep', orgId, projectId, keepHash);
}

export function writeKeepCache(orgId: string, projectId: string, keepHash: string, envBlob: string): void {
  try {
    writeSecureFile(getKeepCachePath(orgId, projectId, keepHash), envBlob);
  } catch {
    // Best-effort — silent on error
  }
}

export function readKeepCache(orgId: string, projectId: string, keepHash: string): string | null {
  return readFileOrNull(getKeepCachePath(orgId, projectId, keepHash));
}

// --- Recovery session (~/.capy/recover/) ---

export function getRecoverySessionPath(): string {
  return join(getGlobalCapyDir(), 'recover', 'session.json');
}

export function isRecoveryActive(): boolean {
  return existsSync(getRecoverySessionPath());
}

export function saveRecoverySession(masterKeyHex: string, orgId: string): void {
  const data = {
    master_key: masterKeyHex,
    org_id: orgId,
    created_at: new Date().toISOString(),
  };
  writeSecureFile(getRecoverySessionPath(), JSON.stringify(data, null, 2));
}

export function readRecoverySession(): { master_key: string; org_id: string } | null {
  const content = readFileOrNull(getRecoverySessionPath());
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function deleteRecoverySession(): void {
  const recoverDir = join(getGlobalCapyDir(), 'recover');
  if (existsSync(recoverDir)) {
    rmSync(recoverDir, { recursive: true, force: true });
  }
}

// --- Force-login marker (~/.capy/auth/.force-login) ---
//
// Written by `capy logout` so the next interactive OAuth flow tells the
// service to ask WorkOS for a fresh login instead of reusing the AuthKit
// SSO cookie. Without this, `logout` followed by `capy` silently re-auths
// the previous user — which is what shared-machine evaluators hit.

export function getForceLoginMarkerPath(): string {
  return join(getGlobalCapyDir(), 'auth', '.force-login');
}

export function setForceLoginMarker(): void {
  writeSecureFile(getForceLoginMarkerPath(), '');
}

export function consumeForceLoginMarker(): boolean {
  const path = getForceLoginMarkerPath();
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort
  }
  return true;
}

export async function fetchSecretsWithCache(
  serviceClient: { getSecrets(projectId: string, keepHash: string): Promise<{ env_file: string } | null> },
  orgId: string,
  projectId: string,
  keepHash: string,
): Promise<{ env_file: string } | null> {
  const cached = readKeepCache(orgId, projectId, keepHash);
  if (cached !== null) {
    return { env_file: cached };
  }
  const result = await serviceClient.getSecrets(projectId, keepHash);
  if (result?.env_file) {
    writeKeepCache(orgId, projectId, keepHash, result.env_file);
  }
  return result;
}
