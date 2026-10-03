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

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class DecryptCommand {
  async execute(): Promise<void> {
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

      // The whole trial, as one function. Returns null when no known KDF
      // version opened this .env — which is the same condition the terminal
      // path calls a wrong seed phrase.
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
      const writeDecrypted = (values: Record<string, string>): void => {
        const content = Object.entries(values)
          .map(([key, value]) => `${key}=${dotenvEscape(value)}`)
          .join('\n');
        writeFileSync(join(process.cwd(), outputFile), content + '\n', 'utf-8');
        fm.updateGitignore(['.env.*.decrypted']);
      };

      const decryptFromSession = (): Record<string, string> => {
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
        try {
          return decryptWith(session.master_key);
        } catch (error: any) {
          if (error?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH) return wrongSeedExit();
          throw error;
        }
      };

      const decryptFromPrompt = async (): Promise<Record<string, string>> => {
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

        saveRecoverySession(resolved.hex, orgId);
        console.log('  ✓ Recovery session started');
        return resolved.decrypted;
      };

      const decrypted = isRecoveryActive() ? decryptFromSession() : await decryptFromPrompt();

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
      await displayErrorAndExit(error);
    }
  }
}
