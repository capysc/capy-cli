import { describe, expect, mock, test } from 'bun:test';
import { executeFlowPair, requirePairSilentAuthentication, type PairCheckpoint, type PairExecutorDependencies, type PairRuntimeView } from '../../src/commands/flowPairCommand';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal, DEVICE_KEY_KDF_VERSION } from '../../src/auth/deviceKey/crypto';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../src/service/serviceClient';

const flowId = '11111111-1111-4111-8111-111111111111';
const runtimeId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const options = { expectedUserId: 'user_test', serviceOrigin: 'https://service.invalid' } as const;
const now = Date.parse('2026-09-06T15:00:00Z');
const credentialId = 'credential_test';
const key = Buffer.alloc(32, 7);
const prf = Buffer.alloc(32, 4);
const salt = Buffer.alloc(32, 9);
const metadata: KeyWrapperMetadata = { id: 'door-test', type: 'wrapped_k_local', credential_id: credentialId,
  kdf_version: DEVICE_KEY_KDF_VERSION, is_seed: true, verified_at: new Date(now).toISOString(),
  organization_id: null, created_at: new Date(now).toISOString(), deleted_at: null, mirror_state: 'pending' };
const wrapped = wrapKLocal(key, deriveDeviceKeyKek(prf, salt, DEVICE_KEY_KDF_VERSION), deviceKeyWrapAAD(options.expectedUserId, credentialId));
const payload: KeyWrapperPayload = { ...metadata, wrapped_k_local: wrapped.wrappedKLocal, iv: wrapped.iv, prf_salt: salt.toString('base64') };
const answer = { v: 1, flow: 'device-key', ceremony: 'grant', custody: 'filesystem', ok: true, credentialId, prfOutput: prf.toString('base64') };

function harness(initial: PairCheckpoint | null = null) {
  const save = mock((_state: PairCheckpoint) => undefined);
  const read = () => save.mock.calls.at(-1)?.[0] ?? initial;
  const view: PairRuntimeView = { flow_id: flowId, user_id: options.expectedUserId, custody_org_id: 'org_custody',
    phase: 'pairing', runtime_id: null, repo_fingerprint: null, receipt_id: null };
  const report = mock(async (body: Parameters<PairExecutorDependencies['report']>[0]): Promise<PairRuntimeView> => {
    if (body.action === 'handoff') expect(read()?.connection?.privateKeyB64).toBeTruthy();
    if (body.action === 'complete') {
      expect(read()?.installed).toBe(true);
      return { ...view, phase: 'paired', runtime_id: body.runtime_id, repo_fingerprint: body.repo_fingerprint, receipt_id: body.receipt_id };
    }
    return { ...view, runtime_id: body.runtime_id, repo_fingerprint: body.repo_fingerprint };
  });
  const persist = mock(async (material: { readonly kLocal: Buffer }, orgId: string) => {
    expect(material.kLocal).toEqual(key);
    expect(orgId).toBe('org_custody');
    expect(read()?.answer?.prfOutput).toBe(prf.toString('base64'));
  });
  const createConnection = mock(async () => ({ connectionId, expiresAt: new Date(now + 900000).toISOString(), keypair: mintConnectionKeypair() }));
  const poll = mock(async (_connection: Parameters<PairExecutorDependencies['poll']>[0]) => ({ kind: 'answered' as const, plaintext: JSON.stringify(answer) }));
  const deps: PairExecutorDependencies = { now: () => now, repositoryFingerprint: 'repo-fingerprint', runtimeId: () => runtimeId,
    read, save, view: async () => view, report,
    wrappers: { listWrappers: async () => [metadata], fetchWrapper: async () => payload },
    createConnection, poll, persist,
    existingCredential: async () => persist.mock.calls.length || initial?.installed ? credentialId : null,
    keepOrigin: 'https://keep.invalid',
  };
  return { deps, save, read, report, persist, createConnection, poll, view };
}

describe('noninteractive Keep-owned runtime pairing executor', () => {
  test.each([
    [{ success: false, error_code: 'no_session' }, 'PAIR_AUTHENTICATION_REQUIRED'],
    [{ success: false, error_code: 'session_ended' }, 'PAIR_AUTHENTICATION_REQUIRED'],
    [{ success: false, error_code: 'network' }, 'PAIR_AUTH_NETWORK_UNAVAILABLE'],
    [{ success: false, error_code: 'server_error' }, 'PAIR_AUTH_SERVICE_UNAVAILABLE'],
    [{ success: false }, 'PAIR_AUTH_SERVICE_UNAVAILABLE'],
    [{ success: false, error_code: 'org_not_found' }, 'PAIR_SIGNUP_REQUIRED'],
    [{ success: true, user_id: 'user_other' }, 'PAIR_ACCOUNT_MISMATCH'],
  ] as const)('classifies silent auth %j without starting a new device sign-in', (result, code) => {
    expect(() => requirePairSilentAuthentication(result, options.expectedUserId)).toThrow(code);
  });
  test('an unsupported runtime authentication code fails closed', () => {
    expect(() => {
      // @ts-expect-error Deliberately invalid provider data tests the runtime rejection boundary.
      requirePairSilentAuthentication({ success: false, error_code: 'unrecognized_failure' }, options.expectedUserId);
    }).toThrow('PAIR_AUTH_SERVICE_UNAVAILABLE');
  });
  test('checkpoints private connection before returning its public handoff and exits without polling', async () => {
    const h = harness();
    const result = await executeFlowPair(flowId, options, h.deps);
    expect(result.stage).toBe('pairing_pending');
    expect(result.continuation).toEqual({ tool: 'capy_onboard', args: { flow_id: flowId } });
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    const state = h.read()!;
    expect(state.handoff.url).toStartWith('https://keep.invalid/flow/device-key?c=');
    expect(JSON.parse(Buffer.from(new URL(state.handoff.url).hash.slice(3), 'base64url').toString('utf8')))
      .toMatchObject({ v: 1, ceremony: 'grant', custody: 'filesystem' });
    expect(JSON.stringify(result)).not.toContain(state.connection!.privateKeyB64);
    expect(JSON.stringify(result)).not.toContain(prf.toString('base64'));
    expect(JSON.stringify(result)).not.toContain(key.toString('base64'));
  });

  test('new invocation resumes same connection and real grant crypto before authenticated completion', async () => {
    const first = harness();
    await executeFlowPair(flowId, options, first.deps);
    const next = harness(first.read());
    const result = await executeFlowPair(flowId, options, next.deps);
    expect(result.stage).toBe('paired');
    expect(next.createConnection).not.toHaveBeenCalled();
    expect(next.poll.mock.calls[0]?.[0].connectionId).toBe(connectionId);
    expect(next.persist).toHaveBeenCalledTimes(1);
    expect(next.read()?.completed).toBe(true);
    expect(next.read()?.connection).toBeUndefined();
    expect(next.read()?.answer).toBeUndefined();
    expect(JSON.stringify(next.read())).not.toContain(prf.toString('base64'));
  });

  test('bounded pending retains connection without creating or cancelling a ceremony', async () => {
    const first = harness(); await executeFlowPair(flowId, options, first.deps);
    const next = harness(first.read());
    const result = await executeFlowPair(flowId, options, { ...next.deps, poll: async () => ({ kind: 'pending' }) });
    expect(result.stage).toBe('pairing_pending');
    expect(next.createConnection).not.toHaveBeenCalled();
    expect(next.persist).not.toHaveBeenCalled();
    expect(next.read()).toEqual(first.read());
  });

  test('delivered receipt retries installation without consuming the answer again', async () => {
    const first = harness(); await executeFlowPair(flowId, options, first.deps);
    const next = harness({ ...first.read()!, answer: { ok: true, credentialId, prfOutput: prf.toString('base64'), custody: 'filesystem' } });
    const result = await executeFlowPair(flowId, options, next.deps);
    expect(result.stage).toBe('paired');
    expect(next.poll).not.toHaveBeenCalled();
  });

  test('interrupted completion retries the same receipt without installing or touching passkey again', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    await executeFlowPair(flowId, options, h.deps);
    const installed = { ...h.read()!, completed: undefined };
    const next = harness(installed);
    await executeFlowPair(flowId, options, next.deps);
    expect(next.persist).not.toHaveBeenCalled();
    expect(next.poll).not.toHaveBeenCalled();
    expect(next.report.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'complete', receipt_id: installed.receiptId });
  });

  test('missing local custody cannot replay an old completion receipt', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps); await executeFlowPair(flowId, options, h.deps);
    await expect(executeFlowPair(flowId, options, { ...h.deps, existingCredential: async () => null })).rejects.toThrow('PAIR_LOCAL_CUSTODY_MISSING');
  });

  test('changed repository, user, and service origin are refused before service writes', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    for (const change of [{ repositoryFingerprint: 'other' }, { userId: 'user_other' }, { serviceOrigin: 'https://other.invalid' }]) {
      const next = harness({ ...h.read()!, ...change });
      await expect(executeFlowPair(flowId, options, next.deps)).rejects.toThrow('PAIR_CHECKPOINT_MISMATCH');
      expect(next.report).not.toHaveBeenCalled();
    }
  });

  test('service authentication/readiness refusal produces no connection or key install', async () => {
    const h = harness();
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      view: async () => ({ ...h.view, phase: 'authentication' }) })).rejects.toThrow('PAIR_AUTHENTICATION_REQUIRED');
    expect(h.report).not.toHaveBeenCalled();
    expect(h.createConnection).not.toHaveBeenCalled();
  });

  test('checkpoint failure prevents exposing or registering its public link', async () => {
    const h = harness();
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      save: () => { throw new Error('private checkpoint unavailable'); },
    })).rejects.toThrow('private checkpoint unavailable');
    expect(h.report.mock.calls.some(([body]) => body.action === 'handoff')).toBe(false);
    expect(h.persist).not.toHaveBeenCalled();
  });

  test('installation failure keeps the delivered answer for retry and never reports complete', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      persist: async () => { throw new Error('storage unavailable'); },
    })).rejects.toThrow('storage unavailable');
    expect(h.read()?.answer?.credentialId).toBe(credentialId);
    expect(h.read()?.installed).toBeUndefined();
    expect(h.report.mock.calls.some(([body]) => body.action === 'complete')).toBe(false);
  });

  test('completion acknowledgement mismatch preserves installed receipt and refuses success', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    await expect(executeFlowPair(flowId, options, { ...h.deps, report: async () => h.view })).rejects.toThrow('PAIR_COMPLETION_NOT_ACKNOWLEDGED');
    expect(h.read()?.installed).toBe(true);
    expect(h.read()?.completed).toBeUndefined();
  });

  test.each([
    ['flow', { flow_id: connectionId }],
    ['custody organization', { custody_org_id: 'org_foreign' }],
  ] as const)('foreign completion acknowledgement %s preserves the installed receipt', async (_field, override) => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      report: async (body) => ({
        ...h.view,
        phase: body.action === 'complete' ? 'paired' : 'pairing',
        runtime_id: body.runtime_id,
        repo_fingerprint: body.repo_fingerprint,
        receipt_id: body.action === 'complete' ? body.receipt_id : null,
        ...(body.action === 'complete' ? override : {}),
      }),
    })).rejects.toThrow('PAIR_COMPLETION_NOT_ACKNOWLEDGED');
    expect(h.read()?.installed).toBe(true);
    expect(h.read()?.completed).toBeUndefined();
  });

  test('different attached runtime and unproven existing pairing fail closed', async () => {
    const h = harness();
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      view: async () => ({ ...h.view, runtime_id: connectionId }) })).rejects.toThrow('PAIR_RUNTIME_MISMATCH');
    await expect(executeFlowPair(flowId, options, { ...h.deps,
      existingCredential: async () => credentialId })).rejects.toThrow('PAIR_EXISTING_REQUIRES_PROOF');
    expect(h.createConnection).not.toHaveBeenCalled();
  });

  test('consumed-without-receipt and expired connection are explicit failures, never success', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    await expect(executeFlowPair(flowId, options, { ...h.deps, poll: async () => ({ kind: 'consumed' }) })).rejects.toThrow('PAIR_ANSWER_LOST_RESTART_REQUIRED');
    await expect(executeFlowPair(flowId, options, { ...h.deps, now: () => now + 900001 })).rejects.toThrow('PAIR_CEREMONY_EXPIRED');
    expect(h.persist).not.toHaveBeenCalled();
  });

  test('malformed or rejected browser answer never reaches key installation', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    for (const body of [{ ...answer, prfOutput: 'bad' }, { ...answer, flow: 'other' }, { ...answer, ok: false, code: 'cancelled' }]) {
      await expect(executeFlowPair(flowId, options, { ...h.deps,
        poll: async () => ({ kind: 'answered', plaintext: JSON.stringify(body) }) })).rejects.toThrow();
    }
    expect(h.persist).not.toHaveBeenCalled();
  });
  test('missing or altered sealed custody acknowledgement never installs durable material', async () => {
    const h = harness(); await executeFlowPair(flowId, options, h.deps);
    for (const custody of [undefined, 'memory']) {
      await expect(executeFlowPair(flowId, options, { ...h.deps,
        poll: async () => ({ kind: 'answered', plaintext: JSON.stringify({ ...answer, custody }) }) }))
        .rejects.toThrow('PAIR_CUSTODY_APPROVAL_REQUIRED');
    }
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.report.mock.calls.some(([body]) => body.action === 'complete')).toBe(false);
  });
});
