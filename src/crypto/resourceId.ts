import { createHash } from 'crypto';

// Readable alphabet (no ambiguous chars: 0/O, 1/l/I)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 5;

/**
 * Derives a deterministic 5-character resource ID from a variable name.
 * Used in keep.lock files to reference encrypted variables.
 *
 * v4: Resource IDs are per-variable (environment-agnostic).
 * The branch parameter is kept for backward compat but defaults to ''.
 */
export function deriveResourceId(branch: string, variableName: string): string {
  const hash = createHash('sha256').update(`${branch}:${variableName}`).digest();
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[hash[i] % ALPHABET.length];
  }
  return id;
}

/**
 * v4: Derives a resource ID from just the variable name (no branch/environment).
 */
export function deriveResourceIdV4(variableName: string): string {
  return deriveResourceId('', variableName);
}
