import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { deriveWrappingKey, encryptMasterKey } from '../crypto/keyManager';
import { saveMasterKey, hasOrgKey } from '../config/globalConfig';

export class RedeemCommand {
  private apiUrl?: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl;
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

    // 2. Authenticate (user must already have a WorkOS account)
    const authService = new AuthService(this.apiUrl);
    const authResult = await authService.authenticate();
    if (!authResult.success) {
      console.error('Authentication failed. You need a Capy account to redeem an invite.');
      process.exit(1);
    }

    let userId = authResult.user_id!;
    let orgId = authResult.organization_id!;

    // 3. If logged into a different org, authenticate for the invite's org.
    //    Multi-org sessions let both orgs coexist — no save/restore needed.
    if (orgId !== targetOrgId) {
      const switched = await authService.authenticate(targetOrgId);
      if (!switched.success) {
        console.error('Failed to switch to the invited organization. You may not have access.');
        process.exit(1);
      }
      orgId = targetOrgId;
      userId = switched.user_id!;
      console.log(`  Switched to organization \x1b[1m${targetOrgId}\x1b[0m`);
    }

    // 4. Reject if user already has the master key for this org
    if (hasOrgKey(orgId, userId)) {
      console.error('You are already a member of this organization.');
      process.exit(1);
    }

    const serviceToken = authService.getToken();
    const serviceClient = new ServiceClient(this.apiUrl);
    if (serviceToken) serviceClient.setToken(serviceToken);

    // 5. Service redeems invite (strips outer KMS layer + validates recipient email)
    let innerBlob: string;
    try {
      const result = await serviceClient.redeemInvite(orgId, ciphertext);
      innerBlob = result.plaintext;
    } catch (err: any) {
      console.error(`Redeem failed: ${err.message}`);
      console.error('You may not be the intended recipient, or the invite has been revoked.');
      process.exit(1);
    }

    // 5. Strip inner layer with T → recover M
    let masterKey: Buffer;
    try {
      const { innerUnwrap } = await import('../crypto/inviteCrypto');
      masterKey = innerUnwrap(innerBlob, token, orgId);
    } catch {
      console.error('Failed to unwrap invite. The redeem code may be corrupted.');
      process.exit(1);
    }

    // 6. Re-encrypt M under this user's wrapping key and store locally
    const wrappingKey = deriveWrappingKey(userId, orgId);
    const encryptedM = encryptMasterKey(masterKey, wrappingKey);
    saveMasterKey(orgId, encryptedM, userId);

    console.log('');
    console.log('  \x1b[32mInvite redeemed successfully!\x1b[0m');
    console.log('');
    console.log(`  You now have access to org \x1b[1m${orgId}\x1b[0m.`);
    console.log('  Run \x1b[1mcapy\x1b[0m in a project directory to sync secrets.');
    console.log('');
  }
}
