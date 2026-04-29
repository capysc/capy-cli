import { createHash } from 'crypto';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { fetchSecretsWithCache, writeKeepCache } from '../config/globalConfig';
import { hashValue } from './statusCommand';
import { EditScreen, EditRow, EditState } from '../ui/editScreen';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { setSyncKeepHash } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

type RowStatus = EditRow['status'];

function classifyStatus(
  pinned: string | undefined,
  local: string | undefined,
  remote: string | undefined,
  remoteAvailable: boolean,
): RowStatus {
  if (!remoteAvailable) return 'unknown';
  if (pinned === local && pinned === remote) return 'in sync';
  const localDiffers = local !== pinned;
  const remoteDiffers = remote !== pinned;
  if (localDiffers && remoteDiffers && local !== remote) return 'conflict';
  if (localDiffers) return 'local';
  if (remoteDiffers) return 'remote';
  return 'in sync';
}

export class EditCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
      console.error(`No keep.lock found. Run ${B('capy')} to initialize.`);
      process.exit(1);
    }
    const orgId = projectState.organizationId;
    const projectId = projectState.projectId;

    const keep = pm.readKeepFile();
    if (!keep) {
      console.error('Could not read keep.lock');
      process.exit(1);
    }

    const branch = projectState.activeBranch;
    const fileManager = new FileManager();

    // Pinned hashes for the active branch
    const pinned: Record<string, string> = {};
    for (const [varName, entries] of Object.entries(keep.variables)) {
      const entry = entries.find((e) => e.branch === branch);
      if (entry) pinned[varName] = entry.value_hash;
    }

    // Auth — silent first, then interactive (mirrors usersCommand pattern)
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    let authResult = await authService.authenticateSilent(orgId);
    if (!authResult.success) authResult = await authService.authenticateSilent();
    if (!authResult.success) authResult = await authService.authenticate(orgId);
    if (!authResult.success || !authResult.user_id) {
      console.error('Authentication failed');
      process.exit(1);
    }

    let projectKey: string;
    let remoteAvailable = false;
    try {
      const { resolveProjectKey } = await import('../crypto/keyResolver');
      const keyOps = {
        coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
      };
      projectKey = await resolveProjectKey(
        orgId,
        projectId,
        authResult.user_id,
        keyOps,
      );
    } catch (err: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(err, {
        projectName: keep.project_name,
        projectId: keep.project_id,
        branch,
      });
      return;
    }

    // Decrypt local .env values
    const localPlaintext: Record<string, string> = {};
    const rawLocal = fileManager.readEnvFile();
    for (const [key, value] of Object.entries(rawLocal)) {
      if (value.startsWith('capy:')) {
        try {
          localPlaintext[key] = fileManager.decryptValue(value, projectKey);
        } catch {
          // Skip values we can't decrypt
        }
      } else {
        localPlaintext[key] = value;
      }
    }

    // Fetch and decrypt remote
    const remotePlaintext: Record<string, string> = {};
    try {
      const keepHash = SyncEngine.computeKeepHash(keep, branch);
      const blob = await fetchSecretsWithCache(
        serviceClient,
        orgId,
        projectId,
        keepHash,
      );
      if (blob?.env_file) {
        const encrypted = fileManager.parseEnvContent(blob.env_file);
        for (const [key, value] of Object.entries(encrypted)) {
          try {
            remotePlaintext[key] = fileManager.decryptValue(value, projectKey);
          } catch {
            // Skip values we can't decrypt
          }
        }
        remoteAvailable = true;
      }
    } catch {
      // Remote fetch failed — TUI runs in local-only mode for the remote column
    }

    // Build rows for every variable known to any source
    const allKeys = new Set<string>([
      ...Object.keys(pinned),
      ...Object.keys(localPlaintext),
      ...Object.keys(remotePlaintext),
    ]);

    const rows: EditRow[] = [];
    for (const key of Array.from(allKeys).sort()) {
      const localVal = localPlaintext[key];
      const remoteVal = remotePlaintext[key];
      const pinnedHash = pinned[key];
      const localHash = localVal !== undefined ? hashValue(localVal) : undefined;
      const remoteHash = remoteVal !== undefined ? hashValue(remoteVal) : undefined;
      const status = classifyStatus(pinnedHash, localHash, remoteHash, remoteAvailable);

      let updatedLabel: string;
      if (!remoteAvailable) updatedLabel = '—';
      else if (status === 'in sync') updatedLabel = 'in sync';
      else if (status === 'local') updatedLabel = 'local';
      else if (status === 'remote') updatedLabel = 'remote';
      else if (status === 'conflict') updatedLabel = 'needs review';
      else updatedLabel = '—';

      rows.push({
        key,
        localValue: localVal,
        remoteValue: remoteVal,
        status,
        updatedLabel,
      });
    }

    const state: EditState = {
      projectName: keep.project_name,
      branch,
      rows,
      remoteAvailable,
    };

    const screen = new EditScreen();
    await screen.run(state, {
      saveLocalEdits: async (edits: Record<string, string>) => {
        // Same flow as the conflict-resolution "commit local" action and
        // PushCommand: encrypt the merged local state, mergeWithKeep, push
        // to the server, then cache + write keep.lock + .env + sync state.
        const finalEnv: Record<string, string> = { ...localPlaintext, ...edits };

        const encrypted: Record<string, string> = {};
        for (const [key, value] of Object.entries(finalEnv)) {
          const resourceId = deriveResourceId(branch, key);
          const enc = Encryptor.encrypt(value, projectKey);
          encrypted[key] = `capy:${resourceId}:${enc}`;
        }
        const envBlob = Object.entries(encrypted)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');

        const pushedVars: Record<string, { resource_id: string; value_hash: string }> = {};
        for (const [key, value] of Object.entries(finalEnv)) {
          pushedVars[key] = {
            resource_id: deriveResourceId(branch, key),
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          };
        }

        const syncEngine = new SyncEngine();
        const finalKeep = syncEngine.mergeWithKeep(keep, pushedVars, branch);

        // Drop branch entries for variables no longer in finalEnv.
        for (const varName of Object.keys(finalKeep.variables)) {
          if (!(varName in finalEnv)) {
            const entries = finalKeep.variables[varName].filter((e) => e.branch !== branch);
            if (entries.length > 0) finalKeep.variables[varName] = entries;
            else delete finalKeep.variables[varName];
          }
        }

        const result = await serviceClient.pushSecrets(
          projectId,
          JSON.stringify(finalKeep),
          envBlob,
          branch,
        );

        writeKeepCache(orgId, projectId, result.keep_hash, envBlob);
        fileManager.writeKeepFile(finalKeep);
        fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

        const existingSyncState = pm.readSyncState();
        fileManager.writeSyncState({
          ...existingSyncState,
          last_sync: new Date().toISOString(),
          synced_variables: Object.keys(finalEnv),
          user_id: authResult.user_id,
          keep_hash: setSyncKeepHash(existingSyncState, branch, SyncEngine.computeKeepHash(finalKeep, branch)),
        });
      },
    });
  }
}
