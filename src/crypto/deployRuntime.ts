import { createDecipheriv, hkdfSync } from 'crypto';

// ---------------------------------------------------------------------------
// SECRETS_BLOB parsing and decryption (deployed mode for `capy run`)
//
// Ported verbatim from the (now-deleted) @capy/sdk. Zero-trust primitives:
// the CLI never sees the server's KMS master key; it only gets the HKDF-
// derived service_key per-request from /deploy/:deployId/decrypt, which is
// gated on revocation checks.
// ---------------------------------------------------------------------------

const DEPLOY_ID_LENGTH = 32;
const OUTER_BLOB_LEN_SIZE = 4;
const BLOB_IV_LENGTH = 12;
const BLOB_AUTH_TAG_LENGTH = 16;

export interface ParsedSecretsBlob {
  deployId: Buffer;
  outerBlob: Buffer;
  encryptedVars: Buffer;
}

/**
 * Parses a SECRETS_BLOB value into its components.
 * Format: base64(deploy_id[32] || outer_blob_len[4, big-endian] || outer_blob || encrypted_vars)
 */
export function parseSecretsBlob(blob: string): ParsedSecretsBlob {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < DEPLOY_ID_LENGTH + OUTER_BLOB_LEN_SIZE + 1) {
    throw new Error('Invalid SECRETS_BLOB: too short');
  }

  const deployId = buf.subarray(0, DEPLOY_ID_LENGTH);
  const outerBlobLen = buf.readUInt32BE(DEPLOY_ID_LENGTH);
  const outerBlobStart = DEPLOY_ID_LENGTH + OUTER_BLOB_LEN_SIZE;
  const outerBlobEnd = outerBlobStart + outerBlobLen;

  if (buf.length < outerBlobEnd + 1) {
    throw new Error('Invalid SECRETS_BLOB: outer_blob truncated');
  }

  const outerBlob = buf.subarray(outerBlobStart, outerBlobEnd);
  const encryptedVars = buf.subarray(outerBlobEnd);

  return { deployId, outerBlob, encryptedVars };
}

/**
 * Calls the service to get SERVICE_KEY for a deploy token.
 * 30-second timeout; clear error on network failure so builds fail loudly.
 */
export async function fetchServiceKey(
  apiUrl: string,
  deployId: string,
  outerBlob: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let res: globalThis.Response;
  try {
    res = await fetch(`${apiUrl}/deploy/${encodeURIComponent(deployId)}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: outerBlob }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new Error(
      `Cannot reach Capy service for deploy decrypt at ${apiUrl}. ` +
        'Set CAPY_API_URL to the service that minted this deploy token (build env hits ' +
        'https://api.capy.sc by default — a dev-minted token will not resolve there).',
    );
  }
  clearTimeout(timeout);

  if (res.status === 404) {
    throw new Error(
      `Deploy token not found on ${apiUrl} — was it minted against a different Capy service? ` +
        'Make sure CAPY_API_URL in the build matches the service used to deploy.',
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'unknown' }));
    throw new Error(`Deploy decrypt failed (${res.status}): ${(body as any).error || 'unknown'}`);
  }

  const body = await res.json() as { service_key: string };
  return body.service_key;
}

/**
 * Derives the DECRYPT_KEY = HKDF(PROJECT_KEY || SERVICE_KEY, salt=deployId,
 * info="capy:deploy:decrypt") and decrypts the env var blob with AES-256-GCM.
 *
 * Returns a record of KEY=value pairs parsed from the "KEY1=value1\n..." plaintext.
 */
export function decryptSecretsBlob(
  encryptedVars: Buffer,
  projectKeyHex: string,
  serviceKeyHex: string,
  deployId: Buffer,
): Record<string, string> {
  const projectKey = Buffer.from(projectKeyHex, 'hex');
  const serviceKey = Buffer.from(serviceKeyHex, 'hex');
  const combined = Buffer.concat([projectKey, serviceKey]);

  const derived = hkdfSync('sha256', combined, deployId, 'capy:deploy:decrypt', 32);
  const decryptKey = Buffer.from(derived);

  if (encryptedVars.length < BLOB_IV_LENGTH + BLOB_AUTH_TAG_LENGTH) {
    throw new Error('Encrypted vars blob too short');
  }

  const iv = encryptedVars.subarray(0, BLOB_IV_LENGTH);
  const authTag = encryptedVars.subarray(encryptedVars.length - BLOB_AUTH_TAG_LENGTH);
  const ciphertext = encryptedVars.subarray(BLOB_IV_LENGTH, encryptedVars.length - BLOB_AUTH_TAG_LENGTH);

  // No setAAD — mirrors deployCrypto.encryptSecretsBlob: decryptKey already
  // binds the deploy context via HKDF(salt=deployId), so AAD would be redundant.
  const decipher = createDecipheriv('aes-256-gcm', decryptKey, iv, {
    authTagLength: BLOB_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const result: Record<string, string> = {};
  for (const line of plaintext.toString('utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    result[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
  }
  return result;
}
