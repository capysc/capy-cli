import { readdirSync, statSync, unlinkSync } from 'fs';
import { isRecoveryActive, deleteRecoverySession } from '../config/globalConfig';
import { formatRelativeTime } from '../ui/relativeTime';
import type { DecryptedFile } from '../ui/screens/contract';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * Which files a recovery session leaves lying around.
 *
 * The pattern is the command's, and it is deliberately narrow: only
 * `.env.*.decrypted` in the working directory, so nothing else can be swept up
 * by a name that happens to look similar.
 */
export const DECRYPTED_FILE_PATTERN = /^\.env\..*\.decrypted$/;

/**
 * The plaintext this directory is holding, newest last.
 *
 * Names, ages and sizes only. Every one of these files is readable secret
 * material, and the whole point of the command is to stop that being true — a
 * listing that peeked inside would undo it.
 */
export function listDecryptedFiles(cwd: string, now: Date = new Date()): DecryptedFile[] {
  return [...decryptedNames(cwd)].sort().map(name => {
    try {
      const st = statSync(`${cwd}/${name}`);
      return {
        name,
        age: formatRelativeTime(st.mtime.toISOString(), now),
        size: formatBytes(st.size),
      };
    } catch {
      // Unreadable metadata is not a reason to hide a file that is still
      // sitting there in plaintext.
      return { name };
    }
  });
}

/** The matching names in `cwd`, in directory order; none when the directory cannot be read. */
function decryptedNames(cwd: string): string[] {
  try {
    return readdirSync(cwd).filter(n => DECRYPTED_FILE_PATTERN.test(n));
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Removes the named files in order, announcing each. Best-effort: it stops at
 * the first failure and returns the names removed before it.
 */
function removeInOrder(cwd: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const [name, ...rest] = names;
  try {
    unlinkSync(`${cwd}/${name}`);
  } catch {
    return [];
  }
  console.log(`  Removed ${name}`);
  return [name, ...removeInOrder(cwd, rest)];
}

export class EndRecoverCommand {
  async execute(): Promise<void> {
    try {
      if (!isRecoveryActive()) {
        this.reportNoSession();
        return;
      }

      // Delete recovery session
      deleteRecoverySession();

      // Find and delete all .env.*.decrypted files in cwd
      const cwd = process.cwd();
      // Best-effort cleanup of decrypted files
      const deleted = removeInOrder(cwd, decryptedNames(cwd)).length;

      console.log(`\n  ✓ Recovery session ended.`);
      if (deleted > 0) {
        console.log(`  ✓ Removed ${deleted} decrypted file(s).`);
      }
      console.log('');
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /**
   * There is nothing to close.
   *
   * This state is reached with plaintext still lying in the directory — a
   * session cleared some other way leaves its `.env.*.decrypted` files behind
   * — and `capy end-recover` used to print "No recovery session active" over
   * the top of them and exit, so the files read as swept.
   *
   * Naming them is a report, not a sweep: nothing is deleted here.
   */
  private reportNoSession(): void {
    console.log('\n  No recovery session active.\n');

    const cwd = process.cwd();
    const left = listDecryptedFiles(cwd);
    if (left.length === 0) return;

    console.log(
      `  ${left.length === 1 ? 'One decrypted file is' : `${left.length} decrypted files are`} still here, left by a session that is already closed:`,
    );
    for (const f of left) console.log(`    ${f.name}`);
    console.log(`\n  They are readable plaintext in ${bold(cwd)}. Delete them by hand.\n`);
  }
}
