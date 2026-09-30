/**
 * Shared payload shape for `capy transport` and `capy pair` (CAP-684).
 *
 * Both flows move the same two files — `local.key` (K_local) and `key.enc`
 * — for one or more (org, user) pairs, sealed in a different envelope for
 * each flow (see transportCrypto.ts / pairCrypto.ts). The entry shape is
 * identical either way, so it lives here once rather than being redefined
 * per envelope module.
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

/** `capy transport` ships exactly one entry — the spec is explicit about this. */
export interface TransportPayload {
  v: 1;
  entries: [PairingEntry];
}
