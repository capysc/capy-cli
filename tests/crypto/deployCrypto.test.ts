import { randomBytes } from 'crypto';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  deployInnerUnwrap,
  buildDeployCode,
  parseDeployCode,
} from '../../src/crypto/deployCrypto';
import { deriveInnerKey } from '../../src/crypto/inviteCrypto';

describe('deployCrypto', () => {
  const projectKey = randomBytes(32);
  const projectId = 'test-project-456';

  describe('generateDeployId', () => {
    it('generates a 32-byte deploy ID', () => {
      const id = generateDeployId();
      expect(id).toBeInstanceOf(Buffer);
      expect(id.length).toBe(32);
    });

    it('generates unique IDs', () => {
      const a = generateDeployId();
      const b = generateDeployId();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('generateDerivationToken', () => {
    it('generates a 32-byte token', () => {
      const dt = generateDerivationToken();
      expect(dt).toBeInstanceOf(Buffer);
      expect(dt.length).toBe(32);
    });
  });

  describe('deployInnerWrap / deployInnerUnwrap', () => {
    it('round-trips project key', () => {
      const dt = generateDerivationToken();
      const wrapped = deployInnerWrap(projectKey, dt, projectId);
      const unwrapped = deployInnerUnwrap(wrapped, dt, projectId);
      expect(unwrapped.equals(projectKey)).toBe(true);
    });

    it('fails with wrong DT', () => {
      const dt = generateDerivationToken();
      const wrongDt = generateDerivationToken();
      const wrapped = deployInnerWrap(projectKey, dt, projectId);
      expect(() => deployInnerUnwrap(wrapped, wrongDt, projectId)).toThrow();
    });

    it('fails with wrong projectId', () => {
      const dt = generateDerivationToken();
      const wrapped = deployInnerWrap(projectKey, dt, projectId);
      expect(() => deployInnerUnwrap(wrapped, dt, 'wrong-project')).toThrow();
    });
  });

  describe('deploy vs invite key separation', () => {
    it('same token produces different keys for deploy vs invite', () => {
      const token = randomBytes(32);
      const salt = 'same-salt';
      const deployKey = deriveInnerKey(token, salt, 'capy:deploy');
      const inviteKey = deriveInnerKey(token, salt, 'capy:invite');
      expect(deployKey.equals(inviteKey)).toBe(false);
    });
  });

  describe('buildDeployCode / parseDeployCode', () => {
    it('round-trips deploy ID, DT, and outer blob', () => {
      const deployId = generateDeployId();
      const dt = generateDerivationToken();
      const outerBlob = randomBytes(96).toString('base64');

      const code = buildDeployCode(deployId, dt, outerBlob);
      const parsed = parseDeployCode(code);

      expect(parsed.deployId.equals(deployId)).toBe(true);
      expect(parsed.dt.equals(dt)).toBe(true);
      expect(parsed.outerBlob).toBe(outerBlob);
    });

    it('throws on too-short deploy code', () => {
      const shortCode = randomBytes(32).toString('base64');
      expect(() => parseDeployCode(shortCode)).toThrow(/too short/);
    });

    it('throws on exactly 64 bytes (no outer blob)', () => {
      const exactCode = randomBytes(64).toString('base64');
      expect(() => parseDeployCode(exactCode)).toThrow(/too short/);
    });
  });

  describe('full deploy roundtrip', () => {
    it('simulates setup -> KMS wrap -> CI decrypt -> SDK key', () => {
      // 1. Setup: generate deploy ID, DT, inner-wrap PK
      const deployId = generateDeployId();
      const dt = generateDerivationToken();
      const innerBlob = deployInnerWrap(projectKey, dt, projectId);

      // 2. Simulate KMS outer wrap (local dev: simple AES)
      const { createCipheriv, createDecipheriv } = require('crypto');
      const kmsKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kmsKey, iv, { authTagLength: 16 });
      const enc = Buffer.concat([cipher.update(Buffer.from(innerBlob, 'base64')), cipher.final()]);
      const tag = cipher.getAuthTag();
      const outerBlob = Buffer.concat([iv, enc, tag]).toString('base64');

      // 3. Build deploy code
      const code = buildDeployCode(deployId, dt, outerBlob);

      // 4. CI parses deploy code
      const parsed = parseDeployCode(code);

      // 5. Service KMS-unwraps outer blob
      const outerCombined = Buffer.from(parsed.outerBlob, 'base64');
      const oIv = outerCombined.subarray(0, 12);
      const oTag = outerCombined.subarray(outerCombined.length - 16);
      const oEnc = outerCombined.subarray(12, outerCombined.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', kmsKey, oIv, { authTagLength: 16 });
      decipher.setAuthTag(oTag);
      const recoveredInnerBlob = Buffer.concat([decipher.update(oEnc), decipher.final()]).toString('base64');

      // 6. CI unwraps inner layer with DT
      const recoveredPK = deployInnerUnwrap(recoveredInnerBlob, parsed.dt, projectId);
      expect(recoveredPK.equals(projectKey)).toBe(true);

      // 7. Verify the recovered key is a valid hex CAPY_KEY
      const pkHex = recoveredPK.toString('hex');
      expect(pkHex).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
