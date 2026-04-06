import { createHash } from 'crypto';

// Readable alphabet (no ambiguous chars: 0/O, 1/l/I)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 5;

/**
 * Derives a deterministic 5-character resource ID from a branch and variable name.
 * Used in keep.lock files to reference encrypted variables.
 *
 * - Same (branch, variableName) always produces the same ID regardless of encryption key
 * - Different variable names produce different IDs
 * - Different branches produce different IDs for the same variable
 * - branch='' for branchless (environment-agnostic) variables
 */
export function deriveResourceId(branch: string, variableName: string): string {
  const hash = createHash('sha256').update(`${branch}:${variableName}`).digest();
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[hash[i] % ALPHABET.length];
  }
  return id;
}
