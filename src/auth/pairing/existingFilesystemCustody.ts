import { timingSafeEqual } from 'node:crypto';
import { AuthService } from '../authService';
import { getLocalRootMode, readLocalRoot, readMasterKey } from '../../config/globalConfig';
import { decryptMasterKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';

type Identity = Readonly<{ userId: string; orgId: string; accessToken: string }>;
export type ExistingFilesystemCustody =
  | Readonly<{ kind: 'verified'; orgId: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

export type ExistingFilesystemCustodyDependencies = Readonly<{
  authenticate: (origin: string, userId: string) => Promise<Identity | null>;
  readRoot: (orgId: string, userId: string) => Buffer | null;
  readWrapped: (orgId: string, userId: string) => string | null;
  unwrapOuter: (origin: string, identity: Identity, ciphertext: string) => Promise<string>;
}>;

const defaults: ExistingFilesystemCustodyDependencies = {
  authenticate: async (origin, userId) => {
    const auth = new AuthService(origin, false, userId);
    const identity = await auth.authenticateSilent();
    if (!identity.success) return null;
    const token = await auth.getValidToken();
    return token ? { userId: token.user_id, orgId: token.organization_id, accessToken: token.access_token } : null;
  },
  readRoot: (orgId, userId) => getLocalRootMode(orgId, userId) === 'file' ? readLocalRoot(orgId, userId) : null,
  readWrapped: readMasterKey,
  unwrapOuter: async (origin, identity, ciphertext) => {
    const response = await fetch(`${origin}/orgs/${encodeURIComponent(identity.orgId)}/co-decrypt`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${identity.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext }),
    });
    if (!response.ok) throw new Error('CUSTODY_ACCESS_UNAVAILABLE');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('plaintext' in body) || typeof body.plaintext !== 'string') {
      throw new Error('CUSTODY_ACCESS_UNAVAILABLE');
    }
    return body.plaintext;
  },
};

/** Verify existing custody without writing, migrating, or transferring a key. */
export async function inspectExistingFilesystemCustody(
  input: Readonly<{ serviceOrigin: string; userId: string }>,
  dependencies: ExistingFilesystemCustodyDependencies = defaults,
): Promise<ExistingFilesystemCustody> {
  try {
    const identity = await dependencies.authenticate(input.serviceOrigin, input.userId);
    // A newly authenticated account may not have selected an organization yet.
    if (!identity) return { kind: 'missing' };
    if (identity.userId !== input.userId || !identity.orgId || !identity.accessToken) return { kind: 'invalid' };
    const root = dependencies.readRoot(identity.orgId, input.userId);
    const wrapped = dependencies.readWrapped(identity.orgId, input.userId);
    if (!root && !wrapped) return { kind: 'missing' };
    if (!root || root.byteLength !== 32 || !wrapped) return { kind: 'invalid' };
    const inner = await dependencies.unwrapOuter(input.serviceOrigin, identity, wrapped);
    decryptMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(input.userId, identity.orgId));
    const currentRoot = dependencies.readRoot(identity.orgId, input.userId);
    if (!currentRoot || currentRoot.byteLength !== root.byteLength || !timingSafeEqual(currentRoot, root)
      || dependencies.readWrapped(identity.orgId, input.userId) !== wrapped) return { kind: 'invalid' };
    return { kind: 'verified', orgId: identity.orgId };
  } catch {
    return { kind: 'invalid' };
  }
}
