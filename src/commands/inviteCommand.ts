import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { readMasterKey } from '../config/globalConfig';
import { decryptMasterKey, deriveWrappingKey } from '../crypto/keyManager';
import { wrapAndSaveMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
  resolveInviteTtlMs,
} from '../crypto/inviteCrypto';

const ROLES = [
  { name: 'Member', value: 'member' },
  { name: 'Project Admin', value: 'project-admin' },
  { name: 'Admin', value: 'admin' },
] as const;

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

  async execute(email: string): Promise<void> {
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

      let masterKey: Buffer;
      try {
        // Strip KMS outer layer via server co-decrypt
        const { plaintext: innerBlob } = await serviceClient.coDecrypt(orgId, encryptedM);
        // Strip local inner layer
        const wrappingKey = deriveWrappingKey(userId, orgId);
        masterKey = decryptMasterKey(innerBlob, wrappingKey);
      } catch (err: any) {
        // Fallback: try legacy single-wrapped (no KMS outer)
        try {
          const wrappingKey = deriveWrappingKey(userId, orgId);
          masterKey = decryptMasterKey(encryptedM, wrappingKey);
          // Migration: re-wrap with KMS outer layer
          const keyOps = {
            coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
            wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
          };
          await wrapAndSaveMasterKey(masterKey, orgId, userId, keyOps);
        } catch {
          console.error('Failed to unwrap master key. Re-authenticate and try again.');
          process.exit(1);
        }
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

      if (existingMember) {
        role = existingMember.role;
        const existingProjectIds = (existingMember.projects || []).map((p) => p.id);
        projectId = existingProjectIds[0];
        extraProjectIds = existingProjectIds.slice(1);
      } else {
        // Prompt for role, filtered to what the caller may grant.
        const allowedChoices = ROLES.filter(r => invitable.includes(r.value));
        const answer = await inquirer.prompt([{
          type: 'list',
          name: 'role',
          message: `Select a role for ${email}:`,
          choices: allowedChoices,
          default: 'member',
        }]);
        role = answer.role;

        // Project scope is required for project-admin and member. Multi-select
        // so the inviter can grant access to several projects at once.
        if (role === 'project-admin' || role === 'member') {
          const projects = await serviceClient.listProjects();
          if (projects.length === 0) {
            console.error('No projects in this organization. Create one with `capy` first.');
            process.exit(1);
          }
          // Preselect the cwd project if we're inside one and it's available.
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

          const { CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME } = await import('../ui/promptStyle');
          const { chosenProjectIds } = await inquirer.prompt<{ chosenProjectIds: string[] }>({
            type: 'checkbox',
            name: 'chosenProjectIds',
            message: `Grant ${role === 'project-admin' ? 'Project Admin' : 'Member'} access to which projects?`,
            instructions: CHECKBOX_INSTRUCTIONS,
            theme: CHECKBOX_THEME,
            choices: projects.map((p) => ({
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

      // 1. Generate invite token T
      const inviteToken = generateInviteToken();

      // 2. Inner wrap M with HKDF(T, salt=orgId:email)
      //    The recipient email is bound into the HKDF salt so only they can unwrap.
      const innerBlob = innerWrap(masterKey, inviteToken, orgId, email);

      // 3. Service outer wraps (KMS layer), bound to (orgId, notAfter) so
      //    the redeem code can't outlive its window even if forwarded.
      const notAfter = Date.now() + resolveInviteTtlMs();
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

      const { promptCopyToClipboard } = await import('../ui/clipboard');
      await promptCopyToClipboard(redeemCommand);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}
