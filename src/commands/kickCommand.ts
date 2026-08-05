import { resolveOrgContext } from '../core/orgContext';

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
}

export class KickCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(email: string, opts: KickOpts = {}): Promise<void> {
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
        console.error(`No member found matching "${email}".`);
        process.exit(1);
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
      console.error(`Failed to list members: ${err.message}`);
      process.exit(1);
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
      console.error(`Failed to remove member: ${err.message}`);
      process.exit(1);
    }

    console.log('');
    console.log(`  \x1b[33m${email}\x1b[0m has been removed from the organization.`);
    console.log(`  \x1b[90mMembership ${membershipId} deleted.\x1b[0m`);
    console.log('  \x1b[90mThey can no longer co-decrypt secrets.\x1b[0m');
    console.log('');
  }
}
