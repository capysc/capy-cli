import { basename } from 'path';
import { isStagingEntrypoint } from '../../config/stagingTarget';
import type { RuntimeCustodyEnvironment } from './runtimeCustodyProvider';

/** Match the existing entrypoint/state-home split; never infer from a browser URL. */
export function runtimePairingEnvironment(devMode: boolean = false): RuntimeCustodyEnvironment {
  if (isStagingEntrypoint()) return 'staging';
  // Nested grant recovery has no command-level devMode argument. Honor the
  // executed development entrypoint, just as staging is pinned above.
  const developmentEntrypoint = basename(process.argv[1] ?? '') === 'capy-dev';
  return devMode || developmentEntrypoint || process.env.CAPY_GLOBAL_DIR_NAME === '.capy-dev' ? 'development' : 'production';
}
