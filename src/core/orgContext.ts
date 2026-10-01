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
 *
 * `nonTty` forces `authenticate()`'s non-interactive refusal (CAP-520/
 * CAP-659) even on a real TTY — threaded through from callers that have a
 * `--non-tty` flag. Without it, silent auth is always tried first (above),
 * and the interactive fallback below only runs when there's actually no
 * terminal to run it on. On that refusal, `authenticate()` throws a
 * `CapyError(AUTH_NEEDS_TTY)` rather than returning a failure — it
 * propagates out of this function uncaught (there is nothing for it to
 * special-case into here, since callers vary in whether they're `--json`),
 * so every caller wraps its own call with `withAuthNeedsTtyExit()`.
 */
export async function resolveOrgContext(
  apiUrl: string | undefined,
  devMode: boolean,
  nonTty?: boolean,
): Promise<OrgContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  const authService = new AuthService(apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  let orgId = projectState.organizationId;
  let authResult = await authService.authenticateSilent(orgId);
  if (!authResult.success) authResult = await authService.authenticateSilent();
  if (!authResult.success) authResult = await authService.authenticate(orgId, nonTty);
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
    if (!authResult.success) authResult = await authService.authenticate(orgId, nonTty);
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
