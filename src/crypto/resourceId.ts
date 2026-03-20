import { createHash } from 'crypto';

// Readable alphabet (no ambiguous chars: 0/O, 1/l/I)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 5;

/**
 * Derives a deterministic 5-character resource ID from a key and variable name.
 * Used in .keep files to reference encrypted variables.
 *
 * - Same (key, variableName) always produces the same ID
 * - Different variable names produce different IDs
 * - Rotating the key produces new IDs for all variables
 */
export function deriveResourceId(key: string, variableName: string): string {
  const hash = createHash('sha256').update(`${key}:${variableName}`).digest();
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[hash[i] % ALPHABET.length];
  }
  return id;
}
