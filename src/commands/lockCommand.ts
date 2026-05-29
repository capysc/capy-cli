import { isLocalOnly } from '../config/profileConfig';
import { isLocalUnlocked, clearLocalSession } from '../config/globalConfig';
import { getLocalLockTimeoutMs } from '../config/profileConfig';

/**
 * `capy lock` — clear the cached local-only key, forcing the next command to
 * re-prompt for the passphrase. The mirror of the recovery-session
 * `capy end-recover`. Only meaningful in local-only mode.
 *
 * There is intentionally no `capy unlock`: unlocking happens on demand
 * whenever a command needs the key.
 */
export class LockCommand {
  async execute(): Promise<void> {
    if (!isLocalOnly()) {
      console.log('\n  `capy lock` only applies in local-only mode.\n');
      return;
    }

    if (!isLocalUnlocked(getLocalLockTimeoutMs())) {
      console.log('\n  Already locked.\n');
      return;
    }

    clearLocalSession();
    console.log('\n  ✓ Local key locked. The next command will ask for your passphrase.\n');
  }
}
