/**
 * Automatic keep.lock commits are gone entirely.
 *
 * `src/git/autoCommitKeep.ts` (which committed keep.lock on whatever branch
 * the user happened to be on, every time secrets changed) is deleted, and no
 * source file imports or calls it — the only committing paths left are
 * `capy deploy` (unchanged) and the `capy edit` exit flow
 * (src/commands/editExitFlow.ts), both of which commit into an isolated
 * worktree on an explicit action, never onto the user's own checkout.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

function walkTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) return walkTsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('no automatic keep.lock commits', () => {
  test('src/git/autoCommitKeep.ts no longer exists', () => {
    expect(existsSync(join(SRC_ROOT, 'git', 'autoCommitKeep.ts'))).toBe(false);
  });

  test('no source file references autoCommitKeep', () => {
    const offenders = walkTsFiles(SRC_ROOT).filter((file) =>
      readFileSync(file, 'utf-8').includes('autoCommitKeep'),
    );
    expect(offenders).toEqual([]);
  });
});
