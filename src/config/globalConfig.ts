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

// --- K_local (machine-local inner-wrap root) ---
//
// Lives beside key.enc under ~/.capy/orgs/<orgId>/users/<userId>/ — the
// recovery-equivalent area `capy logout` never wipes. Never transmitted.
// Losing it means re-redeeming an invite, same as a lost device.

export function getLocalRootPath(orgId: string, userId?: string): string {
  const base = userId
    ? join(getGlobalCapyDir(), 'orgs', orgId, 'users', userId)
    : join(getGlobalCapyDir(), 'orgs', orgId);
  return join(base, 'local.key');
}

/** Persists K_local (raw 32 bytes, base64) with mode 0600. */
export function saveLocalRoot(orgId: string, kLocal: Buffer, userId?: string): void {
  writeSecureFile(getLocalRootPath(orgId, userId), kLocal.toString('base64'));
}

/** Reads K_local, or null if this machine has never minted one for this org+user. */
export function readLocalRoot(orgId: string, userId?: string): Buffer | null {
  const content = readFileOrNull(getLocalRootPath(orgId, userId));
  return content ? Buffer.from(content.trim(), 'base64') : null;
}

export function hasLocalRoot(orgId: string, userId?: string): boolean {
  return existsSync(getLocalRootPath(orgId, userId));
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

// --- Local-only mode (~/.capy/local/) ---
//
// Fixed identity for local-only mode. There is no identity provider and no
// server user, so org/user are synthetic constants. projectId remains real
// and per-project, so deriveProjectKey(M, projectId, LOCAL_ORG_ID) still
// yields distinct keys per project.
export const LOCAL_ORG_ID = 'local';
export const LOCAL_USER_ID = 'local';

// The passphrase-wrapped master key lives under ~/.capy/local/ — deliberately
// NOT under ~/.capy/orgs/, so `capy logout` (which sweeps org/session state)
// can never delete the only copy of M.
export function getLocalKeyPath(): string {
  return join(getGlobalCapyDir(), 'local', 'key.local');
}

export interface LocalKeyRecord {
  version: string;
  wrapping_method: 'passphrase';
  /** base64 random salt for the passphrase KDF */
  salt: string;
  iterations: number;
  /** base64(iv || ciphertext || authTag) of M */
  encrypted_master_key: string;
  created_at: string;
}

export function saveLocalKeyRecord(record: LocalKeyRecord): void {
  writeSecureFile(getLocalKeyPath(), JSON.stringify(record, null, 2));
}

export function readLocalKeyRecord(): LocalKeyRecord | null {
  const content = readFileOrNull(getLocalKeyPath());
  if (!content) return null;
  try {
    return JSON.parse(content) as LocalKeyRecord;
  } catch {
    return null;
  }
}

export function hasLocalKey(): boolean {
  return existsSync(getLocalKeyPath());
}

// --- Local-only session (~/.capy/local/session.json) ---
//
// After a successful passphrase unlock, the decrypted M is cached here (mode
// 0600) so subsequent commands in the same window don't re-prompt — mirroring
// the recovery-session model. Idle auto-lock: the cached key is treated as
// locked once `now - last_used_at` exceeds the configured timeout.

export function getLocalSessionPath(): string {
  return join(getGlobalCapyDir(), 'local', 'session.json');
}

interface LocalSessionRecord {
  master_key: string;
  last_used_at: string;
}

export function saveLocalSession(masterKeyHex: string): void {
  const data: LocalSessionRecord = {
    master_key: masterKeyHex,
    last_used_at: new Date().toISOString(),
  };
  writeSecureFile(getLocalSessionPath(), JSON.stringify(data, null, 2));
}

function readLocalSessionRecord(): LocalSessionRecord | null {
  const content = readFileOrNull(getLocalSessionPath());
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (typeof data?.master_key === 'string') return data as LocalSessionRecord;
    return null;
  } catch {
    return null;
  }
}

export function clearLocalSession(): void {
  try {
    rmSync(getLocalSessionPath(), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Whether an unexpired local session exists. Enforces idle auto-lock lazily:
 * if the session is older than `timeoutMs` of inactivity, it is cleared and
 * treated as locked. No background daemon — checked on every use.
 */
export function isLocalUnlocked(timeoutMs: number): boolean {
  const rec = readLocalSessionRecord();
  if (!rec) return false;
  const last = Date.parse(rec.last_used_at);
  if (Number.isNaN(last)) {
    clearLocalSession();
    return false;
  }
  if (Date.now() - last > timeoutMs) {
    clearLocalSession();
    return false;
  }
  return true;
}

/** Read the cached master key hex, or null if no (unexpired) session. */
export function readLocalSession(timeoutMs: number): string | null {
  if (!isLocalUnlocked(timeoutMs)) return null;
  return readLocalSessionRecord()?.master_key ?? null;
}

/** Refresh the idle clock on an active session (call after each use). */
export function touchLocalSession(): void {
  const rec = readLocalSessionRecord();
  if (!rec) return;
  saveLocalSession(rec.master_key);
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

/**
 * Local-only counterpart to fetchSecretsWithCache: reads the encrypted blob
 * from the local keep cache ONLY, returning null on a miss. Never touches the
 * network — used by local-only mode so a cache miss can't fall through to a
 * server fetch.
 */
export function readSecretsLocal(
  orgId: string,
  projectId: string,
  keepHash: string,
): { env_file: string } | null {
  const cached = readKeepCache(orgId, projectId, keepHash);
  return cached !== null ? { env_file: cached } : null;
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
