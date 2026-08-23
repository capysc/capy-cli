import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { hasOrgKey } from '../config/globalConfig';
import { unwrapMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
  resolveInviteTtlMs,
} from '../crypto/inviteCrypto';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';
import { emitHandoffUrlEvent } from '../ui/handoffEvent';
import {
  invitePlan,
  unansweredInviteStops,
  heldProjects,
  grantedProjects,
  parseTtl,
  formatTtl,
  formatRelativeFuture,
  type InvitePlanInput,
  type SettledAnswer,
} from '../core/invitePlan';
import type { InviteTeammateStop } from '../ui/screens/contract';
import type { WebInviteParams } from '../ui/memberScreens';

const ROLES = [
  { name: 'Member', value: 'member' },
  { name: 'Project Admin', value: 'project-admin' },
  { name: 'Admin', value: 'admin' },
] as const;

export interface InviteOpts {
  /** Invitee role: member | project-admin | admin (validated against the caller's grantable set). */
  role?: string;
  /** Project access by id or name; repeatable. Required for member/project-admin. */
  projects?: string[];
  /** Invite lifetime, e.g. "30m", "24h", "7d", or bare seconds. Overrides CAPY_INVITE_TTL_SECONDS. */
  ttl?: string;
  /** Absolute expiry as an ISO date/time. Takes precedence over ttl. */
  expires?: string;
  /** Emit machine-readable JSON (redeem code, role, projects, expiry) instead of the human UI. */
  json?: boolean;
  /** No prompts: resolve from flags or fail fast; also skips the clipboard prompt. */
  nonTty?: boolean;
  /**
   * Render the questions as compiled screens in a local browser instead of
   * inquirer, and hand the redeem code over in a page rather than on stdout.
   *
   * `--web` is a global option on the root program. `src/index.ts` does not
   * read it for `invite` yet, so this path is live and tested but not reachable
   * from argv until whoever owns that file threads `optsWithGlobals().web`
   * through — the same seam `capy checkout` is waiting on.
   */
  web?: boolean;
}

/** Parse "30s"/"10m"/"24h"/"7d" or bare seconds → ms. Exits on invalid input. */
function parseTtlMs(raw: string): number {
  // The grammar lives in `invitePlan` so the flag and the browser's expiry step
  // accept exactly the same lifetimes. Only the exit is this command's.
  const ms = parseTtl(raw);
  if (ms === null) {
    console.error(`\n  Invalid --ttl "${raw}". Use e.g. 30m, 24h, 7d, or a number of seconds.\n`);
    process.exit(1);
  }
  return ms;
}

/**
 * Resolve the invite's notAfter (ms epoch) from --expires / --ttl / env
 * default. Exits on invalid.
 *
 * `chosenTtl` is the lifetime the browser's expiry stop answered. It sits
 * between the flags and the env default deliberately: an explicit `--expires`
 * or `--ttl` on the command line still outranks a control the same run put on
 * screen, which is §8.2's precedence and not a preference.
 */
function resolveNotAfter(opts: InviteOpts, chosenTtl?: string): number {
  if (opts.expires) {
    const t = Date.parse(opts.expires);
    if (Number.isNaN(t)) {
      console.error(`\n  Invalid --expires "${opts.expires}". Use an ISO date, e.g. 2026-06-01T00:00:00Z.\n`);
      process.exit(1);
    }
    if (t <= Date.now()) {
      console.error(`\n  --expires "${opts.expires}" is in the past.\n`);
      process.exit(1);
    }
    return t;
  }
  if (opts.ttl) return Date.now() + parseTtlMs(opts.ttl);
  if (chosenTtl) return Date.now() + parseTtlMs(chosenTtl);
  return Date.now() + resolveInviteTtlMs();
}

/**
 * What settled the role before anything opened, if anything did.
 *
 * An explicit `--role` outranks an existing membership so an admin can promote
 * or demote on re-invite — the same precedence the resolution below applies,
 * stated once so the rail and the run cannot disagree about it.
 */
function settledRole(opts: InviteOpts, existingRole?: string): SettledAnswer | undefined {
  if (opts.role) return { value: opts.role, flag: `--role ${opts.role}` };
  if (existingRole) return { value: existingRole, flag: 'existing membership' };
  return undefined;
}

/** What settled the expiry before anything opened, if anything did. */
function settledExpiry(opts: InviteOpts): SettledAnswer | undefined {
  if (opts.expires) return { value: opts.expires, flag: `--expires ${opts.expires}` };
  if (opts.ttl) return { value: opts.ttl, flag: `--ttl ${opts.ttl}` };
  return undefined;
}

/**
 * Resolve `--project` tokens (id or name) to ids, cwd first. Exits on unknowns.
 *
 * Shared by the terminal path and the browser one, because `--project` settles
 * the projects stop for both: the browser never serves a step a flag already
 * answered, so the ids those tokens name have to come from somewhere other than
 * an answer nobody was asked for. One resolution, one refusal.
 */
function resolveProjectTokens(
  tokens: string[],
  projects: Array<{ id: string; name: string }>,
  cwdProjectId: string | undefined,
): string[] {
  const resolved: string[] = [];
  for (const token of tokens) {
    const match = projects.find((p) => p.id === token || p.name === token);
    if (!match) {
      console.error(
        `\n  No project "${token}" in this org. Available: ${projects.map((p) => p.name).join(', ')}.\n`,
      );
      process.exit(1);
    }
    if (!resolved.includes(match.id)) resolved.push(match.id);
  }
  return resolved.sort((a, b) => (a === cwdProjectId ? -1 : b === cwdProjectId ? 1 : 0));
}

/** `CAPY_INVITE_TTL_SECONDS` in `--ttl`'s own vocabulary, when it is set. */
function envTtl(): string | undefined {
  return process.env.CAPY_INVITE_TTL_SECONDS === undefined
    ? undefined
    : formatTtl(resolveInviteTtlMs());
}

// Which roles a caller of a given role may invite. Owners are never invitable:
// there is exactly one owner per org.
const INVITABLE_BY_ROLE: Record<string, ReadonlyArray<typeof ROLES[number]['value']>> = {
  owner: ['member', 'project-admin', 'admin'],
  admin: ['member', 'project-admin', 'admin'],
  'project-admin': ['member', 'project-admin'],
};

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class InviteCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(email: string, opts: InviteOpts = {}): Promise<void> {
    const interactive = isInteractive(opts.nonTty);
    try {
      const { orgId, userId, userEmail, authService, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

      // Check if inviting yourself or an existing member
      if (userEmail && userEmail.toLowerCase() === email.toLowerCase()) {
        console.log(`${email} is already a member of this organization.`);
        return;
      }

      // Determine caller's role to filter which roles they may grant.
      const me = await serviceClient.getOrgMe(orgId);
      const invitable = INVITABLE_BY_ROLE[me.role];
      if (!invitable) {
        console.error(`Your role (${me.role}) does not permit inviting users.`);
        process.exit(1);
      }
      if (me.role === 'project-admin' && me.admin_projects.length === 0) {
        console.error('You do not administer any projects in this organization.');
        process.exit(1);
      }


      // Read and unwrap master key (double-wrapped: KMS outer + K_local inner).
      // unwrapMasterKey handles legacy blobs and transparently re-wraps them.
      if (!hasOrgKey(orgId, userId)) {
        console.error('No master key found for this organization. Only the org owner can invite.');
        process.exit(1);
      }

      let masterKey: Buffer;
      try {
        const keyOps = {
          coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
          wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
        };
        masterKey = await unwrapMasterKey(orgId, userId, keyOps);
      } catch {
        console.error('Failed to unwrap master key. Re-authenticate and try again.');
        process.exit(1);
      }

      // If this email already belongs to an org member, reuse their role and
      // project assignments instead of prompting. Re-inviting an existing
      // member is how admins re-issue a wrapped key (e.g., new machine).
      const { members } = await serviceClient.listMemberDetails(orgId);
      const existingMember = members.find(
        (m) => m.email && m.email.toLowerCase() === email.toLowerCase(),
      );

      let role: string;
      let projectId: string | undefined;
      let extraProjectIds: string[] = [];
      /**
       * What settled each answer, for the marker on the finished rail.
       *
       * `undefined` means somebody was asked and answered — a prompt, or a
       * control on a page. Anything else is a source the run picked without
       * asking, and naming it is the whole point: off a TTY this command
       * silently falls back to `member` and to whichever project you happen to
       * be standing in, and `Role · member` with no marker is indistinguishable
       * from a choice a person made.
       */
      let roleSource: string | undefined;
      let projectSource: string | undefined;
      const reissuing = !!existingMember;
      // Only projects this member actually holds a role on. `member.projects`
      // is the whole organization annotated with their role-or-nothing, so
      // mapping it wholesale would re-grant every project in the org on a
      // re-issue — access the caller never asked to hand out.
      const existingHeldProjects = heldProjects(existingMember);
      const existingProjectIds = existingHeldProjects.map((p) => p.id);

      // The whole route, declared before anything opens. Built from argv and
      // from the membership this address already has — the two things that can
      // settle a question before it is asked — so the rail, the decision about
      // whether to open a browser at all, and what `--json` prints all come off
      // one call. `canAskExpiry` is `--web`: `resolveNotAfter` never prompts, so
      // a terminal run's expiry is settled before the command starts.
      const inheritedRole = existingMember && !opts.role ? existingMember.role : undefined;
      const inheritedProjectNames =
        existingMember && !opts.role ? existingHeldProjects.map((p) => p.name) : [];
      const planInput: InvitePlanInput = {
        role: settledRole(opts, inheritedRole),
        projects:
          opts.projects && opts.projects.length > 0
            ? { names: opts.projects, flag: opts.projects.map((p) => `--project ${p}`).join(' ') }
            : inheritedProjectNames.length > 0
              ? { names: inheritedProjectNames, flag: 'existing membership' }
              : undefined,
        expiry: settledExpiry(opts),
        envTtl: envTtl(),
        defaultTtl: envTtl() ?? '7d',
        canAskExpiry: opts.web === true,
      };
      const plan = invitePlan(planInput);

      /** The lifetime the browser's expiry stop answered, when it asked. */
      let chosenTtl: string | undefined;
      /** Everything the browser needs, gathered once so both pages share it. */
      let webParams: WebInviteParams | undefined;

      if (opts.web) {
        // Narrowed to projects they HOLD before the screen ever sees it: the
        // page renders this as their current access, and `projects` there has
        // no role field left to filter on.
        const existingForScreen = existingMember
          ? { ...existingMember, projects: existingHeldProjects.map((p) => ({ id: p.id, name: p.name })) }
          : undefined;
        webParams = await this.gatherWebParams(
          email, orgId, me, invitable, existingForScreen, planInput, authService, serviceClient, userEmail,
        );
      }

      // Pure re-issue (existing member, no explicit --role): reuse their current
      // role + projects. But an explicit --role MUST be honored so admins can
      // promote/demote on re-invite — and so a re-invite that races a just-issued
      // `kick` (a not-yet-propagated member read) still applies the requested
      // role instead of silently keeping the stale one.
      if (existingMember && !opts.role) {
        role = existingMember.role;
        projectId = existingProjectIds[0];
        extraProjectIds = existingProjectIds.slice(1);
        roleSource = 'existing membership';
        projectSource = 'existing membership';
      } else if (webParams && unansweredInviteStops(plan).length > 0) {
        // `--role` is validated first either way: a role this caller cannot
        // grant is refused before a browser opens, not after somebody answers
        // two more questions on top of it.
        if (opts.role && !invitable.includes(opts.role as typeof ROLES[number]['value'])) {
          console.error(
            `\n  Your role (${me.role}) can't grant "${opts.role}". Allowed: ${invitable.join(', ')}.\n`,
          );
          process.exit(1);
        }
        // `--project` settles the projects stop, so the browser never serves
        // it — and an unknown token is refused here, before a browser opens,
        // rather than after somebody has answered two questions on top of it.
        const flagProjectIds =
          opts.projects && opts.projects.length > 0
            ? resolveProjectTokens(
                opts.projects,
                webParams.projects,
                webParams.projects.find((p) => p.isCwd)?.id,
              )
            : [];

        const { askInviteInBrowser } = await import('../ui/memberScreens');
        const answered = await askInviteInBrowser(webParams);
        // Cancelling is a refusal: nothing was minted and nothing below may
        // run, because everything below hands somebody a copy of the org key.
        if (answered.cancelled) {
          console.log('\n  No invite created.\n');
          return;
        }
        role = answered.role;
        const ids = grantedProjects(role, answered.projectIds, flagProjectIds);
        projectId = ids[0];
        extraProjectIds = ids.slice(1);
        chosenTtl = answered.ttl;
        // A stop a flag settled is never served, so anything the browser did
        // NOT answer keeps the marker argv gave it.
        roleSource = opts.role ? `--role ${opts.role}` : undefined;
        projectSource = answered.projectIds.length > 0 ? undefined : planInput.projects?.flag;
      } else {
        // ── Role ────────────────────────────────────────────────────────────
        const allowedChoices = ROLES.filter(r => invitable.includes(r.value));
        if (opts.role) {
          if (!invitable.includes(opts.role as typeof ROLES[number]['value'])) {
            console.error(
              `\n  Your role (${me.role}) can't grant "${opts.role}". Allowed: ${invitable.join(', ')}.\n`,
            );
            process.exit(1);
          }
          role = opts.role;
          roleSource = `--role ${opts.role}`;
        } else if (!interactive) {
          // No --role given and can't prompt: default to the safe baseline
          // (same default the interactive picker uses). Override with --role.
          role = 'member';
          roleSource = 'non-interactive default';
        } else {
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'role',
            message: `Select a role for ${email}:`,
            choices: allowedChoices,
            default: 'member',
          }]);
          role = answer.role;
        }

        // ── Project scope (required for project-admin and member) ─────────────
        if (role === 'project-admin' || role === 'member') {
          const projects = await serviceClient.listProjects();
          if (projects.length === 0) {
            console.error('No projects in this organization. Create one with `capy` first.');
            process.exit(1);
          }
          // The cwd project sorts first (it's the most likely intent) and is
          // the non-interactive default when --project is omitted.
          let cwdProjectId: string | undefined;
          try {
            const pm = new ProjectManager();
            const ps = await pm.detectProjectState();
            if (ps.projectId && projects.some((p) => p.id === ps.projectId)) {
              cwdProjectId = ps.projectId;
            }
          } catch {
            // ignore — cwd detection is best-effort
          }
          const cwdFirst = <T extends { id: string }>(a: T, b: T) =>
            a.id === cwdProjectId ? -1 : b.id === cwdProjectId ? 1 : 0;

          if (opts.projects && opts.projects.length > 0) {
            const resolved = resolveProjectTokens(opts.projects, projects, cwdProjectId);
            projectId = resolved[0];
            extraProjectIds = resolved.slice(1);
            projectSource = planInput.projects?.flag;
          } else if (!interactive) {
            // No --project: keep the member's existing projects on re-issue, else
            // fall back to the cwd project, else refuse — we won't silently grant
            // access to a project the caller didn't name.
            if (reissuing && existingProjectIds.length > 0) {
              projectId = existingProjectIds[0];
              extraProjectIds = existingProjectIds.slice(1);
              projectSource = 'existing membership';
            } else if (cwdProjectId) {
              projectId = cwdProjectId;
              projectSource = 'this directory';
            } else {
              refuseNonInteractive(
                `role "${role}" needs project access and none was given`,
                `Pass --project <id|name> (available: ${projects.map((p) => p.name).join(', ')}).`,
              );
            }
          } else {
            const { CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME } = await import('../ui/promptStyle');
            const ordered = [...projects].sort(cwdFirst);
            const { chosenProjectIds } = await inquirer.prompt<{ chosenProjectIds: string[] }>({
              type: 'checkbox',
              name: 'chosenProjectIds',
              message: `Grant ${role === 'project-admin' ? 'Project Admin' : 'Member'} access to which projects?`,
              instructions: CHECKBOX_INSTRUCTIONS,
              theme: CHECKBOX_THEME,
              choices: ordered.map((p) => ({
                name: p.name,
                value: p.id,
                checked: p.id === cwdProjectId,
              })),
              validate: (v: ReadonlyArray<unknown>) => v.length > 0 || 'Pick at least one project',
            } as any);
            const ids: string[] = chosenProjectIds;
            projectId = ids[0];
            extraProjectIds = ids.slice(1);
          }
        }
      }

      // 1. Generate invite token T
      const inviteToken = generateInviteToken();

      // 2. Inner wrap M with HKDF(T, salt=orgId:email)
      //    The recipient email is bound into the HKDF salt so only they can unwrap.
      const innerBlob = innerWrap(masterKey, inviteToken, orgId, email);

      // 3. Service outer wraps (KMS layer), bound to (orgId, notAfter) so
      //    the redeem code can't outlive its window even if forwarded.
      const notAfter = resolveNotAfter(opts, chosenTtl);
      const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
        orgId,
        Buffer.from(innerBlob, 'base64').toString('base64'),
        notAfter,
      );

      // 4. Create invite record on service
      const inviteResult = await serviceClient.createInvite(orgId, email, role, projectId);

      // 4b. Fan out any additional project assignments picked in the checkbox.
      // Abort noisily only if every extra assignment fails.
      const failures: Array<{ projectId: string; error: string }> = [];
      for (const extraId of extraProjectIds) {
        try {
          await serviceClient.inviteToProject(orgId, extraId, email, role as 'project-admin' | 'member');
        } catch (err: any) {
          failures.push({ projectId: extraId, error: err?.message ?? String(err) });
        }
      }
      void inviteResult;

      // 5. Build redeem code (carries the same notAfter the wrap was bound to).
      const redeemCode = buildRedeemCode(inviteToken, outerBlob, orgId, notAfter);

      const roleName = ROLES.find(r => r.value === role)?.name ?? role;
      const redeemCommand = `capy redeem ${redeemCode}`;
      const grantedProjectIds = [projectId, ...extraProjectIds].filter(Boolean) as string[];
      // Ids for the service, names for the page. The id is the fallback rather
      // than a blank: a project this run granted and could not name is still a
      // project this run granted, and the page has to say so.
      const grantedProjectRefs = grantedProjectIds.map((id) => ({
        id,
        name: webParams?.projects.find((x) => x.id === id)?.name ?? id,
      }));
      // What the fan-out actually landed. A stop is a claim about what this run
      // DID, so a project the service refused cannot be listed as one this
      // invite granted — that is the exact failure the markers exist to
      // prevent, one level down: `Projects · storefront, warehouse` beside
      // `warehouse: 503` is a rail arguing with the receipt printed under it.
      const assignedProjectRefs = grantedProjectRefs.filter(
        (p) => !failures.some((f) => f.projectId === p.id),
      );

      // The route as it ended up: the same builder, fed what actually settled
      // each stop. `--json` and the browser payload cannot describe different
      // runs, because neither of them builds a rail of its own.
      //
      // `canAskExpiry` goes false here — this rail describes a FINISHED run and
      // nothing on a finished run is still outstanding. Left true, a re-issue
      // that never opened a browser (existing member, no `--role`) reports
      // `expiry · current` on a run that already minted the code, which is a
      // stop whose state does not describe what the run did.
      const finalStops: InviteTeammateStop[] = invitePlan({
        ...planInput,
        canAskExpiry: false,
        role: { value: role, flag: roleSource },
        projects: assignedProjectRefs.length > 0
          ? {
              names: assignedProjectRefs.map((p) => p.name),
              flag: projectSource,
              ...(failures.length > 0
                ? {
                    note: `${failures.length} more the service refused: ${failures
                      .map((f) => grantedProjectRefs.find((p) => p.id === f.projectId)?.name ?? f.projectId)
                      .join(', ')}`,
                  }
                : {}),
            }
          : undefined,
        expiry: planInput.expiry ?? (chosenTtl ? { value: chosenTtl } : undefined),
      });

      // Machine-readable path for agents/CI: emit JSON to stdout and skip the
      // human UI + clipboard prompt entirely.
      if (opts.json) {
        console.log(JSON.stringify({
          email,
          role,
          reissued: reissuing,
          projectIds: grantedProjectIds,
          redeemCode,
          redeemCommand,
          expiresAt: new Date(notAfter).toISOString(),
          projectAssignmentFailures: failures,
          stops: finalStops,
        }, null, 2));
        return;
      }

      console.log('');
      if (reissuing) {
        console.log(`  Re-issued invite for \x1b[1m${email}\x1b[0m (existing \x1b[1m${roleName}\x1b[0m)`);
      } else {
        console.log(`  Invite created for \x1b[1m${email}\x1b[0m as \x1b[1m${roleName}\x1b[0m`);
      }
      console.log('');

      if (webParams) {
        // The redeem code is a bearer credential carrying a double-wrapped copy
        // of the organization key — recovery-equivalent material. `--web` is
        // agent-only, and an agent shelling `capy` reads stdout, so under it the
        // code goes to a page and NOWHERE else: not printed, not logged, not
        // copied to the clipboard. The page it lands on is served with the
        // display-only CSP (`connect-src 'none'`), so the one document in this
        // flow holding key material is the one with no way to open a socket.
        const { serveInviteCode } = await import('../ui/memberScreens');
        const page = await serveInviteCode(
          webParams,
          {
            redeemCommand,
            expiresAtIso: new Date(notAfter).toISOString(),
            expiresRelative: formatRelativeFuture(notAfter),
            role,
            reissued: reissuing,
            // What landed, not what was asked for. The failures travel in their
            // own field right below, and a project that appears in both is a
            // page contradicting itself about what this invite reaches.
            grantedProjects: assignedProjectRefs,
            assignmentFailures: failures.map((f) => ({
              project: {
                id: f.projectId,
                name: webParams!.projects.find((x) => x.id === f.projectId)?.name ?? f.projectId,
              },
              error: f.error,
            })),
          },
          { role, projectIds: assignedProjectRefs.map((p) => p.id), ttl: chosenTtl },
          // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI /
          // headless verification drive the loopback without hijacking one.
          { open: !process.env.CAPY_WEB_NO_OPEN },
        );
        console.log('  The redeem code is on this page — it is deliberately not printed here:');
        console.log(`  ${page.url}`);
        console.log('');
        emitHandoffUrlEvent(page.url, 'invite');
        console.log(`  \x1b[90mExpires ${new Date(notAfter).toISOString()}.\x1b[0m`);
        console.log('');
      } else {
        // CAP-402: same bearer-credential-to-stdout risk `--web` already
        // guards above, just not yet enforced for a run that passes neither
        // `--web` nor `--json` and has no real TTY (an agent invoking
        // `capy invite` directly with every flag supplied, so none of this
        // function's earlier refuseNonInteractive calls ever fire). `--json`
        // stays the sanctioned agent path — this is not a REGRESSION there,
        // it exists precisely to hand the code to automation deliberately —
        // this refusal only closes the accidental route: reaching the
        // human-terminal rendering with no human terminal to read it.
        if (!interactive) {
          refuseNonInteractive(
            'this would print a redeem code — a bearer credential for the organization key — with no terminal to read it from',
            'Pass `--json` for structured output, or run `capy invite` at an interactive terminal.',
          );
        }
        console.log('  Send them this command:');
        console.log('');
        console.log(`    ${B('capy')} redeem ${redeemCode}`);
        console.log('');
        console.log('  \x1b[90mThe code contains a double-wrapped copy of the org key.\x1b[0m');
        console.log('  \x1b[90mIt cannot be decrypted without service co-decryption + authentication.\x1b[0m');
        console.log(`  \x1b[90mExpires ${new Date(notAfter).toISOString()}.\x1b[0m`);
        console.log('');
      }

      if (failures.length > 0) {
        console.log(`  \x1b[33m${failures.length} additional project assignment${failures.length === 1 ? '' : 's'} failed:\x1b[0m`);
        for (const f of failures) {
          console.log(`    \x1b[90m${f.projectId}: ${f.error}\x1b[0m`);
        }
        console.log('');
      }

      // The clipboard prompt is interactive — skip it under --non-tty/piped,
      // and under `--web`, where the terminal never held the code to begin with
      // and the page has its own copy control.
      if (interactive && !webParams) {
        const { promptCopyToClipboard } = await import('../ui/clipboard');
        await promptCopyToClipboard(redeemCommand);
      }
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /**
   * Everything the two browser pages need, gathered once.
   *
   * Both the question wizard and the code page render the same screen with the
   * same payload shape, so building it twice would be two chances for the run a
   * person answered and the run they are handed a key for to disagree.
   *
   * The project list is fetched here even when the role is already settled and
   * needs no projects: the code page names the projects an invite granted, and
   * `createInvite` takes ids while a person reads names.
   */
  private async gatherWebParams(
    email: string,
    orgId: string,
    me: { role: string },
    invitable: ReadonlyArray<typeof ROLES[number]['value']>,
    existingMember: { role: string; status: string; projects?: Array<{ id: string; name: string }> } | undefined,
    planInput: InvitePlanInput,
    authService: { authenticateSilent: (orgId?: string) => Promise<{ organization_name?: string }> },
    serviceClient: { listProjects: () => Promise<Array<{ id: string; name: string }>> },
    callerEmail: string | undefined,
  ): Promise<WebInviteParams> {
    const projects = await serviceClient.listProjects();

    // The cwd project sorts first and is ticked by default — the same order and
    // the same default the terminal checkbox uses. The screen keeps both and
    // drops the silence: the row says where the tick came from.
    let cwdProjectId: string | undefined;
    try {
      const ps = await new ProjectManager().detectProjectState();
      if (ps.projectId && projects.some((p) => p.id === ps.projectId)) cwdProjectId = ps.projectId;
    } catch {
      // ignore — cwd detection is best-effort
    }
    const ordered = [...projects].sort((a, b) =>
      a.id === cwdProjectId ? -1 : b.id === cwdProjectId ? 1 : 0,
    );

    // `resolveOrgContext` drops the organization name on the way out, and a
    // page headed by a UUID is a page that cannot tell you it opened on the
    // wrong organization. Re-asking the cached session for it costs nothing —
    // a live token short-circuits before any request — and the id is the
    // fallback rather than a blank.
    let orgName = orgId;
    try {
      const again = await authService.authenticateSilent(orgId);
      if (again.organization_name) orgName = again.organization_name;
    } catch {
      // ignore — the id still identifies the organization unambiguously
    }

    return {
      // What the CODE is bound to, not what argv typed. `innerWrap` derives the
      // inner key from `${orgId}:${email.toLowerCase()}`, so the lowercased
      // address is the one that decides whether this invite can ever be
      // redeemed, and it is the one the page names. Argv travels beside it: the
      // screen draws "The address was cleaned up" when the two differ, which is
      // the only warning anybody gets that `capy invite Bob@X.com` mints a code
      // bound to something they did not type.
      //
      // Lowercased and NOT trimmed, because the CLI lowercases and does not
      // trim. A page that showed a trimmed address would be claiming a binding
      // the code does not have — and ` bob@x.com` really does mint a code
      // nobody can redeem. Fixing THAT is a change to what the command mints,
      // for every path and not only this one, so it is reported rather than
      // smuggled in behind a flag that is supposed to change rendering only.
      email: email.toLowerCase(),
      rawEmail: email,
      orgName,
      callerEmail: callerEmail ?? '',
      callerRole: me.role,
      grantableRoles: [...invitable],
      projects: ordered.map((p) => ({ id: p.id, name: p.name, isCwd: p.id === cwdProjectId })),
      ...(existingMember
        ? {
            existing: {
              role: existingMember.role,
              status: existingMember.status,
              // Already narrowed by the caller to projects they HOLD — this
              // shape has no role field left to filter on, and the screen
              // presents it as their current access.
              projects: (existingMember.projects || []).map((p) => ({ id: p.id, name: p.name })),
            },
          }
        : {}),
      plan: planInput,
      open: !process.env.CAPY_WEB_NO_OPEN,
    };
  }
}
