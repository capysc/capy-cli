/**
 * A real folder on disk (keep.lock, `.env`) for the commit-path tests (CAP-712), pinned to
 * whatever keep the test hands it. Reads go through the same `ProjectManager` /
 * `FileManager` the commands use, so what a test asserts is what the next command would see.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { readLocalPlaintext, type CommitClient, type FolderContext } from '../../src/sync/commit';
import type { KeepFile } from '../../src/types/index';

export interface Folder {
  readonly dir: string;
  readonly pm: ProjectManager;
  readonly fileManager: FileManager;
  /** The folder as the command starts: keep.lock and `.env` read from disk. */
  readonly ctx: FolderContext;
  /** `.env`, decrypted, as it is on disk now. */
  readonly env: () => Record<string, string>;
  /** The keep.lock on disk now. */
  readonly keep: () => KeepFile;
  /** keep.lock's pin for `name` on the folder's branch now. */
  readonly pin: (name: string) => string | undefined;
}

export function makeFolder(opts: {
  readonly projectKey: string;
  readonly branch: string;
  /** The keep.lock the folder is pinned to. */
  readonly keep: KeepFile;
  /** What its `.env` holds. */
  readonly env: Readonly<Record<string, string>>;
  readonly client: CommitClient | undefined;
  readonly projectId?: string;
}): Folder {
  const dir = mkdtempSync(join(tmpdir(), 'capy-folder-'));
  const pm = new ProjectManager(dir);
  const fileManager = new FileManager(dir);
  fileManager.writeKeepFile(opts.keep);
  fileManager.writeEncryptedEnvFile({ ...opts.env }, opts.projectKey, undefined, opts.keep, opts.branch);
  const keep = (): KeepFile => pm.readKeepFile() as KeepFile;
  return {
    dir,
    pm,
    fileManager,
    ctx: {
      pm,
      fileManager,
      serviceClient: opts.client,
      orgId: opts.keep.org_id,
      projectId: opts.projectId ?? opts.keep.project_id,
      branch: opts.branch,
      userId: 'user-b',
      projectKey: opts.projectKey,
      keep: keep(),
      localPlaintext: readLocalPlaintext(fileManager, opts.projectKey),
    },
    env: () => readLocalPlaintext(fileManager, opts.projectKey),
    keep,
    pin: (name) => keep().variables[name]?.find((e) => e.branch === opts.branch)?.value_hash,
  };
}

export const removeFolder = (folder: Folder): void => rmSync(folder.dir, { recursive: true, force: true });
