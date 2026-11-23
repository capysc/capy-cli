import { randomBytes, createCipheriv, hkdfSync } from 'crypto';

const DEPLOY_ID_LENGTH = 32;
const DEPLOY_KEY_LENGTH = 32;
const INNER_SECRET_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Generates a random 32-byte deploy ID.
 */
export function generateDeployId(): Buffer {
  return randomBytes(DEPLOY_ID_LENGTH);
}

/**
 * Generates the random per-deploy key. This, and not the project key, is what
 * a deploy target holds: it decrypts exactly one deploy's blob, and only while
 * the service still answers for that deploy.
 */
export function generateDeployKey(): Buffer {
  return randomBytes(DEPLOY_KEY_LENGTH);
}

/**
 * Generates the inner blob a deploy registers with the service: 32 random
 * bytes, base64. The service KMS-wraps it and treats it as opaque; it carries
 * no key material of anyone's and wraps nothing.
 */
export function generateInnerSecret(): string {
  return randomBytes(INNER_SECRET_LENGTH).toString('base64');
}

/**
 * Encrypts all env vars into a single blob.
 *
 * Zero-trust derivation:
 *   service_key = HKDF-SHA256(innerBlob, salt=projectId+hex(deployId), info="capy:deploy:service-key", 32)
 *   DECRYPT_KEY = HKDF-SHA256(deployKey || service_key, salt=deployId, info="capy:deploy:decrypt", 32)
 *
 * Encrypted with AES-256-GCM(envBlob, DECRYPT_KEY) where envBlob is a JSON
 * object of { KEY: value } pairs. JSON is used (rather than KEY=value\n lines)
 * so values may contain newlines, `=`, and `#` and still round-trip byte-for-byte
 * — multi-line secrets like PEM private keys would otherwise be truncated at the
 * first line and continuation lines containing `=` would mint phantom env vars.
 * `decryptSecretsBlob` still accepts the legacy line format for blobs minted by
 * older CLI versions.
 *
 * `deployKey` is the random per-deploy key (`generateDeployKey`), never the
 * project key: the project key does not take part in this derivation and must
 * not leave the developer's machine.
 *
 * IMPORTANT: innerBlob MUST be the exact base64 string that was sent to the
 * service for KMS-wrapping. Do not regenerate it here — a fresh random inner
 * blob would yield a different service_key and break the decryption round-trip.
 *
 * At decrypt time the consumer fetches service_key from the server (which
 * recovers the same innerBlob via KMS-unwrap) and reconstructs DECRYPT_KEY.
 * deployKey alone is insufficient; revocation gates the server's willingness
 * to return service_key.
 */
export function encryptEnvBlob(
  envVars: Record<string, string>,
  deployKey: Buffer,
  innerBlob: string,
  projectId: string,
  deployId: Buffer,
): Buffer {
  // service_key derivation matches service/src/routes/deploy.ts:250-253
  const innerBlobBytes = Buffer.from(innerBlob, 'base64');
  const saltService = projectId + deployId.toString('hex');
  const serviceKey = Buffer.from(
    hkdfSync('sha256', innerBlobBytes, saltService, 'capy:deploy:service-key', 32),
  );

  // DECRYPT_KEY derivation matches deployRuntime.decryptSecretsBlob
  const combined = Buffer.concat([deployKey, serviceKey]);
  const decryptKey = Buffer.from(
    hkdfSync('sha256', combined, deployId, 'capy:deploy:decrypt', 32),
  );

  // JSON encoding round-trips multi-line values (PEM keys, certs, JSON blobs)
  // and values containing `=`/`#` faithfully. The decrypt side detects this
  // format vs the legacy `KEY=value\n` lines by the leading `{`.
  const plaintext = Buffer.from(JSON.stringify(envVars), 'utf-8');

  const iv = randomBytes(IV_LENGTH);
  // No setAAD: decryptKey = HKDF(deployKey||serviceKey, salt=deployId,
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
