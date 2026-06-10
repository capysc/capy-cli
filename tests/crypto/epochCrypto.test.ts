import { describe, it, expect } from 'bun:test';
import {
  generateEpochKey,
  deriveEpoch0,
  deriveProjectKey,
  snapshotAAD,
  wrapHistoryBlob,
  unwrapHistoryBlob,
  wrapProjectHistoryBlob,
  unwrapProjectHistoryBlob,
  wrapEscrowBlob,
  unwrapEscrowBlob,
} from '../../src/crypto/epochCrypto';
import { randomBytes } from 'crypto';

const ORG = 'org_test';
const PROJ_A = 'proj_a';
const PROJ_B = 'proj_b';

describe('epoch key generation', () => {
  it('generates 32-byte keys', () => {
    expect(generateEpochKey()).toHaveLength(32);
  });

  it('generates independent keys (no derivation relationship)', () => {
    const a = generateEpochKey();
    const b = generateEpochKey();
    expect(a.equals(b)).toBe(false);
  });

  it('deriveEpoch0 IS M (epoch 0 = legacy M path, CAP-58 migration decision)', () => {
    const M = randomBytes(32);
    // E_0 == M so legacy ciphertext under deriveProjectKey(M, …) reads as
    // epoch 0 with no re-encryption.
    expect(deriveEpoch0(M).equals(M)).toBe(true);
    expect(deriveEpoch0(M)).toHaveLength(32);
    // Returns a copy — mutating it must not corrupt M.
    const e0 = deriveEpoch0(M);
    e0[0] ^= 0xff;
    expect(deriveEpoch0(M).equals(M)).toBe(true);
  });
});

describe('deriveProjectKey', () => {
  it('is deterministic and project-scoped', () => {
    const E = generateEpochKey();
    expect(deriveProjectKey(E, PROJ_A, ORG)).toBe(deriveProjectKey(E, PROJ_A, ORG));
    expect(deriveProjectKey(E, PROJ_A, ORG)).not.toBe(deriveProjectKey(E, PROJ_B, ORG));
  });

  it('different epoch keys yield different project keys', () => {
    const e1 = generateEpochKey();
    const e2 = generateEpochKey();
    expect(deriveProjectKey(e1, PROJ_A, ORG)).not.toBe(deriveProjectKey(e2, PROJ_A, ORG));
  });
});

describe('history chain (org-wide)', () => {
  it('round-trips E_3 -> E_2 -> E_1 by walking backward', () => {
    const e1 = generateEpochKey();
    const e2 = generateEpochKey();
    const e3 = generateEpochKey();
    const blob2 = wrapHistoryBlob(e1, e2); // transition 1->2
    const blob3 = wrapHistoryBlob(e2, e3); // transition 2->3

    // Holding e3, walk to e2 then e1.
    const recovered2 = unwrapHistoryBlob(blob3, e3);
    expect(recovered2.equals(e2)).toBe(true);
    const recovered1 = unwrapHistoryBlob(blob2, recovered2);
    expect(recovered1.equals(e1)).toBe(true);
  });

  it('forward walk is impossible by construction (no api yields E_{e+1} from E_e)', () => {
    // The only history primitive recovers the PREVIOUS key from the NEW key.
    // Given e2 and the 2->3 blob, you cannot get e3 (you ARE expected to hold
    // e3 to open it). Confirm the blob does not open with the old key.
    const e2 = generateEpochKey();
    const e3 = generateEpochKey();
    const blob3 = wrapHistoryBlob(e2, e3);
    expect(() => unwrapHistoryBlob(blob3, e2)).toThrow();
  });
});

describe('history chain (per-project confinement)', () => {
  it('project A chain never exposes the org-wide E or project B keys', () => {
    const e1 = generateEpochKey();
    const e2 = generateEpochKey();
    const blobA = wrapProjectHistoryBlob(e1, e2, PROJ_A, ORG);

    const newDerivedA = deriveProjectKey(e2, PROJ_A, ORG);
    const recoveredA = unwrapProjectHistoryBlob(blobA, newDerivedA);
    // Recovers project A's PREVIOUS derived key — equals deriveProjectKey(e1, A).
    expect(recoveredA).toBe(deriveProjectKey(e1, PROJ_A, ORG));

    // The recovered value is a project-A derived key, NOT the org-wide e1 and
    // NOT project B's key.
    expect(recoveredA).not.toBe(e1.toString('hex'));
    expect(recoveredA).not.toBe(deriveProjectKey(e1, PROJ_B, ORG));

    // Project A's blob cannot be opened with project B's derived key.
    const newDerivedB = deriveProjectKey(e2, PROJ_B, ORG);
    expect(() => unwrapProjectHistoryBlob(blobA, newDerivedB)).toThrow();
  });
});

describe('escrow round-trip', () => {
  it('M opens every epoch escrow; wrong M fails GCM auth', () => {
    const M = randomBytes(32);
    const wrongM = randomBytes(32);
    const e1 = generateEpochKey();
    const e2 = generateEpochKey();
    const blob1 = wrapEscrowBlob(M, 1, e1);
    const blob2 = wrapEscrowBlob(M, 2, e2);

    expect(unwrapEscrowBlob(blob1, M, 1).equals(e1)).toBe(true);
    expect(unwrapEscrowBlob(blob2, M, 2).equals(e2)).toBe(true);
    expect(() => unwrapEscrowBlob(blob1, wrongM, 1)).toThrow();
  });

  it('escrow blob for one epoch does not open under a different epoch number', () => {
    const M = randomBytes(32);
    const e1 = generateEpochKey();
    const blob1 = wrapEscrowBlob(M, 1, e1);
    // The epoch is bound into the HKDF info, so the key differs.
    expect(() => unwrapEscrowBlob(blob1, M, 2)).toThrow();
  });
});

describe('snapshot AAD binding', () => {
  it('differs across epoch, project, and org', () => {
    const base = snapshotAAD(ORG, PROJ_A, 1).toString();
    expect(snapshotAAD(ORG, PROJ_A, 2).toString()).not.toBe(base);
    expect(snapshotAAD(ORG, PROJ_B, 1).toString()).not.toBe(base);
    expect(snapshotAAD('other', PROJ_A, 1).toString()).not.toBe(base);
  });
});
