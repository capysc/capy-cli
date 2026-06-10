import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { readMasterKey } from '../config/globalConfig';
import { unwrapMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
  resolveInviteTtlMs,
} from '../crypto/inviteCrypto';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';

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
}

/** Parse "30s"/"10m"/"24h"/"7d" or bare seconds → ms. Exits on invalid input. */
function parseTtlMs(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) {
    console.error(`\n  Invalid --ttl "${raw}". Use e.g. 30m, 24h, 7d, or a number of seconds.\n`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 's').toLowerCase()]!;
  return n * mult;
}

/** Resolve the invite's notAfter (ms epoch) from --expires / --ttl / env default. Exits on invalid. */
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
    return t;
  }
  if (opts.ttl) return Date.now() + parseTtlMs(opts.ttl);
  return Date.now() + resolveInviteTtlMs();
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


      // Read and unwrap master key (double-wrapped: KMS outer + local inner)
      const encryptedM = readMasterKey(orgId, userId);
      if (!encryptedM) {
        console.error('No master key found for this organization. Only the org owner can invite.');
        process.exit(1);
      }

      // Recover M via the shared resolver: co-decrypt strips the KMS outer
      // layer, the inner layer is unwrapped under K_local (legacy SHA256
      // fallback + transparent migration). The invite payload re-wraps M under
      // the invite token, so K_local never enters it.
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
      const reissuing = !!existingMember;
      const existingProjectIds = existingMember
        ? (existingMember.projects || []).map((p) => p.id)
        : [];

      // Pure re-issue (existing member, no explicit --role): reuse their current
      // role + projects. But an explicit --role MUST be honored so admins can
      // promote/demote on re-invite — and so a re-invite that races a just-issued
      // `kick` (a not-yet-propagated member read) still applies the requested
      // role instead of silently keeping the stale one.
      if (existingMember && !opts.role) {
        role = existingMember.role;
        projectId = existingProjectIds[0];
        extraProjectIds = existingProjectIds.slice(1);
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
        } else if (!interactive) {
          // No --role given and can't prompt: default to the safe baseline
          // (same default the interactive picker uses). Override with --role.
          role = 'member';
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
            // Resolve each token (id or name) to an id; refuse on unknowns.
            const resolved: string[] = [];
            for (const token of opts.projects) {
              const match = projects.find((p) => p.id === token || p.name === token);
              if (!match) {
                console.error(
                  `\n  No project "${token}" in this org. Available: ${projects.map((p) => p.name).join(', ')}.\n`,
                );
                process.exit(1);
              }
              if (!resolved.includes(match.id)) resolved.push(match.id);
            }
            resolved.sort((a, b) => cwdFirst({ id: a }, { id: b }));
            projectId = resolved[0];
            extraProjectIds = resolved.slice(1);
          } else if (!interactive) {
            // No --project: keep the member's existing projects on re-issue, else
            // fall back to the cwd project, else refuse — we won't silently grant
            // access to a project the caller didn't name.
            if (reissuing && existingProjectIds.length > 0) {
              projectId = existingProjectIds[0];
              extraProjectIds = existingProjectIds.slice(1);
            } else if (cwdProjectId) {
              projectId = cwdProjectId;
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
      console.log('  \x1b[90mThe code contains a double-wrapped copy of the org key.\x1b[0m');
      console.log('  \x1b[90mIt cannot be decrypted without service co-decryption + authentication.\x1b[0m');
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
      displayErrorAndExit(error);
    }
  }
}
