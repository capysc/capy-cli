import { randomBytes, hkdfSync, createCipheriv } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  generateDeployId,
  generateDeployKey,
  generateInnerSecret,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../../src/crypto/deployCrypto';
import {
  parseSecretsBlob,
  decryptSecretsBlob,
  parseEnvPlaintext,
} from '../../src/crypto/deployRuntime';
import { deriveInnerKey } from '../../src/crypto/inviteCrypto';

const PEM = readFileSync(join(__dirname, '../fixtures/rsa_test_key.pem'), 'utf-8');

// Derives the same DECRYPT_KEY the deploy/run pair uses, so a test can mint a
// blob in either the current (JSON) or legacy (KEY=value\n) plaintext format.
function deriveDecryptKey(pk: Buffer, innerBlob: string, projectId: string, deployId: Buffer): Buffer {
  const innerBlobBytes = Buffer.from(innerBlob, 'base64');
  const serviceKey = Buffer.from(
    hkdfSync('sha256', innerBlobBytes, projectId + deployId.toString('hex'), 'capy:deploy:service-key', 32),
  );
  const combined = Buffer.concat([pk, serviceKey]);
  return Buffer.from(hkdfSync('sha256', combined, deployId, 'capy:deploy:decrypt', 32));
}

function serviceKeyHexFor(innerBlob: string, projectId: string, deployId: Buffer): string {
  const innerBlobBytes = Buffer.from(innerBlob, 'base64');
  return Buffer.from(
    hkdfSync('sha256', innerBlobBytes, projectId + deployId.toString('hex'), 'capy:deploy:service-key', 32),
  ).toString('hex');
}

// Encrypts an arbitrary plaintext under the deploy DECRYPT_KEY, reproducing the
// AES-256-GCM framing of encryptEnvBlob. Used to mint a *legacy*-format blob.
function encryptPlaintextBlob(plaintext: string, decryptKey: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decryptKey, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]);
}

describe('deployCrypto', () => {
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

  describe('generateDeployKey / generateInnerSecret', () => {
    it('generates a 32-byte per-deploy key, different every time', () => {
      const a = generateDeployKey();
      expect(a).toBeInstanceOf(Buffer);
      expect(a.length).toBe(32);
      expect(a.equals(generateDeployKey())).toBe(false);
    });

    it('generates a base64 inner secret of 32 random bytes, different every time', () => {
      const a = generateInnerSecret();
      expect(Buffer.from(a, 'base64').length).toBe(32);
      expect(Buffer.from(a, 'base64').toString('base64')).toBe(a);
      expect(generateInnerSecret()).not.toBe(a);
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

  describe('encryptEnvBlob / decryptSecretsBlob round-trip (zero-trust)', () => {
    it('mint-side encrypt round-trips with consumer-side decrypt via service_key', () => {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const envVars = {
        DATABASE_URL: 'postgres://u:p@h/d',
        STRIPE_API_KEY: 'sk_test_xxx',
        OPENAI_API_KEY: 'sk-proj-abc',
      };

      // Mint side: exactly what capy deploy does.
      const innerBlob = generateInnerSecret();
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);

      // Simulate the server's service_key derivation. In production, the server
      // KMS-unwraps outerBlob to get innerBlob bytes, then derives service_key
      // from those bytes. Here we skip KMS and go directly from innerBlob.
      const innerBlobBytes = Buffer.from(innerBlob, 'base64');
      const salt = projectId + deployId.toString('hex');
      const serviceKeyHex = Buffer.from(
        hkdfSync('sha256', innerBlobBytes, salt, 'capy:deploy:service-key', 32),
      ).toString('hex');

      // Consumer side: derive DECRYPT_KEY from pk + service_key, decrypt.
      const decrypted = decryptSecretsBlob(
        encryptedVars,
        pk.toString('hex'),
        serviceKeyHex,
        deployId,
      );
      expect(decrypted).toEqual(envVars);
    });

    it('the key alone cannot decrypt without the service key (zero-trust property)', () => {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const envVars = { SECRET: 'leaked' };

      const innerBlob = generateInnerSecret();
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);

      // An attacker with just the key (no service_key) should not be able to decrypt.
      // Using a zero-filled service_key yields a wrong DECRYPT_KEY → auth fail.
      const fakeServiceKey = Buffer.alloc(32).toString('hex');
      expect(() =>
        decryptSecretsBlob(encryptedVars, pk.toString('hex'), fakeServiceKey, deployId),
      ).toThrow();
    });

    it('wrong service_key cannot decrypt', () => {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const envVars = { SECRET: 'value' };

      const innerBlob = generateInnerSecret();
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);

      const otherServiceKey = randomBytes(32).toString('hex');
      expect(() =>
        decryptSecretsBlob(encryptedVars, pk.toString('hex'), otherServiceKey, deployId),
      ).toThrow();
    });

    it('SECRETS_BLOB end-to-end: buildSecretsBlob + parseSecretsBlob + decryptSecretsBlob', () => {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const envVars = { API_KEY: 'val', DB: 'url' };

      // Mint
      const innerBlob = generateInnerSecret();
      const outerBlob = innerBlob; // skip KMS; just round-trip through the container format
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);
      const secretsBlobStr = buildSecretsBlob(deployId, outerBlob, encryptedVars);

      // Parse
      const parsed = parseSecretsBlob(secretsBlobStr);
      expect(parsed.deployId.equals(deployId)).toBe(true);
      expect(parsed.encryptedVars.equals(encryptedVars)).toBe(true);

      // Decrypt (compute service_key the way the server would)
      const innerBlobBytes = Buffer.from(innerBlob, 'base64');
      const salt = projectId + deployId.toString('hex');
      const serviceKeyHex = Buffer.from(
        hkdfSync('sha256', innerBlobBytes, salt, 'capy:deploy:service-key', 32),
      ).toString('hex');
      const decrypted = decryptSecretsBlob(
        parsed.encryptedVars,
        pk.toString('hex'),
        serviceKeyHex,
        parsed.deployId,
      );
      expect(decrypted).toEqual(envVars);
    });
  });

  // CAP-55: multi-line secrets (PEM keys, certs) were truncated at the first
  // line, and continuation lines containing `=` minted phantom env vars,
  // because the deploy blob serialized vars as `KEY=value\n`. It now uses JSON.
  describe('multi-line and special-character values (CAP-55)', () => {
    function deployRoundtrip(envVars: Record<string, string>): Record<string, string> {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const innerBlob = generateInnerSecret();
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);
      return decryptSecretsBlob(
        encryptedVars,
        pk.toString('hex'),
        serviceKeyHexFor(innerBlob, projectId, deployId),
        deployId,
      );
    }

    it('round-trips a real multi-line RSA PEM byte-for-byte', () => {
      const decrypted = deployRoundtrip({ RSA_KEY: PEM, DB: 'postgres://u:p@h/d' });
      expect(decrypted.RSA_KEY).toBe(PEM);
      expect(decrypted.DB).toBe('postgres://u:p@h/d');
    });

    it('does not mint phantom keys from value lines containing "=" or "#"', () => {
      const envVars = {
        CERT: '-----BEGIN CERTIFICATE-----\nkey=val\n# not a comment\n-----END CERTIFICATE-----\n',
        SVC_JSON: '{"type":"service_account","key":"a=b"}',
      };
      const decrypted = deployRoundtrip(envVars);
      // Exactly the two declared keys — no `key`, no orphaned lines.
      expect(Object.keys(decrypted).sort()).toEqual(['CERT', 'SVC_JSON']);
      expect(decrypted).toEqual(envVars);
    });

    it('decrypts a legacy KEY=value\\n blob minted by an older CLI (backward compat)', () => {
      const pk = randomBytes(32);
      const deployId = generateDeployId();
      const innerBlob = generateInnerSecret();
      const decryptKey = deriveDecryptKey(pk, innerBlob, projectId, deployId);

      // Mint with the OLD serialization the bug-era CLI produced.
      const legacyPlaintext = 'API_KEY=sk_test_xxx\nDB=postgres://u:p@h/d';
      const encryptedVars = encryptPlaintextBlob(legacyPlaintext, decryptKey);

      const decrypted = decryptSecretsBlob(
        encryptedVars,
        pk.toString('hex'),
        serviceKeyHexFor(innerBlob, projectId, deployId),
        deployId,
      );
      expect(decrypted).toEqual({ API_KEY: 'sk_test_xxx', DB: 'postgres://u:p@h/d' });
    });
  });

  describe('parseEnvPlaintext', () => {
    it('parses the current JSON format', () => {
      expect(parseEnvPlaintext('{"A":"1","B":"two\\nlines"}')).toEqual({ A: '1', B: 'two\nlines' });
    });

    it('parses the legacy KEY=value line format', () => {
      expect(parseEnvPlaintext('A=1\nB=2\n# comment\n')).toEqual({ A: '1', B: '2' });
    });

    it('keeps "=" inside a JSON value intact', () => {
      expect(parseEnvPlaintext('{"TOKEN":"a=b=c"}')).toEqual({ TOKEN: 'a=b=c' });
    });

    it('falls back to line parsing if a non-JSON value happens to start with {', () => {
      // Legacy blobs always start with a key name, never `{`, so this is just a
      // defensive check that malformed JSON does not throw.
      expect(parseEnvPlaintext('{garbage not json')).toEqual({});
    });
  });
});
