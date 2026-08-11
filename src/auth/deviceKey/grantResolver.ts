/**
 * CAP-384 — resolve a project key from a GRANTED K_local, without ever
 * calling `crypto/keyResolver.ts`.
 *
 * WHY THIS FILE EXISTS INSTEAD OF PARAMETERIZING keyResolver.ts: the task
 * (and invariant 4) requires keyResolver.ts to stay byte-for-byte untouched
 * so CAP-383's tree-equivalence regression test keeps exercising the exact
 * production code path it was written against. But keyResolver's
 * `unwrapMasterKey` hard-wires its two disk reads —
 * `globalConfig.readMasterKey` (key.enc) and `readAnyLocalRoot`
 * (local.key) — as direct imports, not as an injected seam. There is no way
 * to hand it an in-memory K_local without either editing it or monkeypatching
 * its module (worse: implicit, fragile, and exactly the kind of thing a
 * future reader would not expect). So this file reimplements ONLY the
 * steady-state K_local branch of `unwrapMasterKey` — the same three
 * primitives (`deriveLocalInnerKey`, `masterKeyAAD`, `decryptMasterKey`,
 * `deriveProjectKey`), same AAD, same HKDF — sourcing its two inputs
 * differently:
 *
 *   - K_local: handed in by the caller (fetched from the grant daemon,
 *     never disk — grantHolder.ts).
 *   - key.enc: fetched FRESH from the server on every call (`ops.fetchKeyEnc`)
 *     instead of `globalConfig.readMasterKey`. This is not a new trust
 *     assumption — key.enc is already server-held by design (CAP-379; the
 *     audit's §1 table names it explicitly) — it just means a grant-mode
 *     resolve costs one extra network round trip per (org, project) instead
 *     of reading a local cache. No legacy-migration fallback exists here on
 *     purpose: a grant is always freshly minted against the CURRENT
 *     kdf_version and the CURRENT key.enc shape, so the legacy branches
 *     `unwrapMasterKey` carries for old on-disk blobs have no analog to
 *     reproduce. A key.enc that fails to unwrap under a fresh K_local is a
 *     real error (PERMISSION_DENIED), not a migration opportunity.
 *
 * This module writes NOTHING to disk. It has no saveLocalRoot, no
 * saveMasterKey, no import from globalConfig at all.
 */
import { CapyError, ERROR_CODES } from '../../types/index';
import { decryptMasterKey, deriveProjectKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';
import type { ServiceClient, KeyWrapperMetadata } from '../../service/serviceClient';
import type { AuthService } from '../authService';
import { withFreshAuthRetry } from './serviceOps';

/** Everything grant-mode resolution needs from the network, org-pinned. */
export interface GrantResolutionOps {
  /** GET the org's key_enc row's ciphertext blob, fresh, org-pinned. Same
   *  contract as OrgKeyEncOps.fetchKeyEnc (onboarding.ts) — reused signature,
   *  not reused implementation, to avoid importing onboarding.ts here. */
  fetchKeyEnc(orgId: string): Promise<string>;
  /** Strip the KMS outer layer. Same contract as KeyServiceOps.coDecrypt. */
  coDecrypt(orgId: string, ciphertext: string): Promise<string>;
}

/**
 * Resolve a project key using a granted K_local instead of the on-disk
 * root. Mirrors `keyResolver.resolveProjectKey`'s signature shape as
 * closely as the different ops contract allows, so call sites read as a
 * drop-in swap (see runCommand.ts for the one place that currently branches
 * between the two).
 */
export async function resolveProjectKeyFromGrant(
  kLocal: Buffer,
  orgId: string,
  projectId: string,
  userId: string,
  ops: GrantResolutionOps,
): Promise<string> {
  let keyEncBlob: string;
  try {
    keyEncBlob = await ops.fetchKeyEnc(orgId);
  } catch (err) {
    throw new CapyError(
      "You do not have access to this project's secrets on this device.\n\n" +
        'The granted device key could not fetch this org\'s key copy from the server.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const innerBlob = await ops.coDecrypt(orgId, keyEncBlob);

  let masterKey: Buffer;
  try {
    masterKey = decryptMasterKey(innerBlob, deriveLocalInnerKey(kLocal), masterKeyAAD(userId, orgId));
  } catch {
    throw new CapyError(
      'The granted device key could not unlock this project — the grant may be for a different account.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { orgId, reason: 'gcm_auth_failed' },
    );
  }

  return deriveProjectKey(masterKey, projectId, orgId);
}

/**
 * Production adapter: builds `GrantResolutionOps` from the same
 * session-holding singletons every other secret-touching command already
 * constructs (`ServiceClient` + `AuthService`). Org-pins via
 * `authenticateSilent(orgId)` before each call, same discipline as
 * `serviceOps.ts`'s `opsForOrg`, and retries the key_enc fetch once on the
 * coded fresh-auth 403 (the same gap the CLI's door-wrapper fetch had —
 * `key_enc` rows were always fresh-auth gated, so a grant-mode resolve on a
 * session past `CAPY_FRESH_AUTH_MAX_AGE_SECONDS` must dance the same retry).
 * One factory, reusable from any call site that already has both
 * singletons in scope — see runCommand.ts for the reference wiring.
 */
export function createGrantResolutionOps(serviceClient: ServiceClient, authService: AuthService): GrantResolutionOps {
  const forceRefresh = () => authService.refreshToken();

  return {
    fetchKeyEnc: async (orgId: string) => {
      await authService.authenticateSilent(orgId);
      // key_enc rows are listed user-scoped but held per (user, org) — find
      // this org's live row before fetching its payload (same two-step
      // onboarding.ts's runUnlock/installOrgFromServer already use).
      const rows = await withFreshAuthRetry(forceRefresh, () => serviceClient.listWrappers());
      const row = rows.find((w: KeyWrapperMetadata) => w.type === 'key_enc' && !w.deleted_at && w.organization_id === orgId);
      if (!row) {
        throw new CapyError('No key copy found for this organization on the server.', ERROR_CODES.WRAPPER_NOT_FOUND, { orgId });
      }
      const wrapper = await withFreshAuthRetry(forceRefresh, () => serviceClient.fetchWrapper(row.id));
      if (wrapper.type !== 'key_enc' || !wrapper.key_enc) {
        throw new CapyError('The server answered with a non-key.enc wrapper.', ERROR_CODES.INVALID_FORMAT, { orgId });
      }
      return wrapper.key_enc;
    },
    coDecrypt: async (orgId: string, ciphertext: string) => {
      await authService.authenticateSilent(orgId);
      return serviceClient.coDecrypt(orgId, ciphertext).then((r) => r.plaintext);
    },
  };
}
