import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { readMasterKey } from '../config/globalConfig';
import { decryptMasterKey, deriveWrappingKey } from '../crypto/keyManager';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
} from '../crypto/inviteCrypto';

export class InviteCommand {
  async execute(email: string): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error('No .keep file found. Run capy first to initialize.');
      process.exit(1);
    }

    const orgId = projectState.organizationId;

    // Authenticate
    const authService = new AuthService();
    const serviceClient = new ServiceClient();
    const authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

    const userId = authResult.user_id!;

    // Read and unwrap master key
    const encryptedM = readMasterKey(orgId);
    if (!encryptedM) {
      console.error('No master key found for this organization. Only the org owner can invite.');
      process.exit(1);
    }

    const wrappingKey = deriveWrappingKey(userId, orgId);
    let masterKey: Buffer;
    try {
      masterKey = decryptMasterKey(encryptedM, wrappingKey);
    } catch {
      console.error('Failed to unwrap master key. Re-authenticate and try again.');
      process.exit(1);
    }

    // 1. Generate invite token T
    const inviteToken = generateInviteToken();

    // 2. Inner wrap M with HKDF(T, orgId)
    const innerBlob = innerWrap(masterKey, inviteToken, orgId);

    // 3. Service outer wraps (KMS layer)
    const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
      orgId,
      Buffer.from(innerBlob, 'base64').toString('base64'),
    );

    // 4. Create invite record on service
    await serviceClient.createInvite(orgId, email);

    // 5. Add as org member
    // Note: In production, this would call WorkOS createUser first to get a userId
    await serviceClient.addMember(orgId, `pending:${email}`, email, 'org_admin');

    // 6. Build redeem code
    const redeemCode = buildRedeemCode(inviteToken, outerBlob);

    console.log('');
    console.log(`  Invite created for \x1b[1m${email}\x1b[0m`);
    console.log('');
    console.log('  Send them this command:');
    console.log('');
    console.log(`    capy redeem ${redeemCode}`);
    console.log('');
    console.log('  \x1b[90mThe code contains a double-wrapped copy of the org key.\x1b[0m');
    console.log('  \x1b[90mIt cannot be decrypted without service co-decryption + authentication.\x1b[0m');
    console.log('');
  }
}
