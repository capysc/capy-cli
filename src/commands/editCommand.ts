import { createHash } from 'crypto';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { fetchSecretsWithCache, readKeepCache, writeKeepCache, readSecretsLocal, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { hashValue } from './statusCommand';
import { EditScreen, EditRow, EditState, classifyLocalRow } from '../ui/editScreen';
import { formatRelativeTime } from '../ui/relativeTime';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { setSyncKeepHash, KeepFile } from '../types/index';
import { EditSaveRecord } from '../deploy/keepGate';
import { concludeEditSession } from './editExitFlow';
import { withAuthNeedsTtyExit } from '../auth/authGate';

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

export interface EditOpts {
  /**
   * Render the variable table and the value editor as compiled screens in a
   * local browser instead of the alternate-screen TUI.
   *
   * Agent-only, and the reason it exists: the TUI has no TTY guard. Run it
   * headlessly and it writes an entire ANSI screen into the agent's captured
   * stdout and then blocks forever on a stdin that never delivers a key.
   */
  web?: boolean;
  /** false when --no-open was passed: print the URL, do not open a browser. */
  open?: boolean;
}

export class EditCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(opts: EditOpts = {}): Promise<void> {
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
    if (!branch) {
      console.error(`No active branch. Run ${B('capy')} to select a branch.`);
      process.exit(1);
    }
    const fileManager = new FileManager();

    // Pinned hashes for the active branch
    const pinned: Record<string, string> = {};
    for (const [varName, entries] of Object.entries(keep.variables)) {
      const entry = entries.find((e) => e.branch === branch);
      if (entry) pinned[varName] = entry.value_hash;
    }

    // Local-only mode: no auth, no server. Identity is synthetic; the key is
    // unwrapped from the passphrase session. No AuthService/ServiceClient is
    // constructed (avoids the dev-mode "[dev] AuthService → …" log and any
    // accidental server use).
    const localMode = isLocalOnly();

    let authService: AuthService | undefined;
    let serviceClient: ServiceClient | undefined;
    let userId: string;
    if (localMode) {
      userId = LOCAL_USER_ID;
    } else {
      // Auth — silent first, then interactive (mirrors usersCommand pattern)
      authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider(() => authService!.getValidToken());
      let authResult = await authService.authenticateSilent(orgId);
      if (!authResult.success) authResult = await authService.authenticateSilent();
      if (!authResult.success) {
        // `edit` has no --json (it's a TUI) — always a stderr refusal.
        authResult = await withAuthNeedsTtyExit(() => authService!.authenticate(orgId), false);
      }
      if (!authResult.success || !authResult.user_id) {
        console.error('Authentication failed');
        process.exit(1);
      }
      userId = authResult.user_id;
    }

    let projectKey: string;
    try {
      if (localMode) {
        projectKey = await resolveLocalProjectKey(projectId);
      } else {
        const { resolveProjectKey } = await import('../crypto/keyResolver');
        const keyOps = {
          coDecrypt: (oid: string, ct: string) => serviceClient!.coDecrypt(oid, ct).then((r) => r.plaintext),
          wrapOuterLayer: (oid: string, pt: string) => serviceClient!.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
        };
        projectKey = await resolveProjectKey(
          orgId,
          projectId,
          userId,
          keyOps,
        );
      }
    } catch (err: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(err, {
        projectName: keep.project_name,
        projectId: keep.project_id,
        branch,
      });
      return;
    }

    // Decrypt local .env values
    const localPlaintext: Record<string, string> = {};
    // Local ciphertext this profile does not hold the key for. The TUI drops
    // these on the floor and says nothing, and the next commit then deletes
    // their pins — so the browser table names them.
    const undecryptableKeys: string[] = [];
    const rawLocal = fileManager.readEnvFile();
    for (const [key, value] of Object.entries(rawLocal)) {
      if (value.startsWith('capy:')) {
        try {
          localPlaintext[key] = fileManager.decryptValue(value, projectKey);
        } catch {
          // Skip values we can't decrypt
          undecryptableKeys.push(key);
        }
      } else {
        localPlaintext[key] = value;
      }
    }

    // Baseline the working copy is compared against:
    //  - remote mode: the latest committed blob fetched from the server.
    //  - local mode:  the committed blob from the local keep cache (no server).
    // In both cases it lands in `remotePlaintext` so the TUI's reclassify can
    // compare working-vs-baseline.
    const remotePlaintext: Record<string, string> = {};
    let remoteAvailable = false;
    // Why there is no other copy to compare against, when there is none. The
    // terminal renders all three the same way — `{n} ? / remote unavailable` —
    // so an offline run, a project nobody has pushed and a cold local cache are
    // indistinguishable. Minted here, where the condition is actually known.
    let remoteGap: 'never_pushed' | 'fetch_failed' | 'local_mode' | undefined;
    // Whether the comparison ran against the on-disk cache rather than the
    // service. A warm cache computes the whole status column while offline with
    // nothing on screen to say so.
    let remoteFromCache = false;
    {
      const keepHash = SyncEngine.computeKeepHash(keep, branch);
      try {
        if (!localMode) remoteFromCache = readKeepCache(orgId, projectId, keepHash) !== null;
        const blob = localMode
          ? readSecretsLocal(orgId, projectId, keepHash)
          : await fetchSecretsWithCache(serviceClient!, orgId, projectId, keepHash);
        if (blob?.env_file) {
          const encrypted = fileManager.parseEnvContent(blob.env_file);
          for (const [key, value] of Object.entries(encrypted)) {
            try {
              remotePlaintext[key] = fileManager.decryptValue(value, projectKey);
            } catch {
              // Skip values we can't decrypt
            }
          }
          // Remote column only applies to server mode; local mode uses the
          // committed baseline with local-mode wording instead.
          if (!localMode) remoteAvailable = true;
        } else {
          remoteGap = localMode ? 'local_mode' : 'never_pushed';
        }
      } catch {
        // Remote fetch failed (server mode) — fall back to pinned-only.
        remoteGap = localMode ? 'local_mode' : 'fetch_failed';
      }
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

      let status: EditRow['status'];
      let updatedLabel: string;
      // Server-assigned changed_at for this branch — drives the UPDATED
      // column's recency label ("5 hours ago"). Absent in local mode and for
      // entries that predate rotation tracking.
      const changedAt = keep.variables[key]?.find((e) => e.branch === branch)?.changed_at;
      if (localMode) {
        // committed-vs-working, via the shared classifier so the initial build
        // and the in-TUI reclassify can't drift. `remoteVal` holds the
        // committed value from the local keep cache.
        ({ status, updatedLabel } = classifyLocalRow(localVal, remoteVal));
      } else {
        status = classifyStatus(pinnedHash, localHash, remoteHash, remoteAvailable);
        updatedLabel = changedAt ? formatRelativeTime(changedAt) : '—';
      }

      rows.push({
        key,
        localValue: localVal,
        remoteValue: remoteVal,
        status,
        updatedLabel,
        changedAt,
      });
    }

    const state: EditState = {
      projectName: keep.project_name,
      branch,
      rows,
      remoteAvailable,
      localMode,
    };

    const screen = new EditScreen();
    const printExpiryAfter = async () => {
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    };
    // Immutable, append-only log of what happened this session, used only to
    // build the exit-time PR (editExitFlow.ts) — never to decide what gets
    // written to disk during the session itself.
    //
    // The screen API's `saveLocalEdits` callback (below) is called once per
    // save and returns only that save's changed_at map — it has no channel
    // back into this function's scope to thread accumulated state through
    // return values across repeated calls. That forces exactly one mutable
    // cell, confined to this single object and touched nowhere else:
    // `sessionSaves.current` is reassigned to a brand-new (readonly) array on
    // every save, never mutated in place. Everything the array holds, and
    // everything built from it afterwards, is immutable.
    const sessionSaves: { current: readonly EditSaveRecord[] } = { current: [] };

    const editContext = {
      saveLocalEdits: async (edits: Record<string, string>) => {
        // Same flow as the conflict-resolution "commit local" action and
        // PushCommand: encrypt the merged local state, mergeWithKeep, push
        // to the server, then cache + write keep.lock + .env + sync state.
        const finalEnv: Record<string, string> = { ...localPlaintext, ...edits };

        const encrypted = Object.fromEntries(
          Object.entries(finalEnv).map(([key, value]) => {
            const resourceId = deriveResourceId(branch, key);
            const enc = Encryptor.encrypt(value, projectKey);
            return [key, `capy:${resourceId}:${enc}`];
          }),
        );
        const envBlob = Object.entries(encrypted)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');

        const pushedVars = Object.fromEntries(
          Object.entries(finalEnv).map(([key, value]) => [
            key,
            {
              resource_id: deriveResourceId(branch, key),
              value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
            },
          ]),
        );

        const syncEngine = new SyncEngine();
        const mergedKeep = syncEngine.mergeWithKeep(keep, pushedVars, branch);

        // Drop branch entries for variables no longer in finalEnv — built as
        // a new object rather than mutated in place (was a `for` loop doing
        // `finalKeep.variables[varName] = entries` / `delete
        // finalKeep.variables[varName]` on the value mergeWithKeep returned).
        const finalKeep: KeepFile = {
          ...mergedKeep,
          variables: Object.fromEntries(
            Object.entries(mergedKeep.variables).flatMap(([varName, entries]) => {
              if (varName in finalEnv) return [[varName, entries]];
              const kept = entries.filter((e) => e.branch !== branch);
              return kept.length > 0 ? [[varName, kept]] : [];
            }),
          ),
        };

        // keep_hash is computed locally; the server returns the same value on
        // push. In local-only mode there is no push — the local writes below
        // ARE the commit.
        const localKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
        const pushResult = localMode
          ? null
          : await serviceClient!.pushSecrets(
              projectId,
              JSON.stringify(finalKeep),
              envBlob,
              branch,
            );
        const keepHashForCache = pushResult ? pushResult.keep_hash : localKeepHash;

        writeKeepCache(orgId, projectId, keepHashForCache, envBlob);
        // Prefer the server's copy — it carries server-assigned changed_at
        const adoptedKeep = SyncEngine.adoptServerKeep(pushResult?.keep_file, finalKeep, branch);
        fileManager.writeKeepFile(adoptedKeep);
        fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

        const existingSyncState = pm.readSyncState();
        fileManager.writeSyncState({
          ...existingSyncState,
          last_sync: new Date().toISOString(),
          synced_variables: Object.keys(finalEnv),
          user_id: userId,
          keep_hash: setSyncKeepHash(existingSyncState, branch, localKeepHash),
        });

        // Record this save for the exit-time PR: the resulting (or deleted)
        // entry, for THIS branch only, of every variable this save touched.
        const touchedEntries = Object.keys(edits).map((variable) => ({
          variable,
          entry: adoptedKeep.variables[variable]?.find((e) => e.branch === branch) ?? null,
        }));
        sessionSaves.current = [...sessionSaves.current, { branch, entries: touchedEntries }];

        // Hand the server-assigned changed_at back to the TUI so the UPDATED
        // column reflects the authoritative stamp for this commit, not a
        // client-side guess.
        const changedAtByKey = Object.fromEntries(
          Object.entries(adoptedKeep.variables)
            .map(([varName, entries]) => [varName, entries.find((e) => e.branch === branch)?.changed_at] as const)
            .filter((pair): pair is [string, string] => pair[1] !== undefined),
        );
        return changedAtByKey;
      },
    };

    // `--web` changes only where the questions are ASKED. The commit callback
    // above is the same object either way, so the crypto, the push, and the
    // keep rewrite are one code path with one browser-shaped front end and
    // one terminal-shaped one.
    if (opts.web) {
      const { runSecretEditorInBrowser } = await import('../ui/secretTableScreen');
      await runSecretEditorInBrowser(
        {
          projectName: keep.project_name,
          branch,
          mode: localMode ? 'local' : 'server',
          rows,
          remoteAvailable,
          remoteGap,
          remoteFromCache,
          undecryptableKeys,
          // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
          // headless runs drive the loopback without hijacking a real browser.
          open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN,
        },
        editContext,
      );
    } else {
      await screen.run(state, editContext);
    }
    // Same exit behavior in both modes: asked in the terminal, even after a
    // --web session's browser tab has closed. See editExitFlow.ts.
    await concludeEditSession(process.cwd(), sessionSaves.current, keep);
    await printExpiryAfter();
  }
}
