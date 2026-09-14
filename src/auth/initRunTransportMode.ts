import { CapyError } from '../types';

export type InitRunTransportMode = 'hosted' | 'local';

/** Ordinary --web converges on hosted; local is an explicit pre-run rollback choice. */
export function resolveInitRunTransportMode(value: string | undefined): InitRunTransportMode {
  if (value === undefined || value === '' || value === 'hosted') return 'hosted';
  if (value === 'local') return 'local';
  throw new CapyError('CAPY_INIT_TRANSPORT must be hosted or local', 'INIT_RUN_CONFIGURATION');
}

/**
 * The development launcher opts into the complete remote onboarding transport.
 * This keeps a plain `capy-dev` first run on the same signup and custody path
 * as `capy-dev --web`, while production's terminal-first behavior remains
 * unchanged until its own rollout enables the flag.
 */
export function usesHostedInitTransport(web: boolean, flowOnboard: string | undefined): boolean {
  return web || flowOnboard === '1';
}
