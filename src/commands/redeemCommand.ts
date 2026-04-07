import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { deriveWrappingKey, encryptMasterKey } from '../crypto/keyManager';
import { saveMasterKey, hasOrgKey } from '../config/globalConfig';

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

    // 2. Authenticate, scoped to the invite's org so WorkOS skips org selection
    const authService = new AuthService(this.apiUrl, this.devMode);
    const authResult = await authService.authenticate(targetOrgId);
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

    // 4. If user already has the master key, they're already set up
    if (hasOrgKey(orgId, userId)) {
      console.log('');
      console.log('  \x1b[32mYou\'re all set — your encryption keys are configured for this organization.\x1b[0m');
      console.log(`  Run \x1b[1mcapy\x1b[0m in a project directory to sync secrets.`);
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
      console.error('Failed to unwrap invite. The redeem code may not be intended for your account.');
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
    console.log(`  You now have access to org \x1b[1m${orgId}\x1b[0m.`);
    console.log('  Run \x1b[1mcapy\x1b[0m in a project directory to sync secrets.');
    console.log('');
  }
}
