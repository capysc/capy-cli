import inquirer from 'inquirer';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from './projectManager';
import { CapyError, ERROR_CODES } from '../types/index';
import type { AuthResult, Organization } from '../types/index';

export interface OrgContext {
  orgId: string;
  /** The organization's name as the sign-in session lists it; the id when the session does not list it. */
  orgName: string;
  userId: string;
  userEmail?: string;
  authService: AuthService;
  serviceClient: ServiceClient;
}

export interface OrgContextOptions {
  /**
   * Whether to ask which organization when this folder has none and the person belongs to several. Default true.
   * `false` (agent mode): refuse with `ORG_SELECTION_REQUIRED` instead of opening a prompt.
   */
  readonly promptForOrg?: boolean;
}

/** Silent session scoped to `orgId`, else a silent session for any org, else a full sign-in scoped to `orgId`. */
async function authenticateScoped(authService: AuthService, orgId: string | undefined): Promise<AuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success) return scopedSilent;
  const plainSilent = await authService.authenticateSilent();
  if (plainSilent.success) return plainSilent;
  return authService.authenticate(orgId);
}

/** Silent session scoped to `orgId`, else a full sign-in scoped to `orgId`. */
async function authenticateForOrg(authService: AuthService, orgId: string): Promise<AuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success) return scopedSilent;
  return authService.authenticate(orgId);
}

/** Exits with a message when the sign-in failed; otherwise returns the result. */
function succeededOrExit(result: AuthResult, message: string): AuthResult {
  if (result.success) return result;
  console.error(message);
  return process.exit(1);
}

/** The one organization to use: the only one, or the one the person picks. Exits when there is none. */
async function chooseOrg(orgs: readonly Organization[], promptForOrg: boolean): Promise<string> {
  if (orgs.length === 0) {
    console.error('No organizations available. Run `capy` to create one.');
    return process.exit(1);
  }
  if (orgs.length === 1) return orgs[0].id;
  if (!promptForOrg) {
    throw new CapyError(
      'More than one organization is available and this folder has none. Run `capy` here, or run the command in a terminal.', // COPY-FLAG
      ERROR_CODES.ORG_SELECTION_REQUIRED,
      { orgs: orgs.map((o) => ({ id: o.id, name: o.name })) },
    );
  }
  const { chosen } = await inquirer.prompt([{
    type: 'list',
    name: 'chosen',
    message: 'Select organization:',
    choices: orgs.map(o => ({ name: o.name, value: o.id })),
  }]);
  return chosen;
}

/** The org's name from whichever session result lists it; the id when none does. */
function orgNameOf(orgId: string, results: readonly AuthResult[]): string {
  const listed = results.flatMap((r) => r.organizations ?? []).find((o) => o.id === orgId)?.name;
  const own = results.find((r) => r.organization_id === orgId)?.organization_name;
  return listed ?? own ?? orgId;
}

/**
 * Resolve org context for org-level commands (invite, kick, users).
 * Prefers keep.lock when present; otherwise authenticates via cached session
 * and picks (or prompts for) an organization. Does not require a project.
 */
export async function resolveOrgContext(
  apiUrl: string | undefined,
  devMode: boolean,
  options: OrgContextOptions = {},
): Promise<OrgContext> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();

  const authService = new AuthService(apiUrl, devMode, projectState.userId);
  const serviceClient = new ServiceClient(apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());

  const folderOrgId = projectState.organizationId;
  const first = succeededOrExit(
    await authenticateScoped(authService, folderOrgId),
    'Authentication failed. Run `capy` to sign in.',
  );

  // The folder's own org wins; with none, the only org, or the one the person picks.
  const orgId = folderOrgId ? folderOrgId : await chooseOrg(first.organizations || [], options.promptForOrg !== false);
  const scoped = folderOrgId
    ? first
    : succeededOrExit(await authenticateForOrg(authService, orgId), 'Authentication failed for selected organization.');

  return {
    orgId,
    orgName: orgNameOf(orgId, [scoped, first]),
    userId: scoped.user_id!,
    userEmail: scoped.user_email,
    authService,
    serviceClient,
  };
}
