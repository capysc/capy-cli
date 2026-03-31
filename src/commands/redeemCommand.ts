import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { deriveWrappingKey, encryptMasterKey } from '../crypto/keyManager';
import { saveMasterKey } from '../config/globalConfig';

export class RedeemCommand {
  private apiUrl?: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl;
  }

  async execute(code: string): Promise<void> {
    // 1. Parse redeem code → T + double-wrapped ciphertext
    let token: Buffer;
    let ciphertext: string;
    try {
      ({ token, ciphertext } = parseRedeemCode(code));
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
    const serviceToken = authService.getToken();
    const userId = authResult.user_id!;
    const orgId = authResult.organization_id!;

    const serviceClient = new ServiceClient(this.apiUrl);
    if (serviceToken) serviceClient.setToken(serviceToken);

    // 3. Store T + ciphertext locally for every-session co-decryption
    //    On each `capy` run, CLI sends ciphertext to service → service strips outer
    //    layer → CLI uses T to strip inner layer → M in memory → HKDF → project key
    //
    //    For now, we do the full round-trip at redeem time to verify it works,
    //    then re-encrypt M under the user's own wrapping key for local storage.

    // 4. Service co-decrypts (strips outer KMS layer)
    let innerBlob: string;
    try {
      const result = await serviceClient.coDecrypt(orgId, ciphertext);
      innerBlob = result.plaintext;
    } catch (err: any) {
      console.error(`Co-decryption failed: ${err.message}`);
      console.error('You may not be a member of this organization, or the invite has been revoked.');
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
    saveMasterKey(orgId, encryptedM);

    console.log('');
    console.log('  \x1b[32mInvite redeemed successfully!\x1b[0m');
    console.log('');
    console.log(`  You now have access to org \x1b[1m${orgId}\x1b[0m.`);
    console.log('  Run \x1b[1mcapy\x1b[0m in a project directory to sync secrets.');
    console.log('');
  }
}
