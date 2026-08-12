import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
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

const K_LOCAL_BYTES = 32;

/** Persists K_local (raw 32 bytes, base64) with mode 0600. */
export function saveLocalRoot(orgId: string, kLocal: Buffer, userId?: string): void {
  writeSecureFile(getLocalRootPath(orgId, userId), kLocal.toString('base64'));
}

/**
 * Persists K_local only if no local.key exists yet (O_EXCL). Returns false if
 * the file already exists. This is the arbitration primitive for concurrent
 * first-run migrations: exactly one process wins the create; the loser must
 * re-read and adopt the winner's root, or both could wrap key.enc under
 * different roots and orphan the blob.
 */
export function saveLocalRootExclusive(orgId: string, kLocal: Buffer, userId?: string): boolean {
  const path = getLocalRootPath(orgId, userId);
  ensureDir(join(path, '..'));
  try {
    writeFileSync(path, kLocal.toString('base64'), { mode: 0o600, flag: 'wx' });
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Reads K_local, or null if this machine has never minted one for this
 * org+user. A file that does not decode to exactly 32 bytes (truncated or
 * corrupt write) is treated as absent: deriving from a short buffer would
 * silently wrap M under a weak or constant key.
 */
export function readLocalRoot(orgId: string, userId?: string): Buffer | null {
  const content = readFileOrNull(getLocalRootPath(orgId, userId));
  if (!content) return null;
  const kLocal = Buffer.from(content.trim(), 'base64');
  return kLocal.length === K_LOCAL_BYTES ? kLocal : null;
}

export function hasLocalRoot(orgId: string, userId?: string): boolean {
  return existsSync(getLocalRootPath(orgId, userId));
}

/**
 * Org ids under ~/.capy/orgs/ that hold a user-scoped local.key for this
 * user. Read-only scan used by device-key onboarding detection (CAP-380):
 * "local.key on disk" means ANY org has one, not just the active org.
 * Only the user-scoped layout (orgs/<orgId>/users/<userId>/local.key) is
 * scanned — every current write path is user-scoped.
 */
export function listOrgsWithLocalRoot(userId: string): string[] {
  const orgsDir = join(getGlobalCapyDir(), 'orgs');
  let entries: string[];
  try {
    entries = readdirSync(orgsDir);
  } catch {
    return [];
  }
  return entries.filter(orgId => existsSync(getLocalRootPath(orgId, userId)));
}

// --- key.enc device-key sync marker (CAP-380) ---
//
// TRANSIENT flag meaning "the server's copy of this org's key.enc is owed an
// upload". Written when device-key onboarding starts touching an org and
// whenever an enrollment-aware run re-wraps key.enc; deleted the moment the
// upload succeeds. It lives beside key.enc (same precedent as the `.mode`
// marker) so `capy logout` — which preserves the orgs/ subtree — cannot lose
// a pending retry. In steady state the file does not exist, so a
// passkey-provisioned tree stays structurally identical to a
// transport-provisioned one (CAP-372 equivalence requirement).
//
// The marker's CONTENT records the canonical identity it was set against
// (gate-2 MAJOR-1 fix): the org whose local.key is the root this org's
// key.enc is owed against, plus a SHA-256 fingerprint of that root's bytes
// at mark-time. A crash-recovery sweep that instead GUESSED the canonical
// root from "any org that happens to be marker-free right now" could pick a
// divergent, never-canonicalized org — durably re-keying a good copy onto a
// root no enrolled door wraps. Recording the identity in the marker itself
// means the sweep never has to guess, and a fingerprint mismatch (the
// recorded canonical org's root moved, or vanished, since the marker was
// set) fails closed instead of silently trusting stale state. A marker with
// empty or unparseable content predates this format — callers MUST treat
// that as "no canonical recorded", never assume it means "not pending"
// (use isKeyEncSyncPending / listOrgsWithKeyEncSyncPending for that).

export interface KeyEncSyncPendingMarker {
  /** Org id whose local.key is the canonical root this org's key.enc owes an upload against. */
  canonicalOrgId: string;
  /** SHA-256 hex digest of the canonical root's raw bytes at mark-time. */
  canonicalRootSha256: string;
}

/** SHA-256 hex digest of a root's raw bytes — the sync-marker fingerprint. */
export function rootFingerprint(root: Buffer): string {
  return createHash('sha256').update(root).digest('hex');
}

export function getKeyEncSyncPendingPath(orgId: string, userId?: string): string {
  return getOrgKeyPath(orgId, userId) + '.sync-pending';
}

/**
 * Marks `orgId`'s key.enc as owing a server upload against `canonicalRoot`
 * (the root of `canonicalOrgId` — the same org when there is nothing to
 * unify onto, a different org when enrollment is re-keying onto a shared
 * canonical root).
 */
export function markKeyEncSyncPending(
  orgId: string,
  userId: string | undefined,
  canonicalOrgId: string,
  canonicalRoot: Buffer,
): void {
  const marker: KeyEncSyncPendingMarker = {
    canonicalOrgId,
    canonicalRootSha256: rootFingerprint(canonicalRoot),
  };
  try {
    writeSecureFile(getKeyEncSyncPendingPath(orgId, userId), JSON.stringify(marker));
  } catch {
    // Best-effort: a failed marker write only costs a missed retry.
  }
}

export function clearKeyEncSyncPending(orgId: string, userId?: string): void {
  try {
    rmSync(getKeyEncSyncPendingPath(orgId, userId), { force: true });
  } catch {
    // best effort
  }
}

export function isKeyEncSyncPending(orgId: string, userId?: string): boolean {
  return existsSync(getKeyEncSyncPendingPath(orgId, userId));
}

/**
 * Reads a marker's recorded canonical identity. Returns null for a missing
 * marker, empty content (the pre-gate-2-fix format), or content that fails
 * to parse as a `KeyEncSyncPendingMarker` — callers must fall back rather
 * than trust it, and must not read null as "not pending".
 */
export function readKeyEncSyncPendingMarker(orgId: string, userId?: string): KeyEncSyncPendingMarker | null {
  const content = readFileOrNull(getKeyEncSyncPendingPath(orgId, userId));
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.canonicalOrgId === 'string' && typeof parsed?.canonicalRootSha256 === 'string') {
      return { canonicalOrgId: parsed.canonicalOrgId, canonicalRootSha256: parsed.canonicalRootSha256 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Org ids with a pending key.enc upload marker for this user. */
export function listOrgsWithKeyEncSyncPending(userId: string): string[] {
  const orgsDir = join(getGlobalCapyDir(), 'orgs');
  let entries: string[];
  try {
    entries = readdirSync(orgsDir);
  } catch {
    return [];
  }
  return entries.filter(orgId => isKeyEncSyncPending(orgId, userId));
}

// --- K_local backend mode marker (read-only legacy detection) ---
//
// The OS-keychain backend was removed, so nothing writes this file anymore
// and 'file' is the only mode capy mints. The read stays because installs
// that opted in via CAPY_LOCAL_KEY_BACKEND=keychain while it existed still
// have the marker on disk and their K_local in the OS keychain; keyResolver
// uses this to fail closed for them instead of silently minting a second
// root. Absence of the file means 'file', so every other install is
// unaffected.

export function getLocalRootModePath(orgId: string, userId?: string): string {
  return getLocalRootPath(orgId, userId) + '.mode';
}

export type LocalRootMode = 'file' | 'keychain';

export function getLocalRootMode(orgId: string, userId?: string): LocalRootMode {
  const content = readFileOrNull(getLocalRootModePath(orgId, userId));
  return content?.trim() === 'keychain' ? 'keychain' : 'file';
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
    // Format stamp, not a parser input: readMasterKey only consumes
    // encrypted_master_key, and pre-K_local binaries ignore these fields too.
    // Stamping 2.0/local_root lets future versions tell "written by a newer
    // capy" apart from a corrupt or foreign blob when the format moves again.
    version: '2.0',
    org_id: orgId,
    encrypted_master_key: encryptedBlob,
    wrapping_method: 'local_root' as const,
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

/**
 * Removes every local key-material file this machine holds for (orgId,
 * userId): local.key, key.enc, the key.enc sync-pending marker, and the
 * K_local backend-mode marker. CAP-402's ephemeral-environment rollback is
 * the only caller — see `runNewUserEnrollment`'s docblock. On a disk that
 * will not outlive this process, a half-finished mint (a ceremony declined,
 * or the key.enc upload never landed) is worse left on disk than deleted:
 * it invites a false "this org is safely provisioned here" reading, when
 * the ONLY durable copy is the seed phrase the caller was (or was not) able
 * to show. Never called for a durable machine — CAP-383's byte-identical-
 * refusal test pins the opposite behavior there (files stay).
 */
export function deleteLocalKeyMaterial(orgId: string, userId?: string): void {
  for (const path of [
    getLocalRootPath(orgId, userId),
    getOrgKeyPath(orgId, userId),
    getKeyEncSyncPendingPath(orgId, userId),
    getLocalRootModePath(orgId, userId),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort: a delete that fails on a disk about to vanish anyway
      // is not a new problem this function can solve.
    }
  }
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
 * Peek without consuming — CAP-374's keep-bridge login path (authService.ts)
 * needs to know whether a fresh WorkOS prompt is required BEFORE deciding
 * whether to route through keep at all: keep's own `/auth/start` doesn't
 * (yet) forward `force_login`, so a pending marker must steer the flow back
 * to the direct `/auth/initiate` path — the one that actually honors it —
 * rather than silently dropping the shared-machine re-auth guarantee.
 */
export function isForceLoginMarkerPending(): boolean {
  return existsSync(getForceLoginMarkerPath());
}

// --- Device-key enrollment nudge marker (~/.capy/auth/.device-key-nudge-declined) ---
//
// Final-gate MAJOR-5: the ordinary `capy` run offers a ONE-TIME, declinable
// nudge to set up a device key when this machine already holds a local root
// but the account has zero live doors (Case B — `enroll_existing`, the
// existing-user-never-enrolled gap the final-gate review named as the
// program's biggest adoption risk). A "no" persists this marker so the
// prompt never repeats.
//
// Lives beside the force-login marker under `auth/` — deliberately NOT
// under `orgs/<orgId>/users/<userId>/`: CAP-383's equivalence test
// (`capyRunEquivalence.e2e.test.ts`) pins that directory's file set to
// exactly `key.enc`/`local.key` byte-for-byte across both provisioning
// paths, so a marker written there would be a regression the moment device
// keys are flag-on. An "enrolled" outcome needs no marker at all — the
// detection condition itself stops being true the moment a door exists.

export function getDeviceKeyNudgeDeclinedMarkerPath(): string {
  return join(getGlobalCapyDir(), 'auth', '.device-key-nudge-declined');
}

export function hasDeclinedDeviceKeyNudge(): boolean {
  return existsSync(getDeviceKeyNudgeDeclinedMarkerPath());
}

export function setDeviceKeyNudgeDeclined(): void {
  writeSecureFile(getDeviceKeyNudgeDeclinedMarkerPath(), '');
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
