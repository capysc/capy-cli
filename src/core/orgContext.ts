import inquirer from 'inquirer';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from './projectManager';

export interface OrgContext {
  orgId: string;
  userId: string;
  userEmail?: string;
  authService: AuthService;
  serviceClient: ServiceClient;
}

/**
 * Resolve org context for org-level commands (invite, kick, users).
 * Prefers keep.lock when present; otherwise authenticates via cached session
 * and picks (or prompts for) an organization. Does not require a project.
 */
export async function resolveOrgContext(
  apiUrl: string | undefined,
  devMode: boolean,
): Promise<OrgContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  const authService = new AuthService(apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(apiUrl);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  let orgId = projectState.organizationId;
  let authResult = await authService.authenticateSilent(orgId);
  if (!authResult.success) authResult = await authService.authenticateSilent();
  if (!authResult.success) authResult = await authService.authenticate(orgId);
  if (!authResult.success) {
    console.error('Authentication failed. Run `capy` to sign in.');
    process.exit(1);
  }

  if (!orgId) {
    const orgs = authResult.organizations || [];
    if (orgs.length === 0) {
      console.error('No organizations available. Run `capy` to create one.');
      process.exit(1);
    } else if (orgs.length === 1) {
      orgId = orgs[0].id;
    } else {
      const { chosen } = await inquirer.prompt([{
        type: 'list',
        name: 'chosen',
        message: 'Select organization:',
        choices: orgs.map(o => ({ name: o.name, value: o.id })),
      }]);
      orgId = chosen;
    }

    authResult = await authService.authenticateSilent(orgId);
    if (!authResult.success) authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed for selected organization.');
      process.exit(1);
    }
  }

  return {
    orgId: orgId!,
    userId: authResult.user_id!,
    userEmail: authResult.user_email,
    authService,
    serviceClient,
  };
}
