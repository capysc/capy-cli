import { writeFileSync } from 'fs';
import { join } from 'path';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { dotenvEscape } from './exportCommand';
import {
  validateSeedPhrase,
  seedPhraseToMasterKey,
  deriveProjectKey,
  KDF_VERSIONS,
} from '../crypto/keyManager';
import {
  isRecoveryActive,
  readRecoverySession,
  saveRecoverySession,
} from '../config/globalConfig';
import { ERROR_CODES } from '../types/index';
import { formatRelativeTime } from '../ui/relativeTime';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * How long the open recovery session has been open, humanised.
 *
 * `saveRecoverySession` writes `created_at` and `readRecoverySession`'s return
 * type does not mention it, so it is read defensively: a session file written
 * by an older CLI has no stamp, and a stop that cannot say when says nothing
 * rather than "Invalid Date".
 */
function sessionAge(session: { org_id: string; master_key: string }): string {
  const createdAt = (session as { created_at?: unknown }).created_at;
  return typeof createdAt === 'string' ? formatRelativeTime(createdAt) : '—';
}

export interface DecryptOpts {
  /**
   * Ask for the phrase in a browser instead of on this terminal.
   *
   * Agent-only. A seed phrase typed at an inquirer password prompt is fine
   * when a human is at the keyboard; headless, that prompt blocks on a piped
   * stdin and then — at EOF — prints `Cancelled.` and exits 0, which an agent
   * reads as a decrypt that succeeded and wrote nothing.
   */
  web?: boolean;
  /** false when --no-open was passed: print the URL, do not open a browser. */
  open?: boolean;
}

export class DecryptCommand {
  async execute(opts: DecryptOpts = {}): Promise<void> {
    try {
      const pm = new ProjectManager();
      const fm = new FileManager();

      // Require keep.lock
      const keep = pm.readKeepFile();
      if (!keep) {
        console.error(`\n  No keep.lock file found. Run ${bold('capy')} first to initialize.\n`);
        process.exit(1);
      }

      const orgId = keep.org_id;
      const projectId = keep.project_id;
      const branch = pm.deriveActiveBranch();
      if (!branch) {
        console.error(`\n  No active branch. Run ${bold('capy')} to select a branch.\n`);
        process.exit(1);
      }

      // Belt-and-suspenders: if .env has metadata headers, verify they match keep.lock.
      // AES-GCM would catch a mismatch via auth tag failure, but this gives a clearer
      // error for the "wrong .env in wrong dir" case (e.g. accidental copy from another project).
      const envMeta = fm.readEnvMeta();
      if (envMeta.org_id && envMeta.org_id !== orgId) {
        console.error(
          `\n  .env was encrypted for a different organization.` +
          `\n  .env org: ${envMeta.org_id}` +
          `\n  keep.lock org: ${orgId}` +
          `\n\n  This .env cannot be decrypted in this project.\n`
        );
        process.exit(1);
      }
      if (envMeta.project_id && envMeta.project_id !== projectId) {
        console.error(
          `\n  .env was encrypted for a different project.` +
          `\n  .env project: ${envMeta.project_id}` +
          `\n  keep.lock project: ${projectId}` +
          `\n\n  This .env cannot be decrypted in this project.\n`
        );
        process.exit(1);
      }

      // Decrypt the .env with the master key M. `decryptWith` derives the
      // project key from a candidate M and decrypts; it throws "different
      // project's key" if M is wrong for this project.
      const decryptWith = (mkHex: string): Record<string, string> => {
        const projectKey = deriveProjectKey(Buffer.from(mkHex, 'hex'), projectId, orgId);
        return fm.readEncryptedEnvFile(projectKey);
      };
      const wrongSeedExit = (): never => {
        console.error(
          `\n  Decryption failed. Double-check your seed phrase — a single wrong word` +
          `\n  produces a completely different key.` +
          `\n\n  If you have multiple orgs, make sure you're using the right seed` +
          `\n  phrase for this org.\n`
        );
        process.exit(1);
      };

      // Resolve M and decrypt. A cached recovery session already holds the
      // resolved M (its KDF version was determined on first use). For a freshly
      // entered phrase the org's KDF version is unknown, so we trial each known
      // version against the encrypted .env (the oracle) and keep the one that
      // decrypts — this is how legacy (v1) and current (v2) orgs are told apart
      // without any stored version marker.
      let masterKeyHex: string;
      let decrypted: Record<string, string>;

      // The whole trial, as one function, because `--web` needs to run it per
      // submitted phrase rather than once at the top of the command. Returns
      // null when no known KDF version opened this .env — which is the same
      // condition the terminal path calls a wrong seed phrase.
      const resolveFromPhrase = (
        seedPhrase: string,
      ): { hex: string; decrypted: Record<string, string> } | null => {
        for (const version of KDF_VERSIONS) {
          const mkHex = seedPhraseToMasterKey(seedPhrase, version).toString('hex');
          try {
            return { hex: mkHex, decrypted: decryptWith(mkHex) };
          } catch (error: any) {
            if (error?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH) continue;
            throw error;
          }
        }
        return null;
      };

      // Write .env.{branch}.decrypted. Escape values so multi-line secrets
      // (PEM keys, certs) are quoted/`\n`-escaped and survive being re-read by
      // dotenv — a bare `KEY=value` line would truncate at the first newline.
      const outputFile = `.env.${branch}.decrypted`;
      const writeDecrypted = (values: Record<string, string>): number => {
        const content = Object.entries(values)
          .map(([key, value]) => `${key}=${dotenvEscape(value)}`)
          .join('\n');
        writeFileSync(join(process.cwd(), outputFile), content + '\n', 'utf-8');
        fm.updateGitignore(['.env.*.decrypted']);
        return Object.keys(values).length;
      };

      if (opts.web) {
        // The phrase is asked for in the browser. It reaches this process once,
        // in the body of one loopback POST, and is not held past the attempt
        // that uses it — never printed, never logged, never in a payload.
        const session = isRecoveryActive() ? readRecoverySession() : null;
        if (isRecoveryActive() && !session) {
          console.error('\n  Recovery session is corrupt. Run `capy end-recover` and try again.\n');
          process.exit(1);
        }
        if (session && session.org_id !== orgId) {
          console.error(
            `\n  Recovery session is for a different org.` +
            `\n  Run ${bold('capy end-recover')} first, then try again.\n`
          );
          process.exit(1);
        }

        const { decryptInBrowser, showDecryptResult } = await import('../ui/decryptScreen');
        const { isLocalOnly } = await import('../config/profileConfig');
        const params = {
          projectName: keep.project_name,
          branch,
          outputFile,
          session: session
            ? {
                // The session file holds an org id and no name, and inventing
                // one would be the screen claiming knowledge the CLI does not
                // have. The id is what identifies the org here.
                orgName: session.org_id,
                startedAt: sessionAge(session),
              }
            : undefined,
          localOnly: isLocalOnly(),
          // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
          // headless runs drive the loopback without hijacking a real browser.
          open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN,
        };

        const outcome = await decryptInBrowser(params, async (input) => {
          let values: Record<string, string>;
          if ('useSession' in input) {
            try {
              values = decryptWith(session!.master_key);
            } catch (error: any) {
              if (error?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH) {
                return { ok: false, reason: 'KEY_MISMATCH' };
              }
              throw error;
            }
          } else {
            if (!validateSeedPhrase(input.phrase)) return { ok: false, reason: 'INVALID' };
            const resolved = resolveFromPhrase(input.phrase);
            if (!resolved) return { ok: false, reason: 'KEY_MISMATCH' };
            values = resolved.decrypted;
            saveRecoverySession(resolved.hex, orgId);
            console.log('  ✓ Recovery session started');
          }

          // An .env with no `capy:` values in it has nothing to decrypt. Not a
          // failure: the terminal exits 0 here and writes no file.
          if (Object.keys(values).length === 0) return { ok: true, count: 0, wrote: false };
          return { ok: true, count: writeDecrypted(values), wrote: true };
        });

        if (outcome.action === 'cancelled') {
          // Three ways to refuse and one outcome: nothing on disk changed. The
          // sentence differs because "the browser never answered" is not a
          // thing the person did, and used to arrive as a thrown error on a
          // command that had done no harm.
          const why =
            outcome.reason === 'timeout'
              ? 'The browser never answered.'
              : outcome.reason === 'closed'
                ? 'Browser closed.'
                : 'Cancelled.';
          console.log(`\n  ${why} Nothing was decrypted.\n`);
          return;
        }
        if (!outcome.wrote) {
          console.log('\n  No encrypted secrets found in .env\n');
        } else {
          console.log(`  ✓ Decrypted ${outcome.count} secret(s) to ${bold(outputFile)}`);
          console.log(`\n  Run ${bold('capy end-recover')} when done to clean up.\n`);
        }
        await showDecryptResult(params, { count: outcome.count, wrote: outcome.wrote });
        return;
      }

      if (isRecoveryActive()) {
        const session = readRecoverySession();
        if (!session) {
          console.error('\n  Recovery session is corrupt. Run `capy end-recover` and try again.\n');
          process.exit(1);
        }
        if (session.org_id !== orgId) {
          console.error(
            `\n  Recovery session is for a different org.` +
            `\n  Run ${bold('capy end-recover')} first, then try again.\n`
          );
          process.exit(1);
        }
        masterKeyHex = session.master_key;
        try {
          decrypted = decryptWith(masterKeyHex);
        } catch (error: any) {
          if (error?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH) wrongSeedExit();
          throw error;
        }
      } else {
        // Prompt for seed phrase
        const inquirer = (await import('inquirer')).default;
        const { seedPhrase } = await inquirer.prompt([{
          type: 'password',
          name: 'seedPhrase',
          message: 'Enter your 24-word seed phrase:',
          mask: '*',
        }]);

        if (!validateSeedPhrase(seedPhrase)) {
          console.error('\n  Invalid seed phrase. Must be 24 words from the BIP-39 wordlist.\n');
          process.exit(1);
        }

        const resolved = resolveFromPhrase(seedPhrase);
        if (!resolved) return wrongSeedExit();

        masterKeyHex = resolved.hex;
        decrypted = resolved.decrypted;
        saveRecoverySession(masterKeyHex, orgId);
        console.log('  ✓ Recovery session started');
      }

      if (Object.keys(decrypted).length === 0) {
        console.log('\n  No encrypted secrets found in .env\n');
        process.exit(0);
      }

      writeDecrypted(decrypted);

      console.log(`  ✓ Decrypted ${Object.keys(decrypted).length} secret(s) to ${bold(outputFile)}`);
      console.log(`\n  Run ${bold('capy end-recover')} when done to clean up.\n`);
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') {
        console.log('\nCancelled.');
        process.exit(0);
      }
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}
