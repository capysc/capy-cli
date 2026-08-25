/**
 * Cross-implementation known-answer vectors for the invite-pickup crypto
 * (docs/invite-pickup-flow.md §3.3, §3.6). This CLI and keep-app derive
 * `invite_id` and `KEK_pickup` independently — Node's `crypto` here,
 * WebCrypto there — and until this file, nothing anywhere asserted the
 * exact output bytes agree. A drifted HKDF parameter, a different SHA-256
 * truncation, or a reordered AAD field on either side would have produced
 * no test failure at all: the failure mode is "Bob's pickup is filed under
 * an id the CLI never looks up" or an opaque decrypt failure in production,
 * with nothing pointing at the cause.
 *
 * `tests/fixtures/inviteCrossImplementation.json` is committed IDENTICALLY
 * in this repo and in keep-app (do not edit one without the other).
 * `wrapped_t_b64`/`iv_b64` in that fixture were produced ONCE by keep-app's
 * real production `wrapPickup()` (`src/lib/flow/redeemInviteCrypto.ts`) on
 * the fixed inputs below — this test decrypts those exact bytes with this
 * repo's own independent implementation. Asserting the recovered T equals
 * the fixture's `t_hex` is a genuine cross-repo proof: two independently
 * written implementations agreeing on one artifact, not two tests that
 * happen to assert the same hand-copied constant.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveInviteId } from '../../src/crypto/inviteCrypto';
import { deriveKekPickup, pickupWrapAAD, unwrapPickupT } from '../../src/auth/invitePickup/crypto';

interface CrossImplFixture {
  t_hex: string;
  prf_output_hex: string;
  prf_salt_hex: string;
  prf_salt_b64: string;
  user_id: string;
  credential_id: string;
  invite_id_hex: string;
  kek_pickup_hex: string;
  wrapped_t_b64: string;
  iv_b64: string;
}

const fixture: CrossImplFixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/inviteCrossImplementation.json'), 'utf8'),
);

describe('cross-implementation known-answer vectors (docs/invite-pickup-flow.md §3.3, §3.6)', () => {
  it('deriveInviteId(T) matches the committed vector — pins the invite_id recipe (prefix, hash, truncation, hex case) across repos', () => {
    const token = Buffer.from(fixture.t_hex, 'hex');
    expect(deriveInviteId(token)).toBe(fixture.invite_id_hex);
  });

  it('deriveKekPickup(prfOutput, prfSalt) matches the committed vector — pins HKDF ikm/salt/info/length across repos', () => {
    const prfOutput = Buffer.from(fixture.prf_output_hex, 'hex');
    const prfSalt = Buffer.from(fixture.prf_salt_hex, 'hex');
    const kek = deriveKekPickup(prfOutput, prfSalt);
    expect(kek.toString('hex')).toBe(fixture.kek_pickup_hex);
  });

  it('decrypts the wrapped_t keep-app actually produced, recovering T byte-for-byte — the genuine cross-repo proof', () => {
    const prfOutput = Buffer.from(fixture.prf_output_hex, 'hex');
    const prfSalt = Buffer.from(fixture.prf_salt_hex, 'hex');
    const kek = deriveKekPickup(prfOutput, prfSalt);
    const aad = pickupWrapAAD(fixture.user_id, fixture.invite_id_hex, fixture.credential_id);

    const recovered = unwrapPickupT(fixture.wrapped_t_b64, fixture.iv_b64, kek, aad);

    // Assert the PROPERTY (the recovered plaintext value), never the shape
    // (a length check or "differs from ciphertext" check would pass on a
    // broken cross-implementation).
    expect(recovered.toString('hex')).toBe(fixture.t_hex);
  });

  it('the base64 prf_salt in the fixture decodes to the same bytes as prf_salt_hex — catches a base64/hex fixture-authoring mismatch, not a crypto bug', () => {
    expect(Buffer.from(fixture.prf_salt_b64, 'base64').toString('hex')).toBe(fixture.prf_salt_hex);
  });
});
