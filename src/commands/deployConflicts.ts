/**
 * Platform values for `capy deploy` (CAP-717; the contract is docs/conflict-resolution.md).
 *
 * The folder and Capy agree by the time a deploy gets here: bare `capy` ran as its very first step
 * (sync/gate.ts), so what is delivered is the folder's values, which are Capy's. What remains is the one
 * place Capy cannot see on its own, a Dokploy service's live env (`adapter.readsLiveValues`; other platforms
 * cannot be read back and are unchanged):
 *
 *   A value changed on the platform outside Capy since Capy last delivered it (or, on a first delivery, a
 *   different value already there) is a decision. `local` = deliver Capy's value; `remote` = keep the
 *   platform's value and skip that variable.
 *
 * In a terminal one question per variable; off a terminal the protocol (`sync/conflicts.ts`: nothing is
 * written, exit 3, the rows with a `conflict_id` on stdout, `--resolve NAME@TARGET=local|remote` +
 * `--conflict` answer them). This module writes nothing. Names and fingerprints only, never a value.
 */
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import type { AdapterCallContext, DeployAdapter, DeployResult, TargetConfig } from '../deploy/adapter';
import { deployedHashesFor } from '../deploy/targetsGate';
import type { TargetCheck } from '../deploy/dokployApi';
import { CapyError, ERROR_CODES } from '../types/index';
import { baseHashOf, readLocalPlaintext, readSnapshot } from '../sync/commit';
import {
  conflictRefusalFor,
  gateConflicts,
  seenResolutions,
  targetResolutions,
  type Conflict,
  type ConflictFlags,
  type ConflictView,
  type Resolutions,
} from '../sync/conflicts';
import { askPlatformConflicts } from './conflictPrompt';

export interface ReconcileInput {
  readonly cwd: string;
  readonly target: TargetConfig;
  readonly adapter: DeployAdapter;
  readonly devMode?: boolean;
  /** `--dry-run`: report the rows (the preview), write nothing, ask nothing. */
  readonly dryRun: boolean;
  /** A person is at a terminal and can be asked. */
  readonly interactive: boolean;
  readonly flags: ConflictFlags;
  /** What the adapter needs to read the platform (the pre-resolved key, the org). */
  readonly adapterCtx: AdapterCallContext;
  /** Prints a failed adapter result (the caller's renderer). */
  readonly showFailure: (result: DeployResult) => void;
}

export type Reconciled =
  | {
      readonly ok: true;
      /** Names whose platform value was kept (`remote`): not delivered, not recorded. */
      readonly skipped: readonly string[];
      /** Hand to the adapter: what Capy last delivered, and the answers. Absent: the adapter does not compare. */
      readonly targetCheck?: TargetCheck;
      /** Where the rows were looked for (the id's scope); absent when nothing was compared. */
      readonly view?: ConflictView;
    }
  | { readonly ok: false; readonly code: number };

const NOTHING_TO_COMPARE: Reconciled = { ok: true, skipped: [] };

/** What a platform comparison needs of the folder: its keep, its `.env` values and Capy's keep hash for the branch. */
async function openFolder(cwd: string, branch: string, devMode: boolean | undefined) {
  const pm = new ProjectManager(cwd);
  const state = await pm.detectProjectState();
  const keep = pm.readKeepFile();
  if (!state.initialized || !state.organizationId || !state.projectId || !keep) return undefined;

  const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveProjectKey } = await import('../crypto/keyResolver');

  const auth = new AuthService(undefined, devMode, state.userId);
  const scoped = await auth.authenticateSilent(state.organizationId);
  const signedIn = scoped.success ? scoped : await auth.authenticateSilent();
  if (!signedIn.success || !signedIn.user_id) {
    throw new CapyError(silentAuthFailureMessage(signedIn), ERROR_CODES.AUTH_FAILED);
  }
  const serviceClient = new ServiceClient(undefined, devMode);
  serviceClient.setTokenProvider(() => auth.getValidToken());
  const projectKey = await resolveProjectKey(state.organizationId, state.projectId, signedIn.user_id, {
    coDecrypt: (o, c) => serviceClient.coDecrypt(o, c).then((r) => r.plaintext),
    wrapOuterLayer: (o, p) => serviceClient.wrapOuterLayer(o, p).then((r) => r.ciphertext),
  });
  const snapshot = await readSnapshot(serviceClient, state.projectId, branch, projectKey).catch((err: unknown) =>
    err instanceof CapyError && err.details?.status === 404 ? { keep: undefined, entries: {} } : Promise.reject(err),
  );
  return {
    keep,
    localPlaintext: readLocalPlaintext(new FileManager(cwd), projectKey),
    view: { project: keep.project_name, branch, serverKeepHash: baseHashOf(snapshot, branch) ?? '' },
  };
}

/**
 * Compares the values this delivery will write with the service's live env, and settles every difference
 * (a question per variable in a terminal, `--resolve` off one). Throws a `ConflictRefusal` off a terminal when
 * the flags do not answer every row (nothing has been written); any other error is a failure to compare, and the
 * caller does not deliver.
 */
export async function reconcileDeployConflicts(input: ReconcileInput): Promise<Reconciled> {
  const { target, adapter } = input;
  // A token adapter mints from the server's own blob: no folder value is delivered. Only Dokploy can be read back.
  if (adapter.needsDeployToken || adapter.readsLiveValues !== true || target.vars.length === 0) return NOTHING_TO_COMPARE;
  const folder = await openFolder(input.cwd, target.branch, input.devMode);
  if (folder === undefined) return NOTHING_TO_COMPARE;

  const env = Object.fromEntries(target.vars.flatMap((v) => (folder.localPlaintext[v] === undefined ? [] : [[v, folder.localPlaintext[v]] as const])));
  const targetCheck: TargetCheck = { pinned: deployedHashesFor(folder.keep, target.branch, adapter.id, target.name), resolutions: {} };

  const live = await adapter.deploy(target, { ...input.adapterCtx, env, dryRun: true, cwd: input.cwd, targetCheck });
  if (!live.ok) {
    input.showFailure(live);
    return { ok: false, code: 1 };
  }
  const rows: readonly Conflict[] = live.conflicts ?? [];
  const scopes = [{ ...folder.view, conflicts: rows }];

  if (input.dryRun) {
    if (rows.length > 0) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, undefined, { dryRun: true });
    return { ok: true, skipped: [], targetCheck, view: folder.view };
  }

  const answers: Resolutions = input.interactive ? await askPlatformConflicts(rows) : gateConflicts(input.flags, scopes);

  // The answers, each bound to the fingerprints they were made against (the adapter re-reads the service).
  const platform = targetResolutions(seenResolutions(answers, rows), target.name);
  return {
    ok: true,
    skipped: Object.entries(platform).flatMap(([name, seen]) => (seen.choice === 'remote' ? [name] : [])),
    targetCheck: { ...targetCheck, resolutions: platform },
    view: folder.view,
  };
}
