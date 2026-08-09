/**
 * BrokerCeremonyTransport against a real (loopback) HTTP stub of the
 * service's /connections surface — same style as
 * tests/service/brokerClient.test.ts — PLUS the real envelope crypto
 * (tests/helpers/sealEnvelope.ts, WebCrypto-built, mirroring keep-app's own
 * sealing implementation) so this suite proves CLI-node:crypto ↔
 * page-WebCrypto interop for the device-key ceremony specifically, not just
 * the no-submit auth screens brokerClient.test.ts already covers.
 *
 * No mock.module, no global mutation — not registered in ISOLATED_FILES.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  BrokerCeremonyTransport,
  MAX_UNLOCK_CANDIDATES,
  MAX_CREDENTIAL_ID_LENGTH,
} from '../../../src/auth/deviceKey/brokerCeremonyTransport';
import { CapyError, ERROR_CODES } from '../../../src/types/index';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';

const CONNECTION_ID = '0b4e2c62-6f6e-4a11-9d3a-1c2f4b5a6d7e';
const TOKEN = 'ceremony-test-token';

interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

const state = {
  requests: [] as Recorded[],
  createStatus: 201,
  resultQueue: [] as Array<{ status: number; body: unknown }>,
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
    state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body });

    if (req.method === 'POST' && url.pathname === '/connections') {
      if (state.createStatus !== 201) {
        return Response.json({ error: 'refused', code: 'SOME_CODE' }, { status: state.createStatus });
      }
      return Response.json(
        { connection_id: CONNECTION_ID, status: 'pending', expires_at: new Date(Date.now() + 900_000).toISOString() },
        { status: 201 },
      );
    }
    if (req.method === 'GET' && url.pathname === `/connections/${CONNECTION_ID}/result`) {
      const next = state.resultQueue.shift() ?? { status: 200, body: { status: 'pending' } };
      return Response.json(next.body as any, { status: next.status });
    }
    if (req.method === 'DELETE' && url.pathname === `/connections/${CONNECTION_ID}`) {
      return Response.json({ status: 'cancelled' });
    }
    return Response.json({ error: 'no', code: 'NOT_FOUND' }, { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

beforeEach(() => {
  state.requests.length = 0;
  state.createStatus = 201;
  state.resultQueue.length = 0;
});

function transport(overrides: Partial<ConstructorParameters<typeof BrokerCeremonyTransport>[0]> = {}) {
  return new BrokerCeremonyTransport({
    serviceUrl: BASE,
    getToken: () => TOKEN,
    machineName: 'test-machine',
    // Keep tests fast — the production defaults (900s/930s) are pinned separately below.
    ttlSeconds: 900,
    deadlineMs: 3_000,
    ...overrides,
  });
}

/** Pull the `#r=...` fragment out of the printed relay URL (captured via console.log). */
function captureRelayedUrl(fn: () => Promise<unknown>): { result: Promise<unknown>; getUrl: () => string | undefined } {
  const original = console.log;
  let captured: string | undefined;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('/flow/device-key')) captured = line.trim();
  };
  const result = fn().finally(() => {
    console.log = original;
  });
  return { result, getUrl: () => captured };
}

function decodeFragmentRequest(url: string): Record<string, unknown> {
  const hashIdx = url.indexOf('#r=');
  expect(hashIdx).toBeGreaterThan(-1);
  const b64url = url.slice(hashIdx + 3);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function sealAnswer(payload: Record<string, unknown>, connectionId: string, clientPubkeyB64: string): Promise<string> {
  return sealEnvelopePageSide({ plaintext: JSON.stringify(payload), connectionId, clientPubkeyB64 });
}

describe('BrokerCeremonyTransport.requestEnrollment', () => {
  test('creates a device-key connection, relays the URL with the enroll fragment, and maps a real sealed success', async () => {
    const { result, getUrl } = captureRelayedUrl(() =>
      transport().requestEnrollment({ userId: 'user-1', userEmail: 'a@b.com', prfSalt: Buffer.alloc(32, 7).toString('base64') }),
    );

    // Answer as soon as the create lands (single poll queued).
    await Bun.sleep(20);
    const created = state.requests.find((r) => r.path === '/connections');
    expect(created).toBeDefined();
    const clientPubkey = (created!.body as any).client_pubkey as string;
    const sealed = await sealAnswer(
      { v: 1, flow: 'device-key', ceremony: 'enroll', ok: true, credentialId: 'cred-abc', prfOutput: Buffer.alloc(32, 9).toString('base64'), backupEligible: true, backupState: false },
      CONNECTION_ID,
      clientPubkey,
    );
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

    const outcome = await result;
    expect(outcome).toEqual({
      ok: true,
      credentialId: 'cred-abc',
      prfOutput: Buffer.alloc(32, 9).toString('base64'),
      backupEligible: true,
      backupState: false,
    });

    // purpose is the single device-key vocabulary (CAP-376/381 convention).
    expect((created!.body as any).purpose).toBe('device-key');
    expect((created!.body as any).ttl_seconds).toBe(900);

    const url = getUrl();
    expect(url).toBeDefined();
    expect(url).toContain('/flow/device-key');
    expect(url).toContain(`c=${CONNECTION_ID}`);
    const req = decodeFragmentRequest(url!);
    expect(req).toEqual({ v: 1, ceremony: 'enroll', prfSalt: Buffer.alloc(32, 7).toString('base64') });
  });

  test('a declined ceremony (real sealed failure payload) maps to the exact CeremonyFailureCode', async () => {
    const { result } = captureRelayedUrl(() =>
      transport().requestEnrollment({ userId: 'user-1', prfSalt: Buffer.alloc(32, 1).toString('base64') }),
    );
    await Bun.sleep(20);
    const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
    const sealed = await sealAnswer(
      { v: 1, flow: 'device-key', ceremony: 'enroll', ok: false, code: 'no_credential' },
      CONNECTION_ID,
      clientPubkey,
    );
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

    expect(await result).toEqual({ ok: false, code: 'no_credential' });
  });

  test('framing validation: v/flow/ceremony mismatches fail closed to transport_error before trusting the payload', async () => {
    for (const bad of [
      { v: 2, flow: 'device-key', ceremony: 'enroll', ok: true, credentialId: 'x', prfOutput: 'y', backupEligible: true, backupState: true },
      { v: 1, flow: 'auth-success', ceremony: 'enroll', ok: true, credentialId: 'x', prfOutput: 'y', backupEligible: true, backupState: true },
      { v: 1, flow: 'device-key', ceremony: 'unlock', ok: true, credentialId: 'x', prfOutput: 'y', backupEligible: true, backupState: true },
    ]) {
      state.requests.length = 0;
      const { result } = captureRelayedUrl(() =>
        transport().requestEnrollment({ userId: 'user-1', prfSalt: Buffer.alloc(32, 2).toString('base64') }),
      );
      await Bun.sleep(20);
      const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
      const sealed = await sealAnswer(bad, CONNECTION_ID, clientPubkey);
      state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });
      expect(await result).toEqual({ ok: false, code: 'transport_error' });
    }
  });

  test('an unrecognized failure code in an otherwise well-framed answer fails closed to transport_error', async () => {
    const { result } = captureRelayedUrl(() =>
      transport().requestEnrollment({ userId: 'user-1', prfSalt: Buffer.alloc(32, 3).toString('base64') }),
    );
    await Bun.sleep(20);
    const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
    const sealed = await sealAnswer({ v: 1, flow: 'device-key', ceremony: 'enroll', ok: false, code: 'some_future_code' }, CONNECTION_ID, clientPubkey);
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });
    expect(await result).toEqual({ ok: false, code: 'transport_error' });
  });

  test('a malformed success payload (missing fields) fails closed to transport_error', async () => {
    const { result } = captureRelayedUrl(() =>
      transport().requestEnrollment({ userId: 'user-1', prfSalt: Buffer.alloc(32, 4).toString('base64') }),
    );
    await Bun.sleep(20);
    const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
    const sealed = await sealAnswer({ v: 1, flow: 'device-key', ceremony: 'enroll', ok: true, credentialId: 'x' /* missing prfOutput/backup* */ }, CONNECTION_ID, clientPubkey);
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });
    expect(await result).toEqual({ ok: false, code: 'transport_error' });
  });

  test('every non-answered broker outcome collapses to transport_error, never a throw', async () => {
    state.createStatus = 500;
    const result = await transport().requestEnrollment({ userId: 'u', prfSalt: Buffer.alloc(32, 5).toString('base64') });
    expect(result).toEqual({ ok: false, code: 'transport_error' });
  });

  test('timeout (no answer before the deadline) is transport_error and best-effort cancels', async () => {
    const result = await transport({ deadlineMs: 150 }).requestEnrollment({
      userId: 'u',
      prfSalt: Buffer.alloc(32, 6).toString('base64'),
    });
    expect(result).toEqual({ ok: false, code: 'transport_error' });
    expect(state.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });
});

describe('BrokerCeremonyTransport.requestUnlock', () => {
  test('sends every candidate in the fragment and maps a real sealed unlock success', async () => {
    const candidates = [
      { credentialId: 'cred-a', prfSalt: Buffer.alloc(32, 11).toString('base64') },
      { credentialId: 'cred-b', prfSalt: Buffer.alloc(32, 12).toString('base64') },
    ];
    const { result, getUrl } = captureRelayedUrl(() => transport().requestUnlock({ userId: 'user-1', candidates }));
    await Bun.sleep(20);
    const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
    const sealed = await sealAnswer(
      { v: 1, flow: 'device-key', ceremony: 'unlock', ok: true, credentialId: 'cred-b', prfOutput: Buffer.alloc(32, 13).toString('base64') },
      CONNECTION_ID,
      clientPubkey,
    );
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

    expect(await result).toEqual({ ok: true, credentialId: 'cred-b', prfOutput: Buffer.alloc(32, 13).toString('base64') });
    const req = decodeFragmentRequest(getUrl()!);
    expect(req).toEqual({ v: 1, ceremony: 'unlock', candidates });
  });

  test('caps: more than MAX_UNLOCK_CANDIDATES throws a coded error before any network call', async () => {
    const candidates = Array.from({ length: MAX_UNLOCK_CANDIDATES + 1 }, (_, i) => ({
      credentialId: `cred-${i}`,
      prfSalt: Buffer.alloc(32, i % 255).toString('base64'),
    }));
    let thrown: unknown;
    try {
      await transport().requestUnlock({ userId: 'u', candidates });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapyError);
    expect((thrown as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_TOO_MANY_CANDIDATES);
    expect(state.requests.length).toBe(0);
  });

  test('caps: a credential id longer than MAX_CREDENTIAL_ID_LENGTH throws a coded error before any network call', async () => {
    const candidates = [{ credentialId: 'x'.repeat(MAX_CREDENTIAL_ID_LENGTH + 1), prfSalt: Buffer.alloc(32, 1).toString('base64') }];
    let thrown: unknown;
    try {
      await transport().requestUnlock({ userId: 'u', candidates });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapyError);
    expect((thrown as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_CREDENTIAL_ID_TOO_LONG);
    expect(state.requests.length).toBe(0);
  });

  test('caps: a request that fits within count/id-length caps but blows the 16 KiB fragment throws a coded error before any network call', async () => {
    // 20 candidates (under the 32 cap) with near-max credential ids (under
    // the 1400-char cap) — the aggregate JSON+base64 comfortably exceeds
    // 16 KiB, tripping only the fragment-size cap.
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      credentialId: 'c'.repeat(MAX_CREDENTIAL_ID_LENGTH - 1),
      prfSalt: Buffer.alloc(32, i).toString('base64'),
    }));
    let thrown: unknown;
    try {
      await transport().requestUnlock({ userId: 'u', candidates });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapyError);
    expect((thrown as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_FRAGMENT_TOO_LARGE);
    expect(state.requests.length).toBe(0);
  });

  test('a cancelled ceremony maps through untouched', async () => {
    const { result } = captureRelayedUrl(() =>
      transport().requestUnlock({ userId: 'u', candidates: [{ credentialId: 'c1', prfSalt: Buffer.alloc(32, 1).toString('base64') }] }),
    );
    await Bun.sleep(20);
    const clientPubkey = (state.requests[0].body as any).client_pubkey as string;
    const sealed = await sealAnswer({ v: 1, flow: 'device-key', ceremony: 'unlock', ok: false, code: 'cancelled' }, CONNECTION_ID, clientPubkey);
    state.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });
    expect(await result).toEqual({ ok: false, code: 'cancelled' });
  });
});

describe('production defaults', () => {
  test('the default ttl/deadline satisfy the Gate-2 ceremony guidance (>=900s, deadline >= ttl*1000)', async () => {
    const mod = await import('../../../src/auth/deviceKey/brokerCeremonyTransport');
    expect(mod.DEVICE_KEY_TTL_SECONDS).toBeGreaterThanOrEqual(900);
    expect(mod.DEVICE_KEY_DEADLINE_MS).toBeGreaterThanOrEqual(mod.DEVICE_KEY_TTL_SECONDS * 1000);
  });

  test('caps mirror keep-app/src/lib/flow/deviceKeyWire.ts exactly (32 / 16 KiB / 1400)', async () => {
    const mod = await import('../../../src/auth/deviceKey/brokerCeremonyTransport');
    expect(mod.MAX_UNLOCK_CANDIDATES).toBe(32);
    expect(mod.MAX_FRAGMENT_LENGTH).toBe(16_384);
    expect(mod.MAX_CREDENTIAL_ID_LENGTH).toBe(1400);
  });
});
