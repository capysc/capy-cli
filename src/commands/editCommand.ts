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
import { EditScreen, EditRow, EditState, classifyLocalRow, focusedOn } from '../ui/editScreen';
import { formatRelativeTime } from '../ui/relativeTime';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { setSyncKeepHash, KeepFile } from '../types/index';
import { reportKeepLockHuman, refuseBadPrFlags, runKeepLockPrStep, type PrFlags } from './keepLockPr';
import { startSaveLog } from './sessionSaveLog';
import { decideEditMode, editPipedCommand, refuseEditNeedsTty } from './editPiped';
import { refuseInvalidName } from './pipedValue';
import { isValidVarName } from './pipedWrite';

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

/**
 * Decrypts `.env`. A value this profile holds no key for is skipped (and named
 * in `undecryptableKeys`); plaintext values pass through.
 */
function decryptLocalEnv(
  fileManager: FileManager,
  projectKey: string,
): { localPlaintext: Record<string, string>; undecryptableKeys: string[] } {
  const decrypted = Object.entries(fileManager.readEnvFile()).map(([key, value]) => {
    if (!value.startsWith('capy:')) return { key, plain: value as string | undefined };
    try {
      return { key, plain: fileManager.decryptValue(value, projectKey) as string | undefined };
    } catch {
      return { key, plain: undefined }; // Skip values we can't decrypt
    }
  });
  return {
    localPlaintext: Object.fromEntries(
      decrypted.flatMap(({ key, plain }) => (plain === undefined ? [] : [[key, plain] as const])),
    ),
    undecryptableKeys: decrypted.filter(({ plain }) => plain === undefined).map(({ key }) => key),
  };
}

/**
 * Why there is no other copy to compare against, when there is none. The
 * terminal renders all three the same way — `{n} ? / remote unavailable` —
 * so an offline run, a project nobody has pushed and a cold local cache are
 * indistinguishable. Minted where the condition is actually known.
 */
type RemoteGap = 'never_pushed' | 'fetch_failed' | 'local_mode';

interface Baseline {
  remotePlaintext: Record<string, string>;
  remoteAvailable: boolean;
  remoteGap: RemoteGap | undefined;
  /**
   * Whether the comparison ran against the on-disk cache rather than the
   * service. A warm cache computes the whole status column while offline with
   * nothing on screen to say so.
   */
  remoteFromCache: boolean;
}

function baselineUnavailable(localMode: boolean, remoteFromCache: boolean): Baseline {
  // Remote fetch failed (server mode) — fall back to pinned-only.
  return {
    remotePlaintext: {},
    remoteAvailable: false,
    remoteGap: localMode ? 'local_mode' : 'fetch_failed',
    remoteFromCache,
  };
}

async function loadBaseline(args: {
  localMode: boolean;
  serviceClient: ServiceClient | undefined;
  fileManager: FileManager;
  projectKey: string;
  keep: KeepFile;
  branch: string;
  orgId: string;
  projectId: string;
}): Promise<Baseline> {
  const { localMode, serviceClient, fileManager, projectKey, keep, branch, orgId, projectId } = args;
  const keepHash = SyncEngine.computeKeepHash(keep, branch);
  const remoteFromCache = probeCache(localMode, orgId, projectId, keepHash);
  if (remoteFromCache === undefined) return baselineUnavailable(localMode, false);
  try {
    const blob = localMode
      ? readSecretsLocal(orgId, projectId, keepHash)
      : await fetchSecretsWithCache(serviceClient!, orgId, projectId, keepHash);
    if (!blob?.env_file) {
      return {
        remotePlaintext: {},
        remoteAvailable: false,
        remoteGap: localMode ? 'local_mode' : 'never_pushed',
        remoteFromCache,
      };
    }
    const encrypted = fileManager.parseEnvContent(blob.env_file);
    const remotePlaintext = Object.fromEntries(
      Object.entries(encrypted).flatMap(([key, value]) => {
        try {
          return [[key, fileManager.decryptValue(value, projectKey)] as const];
        } catch {
          return []; // Skip values we can't decrypt
        }
      }),
    );
    // Remote column only applies to server mode; local mode uses the
    // committed baseline with local-mode wording instead.
    return { remotePlaintext, remoteAvailable: !localMode, remoteGap: undefined, remoteFromCache };
  } catch {
    return baselineUnavailable(localMode, remoteFromCache);
  }
}

/** Whether the keep cache already holds this keep hash; `undefined` when the probe itself threw. */
function probeCache(localMode: boolean, orgId: string, projectId: string, keepHash: string): boolean | undefined {
  try {
    return localMode ? false : readKeepCache(orgId, projectId, keepHash) !== null;
  } catch {
    return undefined;
  }
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
  /**
   * The variable to work on (`capy edit NAME`). With a terminal: the TUI opens
   * with the cursor on it, and an unknown name opens its new-variable entry.
   * Without one: the value is read from stdin (piped mode).
   */
  name?: string;
  /** Piped mode: pure JSON on stdout. */
  json?: boolean;
  /** Piped mode: write `.env` only, do not push. */
  noPush?: boolean;
  /** Treat stdin as not a terminal even when it is one. */
  nonTty?: boolean;
  /** `--pr` / `--no-pr` / `--pr-base`: answers the keep.lock PR step. */
  pr?: PrFlags;
}

export class EditCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  /** Auth — silent first, then interactive (mirrors usersCommand pattern). Exits when it cannot. */
  private async authenticate(
    orgId: string,
    sessionUserId: string | undefined,
  ): Promise<{ serviceClient: ServiceClient; userId: string }> {
    const authService = new AuthService(this.apiUrl, this.devMode, sessionUserId);
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const forOrg = await authService.authenticateSilent(orgId);
    const silent = forOrg.success ? forOrg : await authService.authenticateSilent();
    const authResult = silent.success ? silent : await authService.authenticate(orgId);
    if (!authResult.success || !authResult.user_id) {
      console.error('Authentication failed');
      process.exit(1);
    }
    return { serviceClient, userId: authResult.user_id };
  }

  /** The project key, or `undefined` after the error screen was shown (the caller returns). */
  private async resolveKey(args: {
    localMode: boolean;
    orgId: string;
    projectId: string;
    userId: string;
    serviceClient: ServiceClient | undefined;
    keep: KeepFile;
    branch: string;
  }): Promise<string | undefined> {
    const { localMode, orgId, projectId, userId, serviceClient, keep, branch } = args;
    try {
      if (localMode) return await resolveLocalProjectKey(projectId);
      const { resolveProjectKey } = await import('../crypto/keyResolver');
      const keyOps = {
        coDecrypt: (oid: string, ct: string) => serviceClient!.coDecrypt(oid, ct).then((r) => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient!.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
      };
      return await resolveProjectKey(orgId, projectId, userId, keyOps);
    } catch (err: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(err, {
        projectName: keep.project_name,
        projectId: keep.project_id,
        branch,
      });
      return undefined;
    }
  }

  async execute(opts: EditOpts = {}): Promise<void> {
    // Contradictory PR flags are refused before anything is changed.
    refuseBadPrFlags(opts.pr ?? {}, opts.json === true);

    // Decided first: before anything is drawn, and before any auth or network call.
    const mode = decideEditMode({
      hasName: opts.name !== undefined,
      web: opts.web === true,
      stdinIsTTY: process.stdin.isTTY === true,
      nonTty: opts.nonTty === true,
    });
    if (mode === 'refuse') return refuseEditNeedsTty(opts.json === true);
    if (opts.name !== undefined && !isValidVarName(opts.name)) return refuseInvalidName(opts.json === true);
    if (mode === 'piped' && opts.name !== undefined) {
      return editPipedCommand(opts.name, {
        json: opts.json === true,
        push: opts.noPush !== true,
        devMode: this.devMode,
        pr: opts.pr,
      });
    }

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
    const pinned: Record<string, string> = Object.fromEntries(
      Object.entries(keep.variables).flatMap(([varName, entries]) => {
        const entry = entries.find((e) => e.branch === branch);
        return entry ? [[varName, entry.value_hash] as const] : [];
      }),
    );

    // Local-only mode: no auth, no server. Identity is synthetic; the key is
    // unwrapped from the passphrase session. No AuthService/ServiceClient is
    // constructed (avoids the dev-mode "[dev] AuthService → …" log and any
    // accidental server use).
    const localMode = isLocalOnly();

    const authed = localMode ? undefined : await this.authenticate(orgId, projectState.userId);
    const serviceClient = authed?.serviceClient;
    const userId = authed?.userId ?? LOCAL_USER_ID;

    const projectKey = await this.resolveKey({ localMode, orgId, projectId, userId, serviceClient, keep, branch });
    if (projectKey === undefined) return;

    // Decrypt local .env values. `undecryptableKeys`: local ciphertext this
    // profile does not hold the key for. The TUI drops these on the floor and
    // says nothing, and the next commit then deletes their pins — so the
    // browser table names them.
    const { localPlaintext, undecryptableKeys } = decryptLocalEnv(fileManager, projectKey);

    // Baseline the working copy is compared against:
    //  - remote mode: the latest committed blob fetched from the server.
    //  - local mode:  the committed blob from the local keep cache (no server).
    // In both cases it lands in `remotePlaintext` so the TUI's reclassify can
    // compare working-vs-baseline.
    const { remotePlaintext, remoteAvailable, remoteGap, remoteFromCache } = await loadBaseline({
      localMode,
      serviceClient,
      fileManager,
      projectKey,
      keep,
      branch,
      orgId,
      projectId,
    });

    // Build rows for every variable known to any source
    const allKeys = new Set<string>([
      ...Object.keys(pinned),
      ...Object.keys(localPlaintext),
      ...Object.keys(remotePlaintext),
    ]);

    // Sorting a copy that was built one line above is construction, not mutation.
    const rows: EditRow[] = [...allKeys].sort().map((key) => {
      const localVal = localPlaintext[key];
      const remoteVal = remotePlaintext[key];
      const pinnedHash = pinned[key];
      const localHash = localVal !== undefined ? hashValue(localVal) : undefined;
      const remoteHash = remoteVal !== undefined ? hashValue(remoteVal) : undefined;

      // Server-assigned changed_at for this branch — drives the UPDATED
      // column's recency label ("5 hours ago"). Absent in local mode and for
      // entries that predate rotation tracking.
      const changedAt = keep.variables[key]?.find((e) => e.branch === branch)?.changed_at;
      // Local mode: committed-vs-working, via the shared classifier so the
      // initial build and the in-TUI reclassify can't drift. `remoteVal` holds
      // the committed value from the local keep cache.
      const { status, updatedLabel } = localMode
        ? classifyLocalRow(localVal, remoteVal)
        : {
            status: classifyStatus(pinnedHash, localHash, remoteHash, remoteAvailable),
            updatedLabel: changedAt ? formatRelativeTime(changedAt) : '—',
          };

      return {
        key,
        localValue: localVal,
        remoteValue: remoteVal,
        status,
        updatedLabel,
        changedAt,
      };
    });

    const baseState: EditState = {
      projectName: keep.project_name,
      branch,
      rows,
      remoteAvailable,
      localMode,
    };
    // `capy edit NAME` on a terminal: the cursor starts on NAME (a new name opens
    // its value entry). `--web` opens the browser editor unfocused: focusing it
    // needs a change to the compiled Keep screen, which is not part of this work.
    const state = opts.name !== undefined && !opts.web ? focusedOn(baseState, opts.name) : baseState;

    const screen = new EditScreen();
    const printExpiryAfter = async () => {
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    };
    // Append-only log of what happened this session, used only to build the
    // exit-time PR (keepLockPr.ts) — never to decide what gets written to disk
    // during the session itself. See sessionSaveLog.ts.
    const saveLog = startSaveLog();

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
        saveLog.record({ branch, entries: touchedEntries });

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
    // --web session's browser tab has closed. The TUI has already released
    // stdin (raw mode off, its key listener removed) by the time `run`
    // resolves, so the prompts in keepLockPr.ts start from a clean terminal.
    const outcome = await runKeepLockPrStep({
      command: 'edit',
      cwd: process.cwd(),
      records: await saveLog.finish(),
      localKeep: keep,
      flags: opts.pr ?? {},
      json: opts.json === true,
      nonTty: opts.nonTty,
    });
    reportKeepLockHuman(outcome, { successTo: 'stdout', noteUnanswered: true });
    await printExpiryAfter();
  }
}
