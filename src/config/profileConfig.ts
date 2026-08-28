/**
 * CLI profiles — persistent named configurations stored at ~/.capy/config.json.
 *
 * A profile pairs a server URL with optional TLS trust material (CA bundle
 * path) and a display name. Operators switch between profiles to talk to
 * different Capy instances (cloud + one or more BYOC tenants) without
 * juggling env vars.
 *
 * Resolution precedence at every CLI invocation:
 *   1. explicit apiUrl arg to ServiceClient        (call-site override)
 *   2. CAPY_API_URL env var                        (dev/staging builds only)
 *   3. CAPY_PROFILE env var                        (dev/staging builds only)
 *   4. config.default profile                      (what `capy use` writes)
 *   5. built-in default (https://api.capy.sc)      (no config = cloud user)
 *
 * Steps 2 and 3 are unreachable in the production binary: its entrypoint
 * deletes both variables before this module can read them (config/prodPins.ts),
 * so prod resolves profile-then-default and nothing in the ambient environment
 * can retarget it. The env steps remain live for `capy-dev` and `capy-staging`,
 * which is where retargeting now belongs. Profiles are unaffected either way —
 * `capy byoc` and `capy use` are still how a BYOC operator points prod at their
 * own instance.
 *
 * v1 NOTE: every profile shares the existing ~/.capy/ session/cache/key
 * layout. Per-profile state subdirectories (~/.capy/profiles/<name>/...)
 * are a follow-up — see docs/cli-profiles-spec.md. The cardinal logout
 * rule (never wipe recovery-equivalent wrapped keys) still holds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { getGlobalCapyDir, getGlobalConfigPath } from './globalConfig';

export interface Profile {
  /** Base URL of the Capy service for this profile, no trailing slash. */
  url: string;
  /** Optional absolute path to a CA bundle. Set for BYOC instances with self-signed TLS. */
  caBundle?: string;
  /** Optional human-friendly name surfaced in `capy profile list`. */
  displayName?: string;
  /**
   * Local-only mode: fully offline, passphrase-protected local key, no
   * identity provider and no server calls. When true the profile carries no
   * live server dependency for crypto/auth — secrets are stored only on this
   * machine.
   */
  localOnly?: boolean;
  /**
   * Idle auto-lock timeout (ms) for the local-only session. After this much
   * inactivity the cached key is treated as locked and the passphrase is
   * re-prompted on next use. Only meaningful when localOnly is true.
   * Defaults to LOCAL_LOCK_TIMEOUT_DEFAULT_MS (1 hour).
   */
  localLockTimeoutMs?: number;
}

/** Default idle auto-lock timeout for local-only mode: 1 hour. */
export const LOCAL_LOCK_TIMEOUT_DEFAULT_MS = 60 * 60 * 1000;

export interface ProfileConfig {
  /** Name of the active profile. Must be a key of `profiles`. */
  default: string;
  profiles: Record<string, Profile>;
}

/** Profile name returned when no profile config exists (fresh cloud user). */
export const IMPLICIT_CLOUD_PROFILE = 'cloud';

/** Built-in cloud URL — matches the historical ServiceClient default. */
export const DEFAULT_CLOUD_URL = 'https://api.capy.sc';

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

function writeSecureFile(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, { mode: 0o600 });
}

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read ~/.capy/config.json. Returns null when absent (existing cloud users
 * who've never run `capy byoc` or `capy use`). Returns null on malformed
 * JSON too — a corrupt config falls back to default behavior rather than
 * blowing up every command.
 */
export function readProfileConfig(): ProfileConfig | null {
  const content = readFileOrNull(getGlobalConfigPath());
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof data.default === 'string' &&
      typeof data.profiles === 'object' &&
      data.profiles !== null
    ) {
      return data as ProfileConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeProfileConfig(config: ProfileConfig): void {
  writeSecureFile(getGlobalConfigPath(), JSON.stringify(config, null, 2));
}

/**
 * Resolve which profile to use for this invocation.
 *
 * Returns:
 *   - the named profile from config when CAPY_PROFILE is set or config.default points at it
 *   - null when no config exists at all (caller falls back to built-in cloud default)
 *
 * Throws if CAPY_PROFILE names a profile that doesn't exist — better to fail
 * loudly than silently fall through to cloud and confuse the operator.
 */
export function getActiveProfile(): { name: string; profile: Profile } | null {
  const config = readProfileConfig();
  const envName = process.env.CAPY_PROFILE;

  if (envName) {
    if (!config || !config.profiles[envName]) {
      throw new Error(
        `CAPY_PROFILE="${envName}" but no such profile exists. Run \`capy profile list\` to see configured profiles.`,
      );
    }
    return { name: envName, profile: config.profiles[envName] };
  }

  if (!config) return null;
  const name = config.default;
  const profile = config.profiles[name];
  if (!profile) {
    // Config is corrupt (default points at a missing profile). Fall back to
    // built-in cloud default rather than crash.
    return null;
  }
  return { name, profile };
}

/**
 * True when the active profile is local-only (fully offline, passphrase
 * key). This is the single gate every command consults to decide whether to
 * skip auth/server calls and route crypto through the local keystore.
 *
 * Never throws — a corrupt config or a missing CAPY_PROFILE resolves to
 * false (i.e. normal server-backed behavior) rather than blowing up.
 */
export function isLocalOnly(): boolean {
  try {
    const active = getActiveProfile();
    return active?.profile.localOnly === true;
  } catch {
    return false;
  }
}

/**
 * Idle auto-lock timeout (ms) for the active local-only profile, falling back
 * to the 1-hour default when unset. Returns the default for non-local-only or
 * absent profiles too (harmless — only the local session reads it).
 */
export function getLocalLockTimeoutMs(): number {
  try {
    const active = getActiveProfile();
    const v = active?.profile.localLockTimeoutMs;
    return typeof v === 'number' && v > 0 ? v : LOCAL_LOCK_TIMEOUT_DEFAULT_MS;
  } catch {
    return LOCAL_LOCK_TIMEOUT_DEFAULT_MS;
  }
}

/**
 * Resolve the URL the CLI should hit for this invocation, applying the full
 * precedence chain. ServiceClient (and any other ad-hoc fetcher) calls this
 * when constructed without an explicit apiUrl.
 */
export function resolveActiveUrl(devMode: boolean = false): string {
  // CAPY_API_URL is the highest-precedence override — CI/scripts must keep
  // working regardless of saved profiles.
  if (process.env.CAPY_API_URL) {
    return process.env.CAPY_API_URL;
  }

  const active = getActiveProfile();
  if (active) return active.profile.url;

  // No profile, no env override — built-in default. Dev mode keeps its
  // historical localhost behavior to match the legacy ServiceClient.
  return devMode ? 'http://localhost:3000' : DEFAULT_CLOUD_URL;
}

/**
 * Resolve the CA bundle path for this invocation, if any. Used by the CLI
 * startup to install a fetch dispatcher that trusts self-signed BYOC certs.
 * Returns null when no active profile has a caBundle set.
 */
export function resolveActiveCaBundle(): string | null {
  // CAPY_API_URL override implies no profile, hence no CA bundle from config.
  // Operators using CAPY_API_URL against a self-signed BYOC must set
  // NODE_EXTRA_CA_CERTS themselves.
  if (process.env.CAPY_API_URL) return null;
  const active = getActiveProfile();
  if (!active) return null;
  return active.profile.caBundle ? expandHome(active.profile.caBundle) : null;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Upsert a profile and set it as active in one shot. This is what `capy byoc`
 * calls after a successful probe — there's no use case for "save but don't
 * switch" today.
 */
export function saveAndActivateProfile(name: string, profile: Profile): void {
  const existing = readProfileConfig();
  const config: ProfileConfig = existing
    ? { ...existing, profiles: { ...existing.profiles, [name]: profile }, default: name }
    : { default: name, profiles: { [name]: profile } };
  writeProfileConfig(config);
}

export function setActiveProfile(name: string): void {
  const config = readProfileConfig();
  if (!config) {
    throw new Error(`No profiles configured. Run \`capy byoc\` to create one.`);
  }
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist. Run \`capy profile list\` to see configured profiles.`);
  }
  config.default = name;
  writeProfileConfig(config);
}

export function removeProfile(name: string): void {
  const config = readProfileConfig();
  if (!config || !config.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  if (config.default === name) {
    throw new Error(
      `Cannot remove the active profile "${name}". Switch first with \`capy use <other>\`.`,
    );
  }
  delete config.profiles[name];
  writeProfileConfig(config);
}

export function listProfiles(): Array<{ name: string; profile: Profile; active: boolean }> {
  const config = readProfileConfig();
  if (!config) return [];
  const activeName = config.default;
  return Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    profile,
    active: name === activeName,
  }));
}

/**
 * Derive a default profile name from a URL's hostname. Strips well-known
 * suffixes so `https://capy.acme.com/` → `acme`, `https://capy.internal` →
 * `internal`. The byoc command lets the operator override at the prompt.
 */
export function deriveProfileName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'byoc';
  }
  // capy.<something> → <something>; otherwise the leftmost label.
  const labels = host.split('.');
  if (labels[0] === 'capy' && labels.length > 1) {
    labels.shift();
  }
  return labels[0] || 'byoc';
}
