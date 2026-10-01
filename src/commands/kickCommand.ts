import { resolveOrgContext } from '../core/orgContext';
import { MemberDetail, ServiceClient } from '../service/serviceClient';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { CapyError, ERROR_CODES } from '../types/index';
import { dryRunOk, dryRunExitCode, printDryRunResultHuman, printDryRunResultJson, type DryRunChange } from '../core/dryRun';
import type { WebKickParams } from '../ui/memberScreens';

export interface KickOpts {
  /**
   * Render the confirmation as a compiled screen in a local browser instead of
   * inquirer's one-line confirm.
   *
   * `--web` is a global option on the root program. `src/index.ts` does not
   * read it for `kick` yet, so this path is live and tested but not reachable
   * from argv until whoever owns that file threads `optsWithGlobals().web`
   * through — the same seam `capy checkout` is waiting on.
   */
  web?: boolean;
  /** Skip the confirmation prompt (required non-interactively, unless --web). */
  yes?: boolean;
  /** No prompts: resolve from flags or fail fast (agents/CI). */
  nonTty?: boolean;
  /** Emit machine-readable JSON instead of the human UI. */
  json?: boolean;
  /** CAP-659: preview only — find the member, never call kickMember. */
  dryRun?: boolean;
}

/** Pure JSON refusal on stdout — never on stderr, so `--json` output stays parseable. */
function refuseJson(code: string, error: string, exitCode: number): never {
  console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  process.exit(exitCode);
}

/** Prose refusal on stderr — human mode only. */
function refuseHuman(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function refuse(json: boolean, err: CapyError, exitCode: number = 1): never {
  if (json) refuseJson(err.code, err.message, exitCode);
  refuseHuman(err.message, exitCode);
}

/** Finds the membership by email, or refuses `MEMBER_NOT_FOUND` — coded, same on every path. */
async function findMember(
  serviceClient: ServiceClient,
  orgId: string,
  email: string,
  json: boolean,
): Promise<MemberDetail> {
  const members = await (async (): Promise<MemberDetail[]> => {
    try {
      return (await serviceClient.listMemberDetails(orgId)).members;
    } catch (err: any) {
      refuse(json, new CapyError(`Failed to list members: ${err.message}`, ERROR_CODES.SERVICE_ERROR));
    }
  })();
  const match = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  if (!match) {
    refuse(json, new CapyError(`No member found matching "${email}".`, ERROR_CODES.MEMBER_NOT_FOUND));
  }
  return match;
}

/** Best-effort caller role + id, for the `--web` screen only — never blocks a removal the terminal would have performed. */
async function resolveCallerContext(
  serviceClient: ServiceClient,
  orgId: string,
): Promise<{ callerRole: string; currentUserId: string }> {
  try {
    const me = await serviceClient.getOrgMe(orgId);
    return { callerRole: me.role, currentUserId: me.user_id };
  } catch {
    return { callerRole: 'member', currentUserId: '' };
  }
}

/** The org's display name, re-asked from the cached session — falls back to `orgId` on any failure. */
async function resolveOrgDisplayName(
  authService: { authenticateSilent: (orgId?: string) => Promise<{ organization_name?: string }> },
  orgId: string,
): Promise<string> {
  try {
    const again = await authService.authenticateSilent(orgId);
    return again.organization_name || orgId;
  } catch {
    return orgId;
  }
}

async function confirmInBrowser(params: WebKickParams): Promise<boolean> {
  try {
    const { confirmKickInBrowser } = await import('../ui/memberScreens');
    return await confirmKickInBrowser(params);
  } catch {
    // Closed, timed out, or interrupted. None of those is a yes, and the one
    // thing this flow must never do is read a window nobody answered as
    // agreement to cut somebody off from every secret in the organization.
    return false;
  }
}

async function confirmInTerminal(email: string): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `Remove ${email} from this organization? They will lose access to all secrets.`,
    default: false,
  }]);
  return confirm === true;
}

export class KickCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(email: string, opts: KickOpts = {}): Promise<void> {
    const json = opts.json === true;

    if (opts.dryRun) {
      await this.previewKick(email, opts, json);
      return;
    }

    // Decided before any network call: there is no flag that answers the
    // removal confirm other than --yes (or --web, which asks its own way),
    // so a non-interactive caller without either can never complete this
    // command — refuse fast rather than hang past `resolveOrgContext`.
    if (!opts.yes && !opts.web && !isInteractive(opts.nonTty)) {
      refuse(
        json,
        new CapyError(
          '`capy kick` needs confirmation — pass --yes or run this in a terminal.', // COPY-FLAG
          ERROR_CODES.KICK_NEEDS_TTY,
        ),
        EXIT_NEEDS_INPUT,
      );
    }

    const { orgId, authService, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
    const member = await findMember(serviceClient, orgId, email, json);

    const confirmed = await this.resolveConfirmation(email, opts, member, serviceClient, authService, orgId);
    if (!confirmed) {
      if (json) {
        console.log(JSON.stringify({ ok: true, cancelled: true }, null, 2));
        return;
      }
      console.log('Cancelled.'); // COPY-FLAG
      return;
    }

    try {
      await serviceClient.kickMember(orgId, member.membershipId);
    } catch (err: any) {
      refuse(json, new CapyError(`Failed to remove member: ${err.message}`, ERROR_CODES.SERVICE_ERROR));
    }

    if (json) {
      console.log(JSON.stringify({ ok: true, email, membershipId: member.membershipId }, null, 2));
      return;
    }
    console.log('');
    console.log(`  \x1b[33m${email}\x1b[0m has been removed from the organization.`);
    console.log(`  \x1b[90mMembership ${member.membershipId} deleted.\x1b[0m`);
    console.log('  \x1b[90mThey can no longer co-decrypt secrets.\x1b[0m');
    console.log('');
  }

  /**
   * Confirm. The terminal asks one line, defaulting to No, with the whole
   * consequence folded into the question. Under `--web` it is the
   * `org-members` screen's `confirm-remove` view instead. `--yes` skips
   * asking altogether — the TTY/`--web` gate above already guarantees one of
   * `--yes`, a TTY, or `--web` is available by the time this runs.
   */
  private async resolveConfirmation(
    email: string,
    opts: KickOpts,
    member: MemberDetail,
    serviceClient: ServiceClient,
    authService: { authenticateSilent: (orgId?: string) => Promise<{ organization_name?: string }> },
    orgId: string,
  ): Promise<boolean> {
    if (opts.yes) return true;
    if (opts.web) {
      const { callerRole, currentUserId } = await resolveCallerContext(serviceClient, orgId);
      const orgName = await resolveOrgDisplayName(authService, orgId);
      return confirmInBrowser({
        orgName,
        callerRole,
        currentUserId,
        member: {
          membershipId: member.membershipId,
          userId: member.userId,
          email: member.email,
          role: member.role,
          status: member.status,
          createdAt: member.createdAt,
          projects: (member.projects || []).map((p) => ({ id: p.id, name: p.name, role: p.role })),
        },
        // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI /
        // headless verification drive the loopback without hijacking one.
        open: !process.env.CAPY_WEB_NO_OPEN,
      });
    }
    return confirmInTerminal(email);
  }

  /**
   * CAP-659 preview: finds the member (same refusal codes as the real run),
   * never confirms (the confirm itself is reported `unanswered` unless
   * --yes was passed), never calls `kickMember`, never opens a browser even
   * under --web.
   */
  private async previewKick(email: string, opts: KickOpts, json: boolean): Promise<void> {
    const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
    const member = await findMember(serviceClient, orgId, email, json);
    const changes: DryRunChange[] = [
      {
        where: 'capy_service',
        action: 'kick member',
        target: `${member.email} (membership ${member.membershipId})`,
        reversible: false,
      },
    ];
    const unanswered = opts.yes ? [] : [{ id: 'confirm', flag: '-y, --yes' }];
    const result = dryRunOk('kick', changes, unanswered);
    if (json) printDryRunResultJson(result);
    else printDryRunResultHuman(result);
    process.exit(dryRunExitCode(result));
  }
}
