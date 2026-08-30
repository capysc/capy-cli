/**
 * Small helpers shared by every flow-driven CLI entry point.
 *
 * Split out of the (now-deleted) onboard flow's executors so `checkout`
 * (`flowRunCommand.ts`) does not have to import the onboard layer just to
 * reach this one function.
 */
import { ERROR_CODES, SilentAuthFailureCode } from '../types/index';

/**
 * Why a silent auth attempt failed, as a code the service can map to a blocked
 * reason. Off `error_code` — the reason a refresh failed is not the same thing
 * as "not signed in", and answering `auth_declined` for an unreachable service
 * would send someone into a browser round-trip that cannot succeed.
 */
export function codeForSilentAuthFailure(reason: SilentAuthFailureCode | undefined): string {
  if (reason === 'network') return ERROR_CODES.NETWORK_ERROR;
  if (reason === 'server_error') return ERROR_CODES.SERVICE_ERROR;
  if (reason === 'org_not_found') return ERROR_CODES.ORG_NOT_FOUND;
  return ERROR_CODES.AUTH_FAILED;
}
