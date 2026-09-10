import { CapyError } from '../types';

export type InitRunTransportMode = 'hosted' | 'local';

/** Ordinary --web converges on hosted; local is an explicit pre-run rollback choice. */
export function resolveInitRunTransportMode(value: string | undefined): InitRunTransportMode {
  if (value === undefined || value === '' || value === 'hosted') return 'hosted';
  if (value === 'local') return 'local';
  throw new CapyError('CAPY_INIT_TRANSPORT must be hosted or local', 'INIT_RUN_CONFIGURATION');
}
