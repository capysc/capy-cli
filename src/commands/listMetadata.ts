import { CapyError, ERROR_CODES, type AuthResult, type KeepFile } from '../types/index';

export interface ListMetadataDependencies {
  readonly authenticate: (orgId?: string) => Promise<AuthResult>;
  readonly billing: () => Promise<{ readonly tier: string; readonly grandfathered?: boolean }>;
  readonly projects: () => Promise<readonly { readonly id: string; readonly name: string; readonly organization_id: string }[]>;
  readonly snapshot: (projectId: string, branch: string) => Promise<{ readonly keep_file?: string }>;
}

export async function requireListIdentity(deps: Pick<ListMetadataDependencies, 'authenticate'>, expectedUserId?: string, orgId?: string): Promise<AuthResult> {
  const auth = await deps.authenticate(orgId);
  if (!auth.success || !auth.user_id || (expectedUserId && auth.user_id !== expectedUserId)) {
    throw new CapyError('No matching signed-in session. Ask your agent to reconnect Capy.', ERROR_CODES.AUTH_FAILED);
  }
  return auth;
}

/** Names-only resolution: no local env input, key resolution, or decryption. */
export async function resolveListMetadata(deps: ListMetadataDependencies, expectedUserId?: string): Promise<{ readonly keep: KeepFile; readonly branch: string }> {
  const auth = await requireListIdentity(deps, expectedUserId);
  const billing = await deps.billing();
  if (billing.tier === 'business' || billing.grandfathered) {
    throw new CapyError('This repository has no keep.lock. Complete project selection in Capy setup first.', ERROR_CODES.PROJECT_NOT_FOUND);
  }
  const orgId = auth.organization_id ?? (auth.organizations?.length === 1 ? auth.organizations[0]?.id : undefined);
  if (!orgId) throw new CapyError('Select an organization in Capy before listing variables.', ERROR_CODES.ORG_AMBIGUOUS);
  const matches = (await deps.projects()).filter((project) => project.organization_id === orgId && project.name === 'default');
  if (matches.length !== 1) throw new CapyError('A unique default project is required. Complete Capy setup first.', ERROR_CODES.PROJECT_NOT_FOUND);
  const project = matches[0]!;
  const branch = 'development';
  const snapshot = await deps.snapshot(project.id, branch);
  const keep: KeepFile = snapshot.keep_file
    ? JSON.parse(snapshot.keep_file)
    : { version: '3.0', org_id: orgId, project_id: project.id, project_name: project.name, variables: {} };
  if (keep.org_id !== orgId || keep.project_id !== project.id) {
    throw new CapyError('Remote project metadata does not match the selected project.', ERROR_CODES.PERMISSION_DENIED);
  }
  return { keep, branch };
}

export async function createListMetadataDependencies(devMode: boolean, expectedUserId?: string): Promise<ListMetadataDependencies> {
  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const auth = new AuthService(undefined, devMode, expectedUserId);
  const service = new ServiceClient(undefined, devMode);
  service.setTokenProvider(() => auth.getValidToken());
  return {
    authenticate: (orgId) => auth.authenticateSilent(orgId),
    billing: () => service.getBillingStatus(),
    projects: () => service.listProjects(),
    snapshot: (projectId, branch) => service.getDecryptData(projectId, branch),
  };
}
