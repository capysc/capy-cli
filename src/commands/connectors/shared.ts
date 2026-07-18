import { createHash } from 'crypto';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { AuthService } from '../../auth/authService';
import { ServiceClient } from '../../service/serviceClient';
import { SyncEngine } from '../../sync/syncEngine';
import { Encryptor } from '../../crypto/encryptor';
import { deriveResourceId } from '../../crypto/resourceId';
import { writeKeepCache } from '../../config/globalConfig';
import { setSyncKeepHash, KeepFile, ConnectorMetadata } from '../../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface ResolvedContext {
  pm: ProjectManager;
  fileManager: FileManager;
  authService: AuthService;
  serviceClient: ServiceClient;
  orgId: string;
  projectId: string;
  branch: string;
  userId: string;
  projectKey: string;
  keep: KeepFile;
  localPlaintext: Record<string, string>;
}

/**
 * Run the standard "I'm an interactive command that needs to encrypt + push"
 * setup. Mirrors the front half of editCommand.ts. Exits the process on
 * unrecoverable errors (no keep.lock, auth fail, key resolution fail).
 */
export async function resolveContext(opts: { apiUrl?: string; devMode?: boolean } = {}): Promise<ResolvedContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
    console.error(`No keep.lock found. Run ${B('capy')} to initialize.`);
    process.exit(1);
  }
  const orgId = projectState.organizationId;
  const projectId = projectState.projectId;
  const branch = projectState.activeBranch;
  if (!branch) {
    console.error(`No active branch. Run ${B('capy')} to select a branch.`);
    process.exit(1);
  }

  const keep = pm.readKeepFile();
  if (!keep) {
    console.error('Could not read keep.lock');
    process.exit(1);
  }

  const fileManager = new FileManager();
  const devMode = opts.devMode ?? false;
  const authService = new AuthService(opts.apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(opts.apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  let authResult = await authService.authenticateSilent(orgId);
  if (!authResult.success) authResult = await authService.authenticateSilent();
  if (!authResult.success) authResult = await authService.authenticate(orgId);
  if (!authResult.success || !authResult.user_id) {
    console.error('Authentication failed');
    process.exit(1);
  }

  const { resolveProjectKey } = await import('../../crypto/keyResolver');
  let projectKey: string;
  try {
    projectKey = await resolveProjectKey(orgId, projectId, authResult.user_id, {
      coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    });
  } catch (err: any) {
    const { displayErrorAndExit } = await import('../../ui/errorScreen');
    displayErrorAndExit(err, {
      projectName: keep.project_name,
      projectId: keep.project_id,
      branch,
    });
    throw err;
  }

  const localPlaintext: Record<string, string> = {};
  const rawLocal = fileManager.readEnvFile();
  for (const [k, v] of Object.entries(rawLocal)) {
    if (v.startsWith('capy:')) {
      try {
        localPlaintext[k] = fileManager.decryptValue(v, projectKey);
      } catch {
        // skip undecryptable
      }
    } else {
      localPlaintext[k] = v;
    }
  }

  return {
    pm,
    fileManager,
    authService,
    serviceClient,
    orgId,
    projectId,
    branch,
    userId: authResult.user_id,
    projectKey,
    keep,
    localPlaintext,
  };
}

/**
 * Set `varName=value` in `.env`, encrypt + push to Keep, and update
 * keep.lock + sync state. Mirrors the editCommand `saveLocalEdits` flow.
 *
 * If `connector` is provided, the metadata is attached to the keep.lock entry
 * for `varName` on the active branch. Survives future syncs because
 * `mergeWithKeep` preserves extra fields on existing entries.
 *
 * If `push` is false, writes the encrypted snippet locally only — the next
 * `capy push` / `capy` will pick it up. Local-only mode skips the merge so
 * the connector field doesn't get attached until a real push.
 */
export async function writeAndSync(
  ctx: ResolvedContext,
  varName: string,
  value: string,
  opts: { push: boolean; connector?: ConnectorMetadata },
): Promise<void> {
  const { pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey, keep, localPlaintext } = ctx;

  const finalEnv: Record<string, string> = { ...localPlaintext, [varName]: value };

  if (!opts.push) {
    // Local-only path. Even though we're not hitting the service, we still
    // need to attach the connector marker to keep.lock so a follow-up `capy
    // push` (which will round-trip through mergeWithKeep) preserves it.
    if (opts.connector) {
      const merged = attachConnector(keep, varName, branch, opts.connector);
      fileManager.writeKeepFile(merged);
      fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, merged, branch);
    } else {
      fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, keep, branch);
    }
    return;
  }

  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(finalEnv)) {
    const resourceId = deriveResourceId(branch, k);
    encrypted[k] = `capy:${resourceId}:${Encryptor.encrypt(v, projectKey)}`;
  }
  const envBlob = Object.entries(encrypted)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
  for (const [k, v] of Object.entries(finalEnv)) {
    pushedVars[k] = {
      resource_id: deriveResourceId(branch, k),
      value_hash: createHash('sha256').update(v).digest('hex').slice(0, 16),
    };
  }

  const syncEngine = new SyncEngine();
  let finalKeep = syncEngine.mergeWithKeep(keep, pushedVars, branch);

  for (const name of Object.keys(finalKeep.variables)) {
    if (!(name in finalEnv)) {
      const entries = finalKeep.variables[name].filter((e) => e.branch !== branch);
      if (entries.length > 0) finalKeep.variables[name] = entries;
      else delete finalKeep.variables[name];
    }
  }

  if (opts.connector) {
    finalKeep = attachConnector(finalKeep, varName, branch, opts.connector);
  }

  const result = await serviceClient.pushSecrets(projectId, JSON.stringify(finalKeep), envBlob, branch);

  writeKeepCache(orgId, projectId, result.keep_hash, envBlob);
  // Prefer the server's copy — it carries server-assigned changed_at
  fileManager.writeKeepFile(SyncEngine.adoptServerKeep(result.keep_file, finalKeep, branch));
  fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

  const existingSyncState = pm.readSyncState();
  fileManager.writeSyncState({
    ...existingSyncState,
    last_sync: new Date().toISOString(),
    synced_variables: Object.keys(finalEnv),
    user_id: userId,
    keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
  });

  // The new pin reaches teammates only through git.
  const { autoCommitKeep } = await import('../../git/autoCommitKeep');
  autoCommitKeep(branch);
}

/** Return a deep-cloned KeepFile with `connector` set on the (varName, branch) entry. */
export function attachConnector(
  keep: KeepFile,
  varName: string,
  branch: string,
  connector: ConnectorMetadata,
): KeepFile {
  const next: KeepFile = { ...keep, variables: { ...keep.variables } };
  const existing = next.variables[varName] ? next.variables[varName].map((e) => ({ ...e })) : [];
  const idx = existing.findIndex((e) => e.branch === branch);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], connector };
  } else {
    // No entry on this branch yet (writeAndSync hasn't pushed). Defer to the
    // next merge — but seed an entry so subsequent reads see the connector.
    existing.push({ resource_id: '', branch, value_hash: '', connector });
  }
  next.variables[varName] = existing;
  return next;
}

/**
 * Look up the connector metadata for (varName, branch). Returns undefined if
 * the var isn't tracked or has no connector field on that branch.
 */
export function findManagedConnector(
  keep: KeepFile,
  varName: string,
  branch: string,
): ConnectorMetadata | undefined {
  const entries = keep.variables[varName];
  if (!entries) return undefined;
  return entries.find((e) => e.branch === branch)?.connector;
}

/** All variables on `branch` that have a connector field set. */
export function listManagedKeys(
  keep: KeepFile,
  branch: string,
): Array<{ varName: string; connector: ConnectorMetadata }> {
  const out: Array<{ varName: string; connector: ConnectorMetadata }> = [];
  for (const [varName, entries] of Object.entries(keep.variables)) {
    const entry = entries.find((e) => e.branch === branch);
    if (entry?.connector) out.push({ varName, connector: entry.connector });
  }
  return out;
}

/** All variables with an entry on `branch`, sorted. Both managed and unmanaged. */
export function listAllVarsOnBranch(keep: KeepFile, branch: string): string[] {
  const out: string[] = [];
  for (const [varName, entries] of Object.entries(keep.variables)) {
    if (entries.some((e) => e.branch === branch)) out.push(varName);
  }
  return out.sort();
}

/** `abc…xyz`-style snippet of a credential value; never plaintext. */
export function fingerprint(value: string): string {
  if (value.length <= 7) return value;
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

export interface ExpiringKey {
  varName: string;
  provider: string;
  expiresIn: number; // days, can be negative if already expired
  connector: ConnectorMetadata;
}

/**
 * Walk keep.lock for managed keys on the active branch whose `expires_at`
 * is within `windowDays`. Silent on any failure (missing/corrupt keep.lock,
 * read errors, etc.) so this never blocks a primary command at its tail.
 */
export function checkExpiringKeys(windowDays: number = 7): ExpiringKey[] {
  try {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    if (!keep) return [];
    const branch = pm.deriveActiveBranch();
    if (!branch) return [];
    const managed = listManagedKeys(keep, branch);
    const now = Date.now() / 1000;
    const windowSec = windowDays * 86400;
    const expiring: ExpiringKey[] = [];
    for (const { varName, connector } of managed) {
      if (typeof connector.expires_at !== 'number') continue;
      const remainingSec = connector.expires_at - now;
      if (remainingSec > windowSec) continue;
      expiring.push({
        varName,
        provider: connector.provider,
        expiresIn: Math.floor(remainingSec / 86400),
        connector,
      });
    }
    return expiring;
  } catch {
    return [];
  }
}

/** Print expiry warnings to stderr. Safe to call from any command's tail. */
export function printExpiryWarnings(): void {
  const expiring = checkExpiringKeys();
  if (expiring.length === 0) return;
  for (const k of expiring) {
    const when = k.expiresIn < 0
      ? `expired ${-k.expiresIn} day(s) ago`
      : k.expiresIn === 0
        ? 'expires today'
        : `expires in ${k.expiresIn} day(s)`;
    console.error(
      `\x1b[33m⚠\x1b[0m ${B(k.varName)} ${when}. Run ${B(`capy rotate ${k.varName}`)} to refresh.`,
    );
  }
}
