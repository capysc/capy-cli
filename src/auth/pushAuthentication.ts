import type { AuthService } from './authService';
import { CapyError, ERROR_CODES, type AuthResult } from '../types/index';

export interface PushAuthPolicy {
  readonly nonInteractive?: boolean;
  readonly expectedUserId?: string;
}
type PushAuthService = Pick<AuthService, 'setSessionUserId' | 'authenticateSilent' | 'authenticate'>;

export function verifyPushIdentity(result: AuthResult, policy: PushAuthPolicy): AuthResult {
  if (result.success && policy.expectedUserId && result.user_id !== policy.expectedUserId)
    throw new CapyError('The CLI is signed in as a different user. Connect the requested account before pushing.', ERROR_CODES.AUTH_FAILED);
  return result;
}

/** Existing interactive fallback is retained only for an explicitly interactive caller. */
export async function authenticatePush(auth: PushAuthService, organizationId: string | undefined, policy: PushAuthPolicy = {}): Promise<AuthResult> {
  if (policy.expectedUserId) auth.setSessionUserId(policy.expectedUserId);
  const scoped = verifyPushIdentity(await auth.authenticateSilent(organizationId), policy);
  if (scoped.success) return scoped;
  const unscoped = verifyPushIdentity(await auth.authenticateSilent(), policy);
  if (unscoped.success) return unscoped;
  if (policy.nonInteractive) throw new CapyError('No matching CLI session is available. Sign in before retrying this push.', ERROR_CODES.AUTH_FAILED);
  return verifyPushIdentity(await auth.authenticate(organizationId), policy);
}
