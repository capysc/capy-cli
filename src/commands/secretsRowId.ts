import { createHash } from 'crypto';

/**
 * Fixed domain string for `row_id`. It makes the id a hash of its own, so it can
 * never be a prefix (or any other slice) of the row's `value_hash`: an opaque
 * handle for "this name with this value", safe to show to people and agents.
 */
export const ROW_ID_DOMAIN = 'capy:secrets:row:v1';

/** Stable short id for one `capy secrets` row (a name with one distinct value). */
export function rowIdOf(name: string, valueHash: string): string {
  return createHash('sha256').update(`${ROW_ID_DOMAIN}\u0000${name}\u0000${valueHash}`).digest('hex').slice(0, 12);
}
