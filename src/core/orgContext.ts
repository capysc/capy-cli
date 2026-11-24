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
  /**
   * `true` (agent mode): no browser sign-in is ever started, and a sign-in that failed, or an account with no
   * organization, is thrown as a `CapyError` with a code (the same sentences) instead of a sentence on stderr and
   * `process.exit(1)`. Default false.
   */
  readonly agentMode?: boolean;
}

/** Silent session scoped to `orgId`, else a silent session for any org, else a full sign-in scoped to `orgId` (agent mode: the failure instead). */
async function authenticateScoped(authService: AuthService, orgId: string | undefined, agentMode: boolean): Promise<AuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success) return scopedSilent;
  const plainSilent = await authService.authenticateSilent();
  if (plainSilent.success || agentMode) return plainSilent;
  return authService.authenticate(orgId);
}

/** Silent session scoped to `orgId`, else a full sign-in scoped to `orgId` (agent mode: the failure instead). */
async function authenticateForOrg(authService: AuthService, orgId: string, agentMode: boolean): Promise<AuthResult> {
  const scopedSilent = await authService.authenticateSilent(orgId);
  if (scopedSilent.success || agentMode) return scopedSilent;
  return authService.authenticate(orgId);
}

/** Exits with a message when the sign-in failed (throws it, coded, when `coded`); otherwise returns the result. */
function succeededOrExit(result: AuthResult, message: string, coded: boolean): AuthResult {
  if (result.success) return result;
  if (coded) throw new CapyError(message, ERROR_CODES.AUTH_FAILED);
  console.error(message);
  return process.exit(1);
}

/** The one organization to use: the only one, or the one the person picks. Exits when there is none (throws, coded, when `coded`). */
async function chooseOrg(orgs: readonly Organization[], promptForOrg: boolean, coded: boolean): Promise<string> {
  if (orgs.length === 0) {
    const none = 'No organizations available. Run `capy` to create one.';
    if (coded) throw new CapyError(none, ERROR_CODES.ORG_NOT_FOUND);
    console.error(none);
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
  serviceClient.setTokenProvider((rejected, refusal) => authService.getValidToken(rejected, refusal));

  const folderOrgId = projectState.organizationId;
  const coded = options.agentMode === true;
  const first = succeededOrExit(
    await authenticateScoped(authService, folderOrgId, coded),
    'Authentication failed. Run `capy` to sign in.',
    coded,
  );

  // The folder's own org wins; with none, the only org, or the one the person picks.
  const orgId = folderOrgId ? folderOrgId : await chooseOrg(first.organizations || [], options.promptForOrg !== false, coded);
  const scoped = folderOrgId
    ? first
    : succeededOrExit(await authenticateForOrg(authService, orgId, coded), 'Authentication failed for selected organization.', coded);

  return {
    orgId,
    orgName: orgNameOf(orgId, [scoped, first]),
    userId: scoped.user_id!,
    userEmail: scoped.user_email,
    authService,
    serviceClient,
  };
}
