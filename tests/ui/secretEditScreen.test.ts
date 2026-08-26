/**
 * `capy edit --web`'s keep-hosted transport (CAP-540) against a stub broker,
 * mirroring secretIntakeKeepScreen.test.ts's harness pattern extended to
 * THREE chained connections (unlock/values/result — see secretEditWire.ts's
 * module doc for why a single connection cannot carry this exchange).
 *
 * The load-bearing assertions: (1) a courier that does NOT unwrap the
 * named wrapper (wrong credential/PRF) is refused BEFORE any value is
 * sealed — proving the CLI-side verification gate actually gates; (2) a
 * stale `keep_hash` at save time is refused (`stale_version`) without
 * writing; (3) the plaintext secret value never appears on stdout, however
 * the CLI's own progress/URL lines are written.
 *
 * ISOLATED (global.fetch swap): register in run-tests.sh alongside
 * secretIntakeKeepScreen.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';

import { runSecretEditViaKeep, PASSPHRASE_CREDENTIAL_ID, type EditSessionOps } from '../../src/ui/secretEditScreen';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal } from '../../src/auth/deviceKey/crypto';
import { deriveEditSessionKey, openEditValue } from '../../src/service/editSessionCrypto';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../src/service/serviceClient';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const TOKEN = 'org-scoped-test-token';
const USER_ID = 'user-1';
const CREDENTIAL_ID = 'cred-abc';
const realFetch = globalThis.fetch;

interface ConnState {
  createBody: Record<string, unknown>;
  requestCiphertext: string | null;
  answerCiphertext: string | null;
  pagePubkeyB64: string | null;
}

let conns: Map<string, ConnState>;
let creationOrder: string[];
let counter: number;

function makeWrapper(prfOutput: Buffer, prfSalt: Buffer): KeyWrapperPayload {
  const kek = deriveDeviceKeyKek(prfOutput, prfSalt);
  const kLocal = randomBytes(32);
  const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, CREDENTIAL_ID));
  return {
    id: 'wrapper-1',
    type: 'wrapped_k_local',
    credential_id: CREDENTIAL_ID,
    kdf_version: 1,
    is_seed: true,
    verified_at: new Date().toISOString(),
    organization_id: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
    mirror_state: 'mirrored',
    wrapped_k_local: wrapped.wrappedKLocal,
    iv: wrapped.iv,
    prf_salt: prfSalt.toString('base64'),
  };
}

function fakeOps(wrapper: KeyWrapperPayload): EditSessionOps {
  const metadata: KeyWrapperMetadata = {
    id: wrapper.id,
    type: wrapper.type,
    credential_id: wrapper.credential_id,
    kdf_version: wrapper.kdf_version,
    is_seed: wrapper.is_seed,
    verified_at: wrapper.verified_at,
    organization_id: wrapper.organization_id,
    created_at: wrapper.created_at,
    deleted_at: wrapper.deleted_at,
    mirror_state: wrapper.mirror_state,
  };
  return {
    listWrappers: async () => [metadata],
    fetchWrapper: async () => wrapper,
  };
}

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const path = url.slice(SVC.length);
  const body: Record<string, unknown> | null = init?.body ? JSON.parse(String(init.body)) : null;

  if (path === '/connections' && init?.method === 'POST') {
    const id = `conn-${(counter += 1)}`;
    creationOrder.push(id);
    conns.set(id, { createBody: body ?? {}, requestCiphertext: null, answerCiphertext: null, pagePubkeyB64: null });
    return Response.json(
      { connection_id: id, status: 'pending', expires_at: new Date(Date.now() + 900_000).toISOString() },
      { status: 201 },
    );
  }

  const m = path.match(/^\/connections\/([^/?]+)(\/[a-z]+)?/);
  if (!m) return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
  const id = m[1];
  const rest = m[2] ?? '';
  const state = conns.get(id);
  if (!state) return Response.json({ error: 'unknown', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });

  if (rest === '/result') {
    if (state.answerCiphertext) {
      const ciphertext = state.answerCiphertext;
      state.answerCiphertext = null;
      return Response.json({ status: 'answered', ciphertext, page_pubkey: state.pagePubkeyB64 });
    }
    return Response.json({ status: state.pagePubkeyB64 ? 'attached' : 'pending', page_pubkey: state.pagePubkeyB64 });
  }
  if (rest === '/request' && init?.method === 'POST') {
    state.requestCiphertext = body?.ciphertext as string;
    return Response.json({ status: 'sent' });
  }
  if (rest === '' && init?.method === 'DELETE') {
    return Response.json({ status: 'cancelled' });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

beforeEach(() => {
  conns = new Map();
  creationOrder = [];
  counter = 0;
  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(SVC)) return serviceFetch(u, init);
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Poll until `pred()` is true or the deadline passes. */
async function waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe('runSecretEditViaKeep', () => {
  test('unlock -> sealed_values -> save -> CAS-verified write, never printing the plaintext', async () => {
    const prfOutput = randomBytes(32);
    const prfSalt = randomBytes(32);
    const wrapper = makeWrapper(prfOutput, prfSalt);
    const secretValue = 'sk_test_CAP540_SENTINEL_never_print';

    const applied: Array<{ edits: Record<string, string>; expectedKeepHash: string }> = [];

    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      stdoutChunks.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };

    const outcomePromise = runSecretEditViaKeep({
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      userId: USER_ID,
      projectName: 'proj',
      branchName: 'main',
      vars: [{ name: 'API_KEY', value: secretValue }],
      keepHash: 'hash-v1',
      ops: fakeOps(wrapper),
      applyEdits: async (edits, expectedKeepHash) => {
        applied.push({ edits, expectedKeepHash });
        return { ok: true, keepHash: 'hash-v2' };
      },
      deadlineMs: 10_000,
    });

    try {
      // 3 connections created: [unlock, values, result], in program order.
      await waitUntil(() => creationOrder.length === 3);
      const [unlockId, valuesId, resultId] = creationOrder;

      // --- unlock leg ---
      const unlockPage = await mintPageKeypairPageSide();
      conns.get(unlockId)!.pagePubkeyB64 = unlockPage.pagePubkeyB64;
      await waitUntil(() => conns.get(unlockId)!.requestCiphertext !== null);

      const unlockRequest = JSON.parse(
        await openRequestEnvelopePageSide({
          ciphertextB64: conns.get(unlockId)!.requestCiphertext!,
          connectionId: unlockId,
          clientPubkeyB64: conns.get(unlockId)!.createBody.client_pubkey as string,
          pagePrivateKey: unlockPage.privateKey,
        }),
      );
      expect(unlockRequest.kind).toBe('edit_request');
      expect(unlockRequest.vars).toEqual([{ name: 'API_KEY', state: 'locked' }]);
      expect(unlockRequest.prf).toEqual({ credential_id: CREDENTIAL_ID, prf_salt: prfSalt.toString('base64') });
      expect(unlockRequest.values_connection_id).toBe(valuesId);
      expect(unlockRequest.result_connection_id).toBe(resultId);

      conns.get(unlockId)!.answerCiphertext = await sealEnvelopePageSide({
        plaintext: JSON.stringify({
          kind: 'prf_courier',
          v: 1,
          prf_output: prfOutput.toString('base64'),
          credential_id: CREDENTIAL_ID,
        }),
        connectionId: unlockId,
        clientPubkeyB64: conns.get(unlockId)!.createBody.client_pubkey as string,
      });

      // --- values leg ---
      const valuesPage = await mintPageKeypairPageSide();
      conns.get(valuesId)!.pagePubkeyB64 = valuesPage.pagePubkeyB64;
      await waitUntil(() => conns.get(valuesId)!.requestCiphertext !== null);

      const sealedValues = JSON.parse(
        await openRequestEnvelopePageSide({
          ciphertextB64: conns.get(valuesId)!.requestCiphertext!,
          connectionId: valuesId,
          clientPubkeyB64: conns.get(valuesId)!.createBody.client_pubkey as string,
          pagePrivateKey: valuesPage.privateKey,
        }),
      );
      expect(sealedValues.kind).toBe('sealed_values');

      const sessionKey = deriveEditSessionKey(prfOutput, unlockId);
      const opened = openEditValue(sessionKey, sealedValues.values[0]);
      expect(opened).toBe(secretValue);

      // Edit it, then seal + answer with `save`.
      const editedValue = `${secretValue}-EDITED`;
      const { sealEditValue } = await import('../../src/service/editSessionCrypto');
      const sealedEdit = sealEditValue(sessionKey, editedValue);
      conns.get(valuesId)!.answerCiphertext = await sealEnvelopePageSide({
        plaintext: JSON.stringify({
          kind: 'save',
          v: 1,
          edits: [{ name: 'API_KEY', iv: sealedEdit.iv, ct: sealedEdit.ct }],
          keep_hash: 'hash-v1',
        }),
        connectionId: valuesId,
        clientPubkeyB64: conns.get(valuesId)!.createBody.client_pubkey as string,
      });

      // --- result leg ---
      const resultPage = await mintPageKeypairPageSide();
      conns.get(resultId)!.pagePubkeyB64 = resultPage.pagePubkeyB64;
      await waitUntil(() => conns.get(resultId)!.requestCiphertext !== null);

      const result = JSON.parse(
        await openRequestEnvelopePageSide({
          ciphertextB64: conns.get(resultId)!.requestCiphertext!,
          connectionId: resultId,
          clientPubkeyB64: conns.get(resultId)!.createBody.client_pubkey as string,
          pagePrivateKey: resultPage.privateKey,
        }),
      );
      expect(result).toEqual({ kind: 'save', v: 1, ok: true, keep_hash: 'hash-v2' });
    } finally {
      const outcome = await outcomePromise;
      process.stdout.write = originalWrite;
      expect(outcome).toEqual({ kind: 'saved' });
    }

    expect(applied).toEqual([{ edits: { API_KEY: `${secretValue}-EDITED` }, expectedKeepHash: 'hash-v1' }]);

    const allStdout = stdoutChunks.join('');
    expect(allStdout).not.toContain(secretValue);
  });

  test('a courier that does not unwrap the named wrapper is refused before any value is sealed (passkey door: bad_session)', async () => {
    // CREDENTIAL_ID ('cred-abc') is not the passphrase sentinel, so this
    // wrapper is a passkey door — a failed unwrap here is coded
    // `bad_session`, not `wrong_passphrase` (that copy is passphrase-only).
    const prfSalt = randomBytes(32);
    const realPrfOutput = randomBytes(32);
    const wrapper = makeWrapper(realPrfOutput, prfSalt);
    const wrongPrfOutput = randomBytes(32); // does NOT unwrap `wrapper`

    let sealedAnyValues = false;

    const outcomePromise = runSecretEditViaKeep({
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      userId: USER_ID,
      projectName: 'proj',
      branchName: 'main',
      vars: [{ name: 'API_KEY', value: 'irrelevant' }],
      keepHash: 'hash-v1',
      ops: fakeOps(wrapper),
      applyEdits: async () => ({ ok: true, keepHash: 'hash-v2' }),
      deadlineMs: 10_000,
    });

    await waitUntil(() => creationOrder.length === 3);
    const [unlockId, valuesId] = creationOrder;

    const unlockPage = await mintPageKeypairPageSide();
    conns.get(unlockId)!.pagePubkeyB64 = unlockPage.pagePubkeyB64;
    await waitUntil(() => conns.get(unlockId)!.requestCiphertext !== null);

    conns.get(unlockId)!.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({
        kind: 'prf_courier',
        v: 1,
        prf_output: wrongPrfOutput.toString('base64'),
        credential_id: CREDENTIAL_ID,
      }),
      connectionId: unlockId,
      clientPubkeyB64: conns.get(unlockId)!.createBody.client_pubkey as string,
    });

    const valuesPage = await mintPageKeypairPageSide();
    conns.get(valuesId)!.pagePubkeyB64 = valuesPage.pagePubkeyB64;
    await waitUntil(() => conns.get(valuesId)!.requestCiphertext !== null);

    const valuesMessage = JSON.parse(
      await openRequestEnvelopePageSide({
        ciphertextB64: conns.get(valuesId)!.requestCiphertext!,
        connectionId: valuesId,
        clientPubkeyB64: conns.get(valuesId)!.createBody.client_pubkey as string,
        pagePrivateKey: valuesPage.privateKey,
      }),
    );
    sealedAnyValues = valuesMessage.kind === 'sealed_values';
    expect(valuesMessage).toEqual({ kind: 'error', v: 1, code: 'bad_session' });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'declined', code: 'bad_session' });
    expect(sealedAnyValues).toBe(false);
  });

  test('a courier that does not unwrap the named wrapper is refused before any value is sealed (passphrase door: wrong_passphrase)', async () => {
    // Same refusal, but the offered credential IS the passphrase sentinel —
    // the screen's passphrase-specific copy is correct here, so the coded
    // error stays `wrong_passphrase`.
    const prfSalt = randomBytes(32);
    const realPrfOutput = randomBytes(32);
    const kek = deriveDeviceKeyKek(realPrfOutput, prfSalt);
    const kLocal = randomBytes(32);
    const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, PASSPHRASE_CREDENTIAL_ID));
    const wrapper: KeyWrapperPayload = {
      id: 'wrapper-1',
      type: 'wrapped_k_local',
      credential_id: PASSPHRASE_CREDENTIAL_ID,
      kdf_version: 1,
      is_seed: true,
      verified_at: new Date().toISOString(),
      organization_id: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'mirrored',
      wrapped_k_local: wrapped.wrappedKLocal,
      iv: wrapped.iv,
      prf_salt: prfSalt.toString('base64'),
    };
    const wrongPrfOutput = randomBytes(32); // does NOT unwrap `wrapper`

    let sealedAnyValues = false;

    const outcomePromise = runSecretEditViaKeep({
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      userId: USER_ID,
      projectName: 'proj',
      branchName: 'main',
      vars: [{ name: 'API_KEY', value: 'irrelevant' }],
      keepHash: 'hash-v1',
      ops: fakeOps(wrapper),
      applyEdits: async () => ({ ok: true, keepHash: 'hash-v2' }),
      deadlineMs: 10_000,
    });

    await waitUntil(() => creationOrder.length === 3);
    const [unlockId, valuesId] = creationOrder;

    const unlockPage = await mintPageKeypairPageSide();
    conns.get(unlockId)!.pagePubkeyB64 = unlockPage.pagePubkeyB64;
    await waitUntil(() => conns.get(unlockId)!.requestCiphertext !== null);

    conns.get(unlockId)!.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({
        kind: 'prf_courier',
        v: 1,
        prf_output: wrongPrfOutput.toString('base64'),
        credential_id: PASSPHRASE_CREDENTIAL_ID,
      }),
      connectionId: unlockId,
      clientPubkeyB64: conns.get(unlockId)!.createBody.client_pubkey as string,
    });

    const valuesPage = await mintPageKeypairPageSide();
    conns.get(valuesId)!.pagePubkeyB64 = valuesPage.pagePubkeyB64;
    await waitUntil(() => conns.get(valuesId)!.requestCiphertext !== null);

    const valuesMessage = JSON.parse(
      await openRequestEnvelopePageSide({
        ciphertextB64: conns.get(valuesId)!.requestCiphertext!,
        connectionId: valuesId,
        clientPubkeyB64: conns.get(valuesId)!.createBody.client_pubkey as string,
        pagePrivateKey: valuesPage.privateKey,
      }),
    );
    sealedAnyValues = valuesMessage.kind === 'sealed_values';
    expect(valuesMessage).toEqual({ kind: 'error', v: 1, code: 'wrong_passphrase' });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'declined', code: 'wrong_passphrase' });
    expect(sealedAnyValues).toBe(false);
  });

  test('no live device-key wrapper: unavailable, no connections created', async () => {
    const outcome = await runSecretEditViaKeep({
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      userId: USER_ID,
      projectName: 'proj',
      branchName: 'main',
      vars: [{ name: 'API_KEY', value: 'x' }],
      keepHash: 'hash-v1',
      ops: { listWrappers: async () => [], fetchWrapper: async () => { throw new Error('unused'); } },
      applyEdits: async () => ({ ok: true, keepHash: 'hash-v2' }),
    });

    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(creationOrder).toHaveLength(0);
  });

  test('a stale keep_hash at save time is refused without writing', async () => {
    const prfOutput = randomBytes(32);
    const prfSalt = randomBytes(32);
    const wrapper = makeWrapper(prfOutput, prfSalt);
    let applyCalled = false;

    const outcomePromise = runSecretEditViaKeep({
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      userId: USER_ID,
      projectName: 'proj',
      branchName: 'main',
      vars: [{ name: 'API_KEY', value: 'orig' }],
      keepHash: 'hash-v1',
      ops: fakeOps(wrapper),
      applyEdits: async () => {
        applyCalled = true;
        return { ok: false, code: 'stale_version' };
      },
      deadlineMs: 10_000,
    });

    await waitUntil(() => creationOrder.length === 3);
    const [unlockId, valuesId, resultId] = creationOrder;

    const unlockPage = await mintPageKeypairPageSide();
    conns.get(unlockId)!.pagePubkeyB64 = unlockPage.pagePubkeyB64;
    await waitUntil(() => conns.get(unlockId)!.requestCiphertext !== null);
    conns.get(unlockId)!.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({
        kind: 'prf_courier',
        v: 1,
        prf_output: prfOutput.toString('base64'),
        credential_id: CREDENTIAL_ID,
      }),
      connectionId: unlockId,
      clientPubkeyB64: conns.get(unlockId)!.createBody.client_pubkey as string,
    });

    const valuesPage = await mintPageKeypairPageSide();
    conns.get(valuesId)!.pagePubkeyB64 = valuesPage.pagePubkeyB64;
    await waitUntil(() => conns.get(valuesId)!.requestCiphertext !== null);
    const sessionKey = deriveEditSessionKey(prfOutput, unlockId);
    const { sealEditValue } = await import('../../src/service/editSessionCrypto');
    const sealedEdit = sealEditValue(sessionKey, 'new-value');
    conns.get(valuesId)!.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({
        kind: 'save',
        v: 1,
        edits: [{ name: 'API_KEY', iv: sealedEdit.iv, ct: sealedEdit.ct }],
        keep_hash: 'stale-hash',
      }),
      connectionId: valuesId,
      clientPubkeyB64: conns.get(valuesId)!.createBody.client_pubkey as string,
    });

    const resultPage = await mintPageKeypairPageSide();
    conns.get(resultId)!.pagePubkeyB64 = resultPage.pagePubkeyB64;
    await waitUntil(() => conns.get(resultId)!.requestCiphertext !== null);
    const result = JSON.parse(
      await openRequestEnvelopePageSide({
        ciphertextB64: conns.get(resultId)!.requestCiphertext!,
        connectionId: resultId,
        clientPubkeyB64: conns.get(resultId)!.createBody.client_pubkey as string,
        pagePrivateKey: resultPage.privateKey,
      }),
    );
    expect(result).toEqual({ kind: 'error', v: 1, code: 'stale_version' });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'declined', code: 'stale_version' });
    expect(applyCalled).toBe(true);
  });
});
