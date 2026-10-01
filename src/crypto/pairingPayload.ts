/**
 * Shared payload shape for `capy transport` and `capy pair` (CAP-684;
 * CAP-692 for transport's own v3 wire format).
 *
 * Both flows move the same two files — `local.key` (K_local) and `key.enc`
 * — for one or more (org, user) pairs. `capy pair`'s envelope (pairCrypto.ts)
 * still carries a JSON `PairingPayload` of these entries. `capy transport`
 * (transportPackV3.ts) does not — it packs exactly one entry into a
 * fixed-layout BINARY plaintext instead (no JSON, no envelope type of its
 * own), so there is no `TransportPayload` type to pair with `PairingPayload`
 * anymore; `PairingEntry` is still the one shape both flows build.
 *
 * `key_enc` is the `key.enc` file's content AS-IS (it is already JSON text
 * written by `saveMasterKey` — see `globalConfig.ts#readOrgKeyFileRaw`), not
 * re-encoded. `k_local` is the raw 32-byte K_local, base64url-encoded — a
 * genuine byte field, unlike `key_enc`.
 */
export interface PairingEntry {
  org_id: string;
  user_id: string;
  /** K_local, 32 raw bytes, base64url. */
  k_local: string;
  /** `key.enc` file content, verbatim. */
  key_enc: string;
}

export interface PairingPayload {
  v: 1;
  entries: PairingEntry[];
}
