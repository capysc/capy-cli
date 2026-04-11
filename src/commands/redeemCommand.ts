import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { deriveWrappingKey, encryptMasterKey } from '../crypto/keyManager';
import { saveMasterKey, hasOrgKey } from '../config/globalConfig';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class RedeemCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(code: string): Promise<void> {
    // 1. Parse redeem code → T + target org + double-wrapped ciphertext
    let token: Buffer;
    let ciphertext: string;
    let targetOrgId: string;
    try {
      ({ token, orgId: targetOrgId, ciphertext } = parseRedeemCode(code));
    } catch (err: any) {
      console.error(`Invalid redeem code: ${err.message}`);
      process.exit(1);
    }

    // 2. Authenticate — try silent refresh first (no browser popup),
    //    fall back to full OAuth only if no session exists.
    //    The crypto layer (HKDF with email binding) is the real identity proof,
    //    not the OAuth ceremony.
    const authService = new AuthService(this.apiUrl, this.devMode);
    let authResult = await authService.authenticateSilent(targetOrgId);
    if (!authResult.success) {
      // No cached session — need interactive auth
      authResult = await authService.authenticate(targetOrgId);
      if (!authResult.success) {
        console.error(`Authentication failed. You need a ${B('Capy')} account to redeem an invite.`);
        process.exit(1);
      }
    }

    let userId = authResult.user_id!;
    let orgId = authResult.organization_id!;

    // 3. If we got a session for a different org (or no org), refresh into the target org.
    //    Multi-org sessions let both orgs coexist — no save/restore needed.
    if (orgId !== targetOrgId) {
      const switched = await authService.authenticateSilent(targetOrgId);
      if (!switched.success) {
        // Silent refresh failed — try full OAuth scoped to the target org
        const oauthResult = await authService.authenticate(targetOrgId);
        if (!oauthResult.success) {
          console.error('Failed to authenticate for the invited organization. You may not have access.');
          process.exit(1);
        }
        orgId = oauthResult.organization_id!;
        userId = oauthResult.user_id!;
      } else {
        orgId = targetOrgId;
        userId = switched.user_id!;
      }
    }

    // 4. If user already has the master key, they're already set up
    if (hasOrgKey(orgId, userId)) {
      console.log('');
      console.log('  \x1b[32mYou\'re all set — your encryption keys are configured for this organization.\x1b[0m');
      console.log(`  Run ${B('capy')} in a project directory to sync secrets.`);
      console.log('');
      return;
    }

    const serviceToken = authService.getToken();
    const serviceClient = new ServiceClient(this.apiUrl);
    if (serviceToken) serviceClient.setToken(serviceToken);

    // 5. Service co-decrypts (strips outer KMS layer)
    let innerBlob: string;
    try {
      const result = await serviceClient.coDecrypt(orgId, ciphertext);
      innerBlob = result.plaintext;
    } catch (err: any) {
      console.error(`Co-decryption failed: ${err.message}`);
      console.error('You may not be a member of this organization, or the invite has been revoked.');
      process.exit(1);
    }

    // 6. Strip inner layer with T → recover M
    //    The HKDF salt includes the recipient's email, so this fails
    //    cryptographically if the wrong user tries to unwrap.
    const userEmail = authResult.user_email || '';
    let masterKey: Buffer;
    try {
      const { innerUnwrap } = await import('../crypto/inviteCrypto');
      masterKey = innerUnwrap(innerBlob, token, orgId, userEmail);
    } catch {
      console.error(`Failed to unwrap invite. You're signed in as ${B(userEmail)} — this invite may be for a different account.`);
      process.exit(1);
    }

    // 6. Re-encrypt M under this user's wrapping key and store locally
    const wrappingKey = deriveWrappingKey(userId, orgId);
    const encryptedM = encryptMasterKey(masterKey, wrappingKey);
    saveMasterKey(orgId, encryptedM, userId);

    // Write user ID to sync-state so next `capy` run loads the right session
    const { ProjectManager } = await import('../core/projectManager');
    const pm = new ProjectManager();
    pm.writeSyncStateUserId(userId);

    console.log('');
    console.log('  \x1b[32mInvite redeemed successfully!\x1b[0m');
    console.log('');
    console.log(`  You now have access to org ${B(orgId)}.`);
    console.log(`  Run ${B('capy')} in a project directory to sync secrets.`);
    console.log('');
  }
}
