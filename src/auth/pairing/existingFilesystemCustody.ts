import { timingSafeEqual } from 'node:crypto';
import { AuthService, silentAuthFailureMessage } from '../authService';
import { getLocalRootMode, readLocalRoot, readOrgKeyFileRaw } from '../../config/globalConfig';
import { decryptBoundMasterKey, decryptMasterKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';
import { parseFilesystemCustodyFile } from './filesystemCustodyFile';

type Identity = Readonly<{ userId: string; orgId: string; accessToken: string }>;
export type ExistingFilesystemCustody =
  | Readonly<{ kind: 'verified'; orgId: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

export type ExistingFilesystemCustodyDependencies = Readonly<{
  authenticate: (origin: string, userId: string, organizationId?: string) => Promise<Identity | null>;
  readRoot: (orgId: string, userId: string) => Buffer | null;
  readKeyFile: (orgId: string, userId: string) => string | null;
  unwrapOuter: (origin: string, identity: Identity, ciphertext: string, transportId?: string) => Promise<string>;
}>;

const defaults: ExistingFilesystemCustodyDependencies = {
  authenticate: async (origin, userId, organizationId) => {
    const auth = new AuthService(origin, false, userId);
    const identity = await auth.authenticateSilent(organizationId);
    if (!identity.success) { console.error(`flow: ${silentAuthFailureMessage(identity)}`); return null; }
    const token = await auth.getValidToken();
    return token ? { userId: token.user_id, orgId: token.organization_id, accessToken: token.access_token } : null;
  },
  readRoot: (orgId, userId) => getLocalRootMode(orgId, userId) === 'file' ? readLocalRoot(orgId, userId) : null,
  readKeyFile: readOrgKeyFileRaw,
  unwrapOuter: async (origin, identity, ciphertext, transportId) => {
    const response = await fetch(`${origin}/orgs/${encodeURIComponent(identity.orgId)}/co-decrypt`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${identity.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext, ...(transportId === undefined ? {} : { transport_id: transportId }) }),
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
  input: Readonly<{ serviceOrigin: string; userId: string; organizationId?: string; expectedRoot?: Buffer }>,
  dependencies: ExistingFilesystemCustodyDependencies = defaults,
): Promise<ExistingFilesystemCustody> {
  try {
    const identity = await dependencies.authenticate(input.serviceOrigin, input.userId, input.organizationId);
    // A newly authenticated account may not have selected an organization yet.
    if (!identity) return { kind: 'missing' };
    if (identity.userId !== input.userId || !identity.orgId || !identity.accessToken
      || input.organizationId !== undefined && input.organizationId !== identity.orgId) return { kind: 'invalid' };
    const root = dependencies.readRoot(identity.orgId, input.userId);
    const raw = dependencies.readKeyFile(identity.orgId, input.userId);
    if (!root && !raw) return { kind: 'missing' };
    if (!root || root.byteLength !== 32 || !raw) return { kind: 'invalid' };
    if (input.expectedRoot && (input.expectedRoot.length !== root.length || !timingSafeEqual(input.expectedRoot, root))) return { kind: 'invalid' };
    const file = parseFilesystemCustodyFile(raw, identity.orgId);
    if (!file) return { kind: 'invalid' };
    const inner = await dependencies.unwrapOuter(input.serviceOrigin, identity, file.ciphertext, file.transportId);
    const decrypt = file.transportId === undefined ? decryptMasterKey : decryptBoundMasterKey;
    if (decrypt(inner, deriveLocalInnerKey(root), masterKeyAAD(input.userId, identity.orgId)).length !== 32) return { kind: 'invalid' };
    const currentRoot = dependencies.readRoot(identity.orgId, input.userId);
    if (!currentRoot || currentRoot.byteLength !== root.byteLength || !timingSafeEqual(currentRoot, root)
      || dependencies.readKeyFile(identity.orgId, input.userId) !== raw) return { kind: 'invalid' };
    return { kind: 'verified', orgId: identity.orgId };
  } catch {
    return { kind: 'invalid' };
  }
}
