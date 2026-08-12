/**
 * CAP-409 — `parsePairPayload`'s framing + shape validation. Pure logic, no
 * network/mock.module — not registered in ISOLATED_FILES.
 */
import { describe, test, expect } from 'bun:test';
import { parsePairPayload, PAIR_FLOW, PAIR_CEREMONY } from '../../../src/auth/pairing/pairContract';

function validAnswerPayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    flow: PAIR_FLOW,
    ceremony: PAIR_CEREMONY,
    session: {
      user: { id: 'user_1', email: 'u@example.com' },
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', name: 'Org One' }],
    },
    keyMaterial: {
      orgId: 'org_1',
      prfOutput: Buffer.alloc(32, 7).toString('base64'),
      credentialId: 'cred_1',
    },
    ...overrides,
  };
}

describe('parsePairPayload', () => {
  test('accepts a well-formed success payload', () => {
    const result = parsePairPayload(JSON.stringify(validAnswerPayload()));
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.answer.session.user.id).toBe('user_1');
      expect(result.answer.keyMaterial.credentialId).toBe('cred_1');
    }
  });

  test('accepts extra unknown fields on user/org (the [k: string]: unknown escape hatch)', () => {
    const payload = validAnswerPayload({
      session: {
        user: { id: 'user_1', email: 'u@example.com', first_name: 'A', last_name: 'B' },
        refresh_token: 'rt_1',
        organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wo_1', plan: 'pro' }],
      },
    });
    const result = parsePairPayload(JSON.stringify(payload));
    expect(result.kind).toBe('answer');
  });

  test('accepts an optional sessions map', () => {
    const payload = validAnswerPayload({
      session: {
        user: { id: 'user_1', email: 'u@example.com' },
        refresh_token: 'rt_1',
        organizations: [{ id: 'org_1', name: 'Org One' }],
        sessions: { org_1: { access_token: 'at_1', expires_at: Date.now() + 60_000 } },
      },
    });
    const result = parsePairPayload(JSON.stringify(payload));
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.answer.session.sessions?.org_1.access_token).toBe('at_1');
    }
  });

  test('accepts a zero-org session', () => {
    const payload = validAnswerPayload({
      session: { user: { id: 'user_1', email: 'u@example.com' }, refresh_token: 'rt_1', organizations: [] },
    });
    const result = parsePairPayload(JSON.stringify(payload));
    expect(result.kind).toBe('answer');
  });

  test('every documented CeremonyFailure code round-trips', () => {
    for (const code of ['cancelled', 'no_credential', 'prf_unsupported', 'webauthn_unavailable', 'transport_error']) {
      const payload = { v: 1, flow: PAIR_FLOW, ceremony: PAIR_CEREMONY, ok: false, code };
      const result = parsePairPayload(JSON.stringify(payload));
      expect(result).toEqual({ kind: 'failure', code: code as any });
    }
  });

  test('an unknown failure code is malformed, not silently accepted', () => {
    const payload = { v: 1, flow: PAIR_FLOW, ceremony: PAIR_CEREMONY, ok: false, code: 'made_up_code' };
    expect(parsePairPayload(JSON.stringify(payload))).toEqual({ kind: 'malformed' });
  });

  test('not JSON at all -> malformed', () => {
    expect(parsePairPayload('not json{{{')).toEqual({ kind: 'malformed' });
  });

  test('wrong v -> malformed', () => {
    expect(parsePairPayload(JSON.stringify(validAnswerPayload({ v: 2 })))).toEqual({ kind: 'malformed' });
  });

  test('wrong flow -> malformed (a device-key envelope must never be read as a pair answer)', () => {
    expect(parsePairPayload(JSON.stringify(validAnswerPayload({ flow: 'device-key' })))).toEqual({ kind: 'malformed' });
  });

  test('wrong ceremony -> malformed', () => {
    expect(parsePairPayload(JSON.stringify(validAnswerPayload({ ceremony: 'unlock' })))).toEqual({ kind: 'malformed' });
  });

  test('missing session.user.id -> malformed', () => {
    const payload = validAnswerPayload({
      session: { user: { email: 'u@example.com' }, refresh_token: 'rt', organizations: [] },
    });
    expect(parsePairPayload(JSON.stringify(payload)).kind).toBe('malformed');
  });

  test('organizations entry missing name -> malformed', () => {
    const payload = validAnswerPayload({
      session: {
        user: { id: 'u1', email: 'u@example.com' },
        refresh_token: 'rt',
        organizations: [{ id: 'org_1' }],
      },
    });
    expect(parsePairPayload(JSON.stringify(payload)).kind).toBe('malformed');
  });

  test('keyMaterial missing prfOutput -> malformed', () => {
    const payload = validAnswerPayload({
      keyMaterial: { orgId: 'org_1', credentialId: 'c1' },
    });
    expect(parsePairPayload(JSON.stringify(payload)).kind).toBe('malformed');
  });

  // THE FALSIFICATION TEST (CAP-372, restored): a payload that carries a
  // `kLocal` field — even alongside an otherwise-valid prfOutput — must be
  // REJECTED, not silently accepted with the extra field ignored. This is
  // what stops a rolled-back or compromised page from quietly resuming the
  // old "ship raw K_local" behavior: the validator fails closed on the
  // field's mere PRESENCE, not just its absence. Confirmed to fail against
  // the pre-hardening validator (which only checked kLocal's own shape and
  // had no such rejection) — see the pair-hardening task's report for the
  // observed failure count.
  test('keyMaterial carrying a kLocal field -> malformed, even if otherwise well-formed (CAP-372 falsification)', () => {
    const payload = validAnswerPayload({
      keyMaterial: {
        orgId: 'org_1',
        prfOutput: Buffer.alloc(32, 7).toString('base64'),
        credentialId: 'c1',
        kLocal: Buffer.alloc(32, 9).toString('base64'),
      },
    });
    expect(parsePairPayload(JSON.stringify(payload)).kind).toBe('malformed');
  });

  test('a plain object with no v/flow/ceremony at all -> malformed, never crashes', () => {
    expect(parsePairPayload(JSON.stringify({ hello: 'world' }))).toEqual({ kind: 'malformed' });
  });

  test('a bare JSON array -> malformed, never crashes', () => {
    expect(parsePairPayload(JSON.stringify([1, 2, 3]))).toEqual({ kind: 'malformed' });
  });
});
