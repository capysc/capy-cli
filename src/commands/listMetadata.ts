import { CapyError, ERROR_CODES, type AuthResult, type KeepFile } from '../types/index';

export interface ListMetadataDependencies {
  readonly authenticate: (orgId?: string) => Promise<AuthResult>;
  readonly projects: () => Promise<readonly { readonly id: string; readonly name: string; readonly organization_id: string }[]>;
}

export async function requireListIdentity(deps: Pick<ListMetadataDependencies, 'authenticate'>, expectedUserId?: string, orgId?: string): Promise<AuthResult> {
  if (expectedUserId !== undefined && expectedUserId.trim().length === 0) {
    throw new CapyError('No matching signed-in session. Ask your agent to reconnect Capy.', ERROR_CODES.AUTH_FAILED);
  }
  const auth = await deps.authenticate(orgId);
  if (!auth.success || !auth.user_id || (expectedUserId !== undefined && auth.user_id !== expectedUserId)) {
    throw new CapyError('No matching signed-in session. Ask your agent to reconnect Capy.', ERROR_CODES.AUTH_FAILED);
  }
  return auth;
}

export async function createListMetadataDependencies(devMode: boolean, expectedUserId?: string): Promise<ListMetadataDependencies> {
  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const auth = new AuthService(undefined, devMode, expectedUserId);
  const service = new ServiceClient(undefined, devMode);
  service.setTokenProvider(() => auth.getValidToken());
  return {
    authenticate: (orgId) => auth.authenticateSilent(orgId),
    projects: () => service.listProjects(),
  };
}
