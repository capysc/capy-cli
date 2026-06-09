import { resolveOrgContext } from '../core/orgContext';
import { readMasterKey } from '../config/globalConfig';
import { decryptMasterKey, deriveWrappingKey, masterKeyAAD } from '../crypto/keyManager';
import { wrapAndSaveMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
  resolveInviteTtlMs,
} from '../crypto/inviteCrypto';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class TransportCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    try {
      const { orgId, userId, userEmail, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

      if (!userEmail) {
        console.error('Could not determine your email address. Re-authenticate and try again.');
        process.exit(1);
      }

      const encryptedM = readMasterKey(orgId, userId);
      if (!encryptedM) {
        console.error('No master key found for this organization on this machine.');
        process.exit(1);
      }

      let masterKey: Buffer;
      try {
        const { plaintext: innerBlob } = await serviceClient.coDecrypt(orgId, encryptedM);
        const wrappingKey = deriveWrappingKey(userId, orgId);
        masterKey = decryptMasterKey(innerBlob, wrappingKey, masterKeyAAD(userId, orgId));
      } catch {
        try {
          const wrappingKey = deriveWrappingKey(userId, orgId);
          masterKey = decryptMasterKey(encryptedM, wrappingKey, masterKeyAAD(userId, orgId));
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

      // Bind the inner key to the user's own email so only the same WorkOS
      // identity can unwrap on the destination machine.
      const transportToken = generateInviteToken();
      const innerBlob = innerWrap(masterKey, transportToken, orgId, userEmail);

      // Bind notAfter into the KMS EncryptionContext so a tampered redeem
      // code fails the AEAD unwrap (defence in depth on top of the explicit
      // server-side timestamp check). Same TTL policy as invites.
      const notAfter = Date.now() + resolveInviteTtlMs();
      const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
        orgId,
        innerBlob,
        notAfter,
      );

      const redeemCode = buildRedeemCode(transportToken, outerBlob, orgId, notAfter);
      const redeemCommand = `capy redeem ${redeemCode}`;

      console.log('');
      console.log(`  Transport code created for ${B(userEmail)}`);
      console.log('');
      console.log('  On the destination machine, sign in to Capy and run:');
      console.log('');
      console.log(`    ${B('capy')} redeem ${redeemCode}`);
      console.log('');
      console.log(`  \x1b[90mOnly ${userEmail} can redeem this code — the inner key is bound to your email.\x1b[0m`);
      console.log('  \x1b[90mService co-decryption verifies you are still a member at redeem time.\x1b[0m');
      console.log(`  \x1b[90mExpires ${new Date(notAfter).toISOString()}.\x1b[0m`);
      console.log('');

      const { promptCopyToClipboard } = await import('../ui/clipboard');
      await promptCopyToClipboard(redeemCommand);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}
