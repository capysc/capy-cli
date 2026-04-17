import { readdirSync, unlinkSync } from 'fs';
import {
  isRecoveryActive,
  deleteRecoverySession,
} from '../config/globalConfig';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class EndRecoverCommand {
  async execute(): Promise<void> {
    try {
      if (!isRecoveryActive()) {
        console.log('\n  No recovery session active.\n');
        return;
      }

      // Delete recovery session
      deleteRecoverySession();

      // Find and delete all .env.*.decrypted files in cwd
      const cwd = process.cwd();
      const pattern = /^\.env\..*\.decrypted$/;
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
}
