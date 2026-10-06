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
  MAX_INVITE_TTL_MS,
} from '../crypto/inviteCrypto';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';
import { excludeSystemProject } from '../system/reservedProjectName';
import {
  invitePlan,
  parseTtl,
  formatTtl,
  type InvitePlanInput,
  type SettledAnswer,
} from '../core/invitePlan';
import type { InviteTeammateStop } from '../ui/screens/contract';

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
  /** Invite lifetime, max 12h, e.g. "30m", "2h", "12h", or bare seconds. Overrides CAPY_INVITE_TTL_SECONDS. */
  ttl?: string;
  /** Absolute expiry as an ISO date/time. Takes precedence over ttl. */
  expires?: string;
  /** Emit machine-readable JSON (redeem code, role, projects, expiry) instead of the human UI. */
  json?: boolean;
  /** No prompts: resolve from flags or fail fast; also skips the clipboard prompt. */
  nonTty?: boolean;
}

/** Parse "30s"/"10m"/"2h"/"12h" or bare seconds → ms. Exits on invalid input. */
function parseTtlMs(raw: string): number {
  // The grammar lives in `invitePlan`. Only the exit is this command's.
  const ms = parseTtl(raw);
  if (ms === null) {
    console.error(`\n  Invalid --ttl "${raw}". Use e.g. 30m, 2h, 12h, or a number of seconds (max 12h).\n`);
    process.exit(1);
  }
  return ms;
}

/**
 * Resolve the invite's notAfter (ms epoch) from --expires / --ttl / env
 * default. Exits on invalid.
 */
function resolveNotAfter(opts: InviteOpts): number {
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
    return capAtCeiling(t, `--expires ${opts.expires}`);
  }
  if (opts.ttl) return capAtCeiling(Date.now() + parseTtlMs(opts.ttl), `--ttl ${opts.ttl}`);
  return Date.now() + resolveInviteTtlMs();
}

/**
 * Cap a requested expiry at the ceiling, and say so.
 *
 * Warns rather than refusing so an existing script passing a longer lifetime
 * keeps working, and warns rather than clamping in silence so nobody believes
 * they issued a week-long invite that dies in twelve hours. Goes to stderr:
 * `--json` callers parse stdout, and a notice does not belong in their payload.
 */
function capAtCeiling(notAfter: number, source: string): number {
  if (notAfter - Date.now() <= MAX_INVITE_TTL_MS) return notAfter;
  console.error(
    `\n  ${source} exceeds the ${formatTtl(MAX_INVITE_TTL_MS)} maximum invite lifetime — using ${formatTtl(MAX_INVITE_TTL_MS)}.\n`,
  );
  return Date.now() + MAX_INVITE_TTL_MS;
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

/** Resolve `--project` tokens (id or name) to ids, cwd first. Exits on unknowns. */
function resolveProjectTokens(
  tokens: string[],
  projects: Array<{ id: string; name: string }>,
  cwdProjectId: string | undefined,
): string[] {
  const ids = tokens.map((token) => {
    const match = projects.find((p) => p.id === token || p.name === token);
    if (!match) {
      console.error(
        `\n  No project "${token}" in this org. Available: ${projects.map((p) => p.name).join(', ')}.\n`,
      );
      process.exit(1);
    }
    return match.id;
  });
  return [...new Set(ids)].sort((a, b) => (a === cwdProjectId ? -1 : b === cwdProjectId ? 1 : 0));
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
      const { orgId, userId, userEmail, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

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

      const masterKey = await this.unwrapMasterKeyOrExit(orgId, userId, serviceClient);

      // If this email already belongs to an org member, reuse their role and
      // project assignments instead of prompting. Re-inviting an existing
      // member is how admins re-issue a wrapped key (e.g., new machine).
      const { members } = await serviceClient.listMemberDetails(orgId);
      const existingMember = members.find(
        (m) => m.email && m.email.toLowerCase() === email.toLowerCase(),
      );

      const reissuing = !!existingMember;
      const existingProjectIds = existingMember
        ? (existingMember.projects || []).map((p) => p.id)
        : [];

      // The whole route, declared before anything is asked. Built from argv and
      // from the membership this address already has — the two things that can
      // settle a question before it is asked. `resolveNotAfter` never prompts, so
      // a run's expiry is settled before the command starts.
      const inheritedRole = existingMember && !opts.role ? existingMember.role : undefined;
      const inheritedProjectNames =
        existingMember && !opts.role ? (existingMember.projects || []).map((p) => p.name) : [];
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
        defaultTtl: envTtl() ?? '12h',
      };

      const { role, projectId, extraProjectIds, roleSource, projectSource } = await this.resolveInviteRoleAndProjects({
        email, opts, me, invitable, existingMember, reissuing, existingProjectIds,
        planInput, serviceClient, interactive,
      });

      // 1. Generate invite token T
      const inviteToken = generateInviteToken();

      // 2. Inner wrap M with HKDF(T, salt=orgId:email)
      //    The recipient email is bound into the HKDF salt so only they can unwrap.
      const innerBlob = innerWrap(masterKey, inviteToken, orgId, email);

      // 3. Service outer wraps (KMS layer), bound to (orgId, notAfter) so
      //    the redeem code can't outlive its window even if forwarded.
      const notAfter = resolveNotAfter(opts);
      const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
        orgId,
        Buffer.from(innerBlob, 'base64').toString('base64'),
        notAfter,
      );

      // 4. Create invite record on service
      const inviteResult = await serviceClient.createInvite(orgId, email, role, projectId);

      // 4b. Fan out any additional project assignments picked in the checkbox.
      // Abort noisily only if every extra assignment fails.
      const failures = await this.fanOutExtraProjectInvites(orgId, email, role, extraProjectIds, serviceClient);
      void inviteResult;

      // 5. Build redeem code (carries the same notAfter the wrap was bound to).
      const redeemCode = buildRedeemCode(inviteToken, outerBlob, orgId, notAfter);

      const roleName = ROLES.find(r => r.value === role)?.name ?? role;
      const redeemCommand = `capy redeem ${redeemCode}`;
      const grantedProjectIds = [projectId, ...extraProjectIds].filter(Boolean) as string[];
      // Ids for the service; the id also stands in as the name, because a
      // project this run granted and could not name is still a project this run
      // granted.
      const grantedProjectRefs = grantedProjectIds.map((id) => ({ id, name: id }));
      // What the fan-out actually landed. A stop is a claim about what this run
      // DID, so a project the service refused cannot be listed as one this
      // invite granted — that is the exact failure the markers exist to
      // prevent, one level down: `Projects · storefront, warehouse` beside
      // `warehouse: 503` is a rail arguing with the receipt printed under it.
      const assignedProjectRefs = grantedProjectRefs.filter(
        (p) => !failures.some((f) => f.projectId === p.id),
      );

      // The route as it ended up: the same builder, fed what actually settled
      // each stop.
      const finalStops: InviteTeammateStop[] = invitePlan({
        ...planInput,
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

      console.log('  Send them this command:');
      console.log('');
      console.log(`    ${B('capy')} redeem ${redeemCode}`);
      console.log('');
      console.log('  \x1b[90mThis code is safe to share with your team member over email or your\x1b[0m');
      console.log('  \x1b[90mteam messaging app. It can only be used by them.\x1b[0m');
      console.log(`  \x1b[90mExpires ${new Date(notAfter).toISOString()}.\x1b[0m`);
      console.log('');

      if (failures.length > 0) {
        console.log(`  \x1b[33m${failures.length} additional project assignment${failures.length === 1 ? '' : 's'} failed:\x1b[0m`);
        for (const f of failures) {
          console.log(`    \x1b[90m${f.projectId}: ${f.error}\x1b[0m`);
        }
        console.log('');
      }

      // The clipboard prompt is interactive — skip it under --non-tty/piped.
      if (interactive) {
        const { promptCopyToClipboard } = await import('../ui/clipboard');
        await promptCopyToClipboard(redeemCommand);
      }
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /** Reads and unwraps the org master key (double-wrapped: KMS outer + K_local inner). Exits on failure. */
  private async unwrapMasterKeyOrExit(
    orgId: string,
    userId: string,
    serviceClient: { coDecrypt: (oid: string, ct: string, notAfter?: number, transportId?: string) => Promise<{ plaintext: string }>; wrapOuterLayer: (oid: string, pt: string) => Promise<{ ciphertext: string }> },
  ): Promise<Buffer> {
    try {
      const keyOps = {
        coDecrypt: (oid: string, ct: string, transportId?: string) => serviceClient.coDecrypt(oid, ct, undefined, transportId).then(r => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      return await unwrapMasterKey(orgId, userId, keyOps);
    } catch {
      console.error('Failed to unwrap master key. Re-authenticate and try again.');
      process.exit(1);
    }
  }

  /** The cwd's project id, when it's one of `projects` — best-effort, `undefined` on any detection failure. */
  private async resolveCwdProjectId(projects: ReadonlyArray<{ id: string }>): Promise<string | undefined> {
    try {
      const pm = new ProjectManager();
      const ps = await pm.detectProjectState();
      return ps.projectId && projects.some((p) => p.id === ps.projectId) ? ps.projectId : undefined;
    } catch {
      // ignore — cwd detection is best-effort
      return undefined;
    }
  }

  /**
   * Resolves who this invite grants what: the role, the primary + extra
   * project ids, and (for the finished rail) what settled each answer.
   * `undefined` for a source means somebody was asked and answered; anything
   * else is a source the run picked without asking. Each branch below
   * returns its answer directly — nothing here is reassigned.
   */
  private async resolveInviteRoleAndProjects(ctx: {
    email: string;
    opts: InviteOpts;
    me: { role: string };
    invitable: ReadonlyArray<typeof ROLES[number]['value']>;
    existingMember: { role: string; status: string; projects?: Array<{ id: string; name: string }> } | undefined;
    reissuing: boolean;
    existingProjectIds: string[];
    planInput: InvitePlanInput;
    serviceClient: { listProjects: () => Promise<Array<{ id: string; name: string }>> };
    interactive: boolean;
  }): Promise<{
    role: string;
    projectId: string | undefined;
    extraProjectIds: string[];
    roleSource: string | undefined;
    projectSource: string | undefined;
  }> {
    const {
      email, opts, me, invitable, existingMember, reissuing, existingProjectIds,
      planInput, serviceClient, interactive,
    } = ctx;

    // Pure re-issue (existing member, no explicit --role): reuse their current
    // role + projects. But an explicit --role MUST be honored so admins can
    // promote/demote on re-invite — and so a re-invite that races a just-issued
    // `kick` (a not-yet-propagated member read) still applies the requested
    // role instead of silently keeping the stale one.
    if (existingMember && !opts.role) {
      return {
        role: existingMember.role,
        projectId: existingProjectIds[0],
        extraProjectIds: existingProjectIds.slice(1),
        roleSource: 'existing membership',
        projectSource: 'existing membership',
      };
    }

    const { role, roleSource } = await this.resolveInviteeRole(email, opts, me, invitable, interactive);

    // Project scope is only required for project-admin and member.
    if (role !== 'project-admin' && role !== 'member') {
      return {
        role, projectId: undefined, extraProjectIds: [], roleSource, projectSource: undefined,
      };
    }

    const { projectId, extraProjectIds, projectSource } = await this.resolveInviteeProjects(
      role, opts, serviceClient, interactive, reissuing, existingProjectIds, planInput,
    );
    return { role, projectId, extraProjectIds, roleSource, projectSource };
  }

  /** Asks (flag, non-interactive default, or inquirer) which role to grant. Exits on an ungrantable --role. */
  private async resolveInviteeRole(
    email: string,
    opts: InviteOpts,
    me: { role: string },
    invitable: ReadonlyArray<typeof ROLES[number]['value']>,
    interactive: boolean,
  ): Promise<{ role: string; roleSource: string | undefined }> {
    if (opts.role) {
      if (!invitable.includes(opts.role as typeof ROLES[number]['value'])) {
        console.error(
          `\n  Your role (${me.role}) can't grant "${opts.role}". Allowed: ${invitable.join(', ')}.\n`,
        );
        process.exit(1);
      }
      return { role: opts.role, roleSource: `--role ${opts.role}` };
    }
    if (!interactive) {
      // No --role given and can't prompt: default to the safe baseline
      // (same default the interactive picker uses). Override with --role.
      return { role: 'member', roleSource: 'non-interactive default' };
    }
    const allowedChoices = ROLES.filter(r => invitable.includes(r.value));
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'role',
      message: `Select a role for ${email}:`,
      choices: allowedChoices,
      default: 'member',
    }]);
    return { role: answer.role, roleSource: undefined };
  }

  /** Resolves which project(s) a project-admin/member invite grants: by flag, non-interactive default, or checkbox. */
  private async resolveInviteeProjects(
    role: string,
    opts: InviteOpts,
    serviceClient: { listProjects: () => Promise<Array<{ id: string; name: string }>> },
    interactive: boolean,
    reissuing: boolean,
    existingProjectIds: string[],
    planInput: InvitePlanInput,
  ): Promise<{ projectId: string | undefined; extraProjectIds: string[]; projectSource: string | undefined }> {
    const projects = excludeSystemProject(await serviceClient.listProjects());
    if (projects.length === 0) {
      console.error('No projects in this organization. Create one with `capy` first.');
      process.exit(1);
    }
    // The cwd project sorts first (it's the most likely intent) and is
    // the non-interactive default when --project is omitted.
    const cwdProjectId = await this.resolveCwdProjectId(projects);

    if (opts.projects && opts.projects.length > 0) {
      const resolved = resolveProjectTokens(opts.projects, projects, cwdProjectId);
      return { projectId: resolved[0], extraProjectIds: resolved.slice(1), projectSource: planInput.projects?.flag };
    }

    if (!interactive) {
      // No --project: keep the member's existing projects on re-issue, else
      // fall back to the cwd project, else refuse — we won't silently grant
      // access to a project the caller didn't name.
      if (reissuing && existingProjectIds.length > 0) {
        return { projectId: existingProjectIds[0], extraProjectIds: existingProjectIds.slice(1), projectSource: 'existing membership' };
      }
      if (cwdProjectId) {
        return { projectId: cwdProjectId, extraProjectIds: [], projectSource: 'this directory' };
      }
      refuseNonInteractive(
        `role "${role}" needs project access and none was given`,
        `Pass --project <id|name> (available: ${projects.map((p) => p.name).join(', ')}).`,
      );
    }

    const { SEARCHABLE_CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME } = await import('../ui/promptStyle');
    const { searchableCheckbox } = await import('../ui/searchableCheckbox');
    const ordered = [...projects.filter((p) => p.id === cwdProjectId), ...projects.filter((p) => p.id !== cwdProjectId)];
    const ids = await searchableCheckbox<string>({
      message: `Grant ${role === 'project-admin' ? 'Project Admin' : 'Member'} access to which projects?`,
      instructions: SEARCHABLE_CHECKBOX_INSTRUCTIONS,
      theme: CHECKBOX_THEME,
      choices: ordered.map((p) => ({
        name: p.name,
        value: p.id,
        checked: p.id === cwdProjectId,
      })),
      validate: (v) => v.length > 0 || 'Pick at least one project',
    });
    return { projectId: ids[0], extraProjectIds: ids.slice(1), projectSource: undefined };
  }

  /**
   * Invites `extraProjectIds` one at a time (sequential, matching the
   * original loop — not concurrent), collecting a failure per id that
   * refused rather than aborting the rest. Recursion accumulates the result
   * instead of an array a loop body would push into.
   */
  private async fanOutExtraProjectInvites(
    orgId: string,
    email: string,
    role: string,
    extraProjectIds: ReadonlyArray<string>,
    serviceClient: { inviteToProject: (orgId: string, projectId: string, email: string, role: 'project-admin' | 'member') => Promise<unknown> },
  ): Promise<Array<{ projectId: string; error: string }>> {
    if (extraProjectIds.length === 0) return [];
    const [first, ...rest] = extraProjectIds;
    const firstFailure = await (async (): Promise<{ projectId: string; error: string } | null> => {
      try {
        await serviceClient.inviteToProject(orgId, first, email, role as 'project-admin' | 'member');
        return null;
      } catch (err: any) {
        return { projectId: first, error: err?.message ?? String(err) };
      }
    })();
    const restFailures = await this.fanOutExtraProjectInvites(orgId, email, role, rest, serviceClient);
    return firstFailure ? [firstFailure, ...restFailures] : restFailures;
  }
}
