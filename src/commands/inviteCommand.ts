import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { readMasterKey } from '../config/globalConfig';
import { decryptMasterKey, deriveWrappingKey } from '../crypto/keyManager';
import { wrapAndSaveMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
} from '../crypto/inviteCrypto';

const ROLES = [
  { name: 'Member', value: 'member' },
  { name: 'Project Admin', value: 'project-admin' },
  { name: 'Admin', value: 'admin' },
] as const;

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

      // Prompt for role
      const { role } = await inquirer.prompt([{
        type: 'list',
        name: 'role',
        message: `Select a role for ${email}:`,
        choices: ROLES,
        default: 'member',
      }]);

      // 1. Generate invite token T
      const inviteToken = generateInviteToken();

      // 2. Inner wrap M with HKDF(T, salt=orgId:email)
      //    The recipient email is bound into the HKDF salt so only they can unwrap.
      const innerBlob = innerWrap(masterKey, inviteToken, orgId, email);

      // 3. Service outer wraps (KMS layer)
      const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
        orgId,
        Buffer.from(innerBlob, 'base64').toString('base64'),
      );

      // 4. Create invite record on service
      await serviceClient.createInvite(orgId, email, role);

      // 5. Build redeem code
      const redeemCode = buildRedeemCode(inviteToken, outerBlob, orgId);

      const roleName = ROLES.find(r => r.value === role)?.name ?? role;
      const redeemCommand = `capy redeem ${redeemCode}`;

      console.log('');
      console.log(`  Invite created for \x1b[1m${email}\x1b[0m as \x1b[1m${roleName}\x1b[0m`);
      console.log('');
      console.log('  Send them this command:');
      console.log('');
      console.log(`    ${B('capy')} redeem ${redeemCode}`);
      console.log('');
      console.log('  \x1b[90mThe code contains a double-wrapped copy of the org key.\x1b[0m');
      console.log('  \x1b[90mIt cannot be decrypted without service co-decryption + authentication.\x1b[0m');
      console.log('');

      const { promptCopyToClipboard } = await import('../ui/clipboard');
      await promptCopyToClipboard(redeemCommand);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}
