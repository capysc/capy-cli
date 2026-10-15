/**
 * Conflicts for `capy deploy` (CAP-717): before a delivery writes anything, the values it is about to deliver
 * are compared with the two other places that hold them.
 *
 *   SOURCE (folder against the Capy server). The folder's `.env` may lag Capy (a teammate saved since this folder's
 *   pin) or be ahead of it. The same planner every other write uses (`sync/commit.ts`) decides per variable:
 *     - only the server moved (folder unchanged since its pin) → deliver the server's latest, never the stale value;
 *     - only the folder changed → delivered as it always was; it stays an edit of the folder (not committed here);
 *     - both changed, differently → a conflict: mine commits the folder's value (through the commit path) and
 *       delivers it, theirs delivers Capy's latest and the folder takes it like a pull.
 *
 *   TARGET (Capy against the platform, Dokploy only: `adapter.readsLiveValues`). A value changed on the platform
 *   outside Capy since Capy last delivered it is a conflict: mine overwrites it, theirs skips that variable.
 *
 * One decision step for both kinds: in a terminal one question per variable; off a terminal the protocol
 * (`sync/conflicts.ts`: nothing is written, exit 3, the payload on stdout, `--resolve` + `--conflict` answer it).
 * This module writes nothing until every conflict has an answer. Names and fingerprints only, never a value.
 */
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import type { ServiceClient } from '../service/serviceClient';
import type { AdapterCallContext, DeployAdapter, DeployResult, TargetConfig } from '../deploy/adapter';
import { deployedHashesFor } from '../deploy/targetsGate';
import type { TargetCheck } from '../deploy/dokployApi';
import { CapyError, ERROR_CODES } from '../types/index';
import {
  commitFolder,
  findConflicts,
  pinnedHashes,
  readLocalPlaintext,
  readSnapshot,
  sourceConflictsOf,
  type Changes,
  type FolderContext,
  type Snapshot,
} from '../sync/commit';
import { hashValue } from '../sync/compareSecrets';
import { SyncEngine } from '../sync/syncEngine';
import {
  conflictRefusalFor,
  gateConflicts,
  protocolDecider,
  sourceResolutions,
  targetResolutions,
  type Conflict,
  type ConflictFlags,
  type ConflictView,
  type Resolutions,
} from '../sync/conflicts';
import { askConflicts } from './conflictPrompt';

export interface ReconcileInput {
  readonly cwd: string;
  readonly target: TargetConfig;
  readonly adapter: DeployAdapter;
  readonly devMode?: boolean;
  /** `--dry-run`: report the conflicts (the preview), write nothing, ask nothing. */
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
      /** Names whose platform value was kept (`theirs`): not delivered, not recorded. */
      readonly skipped: readonly string[];
      /** Hand to the adapter: what Capy last delivered, and the decisions. Absent: the adapter does not compare. */
      readonly targetCheck?: TargetCheck;
      /** Where the conflicts were looked for (the id's scope); absent when nothing was compared. */
      readonly view?: ConflictView;
    }
  | { readonly ok: false; readonly code: number };

const NOTHING_TO_COMPARE: Reconciled = { ok: true, skipped: [] };

/** The folder, signed in without a prompt, with its key: what a commit needs. `undefined` when this is not a Capy project folder. */
async function openFolder(cwd: string, branch: string, devMode: boolean | undefined): Promise<(FolderContext & { serviceClient: ServiceClient }) | undefined> {
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
  const fileManager = new FileManager(cwd);
  return {
    pm,
    fileManager,
    serviceClient,
    orgId: state.organizationId,
    projectId: state.projectId,
    branch,
    userId: signedIn.user_id,
    projectKey,
    keep,
    localPlaintext: readLocalPlaintext(fileManager, projectKey),
  };
}

/** The server's latest for the branch; a branch the server has nothing for yet is an empty snapshot. */
async function readLatest(folder: FolderContext & { serviceClient: ServiceClient }): Promise<Snapshot> {
  try {
    return await readSnapshot(folder.serviceClient, folder.projectId, folder.branch, folder.projectKey);
  } catch (err) {
    if (err instanceof CapyError && err.details?.status === 404) return { keep: undefined, entries: {} };
    throw err;
  }
}

/**
 * Settles every conflict `capy deploy <target>` would meet, and brings the folder in line with the values that
 * will be delivered. Throws a `ConflictRefusal` off a terminal when the flags do not decide every conflict
 * (nothing has been written); any other error is a failure to compare, and the caller does not deliver.
 */
export async function reconcileDeployConflicts(input: ReconcileInput): Promise<Reconciled> {
  const { target, adapter } = input;
  // A token adapter mints from the server's own blob: no folder value is delivered.
  if (adapter.needsDeployToken || target.vars.length === 0) return NOTHING_TO_COMPARE;
  const folder = await openFolder(input.cwd, target.branch, input.devMode);
  if (folder === undefined) return NOTHING_TO_COMPARE;

  const snapshot = await readLatest(folder);
  const view: ConflictView = {
    project: folder.keep.project_name,
    branch: target.branch,
    serverKeepHash: snapshot.keep === undefined ? '' : SyncEngine.computeKeepHash(snapshot.keep, target.branch),
  };

  // The folder's own changes to the variables being delivered, and what the server says about them.
  const pinned = pinnedHashes(folder.keep, target.branch);
  const edited = target.vars.filter((v) => folder.localPlaintext[v] !== undefined && hashValue(folder.localPlaintext[v]) !== pinned[v]);
  const changes: Changes = { set: Object.fromEntries(edited.map((v) => [v, folder.localPlaintext[v]])), remove: [] };
  const source = sourceConflictsOf(findConflicts({ pinned, latest: snapshot.entries, changes }), snapshot, view);

  // What is delivered, if every conflict is answered `mine`: the folder's edit, else Capy's latest, else the folder's value.
  const valueFor = (name: string): string | undefined =>
    Object.hasOwn(changes.set, name) ? changes.set[name] : (snapshot.entries[name]?.plaintext ?? folder.localPlaintext[name]);
  const env = Object.fromEntries(target.vars.flatMap((v) => (valueFor(v) === undefined ? [] : [[v, valueFor(v) as string] as const])));

  const targetCheck: TargetCheck | undefined = adapter.readsLiveValues
    ? { pinned: deployedHashesFor(folder.keep, target.branch, adapter.id, target.name), resolutions: {} }
    : undefined;
  const live = targetCheck === undefined ? undefined : await adapter.deploy(target, { ...input.adapterCtx, env, dryRun: true, cwd: input.cwd, targetCheck });
  if (live !== undefined && !live.ok) {
    input.showFailure(live);
    return { ok: false, code: 1 };
  }
  const conflicts: readonly Conflict[] = [...source, ...(live?.conflicts ?? [])];
  const scopes = [{ ...view, conflicts }];

  if (input.dryRun) {
    if (conflicts.length > 0) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, undefined, { dryRun: true });
    return { ok: true, skipped: [], ...(targetCheck === undefined ? {} : { targetCheck, view }) };
  }

  // One decision step for both kinds.
  const decisions: Resolutions = conflicts.length === 0 ? {} : input.interactive ? await askConflicts(conflicts) : gateConflicts(input.flags, scopes);

  // The folder takes what will be delivered. A variable the folder did not change is never delivered stale: Capy's
  // latest is pulled in. A conflict is committed with its answer (mine writes the folder's value to Capy, theirs
  // takes Capy's). A folder edit nobody else touched is not committed here: it is delivered as it always was and
  // stays an edit of the folder, for the next `capy`/`capy push`.
  const settled = source.map((c) => c.name);
  const behind = target.vars.some(
    (v) => !edited.includes(v) && snapshot.entries[v]?.plaintext !== undefined && snapshot.entries[v].plaintext !== folder.localPlaintext[v],
  );
  if (settled.length > 0 || behind) {
    await commitFolder(
      { ...folder, ...(input.interactive ? {} : { decide: protocolDecider(input.flags) }) },
      { set: Object.fromEntries(settled.map((name) => [name, folder.localPlaintext[name]])), remove: [] },
      { resolutions: sourceResolutions(decisions), seen: snapshot },
    );
  }

  const platform = targetResolutions(decisions, target.name);
  return {
    ok: true,
    skipped: Object.entries(platform).flatMap(([name, choice]) => (choice === 'theirs' ? [name] : [])),
    ...(targetCheck === undefined ? {} : { targetCheck: { ...targetCheck, resolutions: platform }, view }),
  };
}
