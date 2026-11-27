/**
 * `--folder <path>`: every command runs in that folder. A path that is not an existing folder stops with
 * FOLDER_NOT_FOUND before anything else runs, in JSON for an agent (`--json`, `--non-tty`, or no terminal), so a
 * folder the human typed as "Other" in the folder question comes back as a coded answer, never a crash.
 */
import { statSync } from 'fs';
import { resolve } from 'path';
import { refuse } from '../commands/refusal';
import { ERROR_CODES } from '../types/index';
import { isInteractive } from '../ui/interactive';

export function enterFolder(folder: string, opts: Readonly<Record<string, unknown>>): void {
  const isFolder = statSync(resolve(folder), { throwIfNoEntry: false })?.isDirectory() === true;
  if (!isFolder) {
    const json = opts.json === true || opts.nonTty === true || !isInteractive(opts.nonTty === true);
    refuse(json, {
      code: ERROR_CODES.FOLDER_NOT_FOUND,
      message: `${folder} is not an existing folder. Check the path and run the command again.`, // COPY-FLAG
      exitCode: 1,
      extra: { folder },
    });
  }
  process.chdir(folder);
}
