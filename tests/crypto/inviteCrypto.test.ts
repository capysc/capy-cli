import { randomBytes } from 'crypto';
import {
  generateInviteToken,
  deriveInnerKey,
  innerWrap,
  innerUnwrap,
  buildRedeemCode,
  parseRedeemCode,
  resolveInviteTtlMs,
  MAX_INVITE_TTL_MS,
} from '../../src/crypto/inviteCrypto';

describe('inviteCrypto', () => {
  const masterKey = randomBytes(32);
  const orgId = 'test-org-123';
  const email = 'alice@example.com';

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
      const wrapped = innerWrap(masterKey, token, orgId, email);
      const unwrapped = innerUnwrap(wrapped, token, orgId, email);
      expect(unwrapped.equals(masterKey)).toBe(true);
    });

    it('fails with wrong token', () => {
      const token = generateInviteToken();
      const wrongToken = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId, email);
      expect(() => innerUnwrap(wrapped, wrongToken, orgId, email)).toThrow();
    });

    it('fails with wrong orgId', () => {
      const token = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId, email);
      expect(() => innerUnwrap(wrapped, token, 'wrong-org', email)).toThrow();
    });

    it('fails with wrong email', () => {
      const token = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId, email);
      expect(() => innerUnwrap(wrapped, token, orgId, 'eve@example.com')).toThrow();
    });

    it('email check is case-insensitive', () => {
      const token = generateInviteToken();
      const wrapped = innerWrap(masterKey, token, orgId, 'Alice@Example.COM');
      const unwrapped = innerUnwrap(wrapped, token, orgId, 'alice@example.com');
      expect(unwrapped.equals(masterKey)).toBe(true);
    });
  });

  describe('buildRedeemCode / parseRedeemCode', () => {
    it('round-trips token, orgId, ciphertext, and notAfter', () => {
      const token = generateInviteToken();
      const outerBlob = randomBytes(64).toString('base64');
      const notAfter = Date.now() + 3600_000;
      const code = buildRedeemCode(token, outerBlob, orgId, notAfter);
      const parsed = parseRedeemCode(code);
      expect(parsed.token.equals(token)).toBe(true);
      expect(parsed.orgId).toBe(orgId);
      expect(parsed.ciphertext).toBe(outerBlob);
      expect(parsed.notAfter).toBe(notAfter);
    });

    it('throws on invalid (too short) code', () => {
      const shortCode = randomBytes(16).toString('base64');
      expect(() => parseRedeemCode(shortCode)).toThrow(/too short/);
    });

    it('rejects unsupported version byte (forward compat)', () => {
      const token = generateInviteToken();
      const outerBlob = randomBytes(32).toString('base64');
      const code = buildRedeemCode(token, outerBlob, orgId, Date.now() + 60_000);
      const buf = Buffer.from(code, 'base64');
      buf.writeUInt8(0x99, 0); // bogus version
      const tampered = buf.toString('base64');
      expect(() => parseRedeemCode(tampered)).toThrow(/Unsupported redeem code version/);
    });
  });

  describe('full double-wrap flow', () => {
    it('simulates invite -> redeem -> co-decrypt -> unwrap', () => {
      // 1. Owner generates token and inner-wraps M (bound to recipient email)
      const token = generateInviteToken();
      const innerBlob = innerWrap(masterKey, token, orgId, email);

      // 2. Simulate outer wrap (local dev: simple AES)
      const { createCipheriv, createDecipheriv } = require('crypto');
      const serviceKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', serviceKey, iv, { authTagLength: 16 });
      const enc = Buffer.concat([cipher.update(Buffer.from(innerBlob, 'base64')), cipher.final()]);
      const tag = cipher.getAuthTag();
      const outerBlob = Buffer.concat([iv, enc, tag]).toString('base64');

      // 3. Build redeem code
      const code = buildRedeemCode(token, outerBlob, orgId, Date.now() + 3600_000);

      // 4. Recipient parses redeem code
      const { token: parsedToken, orgId: parsedOrgId, ciphertext } = parseRedeemCode(code);
      expect(parsedOrgId).toBe(orgId);

      // 5. Service co-decrypts (strips outer layer)
      const outerCombined = Buffer.from(ciphertext, 'base64');
      const oIv = outerCombined.subarray(0, 12);
      const oTag = outerCombined.subarray(outerCombined.length - 16);
      const oEnc = outerCombined.subarray(12, outerCombined.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', serviceKey, oIv, { authTagLength: 16 });
      decipher.setAuthTag(oTag);
      const innerBlobRecovered = Buffer.concat([decipher.update(oEnc), decipher.final()]).toString('base64');

      // 6. Recipient strips inner layer with T (must know correct email)
      const recoveredM = innerUnwrap(innerBlobRecovered, parsedToken, orgId, email);
      expect(recoveredM.equals(masterKey)).toBe(true);
    });
  });
});

describe('invite lifetime ceiling', () => {
  const HOUR = 60 * 60 * 1000;
  const original = process.env.CAPY_INVITE_TTL_SECONDS;
  afterEach(() => {
    if (original === undefined) delete process.env.CAPY_INVITE_TTL_SECONDS;
    else process.env.CAPY_INVITE_TTL_SECONDS = original;
  });

  test('the ceiling is 12 hours', () => {
    expect(MAX_INVITE_TTL_MS).toBe(12 * HOUR);
  });

  test('the default is the ceiling — saying nothing gets you the longest allowed', () => {
    delete process.env.CAPY_INVITE_TTL_SECONDS;
    expect(resolveInviteTtlMs()).toBe(MAX_INVITE_TTL_MS);
  });

  test('an env override longer than the ceiling is clamped, not honoured', () => {
    // The redeem code carries organization key material and sits in a mailbox
    // for its whole lifetime. Seven days of that was the old default.
    process.env.CAPY_INVITE_TTL_SECONDS = String(7 * 24 * 60 * 60);
    expect(resolveInviteTtlMs()).toBe(MAX_INVITE_TTL_MS);
  });

  test('a shorter env override still wins, so tests can expire codes quickly', () => {
    process.env.CAPY_INVITE_TTL_SECONDS = '60';
    expect(resolveInviteTtlMs()).toBe(60_000);
  });

  test('a nonsense env value falls back to the default rather than to zero', () => {
    process.env.CAPY_INVITE_TTL_SECONDS = 'later';
    expect(resolveInviteTtlMs()).toBe(MAX_INVITE_TTL_MS);
  });
});
