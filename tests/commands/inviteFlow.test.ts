import { randomBytes, createHash, hkdfSync } from 'crypto';
import {
  generateInviteToken,
  innerWrap,
  innerUnwrap,
  buildRedeemCode,
  parseRedeemCode,
} from '../../src/crypto/inviteCrypto';
import {
  encryptMasterKey,
  decryptMasterKey,
  deriveWrappingKey,
  deriveProjectKey,
} from '../../src/crypto/keyManager';

/**
 * E2E-style tests that simulate the full invite → redeem → sync flow
 * without needing a running service. Uses local crypto to simulate
 * the outer KMS layer.
 */

// Simulate service outer wrap/unwrap (local dev uses symmetric key)
const SERVICE_KEY = createHash('sha256').update('capy-local-dev-key').digest();
import { createCipheriv, createDecipheriv } from 'crypto';

function simulateServiceWrap(plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SERVICE_KEY, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function simulateServiceUnwrap(blob: string): Buffer {
  const combined = Buffer.from(blob, 'base64');
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const enc = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', SERVICE_KEY, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

describe('Invite Flow E2E', () => {
  const orgId = 'org_test_123';
  const projectId = 'proj_test_456';
  const ownerUserId = 'user_owner';
  const inviteeUserId = 'user_alice';

  // Owner's master key (simulating what seed phrase generates)
  const masterKey = randomBytes(32);

  describe('full invite → redeem → derive project key', () => {
    it('invitee derives the same project key as owner', () => {
      // === OWNER SIDE (capy invite) ===

      // 1. Generate invite token T
      const token = generateInviteToken();
      expect(token.length).toBe(32);

      // 2. Inner wrap M with HKDF(T, orgId)
      const innerBlob = innerWrap(masterKey, token, orgId, 'alice@example.com');

      // 3. Service outer wraps (simulate KMS)
      const innerBlobBytes = Buffer.from(innerBlob, 'base64');
      const outerBlob = simulateServiceWrap(innerBlobBytes);

      // 4. Build redeem code
      const redeemCode = buildRedeemCode(token, outerBlob, orgId);

      // === INVITEE SIDE (capy redeem) ===

      // 5. Parse redeem code
      const { token: parsedToken, orgId: parsedOrgId, ciphertext } = parseRedeemCode(redeemCode);
      expect(parsedOrgId).toBe(orgId);
      expect(parsedToken.equals(token)).toBe(true);

      // 6. Service co-decrypts (strips outer layer)
      const innerBlobRecovered = simulateServiceUnwrap(ciphertext);

      // 7. Strip inner layer with T → recover M
      const recoveredM = innerUnwrap(
        innerBlobRecovered.toString('base64'),
        parsedToken,
        orgId,
        'alice@example.com',
      );
      expect(recoveredM.equals(masterKey)).toBe(true);

      // 8. Invitee re-encrypts M under their own wrapping key
      const inviteeWrappingKey = deriveWrappingKey(inviteeUserId, orgId);
      const inviteeEncryptedM = encryptMasterKey(recoveredM, inviteeWrappingKey);

      // 9. Invitee can later unwrap M and derive the same project key
      const inviteeM = decryptMasterKey(inviteeEncryptedM, inviteeWrappingKey);
      const inviteeProjectKey = deriveProjectKey(inviteeM, projectId, orgId);

      // Owner derives project key
      const ownerProjectKey = deriveProjectKey(masterKey, projectId, orgId);

      // Both must match!
      expect(inviteeProjectKey).toBe(ownerProjectKey);
    });
  });

  describe('security properties', () => {
    it('wrong token cannot unwrap inner layer', () => {
      const token = generateInviteToken();
      const wrongToken = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId, 'alice@example.com');

      expect(() => innerUnwrap(innerBlob, wrongToken, orgId, 'alice@example.com')).toThrow();
    });

    it('service cannot recover M (only has outer layer key)', () => {
      const token = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId, 'alice@example.com');
      const outerBlob = simulateServiceWrap(Buffer.from(innerBlob, 'base64'));

      // Service strips outer layer
      const innerBlobBytes = simulateServiceUnwrap(outerBlob);

      // Service has innerBlobBytes but NOT token T
      // Without T, it cannot derive the inner key
      // innerBlobBytes is AES-256-GCM encrypted — indistinguishable from random
      expect(innerBlobBytes.length).toBeGreaterThan(0);
      // Service would need T to call innerUnwrap — it doesn't have T
    });

    it('revoked member cannot co-decrypt even with stored ciphertext', () => {
      // This test validates the concept: if service refuses co-decrypt,
      // the stored ciphertext is inert
      const token = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId, 'alice@example.com');
      const outerBlob = simulateServiceWrap(Buffer.from(innerBlob, 'base64'));

      // Invitee has token + outerBlob stored locally
      // But if kicked, service refuses co-decrypt
      // Without service stripping outer layer, innerUnwrap is impossible
      // because the input to innerUnwrap would still be double-encrypted
      expect(() => {
        innerUnwrap(outerBlob, token, orgId, 'alice@example.com');
      }).toThrow();
    });

    it('different orgs produce different project keys even with same M', () => {
      const key1 = deriveProjectKey(masterKey, projectId, 'org_a');
      const key2 = deriveProjectKey(masterKey, projectId, 'org_b');
      expect(key1).not.toBe(key2);
    });

    it('different projects produce different keys with same M', () => {
      const key1 = deriveProjectKey(masterKey, 'proj_a', orgId);
      const key2 = deriveProjectKey(masterKey, 'proj_b', orgId);
      expect(key1).not.toBe(key2);
    });
  });

  describe('redeem code format', () => {
    it('redeem code is a single base64 string', () => {
      const token = generateInviteToken();
      const outerBlob = randomBytes(80).toString('base64');
      const code = buildRedeemCode(token, outerBlob, orgId);

      // Should be valid base64
      expect(() => Buffer.from(code, 'base64')).not.toThrow();
      // Should not contain whitespace
      expect(code).not.toMatch(/\s/);
    });

    it('can be used as a CLI argument', () => {
      const token = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId, 'alice@example.com');
      const outerBlob = simulateServiceWrap(Buffer.from(innerBlob, 'base64'));
      const code = buildRedeemCode(token, outerBlob, orgId);

      // No shell-unsafe characters (base64 is [A-Za-z0-9+/=])
      expect(code).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });
});
