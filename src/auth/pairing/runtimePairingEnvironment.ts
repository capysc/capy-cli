import { isStagingEntrypoint } from '../../config/stagingTarget';
import type { RuntimeCustodyEnvironment } from './runtimeCustodyProvider';

/** Match the existing entrypoint/state-home split; never infer from a browser URL. */
export function runtimePairingEnvironment(devMode: boolean = false): RuntimeCustodyEnvironment {
  if (isStagingEntrypoint()) return 'staging';
  return devMode || process.env.CAPY_GLOBAL_DIR_NAME === '.capy-dev' ? 'development' : 'production';
}
