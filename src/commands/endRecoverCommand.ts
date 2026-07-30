import { readdirSync, statSync, unlinkSync } from 'fs';
import {
  isRecoveryActive,
  deleteRecoverySession,
  getRecoverySessionPath,
  readRecoverySession,
} from '../config/globalConfig';
import { formatRelativeTime } from '../ui/relativeTime';
import type { DecryptedFile, RemovalOutcome } from '../ui/screens/contract';

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
  let names: string[];
  try {
    names = readdirSync(cwd).filter(n => DECRYPTED_FILE_PATTERN.test(n)).sort();
  } catch {
    return [];
  }

  return names.map(name => {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface EndRecoverOptions {
  /**
   * Preview the sweep in a browser instead of performing it unannounced.
   *
   * The terminal form deletes `~/.capy/recover` and every matching file with
   * no confirmation, no preview and no per-file result. That path is unchanged
   * below. What `--web` adds is the chance to see the list first and untick
   * something — and a report of what actually happened, which the terminal
   * cannot give because it swallows unlink failures and prints ✓ regardless.
   */
  web?: boolean;
}

export class EndRecoverCommand {
  async execute(options: EndRecoverOptions = {}): Promise<void> {
    try {
      if (options.web) {
        await this.executeInBrowser();
        return;
      }

      if (!isRecoveryActive()) {
        console.log('\n  No recovery session active.\n');
        return;
      }

      // Delete recovery session
      deleteRecoverySession();

      // Find and delete all .env.*.decrypted files in cwd
      const cwd = process.cwd();
      const pattern = DECRYPTED_FILE_PATTERN;
      let deleted = 0;

      try {
        const files = readdirSync(cwd);
        for (const file of files) {
          if (pattern.test(file)) {
            unlinkSync(`${cwd}/${file}`);
            console.log(`  Removed ${file}`);
            deleted++;
          }
        }
      } catch {
        // Best-effort cleanup of decrypted files
      }

      console.log(`\n  ✓ Recovery session ended.`);
      if (deleted > 0) {
        console.log(`  ✓ Removed ${deleted} decrypted file(s).`);
      }
      console.log('');
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  /**
   * The sweep, shown before it happens.
   *
   * Two things differ from the terminal form, and both are consequences of
   * there being a page at all rather than of `--web` deciding anything:
   *
   *   - a directory holding plaintext with NO session open is offered the
   *     sweep. The terminal returns early there, so files written by a session
   *     that was cleared some other way sit in the working directory forever
   *     and `capy end-recover` says "No recovery session active" over the top
   *     of them. Nothing is removed without being ticked.
   *   - files that could not be removed are reported. The terminal swallows
   *     the failure and still prints ✓, which is the one outcome where the
   *     user needs to know the plaintext is still there.
   */
  private async executeInBrowser(): Promise<void> {
    const cwd = process.cwd();
    const files = listDecryptedFiles(cwd);
    const active = isRecoveryActive();

    if (!active && files.length === 0) {
      // Nothing to ask about, so no browser: the screen for this state draws
      // no control, and opening a page with no way out of it is worse than
      // the sentence the terminal already prints.
      console.log('\n  No recovery session active.\n');
      return;
    }

    const { endRecoverInBrowser } = await import('../ui/recoveryScreens');
    const answer = await endRecoverInBrowser({
      session: active ? readSessionSummary() : undefined,
      cwd,
      files,
      // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
      // headless verification drive the loopback without hijacking a real one.
      open: !process.env.CAPY_WEB_NO_OPEN,
    });

    if (answer.cancelled) {
      console.log('\n  Cancelled. Nothing was removed.\n');
      return;
    }

    let sessionCleared = false;
    if (answer.endSession) {
      try {
        deleteRecoverySession();
        sessionCleared = true;
      } catch (err: any) {
        // `deleteRecoverySession` sits outside the terminal path's best-effort
        // try, so an EPERM there escapes as a raw error screen. Here the sweep
        // has already been agreed to and the files still deserve their turn.
        console.log(`\n  Could not clear the recovery session: ${err?.message || err}`);
        console.log(`  It is at ${bold(getRecoverySessionPath())} — remove it by hand.`);
      }
    }

    const outcomes: RemovalOutcome[] = answer.remove.map(name => {
      try {
        unlinkSync(`${cwd}/${name}`);
        console.log(`  Removed ${name}`);
        return { name, removed: true };
      } catch (err: any) {
        return { name, removed: false, reason: err?.message || String(err) };
      }
    });

    const removed = outcomes.filter(o => o.removed).length;
    const failed = outcomes.filter(o => !o.removed);
    const kept = files.length - answer.remove.length;

    console.log('');
    if (sessionCleared) {
      console.log('  ✓ Recovery session ended.');
    } else if (!answer.endSession) {
      // There was none to end. Said plainly, because this run swept a
      // directory the terminal form would have refused to look at.
      console.log('  No recovery session was open — only files were swept.');
    }
    if (removed > 0) {
      console.log(`  ✓ Removed ${removed} decrypted file(s).`);
    }
    for (const f of failed) {
      console.log(`  ✗ Could not remove ${f.name} — it still holds readable secrets (${f.reason}).`);
    }
    if (kept > 0) {
      console.log(`  ${kept} file(s) kept on purpose. They stay in ${cwd} as readable plaintext.`);
    }
    console.log('');
  }
}

/**
 * What the session file can say about itself, offline.
 *
 * `end-recover` never authenticates — that is the point of it — so the
 * organization's NAME is not knowable here. The id the session was written
 * with is the honest thing to show; inventing a name would mean a network call
 * in a command whose whole job is to work when nothing else does.
 *
 * The session file also holds the cached master key. It is read here and only
 * `org_id` and `created_at` are taken off it; the key never leaves this
 * function and is never returned, printed or serialised.
 */
function readSessionSummary(): { orgName: string; startedAt: string } | undefined {
  const session = readRecoverySession() as
    | { org_id?: string; created_at?: string }
    | null;
  if (!session) return undefined;
  return {
    orgName: session.org_id || 'unknown organization',
    startedAt: session.created_at ? formatRelativeTime(session.created_at) : 'unknown',
  };
}
