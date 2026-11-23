/**
 * A short, human-comparable fingerprint of this run's one-time pairing public
 * key. Keep shows the same value on `/pair` and `/transport/pair`, so the person
 * approving can check that the request in their browser is this machine.
 *
 * sha256 over the raw (base64url-decoded) public key, first 8 bytes, uppercase
 * hex in four groups: `A1B2-C3D4-E5F6-0718`. Must stay byte-for-byte equal to
 * Keep's `pairKeyFingerprint` (keep-app `src/lib/basicPair/fingerprint.ts`).
 */
import { createHash } from 'crypto';

export function pairKeyFingerprint(publicKeyB64Url: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyB64Url, 'base64url')).digest('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}
