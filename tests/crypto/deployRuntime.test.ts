import { randomBytes } from 'crypto';
import { parseSecretsBlob } from '../../src/crypto/deployRuntime';

describe('deployRuntime.parseSecretsBlob', () => {
  it('parses a valid SECRETS_BLOB produced by buildSecretsBlob format', () => {
    const deployId = randomBytes(32);
    const outerBlob = randomBytes(80);
    const encryptedVars = randomBytes(60);

    // Reproduce buildSecretsBlob format: deployId[32] || len[4 BE] || outerBlob || encryptedVars
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(outerBlob.length, 0);
    const blob = Buffer.concat([deployId, lenBuf, outerBlob, encryptedVars]).toString('base64');

    const parsed = parseSecretsBlob(blob);
    expect(parsed.deployId.equals(deployId)).toBe(true);
    expect(parsed.outerBlob.equals(outerBlob)).toBe(true);
    expect(parsed.encryptedVars.equals(encryptedVars)).toBe(true);
  });

  it('throws on too-short blob', () => {
    const tiny = Buffer.alloc(16).toString('base64');
    expect(() => parseSecretsBlob(tiny)).toThrow(/too short/);
  });

  it('throws when outer_blob is truncated', () => {
    const deployId = randomBytes(32);
    const lenBuf = Buffer.alloc(4);
    // Claim 1000 bytes of outer blob but provide none.
    lenBuf.writeUInt32BE(1000, 0);
    const blob = Buffer.concat([deployId, lenBuf, Buffer.alloc(10)]).toString('base64');
    expect(() => parseSecretsBlob(blob)).toThrow(/truncated/);
  });
});
