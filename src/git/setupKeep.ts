import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGitRepo } from '../deploy/git';
import { CapyError, ERROR_CODES } from '../types';
import { tracksKeepLock } from './keepTracking';

/** Set policy before the first lockfile write, including in a folder that may become a Git repository later. */
export function configureSetupTracking(folder: string, share: boolean): void {
  const inGit = isGitRepo(folder);
  if (inGit && spawnSync('git', ['ls-files', '--error-unmatch', '--', 'keep.lock'], { cwd: folder, stdio: 'ignore' }).status === 0) {
    throw new CapyError('This folder already has a tracked keep.lock. Restore it before setting up the project.', ERROR_CODES.INVALID_FORMAT);
  }
  const file = join(folder, '.gitignore');
  const contents = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const rule = share ? '!/keep.lock' : '/keep.lock';
  const localRule = contents.split(/\r?\n/).includes(rule);
  if ((share && !tracksKeepLock(folder)) || (!share && (!localRule || tracksKeepLock(folder)))) {
    appendFileSync(file, `${contents && !contents.endsWith('\n') ? '\n' : ''}# Capy\n${rule}\n`, 'utf8');
  }
  if (share !== tracksKeepLock(folder)) {
    throw new CapyError('Git could not apply this tracking choice to keep.lock. Check the ignore rules for this folder.', ERROR_CODES.INVALID_FORMAT);
  }
}

/** Commit just this folder's marker, even when the user has staged unrelated files. */
export function commitInitialKeep(folder: string): void {
  try {
    execFileSync('git', ['add', '--', 'keep.lock'], { cwd: folder, stdio: 'pipe' });
    execFileSync('git', ['commit', '--only', '-m', 'Set up Capy for this project', '--', 'keep.lock'], { cwd: folder, stdio: 'pipe' });
  } catch (error) {
    throw new CapyError('The project is set up locally, but Git could not commit keep.lock. In the project folder, run git add -- keep.lock and git commit --only -m "Set up Capy" -- keep.lock.', ERROR_CODES.SERVICE_ERROR, { cause: error });
  }
}
