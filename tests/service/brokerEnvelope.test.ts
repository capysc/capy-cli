/**
 * The broker answer envelope (v1): WebCrypto page-side seal must open under
 * the CLI's node:crypto half, the connection/key binding must be enforced,
 * and every failure must be a code — never a throw, never a sentence.
 */
import { describe, expect, test } from 'bun:test';

import {
  ENVELOPE_HKDF_INFO_PREFIX,
  envelopeHkdfInfo,
  mintConnectionKeypair,
  openEnvelope,
  parseCompletionPayload,
  requestHkdfInfo,
  sealRequestEnvelope,
} from '../../src/service/brokerEnvelope';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const CONNECTION_ID = '4f9c02e2-92cf-4a6b-8f3e-27cf6f6f2f10';

// CAP-376/CAP-381 Gate-2 MINOR-4: keep-app's page-side seal hardcodes this
// same literal (`envelope.ts`) instead of importing it, because the two
// repos share no code. The tests above only prove self-consistency — they
// derive both halves of the HKDF info string from this repo's own constant,
// so a drift in that constant would keep this suite green while breaking
// real browser -> CLI interop. Pinning the literal here means a change to
// `ENVELOPE_HKDF_INFO_PREFIX` fails loudly on THIS side too, not just
// silently on keep-app's.
test('the HKDF info prefix is pinned to the literal keep-app hardcodes independently (interop tripwire)', () => {
  expect(ENVELOPE_HKDF_INFO_PREFIX).toBe('capy-broker-envelope-v1');
});

// The DIRECTION TAG is the other half of the same tripwire. The broker now
// carries two channels over one connection — page->CLI answers and CLI->page
// requests — sharing the envelope shape and both public keys. The `ans`
// segment is what keeps their derived keys disjoint, so an envelope from one
// direction cannot be replayed into the other. keep-app and capy-mcp pin this
// exact string independently; if any repo drops or renames the tag, real
// interop breaks while each repo's self-consistent tests stay green.
test('the answer info string carries the `ans` direction tag (interop tripwire)', () => {
  expect(envelopeHkdfInfo('conn-1', 'CLIENTPUB', 'EPK')).toBe(
    'capy-broker-envelope-v1|ans|conn-1|CLIENTPUB|EPK',
  );
});

// The `req` producer's own tripwire — keep-app's request-opening half (W2-A)
// independently hardcodes this same literal, exactly as CAP-376's `ans`
// pairing already does. A drift here would keep this suite green while
// breaking real CLI -> page interop.
test('the request info string carries the `req` direction tag (interop tripwire)', () => {
  expect(requestHkdfInfo('conn-1', 'CLIENTPUB', 'EPK')).toBe(
    'capy-broker-envelope-v1|req|conn-1|CLIENTPUB|EPK',
  );
});

describe('mintConnectionKeypair', () => {
  test('registers a 65-byte uncompressed P-256 point in base64', () => {
    const { publicKeyB64 } = mintConnectionKeypair();
    const raw = Buffer.from(publicKeyB64, 'base64');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    // Fits the broker's client_pubkey cap (16..512 base64 chars).
    expect(publicKeyB64.length).toBeGreaterThanOrEqual(16);
    expect(publicKeyB64.length).toBeLessThanOrEqual(512);
  });
});

describe('openEnvelope', () => {
  test('opens a WebCrypto-sealed envelope (browser -> CLI interop)', async () => {
    const keypair = mintConnectionKeypair();
    const plaintext = JSON.stringify({ v: 1, flow: 'auth-success', signal: 'acknowledged' });
    const sealed = await sealEnvelopePageSide({
      plaintext,
      connectionId: CONNECTION_ID,
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const opened = openEnvelope({
      ciphertextB64: sealed,
      connectionId: CONNECTION_ID,
      keypair,
    });
    expect(opened).toEqual({ ok: true, plaintext });
  });

  test('an envelope sealed for one connection does not open on another (binding)', async () => {
    const keypair = mintConnectionKeypair();
    const sealed = await sealEnvelopePageSide({
      plaintext: 'bound',
      connectionId: CONNECTION_ID,
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const opened = openEnvelope({
      ciphertextB64: sealed,
      connectionId: 'ffffffff-0000-0000-0000-000000000000',
      keypair,
    });
    expect(opened).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  test('an envelope sealed to a different keypair fails closed', async () => {
    const rightKeypair = mintConnectionKeypair();
    const wrongKeypair = mintConnectionKeypair();
    const sealed = await sealEnvelopePageSide({
      plaintext: 'secret',
      connectionId: CONNECTION_ID,
      clientPubkeyB64: rightKeypair.publicKeyB64,
    });

    const opened = openEnvelope({
      ciphertextB64: sealed,
      connectionId: CONNECTION_ID,
      keypair: wrongKeypair,
    });
    expect(opened).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  test('rejects non-base64 and non-JSON bytes as MALFORMED', () => {
    const keypair = mintConnectionKeypair();
    for (const bad of [
      'not base64 at all!!!',
      Buffer.from('hello world').toString('base64'),
      Buffer.from(JSON.stringify({ v: 1 })).toString('base64'),
      '',
    ]) {
      const opened = openEnvelope({
        ciphertextB64: bad,
        connectionId: CONNECTION_ID,
        keypair,
      });
      expect(opened).toEqual({ ok: false, code: 'MALFORMED' });
    }
  });

  test('rejects an unknown version as UNSUPPORTED_VERSION, not a decrypt attempt', async () => {
    const keypair = mintConnectionKeypair();
    const sealed = await sealEnvelopePageSide({
      plaintext: 'x',
      connectionId: CONNECTION_ID,
      clientPubkeyB64: keypair.publicKeyB64,
    });
    const envelope = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8'));
    envelope.v = 2;
    const reSealed = Buffer.from(JSON.stringify(envelope)).toString('base64');

    const opened = openEnvelope({
      ciphertextB64: reSealed,
      connectionId: CONNECTION_ID,
      keypair,
    });
    expect(opened).toEqual({ ok: false, code: 'UNSUPPORTED_VERSION' });
  });
});

describe('sealRequestEnvelope', () => {
  test('seals a CLI->page request that opens under a real WebCrypto page (interop)', async () => {
    const clientKeypair = mintConnectionKeypair();
    const page = await mintPageKeypairPageSide();
    const plaintext = JSON.stringify({ v: 1, vars: [{ name: 'STRIPE_SECRET_KEY' }] });

    const sealed = sealRequestEnvelope({
      connectionId: CONNECTION_ID,
      clientPubkeyB64: clientKeypair.publicKeyB64,
      pagePubkeyB64: page.pagePubkeyB64,
      payload: plaintext,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const opened = await openRequestEnvelopePageSide({
      ciphertextB64: sealed.ciphertextB64,
      connectionId: CONNECTION_ID,
      clientPubkeyB64: clientKeypair.publicKeyB64,
      pagePrivateKey: page.privateKey,
    });
    expect(opened).toBe(plaintext);
  });

  test('rejects a malformed page_pubkey as a coded failure, never a throw', () => {
    const clientKeypair = mintConnectionKeypair();
    for (const bad of ['not base64!!!', Buffer.from('too short').toString('base64'), '']) {
      const sealed = sealRequestEnvelope({
        connectionId: CONNECTION_ID,
        clientPubkeyB64: clientKeypair.publicKeyB64,
        pagePubkeyB64: bad,
        payload: 'x',
      });
      expect(sealed).toEqual({ ok: false, code: 'MALFORMED_PAGE_PUBKEY' });
    }
  });

  test('a request sealed under `req` does not open as an `ans` (cross-direction replay fails)', async () => {
    // The page's reverse-channel keypair is P-256-shaped identically to the
    // CLI's connection keypair, so a `req` envelope can be fed into
    // `openEnvelope` (the `ans`-only opener) as a structural sanity check
    // that AEAD authentication — not just the info-string label — actually
    // rejects it, the same binding openEnvelope's own tests already pin.
    const clientKeypair = mintConnectionKeypair();
    const page = await mintPageKeypairPageSide();
    const sealed = sealRequestEnvelope({
      connectionId: CONNECTION_ID,
      clientPubkeyB64: clientKeypair.publicKeyB64,
      pagePubkeyB64: page.pagePubkeyB64,
      payload: 'req-tagged',
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    // openEnvelope derives its key against the CLI's OWN keypair (the `ans`
    // direction's recipient); a `req` envelope was sealed to the PAGE's
    // keypair instead, so this must fail closed regardless of which keypair
    // is handed to the (wrong-direction) opener.
    const opened = openEnvelope({
      ciphertextB64: sealed.ciphertextB64,
      connectionId: CONNECTION_ID,
      keypair: clientKeypair,
    });
    expect(opened).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });
});

describe('parseCompletionPayload', () => {
  test('accepts the typed acknowledgement for the expected flow', () => {
    const payload = parseCompletionPayload(
      JSON.stringify({ v: 1, flow: 'auth-success', signal: 'acknowledged', at: '2026-08-08T00:00:00Z' }),
      'auth-success',
    );
    expect(payload).not.toBeNull();
    expect(payload?.signal).toBe('acknowledged');
  });

  test('rejects a payload for a different flow (no cross-flow replay)', () => {
    const payload = parseCompletionPayload(
      JSON.stringify({ v: 1, flow: 'auth-error', signal: 'acknowledged' }),
      'auth-success',
    );
    expect(payload).toBeNull();
  });

  test('rejects wrong version, wrong signal, and non-JSON', () => {
    expect(parseCompletionPayload(JSON.stringify({ v: 2, flow: 'auth-success', signal: 'acknowledged' }), 'auth-success')).toBeNull();
    expect(parseCompletionPayload(JSON.stringify({ v: 1, flow: 'auth-success', signal: 'nope' }), 'auth-success')).toBeNull();
    expect(parseCompletionPayload('not json', 'auth-success')).toBeNull();
  });
});
