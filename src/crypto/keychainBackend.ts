/**
 * OS-keychain backend for K_local — Tier 1 (OS-gatekept software storage).
 *
 * This is NOT hardware-non-extractable. A sufficiently privileged same-user
 * process, or root with an unlocked login keychain, can still read the
 * entry. It defeats plaintext-file exposure (backups, accidental commits,
 * log capture) — it does not defeat a live compromised-user-session
 * attacker. Real Secure Enclave hardware-backing was scoped and paused
 * (see CAP-278/279/280) in favor of this simpler, dependency-only approach.
 *
 * Uses @napi-rs/keyring (keyring-rs): macOS Keychain, Linux Secret Service,
 * Windows Credential Manager. In-process native binding — no subprocess, no
 * argv exposure (unlike shelling out to `security`, which Apple's own CLI
 * help text calls insecure for exactly that reason).
 *
 * Gotcha (found empirically): calling getPassword() again on the SAME
 * already-deleted Entry instance returns null instead of throwing — only a
 * fresh Entry instance reliably throws "not found". Every function here
 * constructs a fresh Entry per call, so this doesn't bite us, but don't
 * reuse a cached Entry across a delete boundary elsewhere.
 */

const SERVICE = 'capy';
const K_LOCAL_BYTES = 32;

/**
 * `@napi-rs/keyring`'s `Entry`, loaded lazily. The keychain backend is opt-in
 * (off unless `CAPY_LOCAL_KEY_BACKEND=keychain`), so we must NOT let its
 * per-platform native binary sit on the default import path — a missing or
 * unloadable prebuilt (unsupported arch, sandbox, failed optional install)
 * would otherwise throw at module load and break the file backend too. The
 * require is cached and its failure is swallowed to `null`, which every caller
 * already treats identically to "keychain unavailable / entry absent".
 */
type EntryCtor = typeof import('@napi-rs/keyring').Entry;
let cachedEntry: EntryCtor | null | undefined;
function loadEntry(): EntryCtor | null {
  if (cachedEntry !== undefined) return cachedEntry;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedEntry = (require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')).Entry;
  } catch {
    cachedEntry = null;
  }
  return cachedEntry;
}

function account(orgId: string, userId?: string): string {
  return userId ? `${orgId}:${userId}` : orgId;
}

/**
 * Best-effort availability probe. Does a real set/get/delete round-trip on a
 * fixed, non-identity-bearing slot — constructing an Entry alone doesn't
 * touch the OS, so a real operation is the only way to know the backend
 * actually works on this machine (unsupported platform, missing prebuilt
 * binary, sandboxed environment with no keychain access, etc).
 */
export function isKeychainAvailable(): boolean {
  const Entry = loadEntry();
  if (!Entry) return false;
  try {
    const probe = new Entry(SERVICE, '__capy_keychain_probe__');
    probe.setPassword('ok');
    const readBack = probe.getPassword();
    probe.deletePassword();
    return readBack === 'ok';
  } catch {
    return false;
  }
}

/** Reads K_local from the keychain, or null if absent / not a valid 32-byte root. */
export function readKeychainRoot(orgId: string, userId?: string): Buffer | null {
  const Entry = loadEntry();
  if (!Entry) return null;
  try {
    const entry = new Entry(SERVICE, account(orgId, userId));
    const value = entry.getPassword();
    if (!value) return null;
    const buf = Buffer.from(value, 'base64');
    return buf.length === K_LOCAL_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Persists K_local only if no entry exists yet for this account — mirrors
 * saveLocalRootExclusive's O_EXCL semantics as closely as a keychain allows.
 *
 * NOT atomic like O_EXCL: two racing processes could both observe "absent"
 * here and both proceed to set. That's an accepted, narrow race — the
 * failure mode is the same one saveLocalRootExclusive's O_EXCL guards
 * against for the file backend (an orphaned key.enc that costs a
 * re-invite), not a security regression.
 */
export function saveKeychainRootExclusive(orgId: string, kLocal: Buffer, userId?: string): boolean {
  const Entry = loadEntry();
  if (!Entry) throw new Error('OS keychain backend is unavailable on this machine.');
  const entry = new Entry(SERVICE, account(orgId, userId));
  // Found empirically: getPassword() returns null (no throw) for an account
  // that was never created, but throws for one that existed and was later
  // deleted. Both mean "absent" for our purposes — only a non-null return
  // means an entry is really there.
  try {
    if (entry.getPassword() !== null) return false; // already exists — didn't win the mint race
  } catch {
    // treated as absent — proceed to set
  }
  entry.setPassword(kLocal.toString('base64'));
  return true;
}

/** Unconditionally overwrites K_local in the keychain (corrupt-entry recovery path). */
export function saveKeychainRoot(orgId: string, kLocal: Buffer, userId?: string): void {
  const Entry = loadEntry();
  if (!Entry) throw new Error('OS keychain backend is unavailable on this machine.');
  const entry = new Entry(SERVICE, account(orgId, userId));
  entry.setPassword(kLocal.toString('base64'));
}

/** Opt-in gate: keychain backend is off by default, on only when explicitly requested. */
export function wantsKeychainBackend(): boolean {
  return process.env.CAPY_LOCAL_KEY_BACKEND === 'keychain';
}
