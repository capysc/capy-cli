import { randomBytes, createCipheriv, hkdfSync } from 'crypto';
import { deriveInnerKey, aesEncrypt, aesDecrypt } from './inviteCrypto';

const DEPLOY_ID_LENGTH = 32;
const DT_LENGTH = 32;
const DEPLOY_HKDF_INFO = 'capy:deploy';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Generates a random 32-byte deploy ID.
 */
export function generateDeployId(): Buffer {
  return randomBytes(DEPLOY_ID_LENGTH);
}

/**
 * Generates a random 32-byte derivation token (DT).
 */
export function generateDerivationToken(): Buffer {
  return randomBytes(DT_LENGTH);
}

/**
 * Inner-wraps the project key PK.
 * IK = HKDF(DT, salt=projectId, info="capy:deploy")
 * Returns base64(iv + ciphertext + authTag).
 */
export function deployInnerWrap(projectKey: Buffer, dt: Buffer, projectId: string): string {
  const innerKey = deriveInnerKey(dt, projectId, DEPLOY_HKDF_INFO);
  return aesEncrypt(projectKey, innerKey);
}

/**
 * Strips the inner layer using DT. Returns the project key PK.
 */
export function deployInnerUnwrap(innerBlob: string, dt: Buffer, projectId: string): Buffer {
  const innerKey = deriveInnerKey(dt, projectId, DEPLOY_HKDF_INFO);
  return aesDecrypt(innerBlob, innerKey);
}

// NOTE: this file used to also export `buildDeployCode` / `parseDeployCode` —
// base64(deployId[32] || DT[32] || outerBlob), a single opaque credential for
// `gh secret set`. Shipped 2026-04-01, replaced 2026-04-09 by the two-variable
// SECRETS_BLOB/PROJECT_KEY(-now-DEPLOY_KEY) shape so the ciphertext could ride
// self-contained inside one env var — required for platforms that need a human
// pasting named values into a dashboard, not a `gh secret set` one-liner (see
// CAP-411 archaeology). They had zero call sites outside their own tests and
// implemented a credential shape we no longer ship; deleted here rather than
// left as dead crypto implying a guarantee this build doesn't provide.

/**
 * service_key = HKDF-SHA256(innerBlob, salt=projectId+hex(deployId), info="capy:deploy:service-key", 32)
 *
 * Pulled out to a named, exported function for two reasons: `encryptEnvBlob`
 * needs it at mint time (it has `innerBlob` in hand, having just built it),
 * and `service/src/routes/deploy.ts`'s `/deploy/:deployId/decrypt` needs the
 * IDENTICAL derivation at request time (it recovers the same `innerBlob` via
 * KMS-unwrap). The two implementations can't share code across the CLI/service
 * repo boundary, so they are kept in lockstep by a hand-maintained comment —
 * fragile, called out in CAP-411. `deployCrypto.test.ts` and the service's
 * `deploy.test.ts` both pin the SAME known-answer vector (fixed innerBlob/
 * projectId/deployId → fixed expected hex) so a divergence in either repo's
 * salt, info string, or algorithm fails a deterministic test instead of only
 * surfacing as a production decrypt failure.
 */
export function deriveServiceKeyFromInnerBlob(
  innerBlob: string,
  projectId: string,
  deployId: Buffer,
): Buffer {
  const innerBlobBytes = Buffer.from(innerBlob, 'base64');
  const salt = projectId + deployId.toString('hex');
  return Buffer.from(hkdfSync('sha256', innerBlobBytes, salt, 'capy:deploy:service-key', 32));
}

/**
 * Encrypts all env vars into a single blob.
 *
 * Zero-trust derivation:
 *   service_key = deriveServiceKeyFromInnerBlob(innerBlob, projectId, deployId)
 *   DECRYPT_KEY = HKDF-SHA256(projectKey || service_key, salt=deployId, info="capy:deploy:decrypt", 32)
 *
 * Encrypted with AES-256-GCM(envBlob, DECRYPT_KEY) where envBlob is a JSON
 * object of { KEY: value } pairs. JSON is used (rather than KEY=value\n lines)
 * so values may contain newlines, `=`, and `#` and still round-trip byte-for-byte
 * — multi-line secrets like PEM private keys would otherwise be truncated at the
 * first line and continuation lines containing `=` would mint phantom env vars.
 * `decryptSecretsBlob` still accepts the legacy line format for blobs minted by
 * older CLI versions.
 *
 * IMPORTANT: innerBlob MUST be the exact base64 string that was sent to the
 * service for KMS-wrapping. Do not recompute innerBlob here — deployInnerWrap
 * uses a random IV, so a fresh call would produce different bytes, yielding a
 * different service_key and breaking decryption round-trip.
 *
 * At decrypt time the consumer fetches service_key from the server (which
 * recovers the same innerBlob via KMS-unwrap) and reconstructs DECRYPT_KEY.
 * Zero-trust holds: projectKey alone is insufficient; revocation gates the
 * server's willingness to return service_key.
 */
export function encryptEnvBlob(
  envVars: Record<string, string>,
  projectKey: Buffer,
  innerBlob: string,
  projectId: string,
  deployId: Buffer,
): Buffer {
  const serviceKey = deriveServiceKeyFromInnerBlob(innerBlob, projectId, deployId);

  // DECRYPT_KEY derivation matches deployRuntime.decryptSecretsBlob
  const combined = Buffer.concat([projectKey, serviceKey]);
  const decryptKey = Buffer.from(
    hkdfSync('sha256', combined, deployId, 'capy:deploy:decrypt', 32),
  );

  // JSON encoding round-trips multi-line values (PEM keys, certs, JSON blobs)
  // and values containing `=`/`#` faithfully. The decrypt side detects this
  // format vs the legacy `KEY=value\n` lines by the leading `{`.
  const plaintext = Buffer.from(JSON.stringify(envVars), 'utf-8');

  const iv = randomBytes(IV_LENGTH);
  // No setAAD: decryptKey = HKDF(projectKey||serviceKey, salt=deployId,
  // info="capy:deploy:decrypt") already binds the deploy/project context, so the
  // blob can't be replayed under a different deploy. AAD would be redundant.
  const cipher = createCipheriv('aes-256-gcm', decryptKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Builds a SECRETS_BLOB: base64(deploy_id[32] || outer_blob_len[4, big-endian] || outer_blob || encrypted_vars)
 */
export function buildSecretsBlob(
  deployId: Buffer,
  outerBlob: string,
  encryptedVars: Buffer,
): string {
  const outerBuf = Buffer.from(outerBlob, 'base64');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(outerBuf.length, 0);
  return Buffer.concat([deployId, lenBuf, outerBuf, encryptedVars]).toString('base64');
}
