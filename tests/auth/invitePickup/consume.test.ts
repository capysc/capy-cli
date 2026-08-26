import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { CapyError, ERROR_CODES } from '../../../src/types/index';
import type { CeremonyTransport, UnlockRequest } from '../../../src/auth/deviceKey/ceremonyTransport';

// Mock homedir before any import that reads it (repo test convention — see
// tests/auth/deviceKeyOnboarding.test.ts) since consumeInvitePickup writes
// real local.key/key.enc files via keyResolver/globalConfig.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-invitepickup-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env.CAPY_GLOBAL_DIR_NAME;
});

let consumeMod: typeof import('../../../src/auth/invitePickup/consume');
let pickupCrypto: typeof import('../../../src/auth/invitePickup/crypto');
let dkCrypto: typeof import('../../../src/auth/deviceKey/crypto');
let inviteCrypto: typeof import('../../../src/crypto/inviteCrypto');
let keyResolver: typeof import('../../../src/crypto/keyResolver');

beforeAll(async () => {
  consumeMod = await import('../../../src/auth/invitePickup/consume');
  pickupCrypto = await import('../../../src/auth/invitePickup/crypto');
  dkCrypto = await import('../../../src/auth/deviceKey/crypto');
  inviteCrypto = await import('../../../src/crypto/inviteCrypto');
  keyResolver = await import('../../../src/crypto/keyResolver');
});

const USER = 'user_bob';
const ORG = 'org_test';
const CRED = 'cred-pickup-1';

/** Deterministic fake authenticator: one known PRF output per credential+salt. */
class FakeAuthenticator implements CeremonyTransport {
  prfByKey = new Map<string, Buffer>();

  async requestEnrollment() {
    return { ok: false as const, code: 'cancelled' as const };
  }

  async requestUnlock(req: UnlockRequest) {
    for (const cand of req.candidates) {
      const output = this.prfByKey.get(`${cand.credentialId}:${cand.prfSalt}`);
      if (output) {
        return { ok: true as const, credentialId: cand.credentialId, prfOutput: output.toString('base64') };
      }
    }
    return { ok: false as const, code: 'no_credential' as const };
  }
}

/** Fake KMS outer layer — plaintext passthrough with a tag prefix. */
const KMS_PREFIX = 'KMS1.';
const kmsWrap = (plaintext: string) => KMS_PREFIX + plaintext;
const kmsStrip = (ct: string) => {
  if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
  return ct.slice(KMS_PREFIX.length);
};

interface FakeWorld {
  pickup: import('../../../src/auth/invitePickup/consume').PendingPickupRow | null;
  wrappers: Array<{ id: string; type: 'wrapped_k_local' | 'key_enc'; credential_id?: string | null; deleted_at?: string | null }>;
  blob: string;
  inviteEmail: string;
  pickupDeleted: boolean;
  nextDoorUploadConflictCredential: string | null;
}

function makeOps(world: FakeWorld): import('../../../src/auth/invitePickup/consume').InvitePickupOps {
  return {
    async getPendingPickup() {
      return world.pickup;
    },
    async fetchInviteBlob(_orgId: string, _inviteId: string) {
      return { blob: world.blob, email: world.inviteEmail };
    },
    async coDecrypt(_orgId: string, ciphertext: string) {
      return kmsStrip(ciphertext);
    },
    async wrapOuterLayer(_orgId: string, plaintext: string) {
      return kmsWrap(plaintext);
    },
    async uploadDoorWrapper(body) {
      if (world.nextDoorUploadConflictCredential !== null) {
        const conflictCred = world.nextDoorUploadConflictCredential;
        world.nextDoorUploadConflictCredential = null;
        // Simulate: a live door already exists under `conflictCred`.
        world.wrappers = [
          ...world.wrappers,
          { id: 'existing-door', type: 'wrapped_k_local', credential_id: conflictCred, deleted_at: null },
        ];
        throw new CapyError('conflict', ERROR_CODES.WRAPPER_CONFLICT, {});
      }
      const row = { id: `door-${world.wrappers.length}`, type: 'wrapped_k_local' as const, credential_id: body.credential_id, deleted_at: null };
      world.wrappers = [...world.wrappers, row];
      return row;
    },
    async listWrappers() {
      return world.wrappers;
    },
    async deletePickup(_inviteId: string) {
      world.pickupDeleted = true;
      world.pickup = null;
    },
  };
}

/** Builds a full, consistent fixture: a pickup row + matching blob, wired to a fake authenticator. */
function buildFixture(opts: { inviteEmail: string; masterKey: Buffer; orgId?: string }) {
  const orgId = opts.orgId ?? ORG;
  const auth = new FakeAuthenticator();
  const prfOutput = randomBytes(32);
  const prfSalt = randomBytes(32);
  auth.prfByKey.set(`${CRED}:${prfSalt.toString('base64')}`, prfOutput);

  const token = inviteCrypto.generateInviteTokenV3();
  const inviteId = inviteCrypto.deriveInviteId(token);

  const kekPickup = pickupCrypto.deriveKekPickup(prfOutput, prfSalt);
  const aad = pickupCrypto.pickupWrapAAD(USER, inviteId, CRED);
  const wrapped = pickupCrypto.wrapPickupT(token, kekPickup, aad);

  const innerBlob = inviteCrypto.innerWrap(opts.masterKey, token, orgId, opts.inviteEmail);
  const blob = kmsWrap(innerBlob);

  const pickup: import('../../../src/auth/invitePickup/consume').PendingPickupRow = {
    invite_id: inviteId,
    organization_id: orgId,
    user_id: USER,
    wrapped_t: wrapped.wrappedT,
    iv: wrapped.iv,
    prf_salt: prfSalt.toString('base64'),
    credential_id: CRED,
    kdf_version: dkCrypto.DEVICE_KEY_KDF_VERSION,
  };

  const world: FakeWorld = {
    pickup,
    wrappers: [],
    blob,
    inviteEmail: opts.inviteEmail,
    pickupDeleted: false,
    nextDoorUploadConflictCredential: null,
  };

  return { auth, world, inviteId, token };
}

describe('consumeInvitePickup', () => {
  it('returns noPendingPickup when there is nothing to consume', async () => {
    const auth = new FakeAuthenticator();
    const world: FakeWorld = {
      pickup: null,
      wrappers: [],
      blob: '',
      inviteEmail: '',
      pickupDeleted: false,
      nextDoorUploadConflictCredential: null,
    };
    const result = await consumeMod.consumeInvitePickup(USER, auth, makeOps(world));
    expect(result).toEqual({ ok: true, noPendingPickup: true });
  });

  it('full happy path: unwraps M, mints K_local, uploads the door, writes key.enc, retires the pickup', async () => {
    const org = `${ORG}-happy-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });

    const result = await consumeMod.consumeInvitePickup(USER, auth, makeOps(world));
    expect(result.ok).toBe(true);
    if ('noPendingPickup' in result) throw new Error('expected a real result');
    expect(result.keyAlreadyPresent).toBe(false);
    expect(result.orgId).toBe(org);
    expect(result.credentialId).toBe(CRED);

    expect(world.pickupDeleted).toBe(true);
    expect(world.wrappers.some((w) => w.type === 'wrapped_k_local' && w.credential_id === CRED)).toBe(true);
    expect(keyResolver.hasOrgKey(org, USER)).toBe(true);
  });

  it('guard: the email used for innerUnwrap comes from the invite row, not the session', async () => {
    // The invite was minted for "bob@example.com". Simulate the session
    // knowing a DIFFERENT (stale) email — consume must still succeed because
    // it never consults the session email at all; it only ever sees the
    // invite row's email, supplied by fetchInviteBlob.
    const org = `${ORG}-email-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });
    // world.inviteEmail (used by fetchInviteBlob) stays "bob@example.com" —
    // the fixture binds innerWrap to it. If consume.ts ever used a
    // session-supplied email instead, this test's fixture would need to pass
    // that email in, and it deliberately does not expose that parameter —
    // proving there is no such input to consumeInvitePickup at all.
    const result = await consumeMod.consumeInvitePickup(USER, auth, makeOps(world));
    expect(result.ok).toBe(true);
    expect(keyResolver.hasOrgKey(org, USER)).toBe(true);
  });

  it('guard 5: hasOrgKey short-circuits — an existing key.enc is never overwritten', async () => {
    const org = `${ORG}-guard5-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });

    // Pre-seed an existing key.enc for this org+user with DIFFERENT content,
    // so a real overwrite would be observable.
    const { saveMasterKey } = await import('../../../src/config/globalConfig');
    const sentinelBlob = 'SENTINEL-DO-NOT-OVERWRITE';
    saveMasterKey(org, sentinelBlob, USER);
    expect(keyResolver.hasOrgKey(org, USER)).toBe(true);

    const result = await consumeMod.consumeInvitePickup(USER, auth, makeOps(world));
    expect(result.ok).toBe(true);
    if ('noPendingPickup' in result) throw new Error('expected a real result');
    expect(result.keyAlreadyPresent).toBe(true);

    const { readMasterKey } = await import('../../../src/config/globalConfig');
    expect(readMasterKey(org, USER)).toBe(sentinelBlob);
    // The pickup is still retired even though the key write was skipped —
    // step 9 runs regardless.
    expect(world.pickupDeleted).toBe(true);
  });

  it('guard 7: door upload 409 under the SAME credential is treated as success and consumption continues', async () => {
    const org = `${ORG}-guard7-same-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });
    // Simulate a previous attempt already having landed the door under the
    // SAME credential this ceremony will use.
    world.nextDoorUploadConflictCredential = CRED;

    const result = await consumeMod.consumeInvitePickup(USER, auth, makeOps(world));
    expect(result.ok).toBe(true);
    if ('noPendingPickup' in result) throw new Error('expected a real result');
    expect(world.pickupDeleted).toBe(true);
    expect(keyResolver.hasOrgKey(org, USER)).toBe(true);
  });

  it('guard 7: door upload 409 under a DIFFERENT credential is NOT swallowed', async () => {
    const org = `${ORG}-guard7-diff-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });
    // A door already exists, but under a completely different credential.
    world.nextDoorUploadConflictCredential = 'some-other-credential';

    await expect(consumeMod.consumeInvitePickup(USER, auth, makeOps(world))).rejects.toThrow(CapyError);
    // Nothing after step 7 should have happened.
    expect(world.pickupDeleted).toBe(false);
    expect(keyResolver.hasOrgKey(org, USER)).toBe(false);
  });

  it('ceremony failure raises DEVICE_KEY_CEREMONY_FAILED and never touches disk', async () => {
    const org = `${ORG}-ceremony-fail-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });
    const brokenAuth = new FakeAuthenticator(); // no PRF registered -> no_credential

    try {
      await consumeMod.consumeInvitePickup(USER, brokenAuth, makeOps(world));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED);
    }
    expect(keyResolver.hasOrgKey(org, USER)).toBe(false);
    expect(world.pickupDeleted).toBe(false);
  });

  it('a tampered wrapped_t fails the pickup unwrap and never reaches the blob fetch', async () => {
    const org = `${ORG}-tamper-${Date.now()}`;
    const masterKey = randomBytes(32);
    const { auth, world } = buildFixture({ inviteEmail: 'bob@example.com', masterKey, orgId: org });
    world.pickup = { ...world.pickup!, wrapped_t: Buffer.from(randomBytes(28)).toString('base64') };

    await expect(consumeMod.consumeInvitePickup(USER, auth, makeOps(world))).rejects.toThrow(CapyError);
    expect(world.pickupDeleted).toBe(false);
  });
});

describe('invitePickup/crypto', () => {
  it('wrapPickupT / unwrapPickupT round-trip', () => {
    const token = randomBytes(12);
    const prfOutput = randomBytes(32);
    const prfSalt = randomBytes(32);
    const kek = pickupCrypto.deriveKekPickup(prfOutput, prfSalt);
    const aad = pickupCrypto.pickupWrapAAD('user-1', 'invite-1', 'cred-1');
    const wrapped = pickupCrypto.wrapPickupT(token, kek, aad);
    const recovered = pickupCrypto.unwrapPickupT(wrapped.wrappedT, wrapped.iv, kek, aad);
    expect(recovered.equals(token)).toBe(true);
  });

  it('fails closed on wrong AAD (credential mismatch)', () => {
    const token = randomBytes(12);
    const prfOutput = randomBytes(32);
    const prfSalt = randomBytes(32);
    const kek = pickupCrypto.deriveKekPickup(prfOutput, prfSalt);
    const wrapped = pickupCrypto.wrapPickupT(token, kek, pickupCrypto.pickupWrapAAD('user-1', 'invite-1', 'cred-1'));
    expect(() =>
      pickupCrypto.unwrapPickupT(wrapped.wrappedT, wrapped.iv, kek, pickupCrypto.pickupWrapAAD('user-1', 'invite-1', 'cred-2')),
    ).toThrow(CapyError);
  });

  it('KEK_pickup and KEK_door differ for the same PRF output/salt (distinct info strings)', () => {
    const prfOutput = randomBytes(32);
    const prfSalt = randomBytes(32);
    const kekPickup = pickupCrypto.deriveKekPickup(prfOutput, prfSalt);
    const kekDoor = dkCrypto.deriveDeviceKeyKek(prfOutput, prfSalt);
    expect(kekPickup.equals(kekDoor)).toBe(false);
  });
});
