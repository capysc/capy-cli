import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { readSecretsLocal, LOCAL_USER_ID } from '../config/globalConfig';
import { isLocalOnly } from '../config/profileConfig';
import { resolveLocalProjectKey } from '../core/localUnlock';
import { hashValue } from './statusCommand';
import { EditScreen, EditRow, EditState, EditLoaded, classifiedRow, focusedOn } from '../ui/editScreen';
import { deployedHashesFor } from '../core/deployStatus';
import { readDefaultBranchTargets } from '../deploy/configuredTargets';
import { KeepFile } from '../types/index';
import { commitFolder, pinnedHashes, readLocalPlaintext, readSnapshot, type FolderContext, type Snapshot } from '../sync/commit';
import { conflictFlagsOrExit, type RawConflictFlags, type Resolutions, type SeenResolutions } from '../sync/conflicts';
import { reportKeepLockHuman, refuseBadPrFlags, runKeepLockPrStep, type PrFlags } from './keepLockPr';
import { startSaveLog } from './sessionSaveLog';
import { decideEditMode, editPipedCommand, refuseEditNeedsTty } from './editPiped';
import { DRY_RUN_UNSUPPORTED_MESSAGES, refuseDryRunUnsupported, refuseInvalidName } from './pipedValue';
import { isValidVarName } from './pipedWrite';
import { printRepoLinkWarnings, reportRepoLink } from '../core/repoLinkReporter';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * What the rows are compared against: the other side's value (and fingerprint) per variable. Server mode: the
 * server's LATEST for the branch, the very read the commit path plans against (`seen`), never the folder's pinned
 * snapshot. Local-only mode: the committed copy in the local cache, with no server.
 */
export interface Baseline {
  readonly entries: Readonly<Record<string, { readonly plaintext: string | undefined; readonly hash: string | undefined }>>;
  /** The keep the UPDATED column and the deploy status read: the server's. */
  readonly keep: KeepFile | undefined;
  readonly available: boolean;
  /** The server read, handed to the commit. */
  readonly seen: Snapshot | undefined;
}

/** The server could not be read (or there is none): nothing to compare against, rows read `unknown`. */
const BASELINE_UNAVAILABLE: Baseline = { entries: {}, keep: undefined, available: false, seen: undefined };

/** The server's latest for the branch: one read, the one the commit path uses. */
async function loadServerBaseline(args: {
  readonly serviceClient: Pick<ServiceClient, 'getDecryptData' | 'pushSecrets'>;
  readonly projectId: string;
  readonly branch: string;
  readonly projectKey: string;
}): Promise<Baseline> {
  try {
    const snapshot = await readSnapshot(args.serviceClient, args.projectId, args.branch, args.projectKey);
    return {
      entries: Object.fromEntries(Object.entries(snapshot.entries).map(([name, e]) => [name, { plaintext: e.plaintext, hash: e.hash }])),
      keep: snapshot.keep,
      available: true,
      seen: snapshot,
    };
  } catch {
    return BASELINE_UNAVAILABLE;
  }
}

/** Local-only mode: the committed copy in the local cache, for the committed-vs-working comparison. */
function loadLocalBaseline(args: {
  readonly fileManager: Pick<FileManager, 'parseEnvContent' | 'decryptValue'>;
  readonly projectKey: string;
  readonly keep: KeepFile;
  readonly branch: string;
  readonly orgId: string;
  readonly projectId: string;
}): Baseline {
  const { fileManager, projectKey, keep, branch, orgId, projectId } = args;
  try {
    const blob = readSecretsLocal(orgId, projectId, SyncEngine.computeKeepHash(keep, branch));
    if (!blob?.env_file) return BASELINE_UNAVAILABLE;
    const encrypted = fileManager.parseEnvContent(blob.env_file);
    const entries = Object.fromEntries(
      Object.entries(encrypted).flatMap(([key, value]) => {
        try {
          const plaintext = fileManager.decryptValue(value, projectKey);
          return [[key, { plaintext, hash: hashValue(plaintext) }] as const];
        } catch {
          return []; // Skip values we can't decrypt
        }
      }),
    );
    // The remote column only applies to server mode; local mode uses the committed copy with local-mode wording instead.
    return { entries, keep: undefined, available: false, seen: undefined };
  } catch {
    return BASELINE_UNAVAILABLE;
  }
}

/**
 * The rows: every variable known to the folder's pin, its `.env` or the other side, compared three ways (pinned,
 * yours, theirs) in server mode, committed-vs-working in local mode. Pure.
 */
export function buildEditRows(input: {
  readonly localMode: boolean;
  readonly branch: string;
  /** The folder's keep.lock now. */
  readonly keep: KeepFile;
  readonly localPlaintext: Readonly<Record<string, string>>;
  readonly baseline: Baseline;
  readonly configuredTargets: ReturnType<typeof readDefaultBranchTargets>;
}): readonly EditRow[] {
  const { localMode, branch, keep, localPlaintext, baseline, configuredTargets } = input;
  const pinned = pinnedHashes(keep, branch);
  const stampKeep = baseline.keep ?? keep;
  const names = [...new Set([...Object.keys(pinned), ...Object.keys(localPlaintext), ...Object.keys(baseline.entries)])];
  const mode = { localMode, remoteAvailable: baseline.available };
  // A name only the pin remembers, that neither the folder nor the server holds any more, is not a variable.
  const present = names.filter((key) => localMode || !baseline.available || has(localPlaintext, key) || has(baseline.entries, key));
  // Sorting a copy that was built by the filter above is construction, not mutation.
  return present.sort().map((key) => {
    const entry = has(baseline.entries, key) ? baseline.entries[key] : undefined;
    const base: EditRow = {
      key,
      localValue: has(localPlaintext, key) ? localPlaintext[key] : undefined,
      remoteValue: entry?.plaintext,
      ...(entry !== undefined && entry.plaintext === undefined && entry.hash !== undefined ? { remoteHash: entry.hash } : {}),
      // Server mode: the pin, so the row is compared three ways. Local mode: committed-vs-working needs none.
      ...(localMode ? {} : { pinnedHash: pinned[key] ?? null }),
      status: 'unknown',
      updatedLabel: '—',
      // Server-assigned changed_at for this branch — drives the UPDATED column's recency label ("5 hours ago"). Absent in
      // local mode and for entries that predate rotation tracking.
      changedAt: stampKeep.variables[key]?.find((e) => e.branch === branch)?.changed_at,
      deployedHashes: deployedHashesFor(stampKeep, key, branch, configuredTargets),
    };
    return classifiedRow(base, mode);
  });
}

/**
 * The rows, from the folder as it is now and the other side as it is now: the server's LATEST (the read a commit
 * plans against), or in local-only mode the committed copy. Called for the first screen, and again after every save
 * and whenever the server moved under one.
 */
export function editLoader(args: {
  readonly pm: Pick<ProjectManager, 'readKeepFile'>;
  readonly fileManager: Pick<FileManager, 'readEnvFile' | 'decryptValue' | 'parseEnvContent'>;
  /** Absent in local-only mode. */
  readonly serviceClient: Pick<ServiceClient, 'getDecryptData' | 'pushSecrets'> | undefined;
  readonly localMode: boolean;
  /** The keep.lock the command started with: used if the folder's cannot be read again. */
  readonly keep: KeepFile;
  readonly branch: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly configuredTargets: ReturnType<typeof readDefaultBranchTargets>;
}): () => Promise<EditLoaded> {
  const { pm, fileManager, serviceClient, localMode, branch, orgId, projectId, projectKey, configuredTargets } = args;
  return async () => {
    const folderKeep = pm.readKeepFile() ?? args.keep;
    const baseline = serviceClient
      ? await loadServerBaseline({ serviceClient, projectId, branch, projectKey })
      : loadLocalBaseline({ fileManager, projectKey, keep: folderKeep, branch, orgId, projectId });
    return {
      // Decrypt local .env values. Local ciphertext this profile does not hold the key for is skipped.
      rows: buildEditRows({ localMode, branch, keep: folderKeep, localPlaintext: readLocalPlaintext(fileManager, projectKey), baseline, configuredTargets }),
      remoteAvailable: baseline.available,
      seen: baseline.seen,
    };
  };
}

const has = (record: object, name: string): boolean => Object.hasOwn(record, name);

/**
 * The decisions that still hold: each is kept only if the fingerprints it was made against are the ones in this read of
 * the server (`seen`) and in the value about to be written. With no read to bind to, none holds.
 */
export function boundResolutions(
  decisions: SeenResolutions,
  seen: Snapshot | undefined,
  set: Readonly<Record<string, string>>,
): Resolutions {
  if (seen === undefined) return {};
  return Object.fromEntries(
    Object.entries(decisions)
      .filter(([name, d]) => d.theirs === (seen.entries[name]?.hash ?? null) && d.yours === (has(set, name) ? hashValue(set[name]) : null))
      .map(([name, d]) => [name, d.choice] as const),
  );
}

/**
 * One save from the edit screen (`c`, or commit on quit). The one commit path (sync/commit.ts):
 * only the edited rows (and the conflict rows the person decided) change, on top of the server's
 * latest. A decision applies only to the values it was made against (`boundResolutions`); a name
 * someone else changed since the screen read it is a `SECRETS_CONFLICT` (nothing uploaded), which
 * the screen answers by reading again and showing it as a conflict. The folder is read afresh for
 * every save, because an earlier save in the same session moved keep.lock and `.env`. Resolves to the server-assigned `changed_at` of every variable on
 * the branch, for the screen's UPDATED column.
 */
export async function saveEdits(
  folder: Omit<FolderContext, 'keep' | 'localPlaintext'>,
  startKeep: KeepFile,
  edits: Readonly<Record<string, string>>,
  saveLog: Pick<ReturnType<typeof startSaveLog>, 'record'>,
  /** The decisions made on the screen, with the server read they were made against (CAP-714). */
  bound?: { readonly decisions: SeenResolutions; readonly seen: Snapshot | undefined },
): Promise<Record<string, string>> {
  const { branch } = folder;
  const committed = await commitFolder(
    {
      ...folder,
      keep: folder.pm.readKeepFile() ?? startKeep,
      localPlaintext: readLocalPlaintext(folder.fileManager, folder.projectKey),
    },
    { set: edits, remove: [] },
    { resolutions: boundResolutions(bound?.decisions ?? {}, bound?.seen, edits), seen: bound?.seen },
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

    const configuredTargets = readDefaultBranchTargets(process.cwd());

    const load = editLoader({ pm, fileManager, serviceClient, localMode, keep, branch, orgId, projectId, projectKey, configuredTargets });
    const loaded = await load();

    const baseState: EditState = {
      projectName: keep.project_name,
      branch,
      rows: loaded.rows,
      remoteAvailable: loaded.remoteAvailable,
      localMode,
      seen: loaded.seen,
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
      saveLocalEdits: (edits: Record<string, string>, bound?: Parameters<typeof saveEdits>[4]) =>
        saveEdits({ pm, fileManager, serviceClient, orgId, projectId, branch, userId, projectKey }, keep, edits, saveLog, bound),
      reload: load,
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
