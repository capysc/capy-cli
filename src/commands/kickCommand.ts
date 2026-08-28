import { resolveOrgContext } from '../core/orgContext';
import { CapyError, ERROR_CODES } from '../types/index';

export interface KickOpts {
  /**
   * Render the confirmation as a compiled screen in a local browser instead of
   * inquirer's one-line confirm.
   *
   * `--web` is a global option on the root program, and `src/index.ts` DOES
   * thread it for `kick` today:
   *     await cmd.execute(email, { web: command.optsWithGlobals().web === true })
   * This comment previously said the opposite, and said it long enough to be
   * believed — it understated the exposure of every refusal below, which are
   * reachable under `--web` right now.
   */
  web?: boolean;
}

export class KickCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  /**
   * The wrapper that makes a refusal reachable.
   *
   * Every ending below used to be `console.error(...)` + `process.exit(1)`,
   * which is right in a terminal and empty under `--web`: the flag exists
   * because the caller is an agent or is on another device, so the one
   * sentence saying what went wrong went to a stream with nobody on it.
   * `displayErrorAndExit` serves the command-error page, holds the process
   * open until the browser has fetched it, still prints to the terminal, and
   * exits 1 either way — so the terminal behaviour is unchanged and the web
   * caller stops getting nothing.
   */
  async execute(email: string, opts: KickOpts = {}): Promise<void> {
    try {
      await this._execute(email, opts);
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') throw error;
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  private async _execute(email: string, opts: KickOpts = {}): Promise<void> {
    const { orgId, authService, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

    // Find the membership by email
    let membershipId: string;
    let member: Awaited<ReturnType<typeof serviceClient.listMemberDetails>>['members'][number];
    let callerRole = 'member';
    let currentUserId = '';
    let orgName = orgId;
    try {
      const { members } = await serviceClient.listMemberDetails(orgId);
      const match = members.find(m =>
        m.email.toLowerCase() === email.toLowerCase()
      );
      if (!match) {
        throw new CapyError(`No member found matching "${email}".`, ERROR_CODES.MEMBER_NOT_FOUND);
      }
      membershipId = match.membershipId;
      member = match;

      // Only the browser path needs to know who is asking — the screen marks
      // the caller's own row, and removing yourself is the one removal that
      // takes your access away rather than somebody else's. A failure here
      // must not stop a removal the terminal would have performed, so it is
      // best-effort and the fallbacks are the honest unknowns.
      if (opts.web) {
        try {
          const me = await serviceClient.getOrgMe(orgId);
          callerRole = me.role;
          currentUserId = me.user_id;
        } catch {
          /* leave the defaults; the server remains the authority on both */
        }
        // `resolveOrgContext` drops the organization name on the way out, and a
        // removal confirm headed by a UUID cannot tell you it opened on the
        // wrong organization. Re-asking the cached session costs nothing — a
        // live token short-circuits before any request.
        try {
          const again = await authService.authenticateSilent(orgId);
          if (again.organization_name) orgName = again.organization_name;
        } catch {
          /* the id still identifies the organization unambiguously */
        }
      }
    } catch (err: any) {
      throw new CapyError(`Failed to list members: ${err.message}`, ERROR_CODES.SERVICE_ERROR);
    }

    // Confirm.
    //
    // The terminal asks `Remove <email> from this organization? They will lose
    // access to all secrets.` — one line, defaulting to No, with the whole
    // consequence folded into the question. Under `--web` it is the
    // `org-members` screen's `confirm-remove` view, where what they lose and
    // what removal does NOT reach (their laptop still holds the key) are two
    // callouts ABOVE the button, and the button stays held down until the
    // address is typed back. A destructive action's consequence never goes
    // inside the control that performs it.
    let confirm: boolean;
    if (opts.web) {
      const { confirmKickInBrowser } = await import('../ui/memberScreens');
      try {
        confirm = await confirmKickInBrowser({
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
            projects: (member.projects || []).map(p => ({ id: p.id, name: p.name, role: p.role })),
          },
          // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI /
          // headless verification drive the loopback without hijacking one.
          open: !process.env.CAPY_WEB_NO_OPEN,
          // Opts this call into the keep-hosted transport when
          // CAPY_KEEP_SCREENS=1 (W2-D) — omitted, unreachable, loopback-only.
          authService,
        });
      } catch {
        // Closed, timed out, or interrupted. None of those is a yes, and the
        // one thing this flow must never do is read a window nobody answered as
        // agreement to cut somebody off from every secret in the organization.
        confirm = false;
      }
    } else {
      const inquirer = (await import('inquirer')).default;
      ({ confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Remove ${email} from this organization? They will lose access to all secrets.`,
        default: false,
      }]));
    }

    if (!confirm) {
      console.log('Cancelled.');
      return;
    }

    try {
      await serviceClient.kickMember(orgId, membershipId);
    } catch (err: any) {
      throw new CapyError(`Failed to remove member: ${err.message}`, ERROR_CODES.SERVICE_ERROR);
    }

    console.log('');
    console.log(`  \x1b[33m${email}\x1b[0m has been removed from the organization.`);
    console.log(`  \x1b[90mMembership ${membershipId} deleted.\x1b[0m`);
    console.log('  \x1b[90mThey can no longer co-decrypt secrets.\x1b[0m');
    console.log('');
  }
}
