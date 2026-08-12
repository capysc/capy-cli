import { randomBytes, hkdfSync, createCipheriv } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  deployInnerUnwrap,
  deriveServiceKeyFromInnerBlob,
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

  // `buildDeployCode` / `parseDeployCode` (base64(deployId || DT || outerBlob),
  // a single opaque `CAPY_DEPLOY_CODE`) were deleted from deployCrypto.ts —
  // dead crypto from a design superseded 2026-04-09 by the two-variable
  // SECRETS_BLOB/DEPLOY_KEY shape a human pastes into a platform dashboard
  // (CAP-411 archaeology). Nothing in the shipping path builds or parses that
  // container anymore.

  describe('full deploy roundtrip (the shape capy actually ships)', () => {
    it('simulates setup -> KMS wrap -> CI fetches inner_blob -> DT recovers PK', () => {
      // 1. Setup: generate deploy ID, DT, inner-wrap PK. This is exactly
      //    mintDeployToken's mint sequence — the artifact ends up carrying
      //    `dt`, never `projectKey`.
      const deployId = generateDeployId();
      const dt = generateDerivationToken();
      const innerBlob = deployInnerWrap(projectKey, dt, projectId);

      // 2. Simulate KMS outer wrap (local dev: simple AES).
      const { createDecipheriv } = require('crypto');
      const kmsKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kmsKey, iv, { authTagLength: 16 });
      const enc = Buffer.concat([cipher.update(Buffer.from(innerBlob, 'base64')), cipher.final()]);
      const tag = cipher.getAuthTag();
      const outerBlob = Buffer.concat([iv, enc, tag]).toString('base64');

      // 3. `_CAPY_SECRETS_BLOB` carries deployId + outerBlob (buildSecretsBlob,
      //    exercised end-to-end elsewhere in this file); `_CAPY_DEPLOY_KEY`
      //    carries `dt` verbatim, hex-encoded, as its own top-level env var —
      //    no container needed for a single 32-byte value.

      // 4. Service KMS-unwraps outer blob → recovers innerBlob byte-for-byte.
      const outerCombined = Buffer.from(outerBlob, 'base64');
      const oIv = outerCombined.subarray(0, 12);
      const oTag = outerCombined.subarray(outerCombined.length - 16);
      const oEnc = outerCombined.subarray(12, outerCombined.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', kmsKey, oIv, { authTagLength: 16 });
      decipher.setAuthTag(oTag);
      const recoveredInnerBlob = Buffer.concat([decipher.update(oEnc), decipher.final()]).toString('base64');

      // 5. `capy run` unwraps the inner layer with the DT it holds — this is
      //    the literal call `runCommand.ts`'s DT path makes.
      const recoveredPK = deployInnerUnwrap(recoveredInnerBlob, dt, projectId);
      expect(recoveredPK.equals(projectKey)).toBe(true);

      // 6. Verify the recovered key is a valid hex project key.
      const pkHex = recoveredPK.toString('hex');
      expect(pkHex).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // CAP-411: `deriveServiceKeyFromInnerBlob` is duplicated across the CLI and
  // service repos (they cannot share code across the repo boundary), kept in
  // lockstep only by a hand-maintained comment pointing at each other's line
  // numbers. A known-answer test with FIXED input bytes and a hard-coded
  // expected output, pinned identically in both repos
  // (service/tests/routes/deploy.test.ts), turns a silent drift in either
  // repo's salt/info/algorithm into a deterministic test failure instead of
  // only a production decrypt error. Do not "fix" this vector to be prettier
  // — its exact bytes must match the service-side copy verbatim.
  describe('deriveServiceKeyFromInnerBlob — cross-repo known-answer test', () => {
    it('matches the pinned vector service/tests/routes/deploy.test.ts also asserts', () => {
      const innerBlobHex = '00112233445566778899aabbccddeeff001122334455';
      const katProjectId = 'kat-project-411';
      const deployId = Buffer.from('11'.repeat(32), 'hex');

      const serviceKey = deriveServiceKeyFromInnerBlob(
        Buffer.from(innerBlobHex, 'hex').toString('base64'),
        katProjectId,
        deployId,
      );

      expect(serviceKey.toString('hex')).toBe(
        '4be441e118ebd72c8acb464037222b1a89686cdd136a95716a3173707d69758e',
      );
    });
  });

  describe('encryptEnvBlob / decryptSecretsBlob round-trip (zero-trust)', () => {
    it('mint-side encrypt round-trips with consumer-side decrypt via service_key', () => {
      const pk = randomBytes(32);
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const envVars = {
        DATABASE_URL: 'postgres://u:p@h/d',
        STRIPE_API_KEY: 'sk_test_xxx',
        OPENAI_API_KEY: 'sk-proj-abc',
      };

      // Mint side: exactly what capy deploy does.
      const innerBlob = deployInnerWrap(pk, dt, projectId);
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

    it('projectKey alone cannot decrypt (zero-trust property)', () => {
      const pk = randomBytes(32);
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const envVars = { SECRET: 'leaked' };

      const innerBlob = deployInnerWrap(pk, dt, projectId);
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);

      // An attacker with just pk (no service_key) should not be able to decrypt.
      // Using a zero-filled service_key yields a wrong DECRYPT_KEY → auth fail.
      const fakeServiceKey = Buffer.alloc(32).toString('hex');
      expect(() =>
        decryptSecretsBlob(encryptedVars, pk.toString('hex'), fakeServiceKey, deployId),
      ).toThrow();
    });

    it('wrong service_key cannot decrypt', () => {
      const pk = randomBytes(32);
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const envVars = { SECRET: 'value' };

      const innerBlob = deployInnerWrap(pk, dt, projectId);
      const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);

      const otherServiceKey = randomBytes(32).toString('hex');
      expect(() =>
        decryptSecretsBlob(encryptedVars, pk.toString('hex'), otherServiceKey, deployId),
      ).toThrow();
    });

    it('SECRETS_BLOB end-to-end: buildSecretsBlob + parseSecretsBlob + decryptSecretsBlob', () => {
      const pk = randomBytes(32);
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const envVars = { API_KEY: 'val', DB: 'url' };

      // Mint
      const innerBlob = deployInnerWrap(pk, dt, projectId);
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
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const innerBlob = deployInnerWrap(pk, dt, projectId);
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
      const dt = generateDerivationToken();
      const deployId = generateDeployId();
      const innerBlob = deployInnerWrap(pk, dt, projectId);
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
