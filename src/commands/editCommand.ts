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
import { CapyError, ERROR_CODES, setSyncKeepHash, getSyncKeepHash, KeepFile } from '../types/index';
import { isReservedRuntimeVar } from '../core/reservedVars';
import { pushKeepWithRetry, maybeWarnPersonalEnv, conflictOverwriteQuestion } from './connectors/shared';

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
   * Agent-only: the terminal TUI is refused outright with no real TTY on
   * both ends (see `editSurfaceIsSafe`), so this is the only way a headless
   * caller can inspect or edit secrets.
   */
  web?: boolean;
  /** false when --no-open was passed: print the URL, do not open a browser. */
  open?: boolean;
}

/**
 * Whether this invocation has a surface that can safely show the editor.
 *
 * `--web` is the sanctioned non-interactive surface (a browser, not a
 * captured terminal). Everything else needs a real terminal on BOTH ends:
 * the leak this guards is on stdout — the drawn alt-screen with every
 * secret's plaintext — not just stdin, so a run with a live keyboard but a
 * redirected stdout is exactly as unsafe as a fully piped one. Pure on
 * purpose: `execute()` reads the real process's streams once and passes
 * them in, so the decision table is testable with no process surgery.
 */
export function editSurfaceIsSafe(
  web: boolean | undefined,
  stdinIsTty: boolean | undefined,
  stdoutIsTty: boolean | undefined,
): boolean {
  if (web === true) return true;
  return stdinIsTty === true && stdoutIsTty === true;
}

export class EditCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(opts: EditOpts = {}): Promise<void> {
    // Decide before doing ANY work, let alone rendering: `EditScreen.run()`
    // enters the alternate screen and draws the whole variable table —
    // secret plaintext included — unconditionally, with no TTY check of its
    // own. The real process's streams are read HERE, once, and handed to the
    // pure predicate — tests exercise the decision table without touching
    // process state.
    if (!editSurfaceIsSafe(opts.web, process.stdin.isTTY, process.stdout.isTTY)) {
      throw new CapyError(
        'This would draw a full-screen editor with every secret value on screen, and there is no real terminal to show it safely.\n\n' +
          `Run ${B('capy edit --web')} instead.`,
        ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE,
      );
    }

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const fileManager = new FileManager();

    // No keep.lock: single-user lock-less mode. `resolveContext()` already does
    // everything this block does below (identity, branch, auth, key
    // resolution) against the server's latest keep.json for the branch, so
    // the lock-less branch just adopts its result wholesale rather than
    // duplicating it. A dir WITH keep.lock keeps every line in the `else`
    // below byte-for-byte unchanged.
    const lockless = !projectState.initialized || !projectState.organizationId || !projectState.projectId;

    let orgId: string;
    let projectId: string;
    let keep: KeepFile;
    let branch: string;
    let localMode: boolean;
    let authService: AuthService | undefined;
    let serviceClient: ServiceClient | undefined;
    let userId: string;
    let projectKey: string;
    let locklessBaseHash: string | undefined;
    // Server-seeded + local-`.env`-overlaid plaintext from resolveContext's
    // lock-less path (see its own doc comment) — used below INSTEAD OF a raw
    // local-`.env`-only read, which in a fresh directory (the normal case for
    // a personal env that follows the user across repos) would be empty and
    // make every existing branch variable look locally deleted.
    let locklessLocalPlaintext: Record<string, string> | undefined;
    // The full lock-less `ResolvedContext`, kept around only so
    // `maybeWarnPersonalEnv` can dedup its one-line note per command
    // invocation (it keys off the object itself) — every other lock-less
    // field above is already unpacked individually.
    let locklessCtx: Awaited<ReturnType<typeof import('./connectors/shared').resolveContext>> | undefined;

    if (lockless) {
      const { resolveContext } = await import('./connectors/shared');
      const ctx = await resolveContext({ apiUrl: this.apiUrl, devMode: this.devMode });
      orgId = ctx.orgId;
      projectId = ctx.projectId;
      keep = ctx.keep;
      branch = ctx.branch;
      // Local-only mode (isLocalOnly()) is a separate, mutually exclusive
      // feature — it has no server identity at all, so it can never be the
      // reason a directory lacks keep.lock under single-user lock-less mode.
      localMode = false;
      authService = ctx.authService;
      serviceClient = ctx.serviceClient;
      userId = ctx.userId;
      projectKey = ctx.projectKey;
      locklessBaseHash = ctx.base_keep_hash;
      locklessLocalPlaintext = ctx.localPlaintext;
      locklessCtx = ctx;
    } else {
      orgId = projectState.organizationId!;
      projectId = projectState.projectId!;

      const foundKeep = pm.readKeepFile();
      if (!foundKeep) {
        console.error('Could not read keep.lock');
        process.exit(1);
      }
      keep = foundKeep;

      const activeBranch = projectState.activeBranch;
      if (!activeBranch) {
        console.error(`No active branch. Run ${B('capy')} to select a branch.`);
        process.exit(1);
      }
      branch = activeBranch;

      // Local-only mode: no auth, no server. Identity is synthetic; the key is
      // unwrapped from the passphrase session. No AuthService/ServiceClient is
      // constructed (avoids the dev-mode "[dev] AuthService → …" log and any
      // accidental server use).
      localMode = isLocalOnly();

      if (localMode) {
        userId = LOCAL_USER_ID;
        try {
          projectKey = await resolveLocalProjectKey(projectId);
        } catch (err: any) {
          const { displayErrorAndExit } = await import('../ui/errorScreen');
          await displayErrorAndExit(err, {
            projectName: keep.project_name,
            projectId: keep.project_id,
            branch,
          });
          return;
        }
      } else {
        // Auth — silent first, then interactive (mirrors usersCommand pattern)
        authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
        serviceClient = new ServiceClient(this.apiUrl, this.devMode);
        serviceClient.setTokenProvider(() => authService!.getValidToken());
        let authResult = await authService.authenticateSilent(orgId);
        if (!authResult.success) authResult = await authService.authenticateSilent();
        if (!authResult.success) authResult = await authService.authenticate(orgId);
        if (!authResult.success || !authResult.user_id) {
          console.error('Authentication failed');
          process.exit(1);
        }
        userId = authResult.user_id;

        try {
          const { resolveProjectKeyWithMintFallback } = await import('../auth/masterKeyMint');
          projectKey = await resolveProjectKeyWithMintFallback({
            orgId,
            projectId,
            userId,
            serviceClient: serviceClient!,
            keyServiceOps: {
              coDecrypt: (oid: string, ct: string) => serviceClient!.coDecrypt(oid, ct).then((r) => r.plaintext),
              wrapOuterLayer: (oid: string, pt: string) => serviceClient!.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
            },
            orgKeyState: authResult.organizations?.find((o) => o.id === orgId)?.key_state,
          });
        } catch (err: any) {
          const { displayErrorAndExit } = await import('../ui/errorScreen');
          await displayErrorAndExit(err, {
            projectName: keep.project_name,
            projectId: keep.project_id,
            branch,
          });
          return;
        }
      }
    }

    // CAS precondition for the eventual save's push — the branch's keep_hash
    // this command started from. Lock-less mode always has one (resolved
    // above, real or the well-known empty-state hash); lock-full mode has one
    // when sync-state recorded it and `undefined` otherwise, in which case
    // the eventual push omits base_keep_hash entirely (legacy behavior).
    const baseKeepHash: string | undefined = lockless ? locklessBaseHash : getSyncKeepHash(pm.readSyncState(), branch);

    // Pinned hashes for the active branch
    const pinned: Record<string, string> = {};
    for (const [varName, entries] of Object.entries(keep.variables)) {
      const entry = entries.find((e) => e.branch === branch);
      if (entry) pinned[varName] = entry.value_hash;
    }

    // Decrypt local .env values
    const localPlaintext: Record<string, string> = {};
    // Local ciphertext this profile does not hold the key for. The TUI drops
    // these on the floor and says nothing, and the next commit then deletes
    // their pins — so the browser table names them.
    const undecryptableKeys: string[] = [];
    if (lockless) {
      // Lock-less mode: `resolveContext()` already built the correct
      // working set — the server's latest values for the branch, with this
      // directory's local `.env` (if any) overlaid on top for uncommitted
      // edits. Re-deriving it here from a raw local `.env` read alone would
      // reintroduce the exact bug that seeding fixes: a fresh directory's
      // `.env` is normal and empty, and `saveLocalEdits`'s prune step would
      // read "every branch variable" as locally deleted.
      for (const [key, value] of Object.entries(locklessLocalPlaintext!)) {
        if (isReservedRuntimeVar(key)) continue;
        localPlaintext[key] = value;
      }
      // `undecryptableKeys` is a display-only hint (see above); resolveContext
      // already swallowed decrypt failures silently while building the merged
      // set, so recompute just the LOCAL half here for the same warning this
      // screen has always shown, without changing what's actually editable.
      const rawLocalForWarning = fileManager.readEnvFile();
      for (const [key, value] of Object.entries(rawLocalForWarning)) {
        if (isReservedRuntimeVar(key)) continue;
        if (!value.startsWith('capy:')) continue;
        try {
          fileManager.decryptValue(value, projectKey);
        } catch {
          undecryptableKeys.push(key);
        }
      }
    } else {
      const rawLocal = fileManager.readEnvFile();
      for (const [key, value] of Object.entries(rawLocal)) {
        // Reserved runtime variables are not editable secrets (CAP-424). They
        // are long opaque blobs that crowd out the real list, and editing one
        // silently breaks that machine's boot while deleting one is worse.
        if (isReservedRuntimeVar(key)) continue;
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
    // Set when a save rewrote keep.lock. The auto-commit runs after the TUI
    // exits — committing (and printing) mid-screen would corrupt the display.
    let keepDirty = false;

    // The same-key CAS conflict confirm `addCommand` uses, adapted to this
    // screen's terminal: `--web` has no secondary confirm surface (Save is
    // already the only "yes" the browser flow has, same rule `addCommand`
    // follows for `--web`/`--nonTty`), so it refuses by omitting the callback
    // entirely. The TUI does have one, but it owns the terminal (alt-screen +
    // raw mode) — `screen.suspendForPrompt` hands it back to inquirer for the
    // one question, then restores the screen exactly as it was.
    const confirmOverwrite = opts.web
      ? undefined
      : async (changedNames: string[], contextLines: string[]): Promise<boolean> => {
          if (!process.stdin.isTTY) return false;
          return screen.suspendForPrompt(async () => {
            for (const line of contextLines) console.log(line);
            const inquirer = (await import('inquirer')).default;
            const { ok } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'ok',
                message: conflictOverwriteQuestion(changedNames),
                default: false,
              },
            ]);
            return ok;
          });
        };

    const editContext = {
      saveLocalEdits: async (edits: Record<string, string>) => {
        // Same flow as the conflict-resolution "commit local" action and
        // PushCommand: encrypt the merged local state, mergeWithKeep, push
        // to the server, then cache + write keep.lock + .env + sync state.
        if (lockless && locklessCtx) maybeWarnPersonalEnv(locklessCtx);
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
        const buildFinalKeep = (base: KeepFile): KeepFile => {
          const fk = syncEngine.mergeWithKeep(base, pushedVars, branch);
          // Drop branch entries for variables no longer in finalEnv.
          // Prune against `keep` (this command's original local basis), not
          // `base` (which a CAS retry replaces with a rebase onto the
          // server's current state) — a var missing from `finalEnv` that
          // `keep` never had either is someone else's concurrent addition,
          // visible only because of the rebase, not something the user
          // deleted in this screen. Pruning it would be a data-loss bug on
          // exactly the retry path meant to avoid one.
          for (const varName of Object.keys(fk.variables)) {
            if (varName in finalEnv) continue;
            const wasInLocalBasis = keep.variables[varName]?.some((e) => e.branch === branch);
            if (!wasInLocalBasis) continue;
            const entries = fk.variables[varName].filter((e) => e.branch !== branch);
            if (entries.length > 0) fk.variables[varName] = entries;
            else delete fk.variables[varName];
          }
          return fk;
        };

        // In local-only mode there is no push — the local writes below ARE
        // the commit, against the merge computed straight off `keep`. In
        // server mode, a stale base is rebased and retried (single-user
        // lock-less CAS); a same-key conflict now offers the same
        // `confirmOverwrite` gate `addCommand` uses (see above) instead of
        // refusing unconditionally.
        let finalKeep = buildFinalKeep(keep);
        let pushedEnvBlob = envBlob;
        const pushResult = localMode
          ? null
          : await pushKeepWithRetry({
              serviceClient: serviceClient!,
              projectId,
              branch,
              baseKeep: keep,
              baseHash: baseKeepHash,
              buildEnvBlob: (extraLines) => (extraLines.length > 0 ? [envBlob, ...extraLines].join('\n') : envBlob),
              localVarNames: Object.keys(finalEnv),
              buildFinalKeep,
              primaryVarNames: Object.keys(edits),
              confirmOverwrite,
            }).then((r) => {
              finalKeep = r.finalKeep;
              pushedEnvBlob = r.envBlob;
              return r;
            });

        // keep_hash is computed locally from what was actually pushed (after
        // any CAS rebase); the server returns the same value on push.
        const localKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
        const keepHashForCache = pushResult ? pushResult.keep_hash : localKeepHash;

        writeKeepCache(orgId, projectId, keepHashForCache, pushedEnvBlob);
        // Prefer the server's copy — it carries server-assigned changed_at.
        // Lock-less mode never writes keep.lock — there is none for this dir.
        const adoptedKeep = SyncEngine.adoptServerKeep(pushResult?.keep_file, finalKeep, branch);
        if (!lockless) {
          fileManager.writeKeepFile(adoptedKeep);
          keepDirty = true;
        }
        fileManager.writeEncryptedEnvFile(finalEnv, projectKey, undefined, finalKeep, branch);

        const existingSyncState = pm.readSyncState();
        fileManager.writeSyncState({
          ...existingSyncState,
          last_sync: new Date().toISOString(),
          synced_variables: Object.keys(finalEnv),
          user_id: userId,
          keep_hash: setSyncKeepHash(existingSyncState, branch, localKeepHash),
        });

        // Hand the server-assigned changed_at back to the TUI so the UPDATED
        // column reflects the authoritative stamp for this commit, not a
        // client-side guess.
        const changedAtByKey: Record<string, string> = {};
        for (const [varName, entries] of Object.entries(adoptedKeep.variables)) {
          const stamp = entries.find((e) => e.branch === branch)?.changed_at;
          if (stamp) changedAtByKey[varName] = stamp;
        }
        return changedAtByKey;
      },
    };

    // `--web` changes only where the questions are ASKED. The commit callback
    // above is the same object either way, so the crypto, the push, the keep
    // rewrite and the auto-commit are one code path with one browser-shaped
    // front end and one terminal-shaped one.
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
    if (keepDirty) {
      const { autoCommitKeep } = await import('../git/autoCommitKeep');
      autoCommitKeep(branch);
    }
    await printExpiryAfter();
  }
}
