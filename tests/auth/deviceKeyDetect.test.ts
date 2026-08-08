import { describe, it, expect } from 'bun:test';
import { decideOnboardingCase, DetectionInputs, OnboardingCaseKind } from '../../src/auth/deviceKey/detect';

/**
 * The MANDATORY detection-order matrix (CAP-380): every case row plus the
 * full precedence lattice. The documented order is
 *   wrappers (live doors) → local.key → orgs → brand-new
 * and no input combination may reorder it.
 */
describe('device-key onboarding detection fork', () => {
  const world = (
    doors: number,
    keyEncs: number,
    localRoot: boolean,
    orgs: number,
  ): DetectionInputs => ({
    liveDoorCount: doors,
    liveKeyEncCount: keyEncs,
    hasLocalRoot: localRoot,
    organizationCount: orgs,
  });

  describe('named case rows', () => {
    it('Case A — brand-new user: nothing anywhere', () => {
      expect(decideOnboardingCase(world(0, 0, false, 0))).toBe('brand_new');
    });

    it('Case B — existing machine (local.key), no wrappers', () => {
      expect(decideOnboardingCase(world(0, 0, true, 1))).toBe('enroll_existing');
    });

    it('Case B′ — existing user, fresh machine: orgs only → explicit recovery/transport route, not a crash', () => {
      expect(decideOnboardingCase(world(0, 0, false, 2))).toBe('recovery_or_transport');
    });

    it('Case C — enrolled user, fresh machine: live doors exist', () => {
      expect(decideOnboardingCase(world(1, 1, false, 1))).toBe('unlock');
    });

    it("Case C′ — same verdict as C: QR/hybrid vs local authenticator is the ceremony's discovery, not the fork's", () => {
      // The fork cannot see where the credential lives; C and C′ are one
      // branch here and diverge only inside the CAP-381 ceremony.
      expect(decideOnboardingCase(world(2, 3, false, 3))).toBe('unlock');
    });
  });

  describe('precedence lattice — all 16 worlds', () => {
    // [doors, keyEncs, localRoot, orgs] → expected
    const rows: Array<[number, number, boolean, number, OnboardingCaseKind]> = [
      // doors present → unlock, whatever else is true
      [1, 0, false, 0, 'unlock'],
      [1, 0, false, 1, 'unlock'],
      [1, 0, true, 0, 'unlock'],
      [1, 0, true, 1, 'unlock'],
      [1, 1, false, 0, 'unlock'],
      [1, 1, false, 1, 'unlock'],
      [1, 1, true, 0, 'unlock'],
      [1, 1, true, 1, 'unlock'],
      // no doors, local root → enroll, whatever orgs say
      [0, 0, true, 0, 'enroll_existing'],
      [0, 0, true, 1, 'enroll_existing'],
      [0, 1, true, 0, 'enroll_existing'],
      [0, 1, true, 1, 'enroll_existing'],
      // no doors, no root, orgs → recovery/transport
      [0, 0, false, 1, 'recovery_or_transport'],
      [0, 1, false, 1, 'recovery_or_transport'],
      // nothing at all → brand-new
      [0, 0, false, 0, 'brand_new'],
      [0, 1, false, 0, 'brand_new'],
    ];

    for (const [doors, keyEncs, localRoot, orgs, expected] of rows) {
      it(`doors=${doors} keyEncs=${keyEncs} localRoot=${localRoot} orgs=${orgs} → ${expected}`, () => {
        expect(decideOnboardingCase(world(doors, keyEncs, localRoot, orgs))).toBe(expected);
      });
    }
  });

  describe('recorded decisions pinned', () => {
    it('a key_enc row WITHOUT any live door does not count as "wrappers exist" (unreachable per the server invariant; degrade to the later checks)', () => {
      expect(decideOnboardingCase(world(0, 5, false, 0))).toBe('brand_new');
      expect(decideOnboardingCase(world(0, 5, true, 1))).toBe('enroll_existing');
      expect(decideOnboardingCase(world(0, 5, false, 1))).toBe('recovery_or_transport');
    });

    it('local.key beats orgs: an existing machine enrolls rather than being routed to recovery', () => {
      expect(decideOnboardingCase(world(0, 0, true, 3))).toBe('enroll_existing');
    });
  });
});
