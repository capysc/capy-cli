import { randomBytes } from 'crypto';
import {
  generateInviteToken,
  deriveInnerKey,
  innerWrap,
  innerUnwrap,
  buildRedeemCode,
  parseRedeemCode,
} from '../../src/crypto/inviteCrypto';

describe('inviteCrypto', () => {
  const masterKey = randomBytes(32);
  const orgId = 'test-org-123';

  describe('generateInviteToken', () => {
    it('generates a 32-byte token', () => {
      const token = generateInviteToken();
      expect(token).toBeInstanceOf(Buffer);
      expect(token.length).toBe(32);
    });

    it('generates unique tokens', () => {
      const t1 = generateInviteToken();
      const t2 = generateInviteToken();
      expect(t1.equals(t2)).toBe(false);
    });
  });

  describe('deriveInnerKey', () => {
    it('derives a 32-byte key', () => {
      const token = generateInviteToken();
      const key = deriveInnerKey(token, orgId, 'capy:invite');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('different tokens produce different keys', () => {
      const t1 = generateInviteToken();
      const t2 = generateInviteToken();
      const k1 = deriveInnerKey(t1, orgId, 'capy:invite');
      const k2 = deriveInnerKey(t2, orgId, 'capy:invite');
      expect(k1.equals(k2)).toBe(false);
    });

    it('different orgIds produce different keys', () => {
      const token = generateInviteToken();
      const k1 = deriveInnerKey(token, 'org-a', 'capy:invite');
      const k2 = deriveInnerKey(token, 'org-b', 'capy:invite');
      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe('innerWrap / innerUnwrap', () => {
    it('round-trips master key', () => {
      const token = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId);
      const unwrapped = innerUnwrap(wrapped, token, orgId);
      expect(unwrapped.equals(masterKey)).toBe(true);
    });

    it('fails with wrong token', () => {
      const token = generateInviteToken();
      const wrongToken = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId);
      expect(() => innerUnwrap(wrapped, wrongToken, orgId)).toThrow();
    });

    it('fails with wrong orgId', () => {
      const token = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId);
      expect(() => innerUnwrap(wrapped, token, 'wrong-org')).toThrow();
    });
  });

  describe('buildRedeemCode / parseRedeemCode', () => {
    it('round-trips token and ciphertext', () => {
      const token = generateInviteToken();
      const outerBlob = randomBytes(64).toString('base64');
      const code = buildRedeemCode(token, outerBlob);
      const parsed = parseRedeemCode(code);
      expect(parsed.token.equals(token)).toBe(true);
      expect(parsed.ciphertext).toBe(outerBlob);
    });

    it('throws on invalid (too short) code', () => {
      const shortCode = randomBytes(16).toString('base64');
      expect(() => parseRedeemCode(shortCode)).toThrow(/too short/);
    });
  });

  describe('full double-wrap flow', () => {
    it('simulates invite -> redeem -> co-decrypt -> unwrap', () => {
      // 1. Owner generates token and inner-wraps M
      const token = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId);

      // 2. Simulate outer wrap (local dev: simple AES)
      const { createCipheriv, createDecipheriv } = require('crypto');
      const serviceKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', serviceKey, iv, { authTagLength: 16 });
      const enc = Buffer.concat([cipher.update(Buffer.from(innerBlob, 'base64')), cipher.final()]);
      const tag = cipher.getAuthTag();
      const outerBlob = Buffer.concat([iv, enc, tag]).toString('base64');

      // 3. Build redeem code
      const code = buildRedeemCode(token, outerBlob);

      // 4. Recipient parses redeem code
      const { token: parsedToken, ciphertext } = parseRedeemCode(code);

      // 5. Service co-decrypts (strips outer layer)
      const outerCombined = Buffer.from(ciphertext, 'base64');
      const oIv = outerCombined.subarray(0, 12);
      const oTag = outerCombined.subarray(outerCombined.length - 16);
      const oEnc = outerCombined.subarray(12, outerCombined.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', serviceKey, oIv, { authTagLength: 16 });
      decipher.setAuthTag(oTag);
      const innerBlobRecovered = Buffer.concat([decipher.update(oEnc), decipher.final()]).toString('base64');

      // 6. Recipient strips inner layer with T
      const recoveredM = innerUnwrap(innerBlobRecovered, parsedToken, orgId);
      expect(recoveredM.equals(masterKey)).toBe(true);
    });
  });
});
