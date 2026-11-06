/**
 * What a `capy deploy` test needs from "the Capy server" now that a deploy compares the values it is about
 * to deliver with Capy's latest (CAP-717), and records through the one commit path: a `getDecryptData` answer,
 * and a project key. Both are fixtures that make the server and the folder AGREE, so a test about something else
 * (a warning printed once, a record pushed once) is not about conflicts.
 */
import * as actualKeyResolver from '../../src/crypto/keyResolver';
import type { KeepFile } from '../../src/types/index';

/**
 * The server's answer for `branch` in which every variable the keep pins there has a line this key cannot
 * decrypt: its fingerprint is then the keep's own, so nothing the keep pins has moved. Pass `envLines` to give
 * the blob exactly the lines a test wants back out of `pushSecrets` (they are kept verbatim).
 */
export function agreeingDecryptData(keep: KeepFile, branch: string, envLines?: string) {
  const lines = Object.entries(keep.variables).flatMap(([name, entries]) => {
    const entry = entries.find((e) => e.branch === branch);
    return entry === undefined ? [] : [`${name}=capy:${entry.resource_id || 'r'}:AAAA`];
  });
  return {
    env_content: envLines ?? lines.join('\n'),
    decrypt_key: '',
    expires_at: '',
    keep_file: JSON.stringify(keep),
  };
}

/** The project key `fixedKeyResolver` hands out: a test that needs a real encrypted server seeds it with this. */
export const FIXED_PROJECT_KEY = 'ab'.repeat(32);

/** A `keyResolver` module for `mock.module`: everything the real one exports, with a fixed project key. */
export function fixedKeyResolver(): Record<string, unknown> {
  return { ...actualKeyResolver, resolveProjectKey: async () => FIXED_PROJECT_KEY };
}
