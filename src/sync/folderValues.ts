/** Reconcile a folder with Capy using its last synchronized pins as the common baseline. */
import inquirer from 'inquirer';
import { CapyError, ERROR_CODES, getSyncKeepHash } from '../types/index';
import { SyncEngine } from './syncEngine';
import { hashValue } from './compareSecrets';
import { baseHashOf, commitFolder, pinnedHashes, type Changes, type FolderContext, type Snapshot } from './commit';
import {
  conflictRefusalFor, gateConflicts, sourceResolutions,
  type ConflictFlags, type ConflictScope, type Resolutions, type SourceConflict,
} from './conflicts';

type Choice = 'local' | 'remote';
interface FolderSyncInput {
  readonly folder: FolderContext;
  readonly snapshot: Snapshot;
  readonly hasEnv: boolean;
  readonly envPath?: string;
  readonly flags: ConflictFlags;
  readonly protocol: boolean;
  readonly dryRun: boolean;
}

const sources = ['local', 'remote'] as const;
const present = (values: Readonly<Record<string, unknown>>, name: string): boolean => Object.hasOwn(values, name);

async function ask(rows: readonly SourceConflict[]): Promise<Resolutions | undefined> {
  const answers: readonly (readonly [string, Choice])[] = [];
  const next = async (index: number, selected: typeof answers): Promise<Resolutions | undefined> => {
    const row = rows[index];
    if (!row) return Object.fromEntries(selected);
    const { choice } = await inquirer.prompt<{ choice: Choice | 'stop' }>([{
      type: 'list', name: 'choice', message: `${row.name} differs between this folder and Capy. Which version should both use?`,
      choices: [
        { value: 'local', name: row.local === null ? 'Use this folder (remove from Capy)' : "Use this folder's value" },
        { value: 'remote', name: row.remote === null ? 'Use Capy (remove from this folder)' : "Use Capy's value" },
        { value: 'stop', name: 'Continue working without syncing' },
      ],
      default: row.local === null ? 'remote' : 'local',
    }]);
    return choice === 'stop' ? undefined : next(index + 1, [...selected, [row.name, choice]]);
  };
  return next(0, answers);
}

export async function syncFolderValues(input: FolderSyncInput): Promise<'changed' | 'up-to-date' | 'stopped'> {
  const { folder, snapshot, hasEnv, flags, dryRun } = input;
  const { localPlaintext, branch } = folder;
  const pins = pinnedHashes(snapshot.keep, branch);
  // A missing blob (or an unreadable line) is not evidence that this name was removed.
  // Keep unreadable remote-only lines byte-for-byte; never overwrite a local copy of one.
  const unavailable = [...new Set([...Object.keys(pins), ...Object.keys(snapshot.entries)])].filter((name) => {
    const entry = snapshot.entries[name];
    if (!present(pins, name) || !entry) return true;
    return entry.plaintext === undefined
      ? !hasEnv || present(localPlaintext, name)
      : hashValue(entry.plaintext) !== pins[name];
  });
  if (unavailable.length > 0) {
    throw new CapyError('Could not read the current Capy values for ' + unavailable.join(', ') + '.',
      ERROR_CODES.SNAPSHOT_NOT_FOUND, { names: unavailable });
  }

  const remote = Object.fromEntries(Object.entries(snapshot.entries).flatMap(([name, entry]) =>
    entry.plaintext === undefined ? [] : [[name, entry.plaintext] as const]));
  // Setup can seed keep.lock from Capy before this folder has ever synced. Those pins
  // cannot tell us who edited a value. Only trust a lock matching this branch's sync receipt.
  const savedLock = folder.pm.readKeepFile();
  const hasBaseline = savedLock != null &&
    getSyncKeepHash(folder.pm.readSyncState(), branch) === SyncEngine.computeKeepHash(savedLock, branch);
  const baseline = pinnedHashes(savedLock, branch);
  const names = [...new Set([...Object.keys(localPlaintext), ...Object.keys(remote)])];
  const differences: readonly SourceConflict[] = names.flatMap((name) => {
    const localHash = present(localPlaintext, name) ? hashValue(localPlaintext[name]) : null;
    const remoteHash = present(remote, name) ? hashValue(remote[name]) : null;
    if (localHash === remoteHash) return [];
    return [{
      name, project: folder.keep.project_name, branch,
      type: localHash !== null && remoteHash !== null ? 'changed' : present(baseline, name) ? 'deleted' : 'new',
      local: localHash, remote: remoteHash, choices: hasEnv ? sources : ['remote'] as const,
    }];
  });

  const automaticChoice = (row: SourceConflict): Choice | undefined => {
    if (!hasEnv) return 'remote';
    if (!hasBaseline) return undefined;
    const previous = present(baseline, row.name) ? baseline[row.name] : null;
    if (row.local === previous) return 'remote';
    if (row.remote === previous) return 'local';
    return undefined;
  };
  const rows = differences.filter((row) => automaticChoice(row) === undefined);
  const scope: ConflictScope = {
    project: folder.keep.project_name, branch, serverKeepHash: baseHashOf(snapshot, branch), conflicts: rows,
    folderIdentity: [folder.orgId, folder.projectId, hasEnv] as const,
  };
  const sourceAnswers = sourceResolutions(flags.resolutions);
  const hasSourceAnswers = Object.keys(sourceAnswers).length > 0;
  if (rows.length === 0 && hasSourceAnswers) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT_STALE, [scope]);

  const answers = rows.length === 0 ? {}
    : input.protocol || dryRun ? gateConflicts(flags, [scope], { dryRun }) : await ask(rows);
  if (answers === undefined) return 'stopped';
  if (dryRun) return 'up-to-date';

  const useLocal = differences.filter((row) => (automaticChoice(row) ?? answers[row.name]) === 'local');
  const changes: Changes = {
    set: Object.fromEntries(useLocal.filter(({ name }) => present(localPlaintext, name)).map(({ name }) => [name, localPlaintext[name]])),
    remove: useLocal.filter(({ name }) => !present(localPlaintext, name)).map(({ name }) => name),
  };

  // A remote choice, a recovery, or agreement computes an empty change set: commitFolder adopts the server's
  // pins and refreshes the encrypted local file without posting anything. A local choice uses the identical upload
  // as the rest of the CLI, conditioned on exactly the server revision the person saw.
  const currentFolder = snapshot.keep === undefined
    ? { ...folder, keep: SyncEngine.spliceKeepBranch(folder.keep, { ...folder.keep, variables: {} }, branch) }
    : folder;
  await commitFolder(currentFolder, changes, { seen: snapshot, envPath: input.envPath });
  return differences.length === 0 && hasEnv ? 'up-to-date' : 'changed';
}
