import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { fetchSecretsWithCache, readKeepCache, readSecretsLocal, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { hashValue } from './statusCommand';
import { EditScreen, EditRow, EditState, classifyLocalRow, focusedOn, withDeployStatus } from '../ui/editScreen';
import { deployedHashesFor } from '../core/deployStatus';
import { readDefaultBranchTargets } from '../deploy/configuredTargets';
import { formatRelativeTime } from '../ui/relativeTime';
import { KeepFile } from '../types/index';
import { commitFolder, pinnedHashes, readLocalPlaintext, type FolderContext } from '../sync/commit';
import { conflictFlagsOrExit, type RawConflictFlags } from '../sync/conflicts';
import { reportKeepLockHuman, refuseBadPrFlags, runKeepLockPrStep, type PrFlags } from './keepLockPr';
import { startSaveLog } from './sessionSaveLog';
import { decideEditMode, editPipedCommand, refuseEditNeedsTty } from './editPiped';
import { DRY_RUN_UNSUPPORTED_MESSAGES, refuseDryRunUnsupported, refuseInvalidName } from './pipedValue';
import { isValidVarName } from './pipedWrite';
import { printRepoLinkWarnings, reportRepoLink } from '../core/repoLinkReporter';

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

interface Baseline {
  remotePlaintext: Record<string, string>;
  remoteAvailable: boolean;
}

/** Remote fetch failed (server mode), or nothing to compare against: fall back to pinned-only. */
const BASELINE_UNAVAILABLE: Baseline = { remotePlaintext: {}, remoteAvailable: false };

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
  if (cacheProbeThrew(localMode, orgId, projectId, keepHash)) return BASELINE_UNAVAILABLE;
  try {
    const blob = localMode
      ? readSecretsLocal(orgId, projectId, keepHash)
      : await fetchSecretsWithCache(serviceClient!, orgId, projectId, keepHash);
    if (!blob?.env_file) return BASELINE_UNAVAILABLE;
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
    return { remotePlaintext, remoteAvailable: !localMode };
  } catch {
    return BASELINE_UNAVAILABLE;
  }
}

/**
 * CAP-702: the keep file whose deploy-target records `not deployed` is read
 * from. The server's copy is the record (CI-mode deploys record targets
 * there, not in the local keep.lock until their PR merges); the local
 * keep.lock is the fallback when the server can't be read, and the only
 * source in local mode.
 */
async function loadDeployKeep(args: {
  localMode: boolean;
  serviceClient: ServiceClient | undefined;
  projectId: string;
  branch: string;
  localKeep: KeepFile;
}): Promise<KeepFile> {
  const { localMode, serviceClient, projectId, branch, localKeep } = args;
  if (localMode || !serviceClient) return localKeep;
  try {
    const latest = await serviceClient.getLatestSecrets(projectId, branch);
    const parsed: unknown = latest?.keep_file ? JSON.parse(latest.keep_file) : undefined;
    return isKeepWithVariables(parsed) ? parsed : localKeep;
  } catch {
    return localKeep;
  }
}

function isKeepWithVariables(value: unknown): value is KeepFile {
  return typeof value === 'object' && value !== null && typeof (value as { variables?: unknown }).variables === 'object';
}

/** Whether probing the keep cache for this keep hash threw (the baseline is then unavailable). */
function cacheProbeThrew(localMode: boolean, orgId: string, projectId: string, keepHash: string): boolean {
  try {
    if (!localMode) readKeepCache(orgId, projectId, keepHash);
    return false;
  } catch {
    return true;
  }
}

/**
 * One save from the edit screen (`c`, or commit on quit). The one commit path (sync/commit.ts):
 * only the edited rows change, on top of the server's latest. A row someone else changed since
 * this folder's pin is a `SECRETS_CONFLICT` (nothing uploaded), which the screen shows as the
 * error. The folder is read afresh for every save, because an earlier save in the same session
 * moved keep.lock and `.env`. Resolves to the server-assigned `changed_at` of every variable on
 * the branch, for the screen's UPDATED column.
 */
export async function saveEdits(
  folder: Omit<FolderContext, 'keep' | 'localPlaintext'>,
  startKeep: KeepFile,
  edits: Readonly<Record<string, string>>,
  saveLog: Pick<ReturnType<typeof startSaveLog>, 'record'>,
): Promise<Record<string, string>> {
  const { branch } = folder;
  const committed = await commitFolder(
    {
      ...folder,
      keep: folder.pm.readKeepFile() ?? startKeep,
      localPlaintext: readLocalPlaintext(folder.fileManager, folder.projectKey),
    },
    { set: edits, remove: [] },
  );
  const adoptedKeep = committed.keep;

  // Record this save for the exit-time PR: the resulting (or deleted)
  // entry, for THIS branch only, of every variable this save touched.
  saveLog.record({
    branch,
    entries: Object.keys(edits).map((variable) => ({
      variable,
      entry: adoptedKeep.variables[variable]?.find((e) => e.branch === branch) ?? null,
    })),
  });

  // Hand the server-assigned changed_at back to the TUI so the UPDATED
  // column reflects the authoritative stamp for this commit, not a
  // client-side guess.
  return Object.fromEntries(
    Object.entries(adoptedKeep.variables)
      .map(([varName, entries]) => [varName, entries.find((e) => e.branch === branch)?.changed_at] as const)
      .filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
}

export interface EditOpts {
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
  /** The global `--dry-run`: piped mode previews; the TUI refuses (`DRY_RUN_UNSUPPORTED`). */
  dryRun?: boolean;
  /** `--resolve` / `--conflict` as typed (CAP-717): they decide a conflict of a piped value. The TUI shows conflicts on its own screen (CAP-714). */
  conflictFlags?: RawConflictFlags;
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
      stdinIsTTY: process.stdin.isTTY === true,
      nonTty: opts.nonTty === true,
    });
    if (mode === 'refuse') return refuseEditNeedsTty(opts.json === true);
    // The TUI would really save: a dry run never runs for real, and has no way to preview it. Before any screen.
    if (mode === 'tui' && opts.dryRun === true) {
      return refuseDryRunUnsupported(opts.json === true, DRY_RUN_UNSUPPORTED_MESSAGES.edit);
    }
    if (opts.name !== undefined && !isValidVarName(opts.name)) return refuseInvalidName(opts.json === true);
    if (mode === 'piped' && opts.name !== undefined) {
      return editPipedCommand(opts.name, {
        json: opts.json === true,
        push: opts.noPush !== true,
        devMode: this.devMode,
        pr: opts.pr,
        dryRun: opts.dryRun === true,
        // A bad flag is refused here, before stdin is read or anything is authenticated.
        conflicts: conflictFlagsOrExit(opts.conflictFlags ?? {}, opts.json === true),
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
    const pinned = pinnedHashes(keep, branch);

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

    // Decrypt local .env values. Local ciphertext this profile does not hold
    // the key for is skipped.
    const localPlaintext = readLocalPlaintext(fileManager, projectKey);

    // Baseline the working copy is compared against:
    //  - remote mode: the latest committed blob fetched from the server.
    //  - local mode:  the committed blob from the local keep cache (no server).
    // In both cases it lands in `remotePlaintext` so the TUI's reclassify can
    // compare working-vs-baseline.
    const { remotePlaintext, remoteAvailable } = await loadBaseline({
      localMode,
      serviceClient,
      fileManager,
      projectKey,
      keep,
      branch,
      orgId,
      projectId,
    });

    const deployKeep = await loadDeployKeep({ localMode, serviceClient, projectId, branch, localKeep: keep });
    const configuredTargets = readDefaultBranchTargets(process.cwd());

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
      const deployedHashes = deployedHashesFor(deployKeep, key, branch, configuredTargets);
      const base: EditRow = { key, localValue: localVal, remoteValue: remoteVal, status, updatedLabel, changedAt, deployedHashes };

      return { ...base, status: withDeployStatus(base, status) };
    });

    const baseState: EditState = {
      projectName: keep.project_name,
      branch,
      rows,
      remoteAvailable,
      localMode,
    };
    // `capy edit NAME` on a terminal: the cursor starts on NAME (a new name opens
    // its value entry).
    const state = opts.name !== undefined ? focusedOn(baseState, opts.name) : baseState;

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
      saveLocalEdits: (edits: Record<string, string>) =>
        saveEdits({ pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey }, keep, edits, saveLog),
    };

    // CAP-697: started now, collected after the TUI closes (it has long since finished by then).
    const repoLinkPending = serviceClient
      ? reportRepoLink({ cwd: process.cwd(), orgId, projectId, projectName: keep.project_name, client: serviceClient })
      : undefined;

    await screen.run(state, editContext);
    if (repoLinkPending) printRepoLinkWarnings(await repoLinkPending);
    // The TUI has already released stdin (raw mode off, its key listener
    // removed) by the time `run` resolves, so the prompts in keepLockPr.ts start
    // from a clean terminal.
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
