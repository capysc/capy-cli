import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { CapyError, ERROR_CODES, Organization } from '../../src/types/index';
import type {
  CeremonyTransport,
  CeremonyFailureCode,
  EnrollmentRequest,
  UnlockRequest,
} from '../../src/auth/deviceKey/ceremonyTransport';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../src/service/serviceClient';

// Mock homedir before any import that reads it (repo test convention).
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-devicekey-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env.CAPY_GLOBAL_DIR_NAME;
});

// Dynamic imports so every module sees the mocked homedir.
let onboarding: typeof import('../../src/auth/deviceKey/onboarding');
let dkCrypto: typeof import('../../src/auth/deviceKey/crypto');
let keyResolver: typeof import('../../src/crypto/keyResolver');
let keyManager: typeof import('../../src/crypto/keyManager');
let localKeyRoot: typeof import('../../src/crypto/localKeyRoot');
let gc: typeof import('../../src/config/globalConfig');

beforeAll(async () => {
  onboarding = await import('../../src/auth/deviceKey/onboarding');
  dkCrypto = await import('../../src/auth/deviceKey/crypto');
  keyResolver = await import('../../src/crypto/keyResolver');
  keyManager = await import('../../src/crypto/keyManager');
  localKeyRoot = await import('../../src/crypto/localKeyRoot');
  gc = await import('../../src/config/globalConfig');
});

const USER = 'user_test_1';

/** Fake KMS — same contract the keyResolver tests pin. */
const KMS_PREFIX = 'KMS1.';
const kmsWrap = (plaintext: string) => KMS_PREFIX + plaintext;
const kmsStrip = (ct: string) => {
  if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
  return ct.slice(KMS_PREFIX.length);
};

/**
 * Fake authenticator: a deterministic PRF per (credential, salt), so an
 * unlock on "another machine" reproduces the enrollment's PRF output exactly
 * like real hardware would.
 */
class FakeAuthenticator implements CeremonyTransport {
  private prf = new Map<string, Buffer>();
  nextCredentialId = 'cred-1';
  failNextWith: CeremonyFailureCode | null = null;
  backupEligible = true;

  async requestEnrollment(req: EnrollmentRequest) {
    if (this.failNextWith) {
      const code = this.failNextWith;
      this.failNextWith = null;
      return { ok: false as const, code };
    }
    const output = randomBytes(32);
    this.prf.set(`${this.nextCredentialId}:${req.prfSalt}`, output);
    return {
      ok: true as const,
      credentialId: this.nextCredentialId,
      prfOutput: output.toString('base64'),
      backupEligible: this.backupEligible,
      backupState: this.backupEligible,
    };
  }

  async requestUnlock(req: UnlockRequest) {
    if (this.failNextWith) {
      const code = this.failNextWith;
      this.failNextWith = null;
      return { ok: false as const, code };
    }
    for (const cand of req.candidates) {
      const output = this.prf.get(`${cand.credentialId}:${cand.prfSalt}`);
      if (output) {
        return {
          ok: true as const,
          credentialId: cand.credentialId,
          prfOutput: output.toString('base64'),
        };
      }
    }
    return { ok: false as const, code: 'no_credential' as const };
  }
}

/** In-memory wrapper store implementing the CAP-379 row semantics we consume. */
class FakeWrapperServer {
  rows: Array<KeyWrapperPayload & { org: string | null }> = [];
  private nextId = 1;
  /** Orgs whose next key.enc upload should fail with this CapyError. */
  failKeyEncUploadFor = new Map<string, CapyError>();
  verifyCalls: string[] = [];

  private meta(row: KeyWrapperPayload & { org: string | null }): KeyWrapperMetadata {
    const { wrapped_k_local, iv, prf_salt, key_enc, org, ...m } = row;
    return { ...m, organization_id: org };
  }

  list(): KeyWrapperMetadata[] {
    return this.rows.filter(r => !r.deleted_at).map(r => this.meta(r));
  }

  fetch(id: string): KeyWrapperPayload {
    const row = this.rows.find(r => r.id === id && !r.deleted_at);
    if (!row) {
      throw new CapyError('not found', ERROR_CODES.WRAPPER_NOT_FOUND, { status: 404 });
    }
    const { org, ...payload } = row;
    return { ...payload, organization_id: org };
  }

  uploadDoor(body: {
    wrapped_k_local: string;
    iv: string;
    prf_salt: string;
    credential_id: string;
    kdf_version: number;
  }): KeyWrapperMetadata {
    if (this.rows.some(r => !r.deleted_at && r.type === 'wrapped_k_local' && r.credential_id === body.credential_id)) {
      throw new CapyError('conflict', ERROR_CODES.WRAPPER_CONFLICT, { status: 409 });
    }
    const row = {
      id: `w${this.nextId++}`,
      type: 'wrapped_k_local' as const,
      credential_id: body.credential_id,
      kdf_version: body.kdf_version,
      is_seed: !this.rows.some(r => !r.deleted_at && r.type === 'wrapped_k_local'),
      verified_at: null,
      organization_id: null,
      org: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'pending' as const,
      wrapped_k_local: body.wrapped_k_local,
      iv: body.iv,
      prf_salt: body.prf_salt,
    };
    this.rows.push(row);
    return this.meta(row);
  }

  uploadKeyEnc(orgId: string, keyEnc: string): KeyWrapperMetadata {
    const failure = this.failKeyEncUploadFor.get(orgId);
    if (failure) {
      this.failKeyEncUploadFor.delete(orgId);
      throw failure;
    }
    if (this.rows.some(r => !r.deleted_at && r.type === 'key_enc' && r.org === orgId)) {
      throw new CapyError('conflict', ERROR_CODES.WRAPPER_CONFLICT, { status: 409 });
    }
    const row = {
      id: `w${this.nextId++}`,
      type: 'key_enc' as const,
      credential_id: null,
      kdf_version: 1,
      is_seed: false,
      verified_at: null,
      organization_id: orgId,
      org: orgId,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'pending' as const,
      key_enc: keyEnc,
    };
    this.rows.push(row);
    return this.meta(row);
  }

  delete(id: string): KeyWrapperMetadata {
    const row = this.rows.find(r => r.id === id && !r.deleted_at);
    if (!row) {
      throw new CapyError('not found', ERROR_CODES.WRAPPER_NOT_FOUND, { status: 404 });
    }
    row.deleted_at = new Date().toISOString();
    return this.meta(row);
  }

  verify(id: string): KeyWrapperMetadata {
    const row = this.rows.find(r => r.id === id && !r.deleted_at);
    if (!row) {
      throw new CapyError('not found', ERROR_CODES.WRAPPER_NOT_FOUND, { status: 404 });
    }
    row.verified_at = new Date().toISOString();
    this.verifyCalls.push(id);
    return this.meta(row);
  }

  liveDoor() {
    return this.rows.find(r => !r.deleted_at && r.type === 'wrapped_k_local');
  }

  liveKeyEnc(orgId: string) {
    return this.rows.find(r => !r.deleted_at && r.type === 'key_enc' && r.org === orgId);
  }
}

function makeDeps(
  server: FakeWrapperServer,
  ceremony: FakeAuthenticator,
  organizations: Organization[],
  options: { activeOrgId?: string; tokenlessOrgs?: string[] } = {},
): import('../../src/auth/deviceKey/onboarding').OnboardingDeps {
  return {
    userId: USER,
    userEmail: 'user@example.com',
    organizations,
    activeOrgId: options.activeOrgId ?? organizations[0]?.id ?? null,
    ceremony,
    ops: {
      listWrappers: async () => server.list(),
      fetchWrapper: async id => server.fetch(id),
      uploadDoorWrapper: async body => server.uploadDoor(body),
      verifyWrapper: async id => server.verify(id),
      deleteWrapper: async id => server.delete(id),
    },
    opsForOrg: async (orgId: string) => {
      if (options.tokenlessOrgs?.includes(orgId)) return null;
      return {
        coDecrypt: async (_oid: string, ct: string) => kmsStrip(ct),
        wrapOuterLayer: async (_oid: string, pt: string) => kmsWrap(pt),
        onKeyEncRewrapped: (oid: string, uid: string) => gc.markKeyEncSyncPending(oid, uid),
        uploadKeyEnc: async (keyEnc: string) => server.uploadKeyEnc(orgId, keyEnc),
        fetchKeyEnc: async (wrapperId: string) => {
          const w = server.fetch(wrapperId);
          if (w.type !== 'key_enc' || !w.key_enc) {
            throw new CapyError('bad row', ERROR_CODES.INVALID_FORMAT);
          }
          return w.key_enc;
        },
      };
    },
  };
}

const org = (id: string): Organization => ({ id, workos_org_id: `wos_${id}`, name: id });

/** Unwrap an uploaded door row back to the root it wraps, as a new device would. */
function rootFromDoor(server: FakeWrapperServer, ceremony: FakeAuthenticator): Buffer {
  const door = server.liveDoor()!;
  const prf = (ceremony as any).prf.get(`${door.credential_id}:${door.prf_salt}`) as Buffer;
  const kek = dkCrypto.deriveDeviceKeyKek(prf, Buffer.from(door.prf_salt!, 'base64'), door.kdf_version);
  return dkCrypto.unwrapKLocal(
    door.wrapped_k_local!,
    door.iv!,
    kek,
    dkCrypto.deviceKeyWrapAAD(USER, door.credential_id!),
  );
}

describe('device-key onboarding engine', () => {
  describe('Case A — brand-new user', () => {
    it('writes files via the existing helpers, uploads both blobs, and the door wraps the on-disk root', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-a';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const deps = makeDeps(server, ceremony, [org('orgA')]);
      const masterKey = randomBytes(32);

      const result = await onboarding.runNewUserEnrollment(deps, { orgId: 'orgA', masterKey });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.orgs).toEqual([{ orgId: 'orgA', status: 'uploaded' }]);
      expect(result.verified).toBe(true);
      expect(server.verifyCalls.length).toBe(1);

      // Files: today's exact locations and formats, via the existing helpers.
      const root = gc.readLocalRoot('orgA', USER);
      expect(root).not.toBeNull();
      const keyEncFile = JSON.parse(readFileSync(gc.getOrgKeyPath('orgA', USER), 'utf-8'));
      expect(keyEncFile.version).toBe('2.0');
      expect(keyEncFile.wrapping_method).toBe('local_root');

      // The uploaded key.enc is the on-disk blob, unchanged.
      expect(server.liveKeyEnc('orgA')!.key_enc).toBe(keyEncFile.encrypted_master_key);

      // The door unwraps (as a new device would) to the root that is on disk.
      expect(rootFromDoor(server, ceremony).equals(root!)).toBe(true);

      // Steady state: the REAL resolver, untouched, recovers M.
      const resolved = await keyResolver.unwrapMasterKey('orgA', USER, {
        coDecrypt: async (_o, ct) => kmsStrip(ct),
        wrapOuterLayer: async (_o, pt) => kmsWrap(pt),
      });
      expect(resolved.equals(masterKey)).toBe(true);

      // Upload landed → no sync debt.
      expect(gc.isKeyEncSyncPending('orgA', USER)).toBe(false);
    });

    it('a cancelled ceremony leaves the machine exactly as the non-passkey flow would', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-a-cancel';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      ceremony.failNextWith = 'cancelled';
      const deps = makeDeps(server, ceremony, [org('orgA')]);

      const result = await onboarding.runNewUserEnrollment(deps, { orgId: 'orgA', masterKey: randomBytes(32) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe(ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED);
      expect(result.ceremonyCode).toBe('cancelled');

      // Files written (today's org-creation behavior), nothing uploaded,
      // and the sync marker records the still-owed upload.
      expect(gc.readLocalRoot('orgA', USER)).not.toBeNull();
      expect(gc.readMasterKey('orgA', USER)).not.toBeNull();
      expect(server.rows.length).toBe(0);
      expect(gc.isKeyEncSyncPending('orgA', USER)).toBe(true);
    });
  });

  describe('Case B — first enrollment on an existing machine', () => {
    it('unifies divergent per-org roots onto the canonical root and uploads every org', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-b';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      // Two orgs provisioned the pre-passkey way: each minted its OWN root.
      const m1 = randomBytes(32);
      const m2 = randomBytes(32);
      await keyResolver.wrapAndSaveMasterKey(m1, 'org1', USER, kms);
      await keyResolver.wrapAndSaveMasterKey(m2, 'org2', USER, kms);
      const root1 = gc.readLocalRoot('org1', USER)!;
      const root2 = gc.readLocalRoot('org2', USER)!;
      expect(root1.equals(root2)).toBe(false);

      const deps = makeDeps(server, ceremony, [org('org1'), org('org2')], { activeOrgId: 'org1' });
      const result = await onboarding.runFirstEnrollment(deps);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');

      const byOrg = Object.fromEntries(result.orgs.map(o => [o.orgId, o.status]));
      expect(byOrg['org1']).toBe('uploaded');
      expect(byOrg['org2']).toBe('rekeyed_and_uploaded');

      // Both org dirs now hold the canonical (active org's) root.
      expect(gc.readLocalRoot('org1', USER)!.equals(root1)).toBe(true);
      expect(gc.readLocalRoot('org2', USER)!.equals(root1)).toBe(true);

      // The door wraps the canonical root.
      expect(rootFromDoor(server, ceremony).equals(root1)).toBe(true);

      // Server blobs both unwrap under the canonical root — the next-device guarantee.
      for (const [orgId, m] of [['org1', m1], ['org2', m2]] as const) {
        const inner = kmsStrip(server.liveKeyEnc(orgId)!.key_enc!);
        const recovered = keyManager.decryptMasterKey(
          inner,
          localKeyRoot.deriveLocalInnerKey(root1),
          keyManager.masterKeyAAD(USER, orgId),
        );
        expect(recovered.equals(m)).toBe(true);
      }

      // Steady state on THIS machine still resolves after unification.
      expect((await keyResolver.unwrapMasterKey('org1', USER, kms)).equals(m1)).toBe(true);
      expect((await keyResolver.unwrapMasterKey('org2', USER, kms)).equals(m2)).toBe(true);

      expect(gc.isKeyEncSyncPending('org1', USER)).toBe(false);
      expect(gc.isKeyEncSyncPending('org2', USER)).toBe(false);
    });

    it('rotates on WRAPPER_CONFLICT: a stale server key.enc row is soft-deleted and replaced', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-b-rotate';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      const stale = server.uploadKeyEnc('org1', 'STALE_BLOB');

      const deps = makeDeps(server, ceremony, [org('org1')]);
      const result = await onboarding.runFirstEnrollment(deps);
      expect(result.ok).toBe(true);

      const staleRow = server.rows.find(r => r.id === stale.id)!;
      expect(staleRow.deleted_at).not.toBeNull();
      expect(server.liveKeyEnc('org1')!.key_enc).toBe(gc.readMasterKey('org1', USER)!);
    });

    it('a failed upload leaves the sync marker; runPendingSync retries and clears it', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-b-retry';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      server.failKeyEncUploadFor.set(
        'org1',
        new CapyError('offline', ERROR_CODES.NETWORK_ERROR, { code: 'ECONNREFUSED' }),
      );

      const deps = makeDeps(server, ceremony, [org('org1')]);
      const result = await onboarding.runFirstEnrollment(deps);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.orgs).toEqual([{ orgId: 'org1', status: 'failed', code: ERROR_CODES.NETWORK_ERROR }]);
      expect(gc.isKeyEncSyncPending('org1', USER)).toBe(true);

      // Next enrollment-aware run: the persisted marker drives the retry.
      const outcomes = await onboarding.runPendingSync(deps);
      expect(outcomes).toEqual([{ orgId: 'org1', status: 'uploaded' }]);
      expect(gc.isKeyEncSyncPending('org1', USER)).toBe(false);
      expect(server.liveKeyEnc('org1')!.key_enc).toBe(gc.readMasterKey('org1', USER)!);

      // And with no markers, the sweep is a no-op.
      expect(await onboarding.runPendingSync(deps)).toEqual([]);
    });

    it('an org without a mintable token is skipped with its marker kept', async () => {
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-case-b-notoken';
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org2', USER, kms);

      const deps = makeDeps(server, ceremony, [org('org1'), org('org2')], {
        activeOrgId: 'org1',
        tokenlessOrgs: ['org2'],
      });
      const result = await onboarding.runFirstEnrollment(deps);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      const byOrg = Object.fromEntries(result.orgs.map(o => [o.orgId, o.status]));
      expect(byOrg['org1']).toBe('uploaded');
      expect(byOrg['org2']).toBe('skipped_no_org_token');
      expect(gc.isKeyEncSyncPending('org2', USER)).toBe(true);
    });
  });

  describe('Case C / C′ — enrolled user, fresh machine', () => {
    it('the full portability round-trip: enroll on machine 1, unlock installs a working tree on machine 2', async () => {
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      // Machine 1: provision two orgs the file way, then enroll (Case B).
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-machine-1';
      const m1 = randomBytes(32);
      const m2 = randomBytes(32);
      await keyResolver.wrapAndSaveMasterKey(m1, 'org1', USER, kms);
      await keyResolver.wrapAndSaveMasterKey(m2, 'org2', USER, kms);
      const depsM1 = makeDeps(server, ceremony, [org('org1'), org('org2')], { activeOrgId: 'org1' });
      const enrolled = await onboarding.runFirstEnrollment(depsM1);
      expect(enrolled.ok).toBe(true);
      const canonicalRoot = gc.readLocalRoot('org1', USER)!;

      // Machine 2: empty tree, same server, same authenticator.
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-machine-2';
      const depsM2 = makeDeps(server, ceremony, [org('org1'), org('org2')], { activeOrgId: 'org1' });

      const detection = await onboarding.detectOnboardingCase(depsM2);
      expect(detection.kind).toBe('unlock');

      const result = await onboarding.runUnlock(depsM2, detection.inventory);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      const byOrg = Object.fromEntries(result.orgs.map(o => [o.orgId, o.status]));
      expect(byOrg['org1']).toBe('installed');
      expect(byOrg['org2']).toBe('installed');

      // Installed files: canonical root in both org dirs, server blobs beside.
      expect(gc.readLocalRoot('org1', USER)!.equals(canonicalRoot)).toBe(true);
      expect(gc.readLocalRoot('org2', USER)!.equals(canonicalRoot)).toBe(true);

      // THE invariant-4 proof: the untouched steady-state resolver works on
      // the passkey-provisioned tree.
      expect((await keyResolver.unwrapMasterKey('org1', USER, kms)).equals(m1)).toBe(true);
      expect((await keyResolver.unwrapMasterKey('org2', USER, kms)).equals(m2)).toBe(true);

      // Idempotence: a second unlock touches nothing.
      const again = await onboarding.runUnlock(depsM2);
      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error('unreachable');
      expect(Object.fromEntries(again.orgs.map(o => [o.orgId, o.status]))).toEqual({
        org1: 'already_provisioned',
        org2: 'already_provisioned',
      });
    });

    it('refuses to overwrite a foreign root (coded local_root_conflict), leaving local state untouched', async () => {
      // Same server as a previous enrollment is fine — build a fresh one for isolation.
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-conflict-src';
      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      const enrolled = await onboarding.runFirstEnrollment(
        makeDeps(server, ceremony, [org('org1')]),
      );
      expect(enrolled.ok).toBe(true);

      // The "new machine" already has a DIFFERENT root for org1 (e.g. a
      // concurrent transport redeem) — invariant 8 says that state stays.
      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-conflict-dst';
      const foreignRoot = randomBytes(32);
      gc.saveLocalRoot('org1', foreignRoot, USER);
      const foreignBlob = kmsWrap(
        keyManager.encryptMasterKey(
          randomBytes(32),
          localKeyRoot.deriveLocalInnerKey(foreignRoot),
          keyManager.masterKeyAAD(USER, 'org1'),
        ),
      );
      gc.saveMasterKey('org1', foreignBlob, USER);

      const result = await onboarding.runUnlock(makeDeps(server, ceremony, [org('org1')]));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.orgs).toEqual([
        { orgId: 'org1', status: 'local_root_conflict', code: ERROR_CODES.LOCAL_ROOT_CONFLICT },
      ]);
      expect(gc.readLocalRoot('org1', USER)!.equals(foreignRoot)).toBe(true);
      expect(gc.readMasterKey('org1', USER)).toBe(foreignBlob);
    });

    it('a declined unlock ceremony is a typed refusal and writes nothing', async () => {
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-unlock-decline-src';
      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      const enrolled = await onboarding.runFirstEnrollment(
        makeDeps(server, ceremony, [org('org1')]),
      );
      expect(enrolled.ok).toBe(true);

      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-unlock-decline-dst';
      ceremony.failNextWith = 'webauthn_unavailable';
      const result = await onboarding.runUnlock(makeDeps(server, ceremony, [org('org1')]));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.ceremonyCode).toBe('webauthn_unavailable');
      expect(existsSync(gc.getLocalRootPath('org1', USER))).toBe(false);
      expect(existsSync(gc.getOrgKeyPath('org1', USER))).toBe(false);
    });
  });

  describe('detection (effectful) matches the pure fork on real state', () => {
    it('walks A → B → C as state accretes, and B′ when only orgs exist', async () => {
      const server = new FakeWrapperServer();
      const ceremony = new FakeAuthenticator();
      const kms = { coDecrypt: async (_o: string, ct: string) => kmsStrip(ct), wrapOuterLayer: async (_o: string, pt: string) => kmsWrap(pt) };

      process.env.CAPY_GLOBAL_DIR_NAME = '.capy-detect';
      const noOrgDeps = makeDeps(server, ceremony, []);
      expect((await onboarding.detectOnboardingCase(noOrgDeps)).kind).toBe('brand_new');

      const orgDeps = makeDeps(server, ceremony, [org('org1')]);
      expect((await onboarding.detectOnboardingCase(orgDeps)).kind).toBe('recovery_or_transport');

      await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'org1', USER, kms);
      expect((await onboarding.detectOnboardingCase(orgDeps)).kind).toBe('enroll_existing');

      const enrolled = await onboarding.runFirstEnrollment(orgDeps);
      expect(enrolled.ok).toBe(true);
      expect((await onboarding.detectOnboardingCase(orgDeps)).kind).toBe('unlock');
    });
  });
});
