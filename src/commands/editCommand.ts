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
import { keepScreensEnabled } from '../ui/screens/keepScreens';
import { pushKeepWithRetry, conflictOverwriteQuestion } from './connectors/shared';
import { requireListIdentity } from './listMetadata';
import type { AuthResult } from '../types/index';

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
  readonly web?: boolean;
  /** false when --no-open was passed: print the URL, do not open a browser. */
  readonly open?: boolean;
  /** Require the signed-in account selected by the hosted launcher. */
  readonly expectedUserId?: string;
}

export interface EditAuthenticator {
  readonly authenticateSilent: (organizationId?: string) => Promise<AuthResult>;
  readonly authenticate: (organizationId?: string) => Promise<AuthResult>;
}

/**
 * Hosted edit calls must use only the already-signed-in account selected by
 * the launcher. They never start repair or interactive authentication, which
 * could switch the account after the launcher established its identity.
 */
export async function authenticateForEdit(
  authService: EditAuthenticator,
  orgId: string,
  expectedUserId?: string,
): Promise<AuthResult> {
  if (expectedUserId !== undefined) {
    return requireListIdentity(
      { authenticate: (organizationId) => authService.authenticateSilent(organizationId) },
      expectedUserId,
      orgId,
    );
  }
  const scoped = await authService.authenticateSilent(orgId);
  if (scoped.success) return scoped;
  const unscoped = await authService.authenticateSilent();
  if (unscoped.success) return unscoped;
  return authService.authenticate(orgId);
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

interface EditProjectContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly keep: KeepFile;
  readonly branch: string;
  readonly projectUserId?: string;
}

interface EditAccessContext {
  readonly localMode: boolean;
  readonly authService?: AuthService;
  readonly serviceClient?: ServiceClient;
  readonly userId: string;
  readonly projectKey: string;
}

interface LocalValues {
  readonly plaintext: Record<string, string>;
  readonly undecryptableKeys: readonly string[];
}

interface RemoteBaseline {
  readonly plaintext: Record<string, string>;
  readonly available: boolean;
  readonly gap: 'never_pushed' | 'fetch_failed' | 'local_mode' | undefined;
  readonly fromCache: boolean;
}

async function displayEditError(error: unknown, context?: EditProjectContext): Promise<void> {
  const { displayErrorAndExit } = await import('../ui/errorScreen');
  if (context === undefined) {
    await displayErrorAndExit(error);
    return;
  }
  await displayErrorAndExit(error, {
    projectName: context.keep.project_name,
    projectId: context.keep.project_id,
    branch: context.branch,
  });
}

async function readEditProjectContext(pm: ProjectManager): Promise<EditProjectContext | undefined> {
  const projectState = await pm.detectProjectState();
  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
    await displayEditError(new CapyError('Could not read keep.lock', ERROR_CODES.NO_KEEP_FILE));
    return undefined;
  }

  const keep = pm.readKeepFile();
  if (!keep) {
    await displayEditError(new CapyError('Could not read keep.lock', ERROR_CODES.NO_KEEP_FILE));
    return undefined;
  }

  const branch = projectState.activeBranch;
  if (!branch) {
    await displayEditError(
      new CapyError(`No active branch. Run ${B('capy')} to select a branch.`, ERROR_CODES.NO_ACTIVE_BRANCH),
    );
    return undefined;
  }

  return {
    orgId: projectState.organizationId,
    projectId: projectState.projectId,
    keep,
    branch,
    projectUserId: projectState.userId,
  };
}

async function resolveEditAccess(
  context: EditProjectContext,
  opts: EditOpts,
  apiUrl: string | undefined,
  devMode: boolean,
): Promise<EditAccessContext | undefined> {
  const localMode = isLocalOnly();
  if (localMode) {
    if (opts.expectedUserId !== undefined) {
      throw new CapyError('No matching signed-in session. Ask your agent to reconnect Capy.', ERROR_CODES.AUTH_FAILED);
    }
    try {
      const projectKey = await resolveLocalProjectKey(context.projectId);
      return { localMode, userId: LOCAL_USER_ID, projectKey };
    } catch (error: unknown) {
      await displayEditError(error, context);
      return undefined;
    }
  }

  const authService = new AuthService(apiUrl, devMode, opts.expectedUserId ?? context.projectUserId);
  const serviceClient = new ServiceClient(apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  const authResult = await authenticateForEdit(authService, context.orgId, opts.expectedUserId);
  if (!authResult.success || !authResult.user_id) {
    await displayEditError(new CapyError('Authentication failed', ERROR_CODES.AUTH_FAILED), context);
    return undefined;
  }

  try {
    const { resolveProjectKeyWithMintFallback } = await import('../auth/masterKeyMint');
    const projectKey = await resolveProjectKeyWithMintFallback({
      orgId: context.orgId,
      projectId: context.projectId,
      userId: authResult.user_id,
      serviceClient,
      keyServiceOps: {
        coDecrypt: (oid: string, ciphertext: string) => serviceClient.coDecrypt(oid, ciphertext).then((result) => result.plaintext),
        wrapOuterLayer: (oid: string, plaintext: string) => serviceClient.wrapOuterLayer(oid, plaintext).then((result) => result.ciphertext),
      },
      orgKeyState: authResult.organizations?.find((organization) => organization.id === context.orgId)?.key_state,
    });
    return { localMode, authService, serviceClient, userId: authResult.user_id, projectKey };
  } catch (error: unknown) {
    await displayEditError(error, context);
    return undefined;
  }
}

function pinnedHashesFor(keep: KeepFile, branch: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(keep.variables).flatMap(([varName, entries]) => {
      const entry = entries.find((candidate) => candidate.branch === branch);
      return entry === undefined ? [] : [[varName, entry.value_hash]];
    }),
  );
}

function localValuesFor(fileManager: FileManager, projectKey: string): LocalValues {
  return Object.entries(fileManager.readEnvFile()).reduce<LocalValues>(
    (values, [key, value]) => {
      if (isReservedRuntimeVar(key)) return values;
      if (!value.startsWith('capy:')) {
        return { ...values, plaintext: { ...values.plaintext, [key]: value } };
      }
      try {
        return { ...values, plaintext: { ...values.plaintext, [key]: fileManager.decryptValue(value, projectKey) } };
      } catch {
        return { ...values, undecryptableKeys: [...values.undecryptableKeys, key] };
      }
    },
    { plaintext: {}, undecryptableKeys: [] },
  );
}

async function remoteBaselineFor(
  fileManager: FileManager,
  context: EditProjectContext,
  access: EditAccessContext,
): Promise<RemoteBaseline> {
  const keepHash = SyncEngine.computeKeepHash(context.keep, context.branch);
  try {
    const fromCache = access.localMode ? false : readKeepCache(context.orgId, context.projectId, keepHash) !== null;
    const blob = access.localMode
      ? readSecretsLocal(context.orgId, context.projectId, keepHash)
      : await fetchSecretsWithCache(access.serviceClient!, context.orgId, context.projectId, keepHash);
    if (!blob?.env_file) {
      return {
        plaintext: {},
        available: false,
        gap: access.localMode ? 'local_mode' : 'never_pushed',
        fromCache,
      };
    }
    const plaintext = Object.fromEntries(
      Object.entries(fileManager.parseEnvContent(blob.env_file)).flatMap(([key, value]) => {
        try {
          return [[key, fileManager.decryptValue(value, access.projectKey)]];
        } catch {
          return [];
        }
      }),
    );
    return { plaintext, available: !access.localMode, gap: undefined, fromCache };
  } catch {
    return {
      plaintext: {},
      available: false,
      gap: access.localMode ? 'local_mode' : 'fetch_failed',
      fromCache: false,
    };
  }
}

function editRowsFor(
  context: EditProjectContext,
  access: EditAccessContext,
  pinned: Record<string, string>,
  localPlaintext: Record<string, string>,
  remote: RemoteBaseline,
): EditRow[] {
  return Array.from(new Set([...Object.keys(pinned), ...Object.keys(localPlaintext), ...Object.keys(remote.plaintext)]))
    .toSorted()
    .map((key) => {
      const localValue = localPlaintext[key];
      const remoteValue = remote.plaintext[key];
      const changedAt = context.keep.variables[key]?.find((entry) => entry.branch === context.branch)?.changed_at;
      const localRow = classifyLocalRow(localValue, remoteValue);
      return {
        key,
        localValue,
        remoteValue,
        status: access.localMode
          ? localRow.status
          : classifyStatus(
              pinned[key],
              localValue === undefined ? undefined : hashValue(localValue),
              remoteValue === undefined ? undefined : hashValue(remoteValue),
              remote.available,
            ),
        updatedLabel: access.localMode ? localRow.updatedLabel : changedAt ? formatRelativeTime(changedAt) : '—',
        changedAt,
      };
    });
}

export class EditCommand {
  constructor(private readonly apiUrl?: string, private readonly devMode: boolean = false) {}

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
    const fileManager = new FileManager();
    const context = await readEditProjectContext(pm);
    if (!context) return;
    const access = await resolveEditAccess(context, opts, this.apiUrl, this.devMode);
    if (!access) return;
    const { orgId, projectId, keep, branch } = context;
    const { localMode, authService, serviceClient, userId, projectKey } = access;
    // CAS precondition for the eventual save's push — the branch's keep_hash
    // this command started from. Lock-less mode always has one (resolved
    // above, real or the well-known empty-state hash); lock-full mode has one
    // when sync-state recorded it and `undefined` otherwise, in which case
    // the eventual push omits base_keep_hash entirely (legacy behavior).
    const baseKeepHash: string | undefined = getSyncKeepHash(pm.readSyncState(), branch);

    // Pinned hashes and the local working copy are immutable snapshots. The
    // baseline is either the server blob or the local committed cache.
    const pinned = pinnedHashesFor(keep, branch);
    const localValues = localValuesFor(fileManager, projectKey);
    const { plaintext: localPlaintext, undecryptableKeys } = localValues;
    const remote = await remoteBaselineFor(fileManager, context, access);
    const rows = editRowsFor(context, access, pinned, localPlaintext, remote);

    const state: EditState = {
      projectName: keep.project_name,
      branch,
      rows,
      remoteAvailable: remote.available,
      localMode,
    };

    const screen = new EditScreen();
    const printExpiryAfter = async () => {
      const { printExpiryWarnings } = await import('./connectors/shared');
      printExpiryWarnings();
    };
    // Resolve when a save rewrites keep.lock. The auto-commit runs only after
    // the UI exits, so its terminal output cannot corrupt the alternate screen.
    const saveCompletion = Promise.withResolvers<boolean>();

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
        const finalEnv: Record<string, string> = { ...localPlaintext, ...edits };

        const encrypted = Object.fromEntries(
          Object.entries(finalEnv).map(([key, value]) => {
            const resourceId = deriveResourceId(branch, key);
            const encryptedValue = Encryptor.encrypt(value, projectKey);
            return [key, `capy:${resourceId}:${encryptedValue}`];
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
        const buildFinalKeep = (base: KeepFile): KeepFile => {
          const merged = syncEngine.mergeWithKeep(base, pushedVars, branch);
          // Drop branch entries for variables no longer in finalEnv.
          // Prune against `keep` (this command's original local basis), not
          // `base` (which a CAS retry replaces with a rebase onto the
          // server's current state) — a var missing from `finalEnv` that
          // `keep` never had either is someone else's concurrent addition,
          // visible only because of the rebase, not something the user
          // deleted in this screen. Pruning it would be a data-loss bug on
          // exactly the retry path meant to avoid one.
          const variables = Object.fromEntries(
            Object.entries(merged.variables).flatMap(([varName, entries]) => {
              if (varName in finalEnv) return [[varName, entries]];
              const wasInLocalBasis = keep.variables[varName]?.some((entry) => entry.branch === branch);
              if (!wasInLocalBasis) return [[varName, entries]];
              const withoutActiveBranch = entries.filter((entry) => entry.branch !== branch);
              return withoutActiveBranch.length === 0 ? [] : [[varName, withoutActiveBranch]];
            }),
          );
          return { ...merged, variables };
        };

        // In local-only mode there is no push — the local writes below ARE
        // the commit, against the merge computed straight off `keep`. In
        // server mode, a stale base is rebased and retried; a same-key conflict
        // offers the same
        // `confirmOverwrite` gate `addCommand` uses (see above) instead of
        // refusing unconditionally.
        const pushOutcome = localMode
          ? { finalKeep: buildFinalKeep(keep), envBlob, pushResult: null }
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
            }).then((pushResult) => ({
              finalKeep: pushResult.finalKeep,
              envBlob: pushResult.envBlob,
              pushResult,
            }));

        const { finalKeep, envBlob: pushedEnvBlob, pushResult } = pushOutcome;

        // keep_hash is computed locally from what was actually pushed (after
        // any CAS rebase); the server returns the same value on push.
        const localKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
        const keepHashForCache = pushResult ? pushResult.keep_hash : localKeepHash;

        writeKeepCache(orgId, projectId, keepHashForCache, pushedEnvBlob);
        // Prefer the server's copy — it carries server-assigned changed_at.
        // Lock-less mode never writes keep.lock — there is none for this dir.
        const adoptedKeep = SyncEngine.adoptServerKeep(pushResult?.keep_file, finalKeep, branch);
        fileManager.writeKeepFile(adoptedKeep);
        saveCompletion.resolve(true);
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
        return Object.fromEntries(
          Object.entries(adoptedKeep.variables).flatMap(([varName, entries]) => {
            const stamp = entries.find((entry) => entry.branch === branch)?.changed_at;
            return stamp === undefined ? [] : [[varName, stamp]];
          }),
        );
      },
    };

    // `--web` changes only where the questions are ASKED. The commit callback
    // above is the same object either way, so the crypto, the push, the keep
    // rewrite and the auto-commit are one code path with one browser-shaped
    // front end and one terminal-shaped one.
    if (opts.web) {
      // Keep-hosted transport (CAP-540), additive beside the untouched
      // loopback browser editor below: a person away from this machine can
      // edit secrets from ANY browser, gated by their own passkey/passphrase
      // rather than possession of this terminal. Any keep-path outcome short
      // of a validated, CAS-verified save degrades to the loopback editor —
      // same posture CAP-376 established for every other keep-migrated
      // screen — but NEVER silently: CAP-539 flagged `capy add`'s silent
      // fallback as a bug, so this prints a visible line (not just `debug()`)
      // explaining why the local editor opened instead.
      const attemptKeepEdit = async (): Promise<boolean> => {
        if (localMode || !authService || !serviceClient || !keepScreensEnabled()) return false;
        const { runSecretEditViaKeep } = await import('../ui/secretEditScreen');
        const outcome = await runSecretEditViaKeep({
          serviceApiUrl: authService.getServiceApiUrl(),
          getToken: async () => (await authService!.getValidToken())?.access_token ?? null,
          userId,
          orgId,
          projectName: keep.project_name,
          branchName: branch,
          vars: rows.map((r) => ({ name: r.key, value: r.localValue ?? r.remoteValue ?? '' })),
          keepHash: SyncEngine.computeKeepHash(keep, branch),
          applyEdits: async (edits, expectedKeepHash) => {
            // CAS, re-checked against a FRESH on-disk read immediately before
            // writing — catches a concurrent `capy push`/`capy pull` that
            // landed while this browser session was open, closing the
            // last-write-wins gap CAP-515 named for this specific path.
            const fresh = pm.readKeepFile();
            const currentHash = fresh ? SyncEngine.computeKeepHash(fresh, branch) : null;
            if (currentHash !== expectedKeepHash) {
              return { ok: false, code: 'stale_version' };
            }
            await editContext.saveLocalEdits(edits);
            const written = pm.readKeepFile();
            const newHash = written ? SyncEngine.computeKeepHash(written, branch) : expectedKeepHash;
            return { ok: true, keepHash: newHash };
          },
        });
        if (outcome.kind === 'saved') return true;
        console.error(
          `Could not edit secrets in your browser via Capy's hosted transport (${outcome.kind === 'unavailable' ? 'no device key enrolled on this account, or the connection broker is unreachable' : outcome.code}).\n` +
            `Opening the local browser editor on this machine instead.`,
        );
        return false;
      };
      const keepHandled = await attemptKeepEdit();

      if (!keepHandled) {
        const { runSecretEditorInBrowser } = await import('../ui/secretTableScreen');
        await runSecretEditorInBrowser(
          {
            projectName: keep.project_name,
            branch,
            mode: localMode ? 'local' : 'server',
            rows,
            remoteAvailable: remote.available,
            remoteGap: remote.gap,
            remoteFromCache: remote.fromCache,
            undecryptableKeys: [...undecryptableKeys],
            // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
            // headless runs drive the loopback without hijacking a real browser.
            open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN,
          },
          editContext,
        );
      }
    } else {
      await screen.run(state, editContext);
    }
    const didSave = await Promise.race([saveCompletion.promise, Promise.resolve(false)]);
    if (didSave) {
      const { autoCommitKeep } = await import('../git/autoCommitKeep');
      autoCommitKeep(branch);
    }
    await printExpiryAfter();
  }
}
