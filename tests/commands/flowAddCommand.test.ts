import { describe, expect, mock, test } from 'bun:test';
import { executeFlowAdd, type IntakeCheckpoint, type IntakeDependencies, type IntakeView } from '../../src/commands/flowAddCommand';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';

const FLOW = 'c41107c9-5646-4bb6-8f90-694ca5c3d836';
const options = { expectedUserId: 'user_test', serviceOrigin: 'https://service.example.test' };
const view: IntakeView = { flow_id: FLOW, onboarding_flow_id: 'c41107c9-5646-4bb6-8f90-694ca5c3d837',
  user_id: options.expectedUserId, runtime_id: 'runtime', repo_fingerprint: 'repo',
  target: { org_id: 'org_test', project_id: 'project', project_name: 'default', branch: 'development', sync_mode: 'free' },
  variable_names: ['API_KEY'], stage: 'intake_pending', expires_at: '2099-01-01T00:00:00Z', next_action: 'intake',
  decision_id: 'decision', create_env_approved: true, local_state_digest: 'local', base_keep_hash: 'remote-before',
  handoff: null, receipt_id: null };

function harness(change: Partial<IntakeView> = {}, prior: IntakeCheckpoint | null = null) {
  const current = { ...view, ...change };
  const connection = { connectionId: 'c41107c9-5646-4bb6-8f90-694ca5c3d838', expiresAt: view.expires_at, keypair: mintConnectionKeypair() };
  const deps = {
    runtimeId: 'runtime', fingerprint: 'repo', now: () => Date.parse('2026-09-06T00:00:00Z'),
    view: mock(async () => current),
    report: mock(async (body: Readonly<Record<string, unknown>>): Promise<IntakeView> => body.action === 'complete'
      ? { ...current, next_action: 'done', receipt_id: body.receipt_id as string } : current),
    read: mock(() => prior), save: mock((_state: IntakeCheckpoint) => undefined),
    observe: mock(async () => ({ env_exists: false, existing_variable_names: [], local_state_digest: 'local', keep_lock: null })),
    localDigest: mock(() => 'local'), create: mock(async () => connection),
    url: (id: string) => `https://keep.example.test/flow/secret-intake?c=${id}`,
    poll: mock<IntakeDependencies['poll']>(async () => ({ kind: 'pending' })),
    send: mock<IntakeDependencies['send']>(async () => ({ kind: 'sent' })),
    apply: mock<IntakeDependencies['apply']>(async () => ({ remoteKeepHash: 'remote-after', localDigest: 'local' })),
  } satisfies IntakeDependencies;
  return { deps, connection };
}
async function prepared() {
  const first = harness();
  const result = await executeFlowAdd(FLOW, options, first.deps);
  return { ...first, result, state: first.deps.save.mock.calls[0]![0] };
}
async function answered(vars: readonly { readonly name: string; readonly value: string }[] = [{ name: 'API_KEY', value: 'disposable-fixture-secret' }]) {
  const first = await prepared();
  const ciphertextB64 = await sealEnvelopePageSide({ plaintext: JSON.stringify({ v: 1, vars }),
    connectionId: first.connection.connectionId, clientPubkeyB64: first.connection.keypair.publicKeyB64 });
  const resumed = harness({ handoff: first.state.handoff }, first.state);
  resumed.deps.poll.mockResolvedValue({ kind: 'answered', ciphertextB64 });
  return { ...first, resumed, ciphertextB64 };
}

describe('Keep-owned bounded secret intake', () => {
  test('remote overwrite names are display-only and never mislabeled as local observations', async () => {
    const { deps } = harness({ next_action: 'observe' });
    const observe = async () => ({ env_exists: false, existing_variable_names: [], overwrite_variable_names: ['API_KEY'], local_state_digest: 'local', keep_lock: null });
    await executeFlowAdd(FLOW, options, { ...deps, observe });
    expect(deps.report.mock.calls[0]![0]).toEqual({ action: 'observe', runtime_id: 'runtime', repo_fingerprint: 'repo',
      env_exists: false, existing_variable_names: [], local_state_digest: 'local', keep_lock: null });
    const intake = harness();
    await executeFlowAdd(FLOW, options, { ...intake.deps, observe });
    expect(intake.deps.save.mock.calls[0]![0].request.reason).toContain('API_KEY already exist(s). Overwrite?');
  });
  test('explicit preapply cancellation returns terminal acknowledgement without continuation', async () => {
    const { state } = await prepared();
    const { deps } = harness({ handoff: state.handoff }, state);
    deps.report.mockResolvedValue({ ...view, next_action: 'cancelled' });
    expect(await executeFlowAdd(FLOW, { ...options, cancel: true }, deps)).toEqual({ ok: true, flow_id: FLOW, stage: 'cancelled' });
    expect(deps.report.mock.calls[0]![0]).toMatchObject({ action: 'cancel', connection_id: state.handoff.connection_id });
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.poll).not.toHaveBeenCalled();
  });
  test('cancellation cannot disguise interrupted or applied operation', async () => {
    const { state } = await prepared();
    for (const prior of [{ ...state, applying: true as const }, { ...state, applied: { remoteKeepHash: 'hash', localDigest: 'local' } }]) {
      const { deps } = harness({ handoff: state.handoff }, prior);
      await expect(executeFlowAdd(FLOW, { ...options, cancel: true }, deps)).rejects.toThrow('INTAKE_CANCEL_TOO_LATE');
      expect(deps.report).not.toHaveBeenCalled();
    }
  });
  test('observation and create-env approval return without minting requests or writing files', async () => {
    for (const next_action of ['observe', 'approve_create_env'] as const) {
      const { deps } = harness({ next_action, create_env_approved: false });
      expect(await executeFlowAdd(FLOW, options, deps)).toMatchObject({ continuation: { tool: 'capy_add', args: { flow_id: FLOW } } });
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
      expect(deps.report.mock.calls.some(([body]) => body.action === 'approve_create_env')).toBe(false);
    }
  });
  test('first call checkpoints private handle before publishing a fixed-name link and exits', async () => {
    const { deps, state, result } = await prepared();
    expect(state.connection?.privateKeyB64).toBeTruthy();
    expect(state.request).toMatchObject({ readonlyNames: true, vars: [{ name: 'API_KEY' }] });
    expect(deps.save.mock.invocationCallOrder[0]!).toBeLessThan(deps.report.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ handoff: state.handoff, continuation: { tool: 'capy_add', args: { flow_id: FLOW } } });
    expect(JSON.stringify(result)).not.toContain(state.connection!.privateKeyB64);
    expect(deps.poll).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('attached browser receives one frozen request; later pending call does not resend', async () => {
    const { state } = await prepared();
    const { deps } = harness({ handoff: state.handoff }, state);
    deps.poll.mockResolvedValue({ kind: 'pending', pagePubkeyB64: 'pagekey' });
    await executeFlowAdd(FLOW, options, deps);
    expect(deps.poll).toHaveBeenCalledTimes(1);
    expect(deps.poll.mock.calls[0]![1]).toBe(0);
    expect(deps.send.mock.calls[0]!.slice(1)).toEqual(['pagekey', JSON.stringify(state.request)]);
    const saved = deps.save.mock.calls[0]![0];
    expect(saved.requestSent).toBe(true);
    const later = harness({ handoff: state.handoff }, saved);
    later.deps.poll.mockResolvedValue({ kind: 'pending', pagePubkeyB64: 'pagekey' });
    await executeFlowAdd(FLOW, options, later.deps);
    expect(later.deps.poll).toHaveBeenCalledTimes(1);
    expect(later.deps.poll.mock.calls[0]![1]).toBe(20);
    expect(later.deps.send).not.toHaveBeenCalled();
  });
  test('unattached page gets one immediate read per invocation, not an internal polling loop', async () => {
    const { state } = await prepared();
    const { deps } = harness({ handoff: state.handoff }, state);
    expect(await executeFlowAdd(FLOW, options, deps)).toMatchObject({ stage: 'intake_pending', handoff: state.handoff });
    expect(deps.poll).toHaveBeenCalledTimes(1);
    expect(deps.poll.mock.calls[0]![1]).toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
  test('raw answer is saved first, then service intent, one canonical apply, receipt and completion', async () => {
    const { resumed: { deps }, ciphertextB64 } = await answered();
    expect(await executeFlowAdd(FLOW, options, deps)).toMatchObject({ stage: 'done' });
    expect(deps.save.mock.calls[0]![0].answerCiphertext).toBe(ciphertextB64);
    expect(deps.save.mock.invocationCallOrder[0]!).toBeLessThan(deps.report.mock.invocationCallOrder[0]!);
    expect(deps.report.mock.calls.map(([body]) => body.action)).toEqual(['applying', 'complete']);
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.apply).toHaveBeenCalledWith([{ name: 'API_KEY', value: 'disposable-fixture-secret' }], 'remote-before', 'local');
    const saved = deps.save.mock.calls.at(-1)![0];
    expect(saved.completed).toBe(true);
    expect(saved.connection).toBeUndefined();
    expect(saved.answerCiphertext).toBeUndefined();
    expect(JSON.stringify(deps.save.mock.calls)).not.toContain('disposable-fixture-secret');
    expect(JSON.stringify(deps.report.mock.calls)).not.toContain('disposable-fixture-secret');
  });
  test('saved encrypted answer survives consumed broker state without another poll', async () => {
    const { state, ciphertextB64 } = await answered();
    const { deps } = harness({ handoff: state.handoff }, { ...state, answerCiphertext: ciphertextB64 });
    await executeFlowAdd(FLOW, options, deps);
    expect(deps.poll).not.toHaveBeenCalled();
    expect(deps.apply).toHaveBeenCalledTimes(1);
  });
  test('delivered local receipt retries only completion, never secret mutation', async () => {
    const { resumed: { deps } } = await answered();
    deps.report.mockImplementation(async (body) => {
      if (body.action === 'complete') throw new Error('offline');
      return { ...view, handoff: deps.read()!.handoff };
    });
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('offline');
    const applied = deps.save.mock.calls.at(-1)![0];
    const retry = harness({ handoff: applied.handoff }, applied);
    await executeFlowAdd(FLOW, options, retry.deps);
    expect(retry.deps.poll).not.toHaveBeenCalled();
    expect(retry.deps.apply).not.toHaveBeenCalled();
    expect(retry.deps.report.mock.calls[0]![0]).toMatchObject({ action: 'complete', receipt_id: applied.receiptId });
  });
  test.each([[{ name: 'OTHER', value: 'x' }], [{ name: 'API_KEY', value: 'x' }, { name: 'API_KEY', value: 'y' }], []].map((vars) => ({ vars })))('changed or duplicate names cannot write: %j', async ({ vars }) => {
    const { resumed: { deps } } = await answered(vars);
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('INTAKE_NAMES_CHANGED');
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });
  test('consumed answer without local receipt fails with a fresh-request action', async () => {
    const { state } = await prepared();
    const { deps } = harness({ handoff: state.handoff }, state);
    deps.poll.mockResolvedValue({ kind: 'consumed' });
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('INTAKE_ANSWER_LOST');
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('ambiguous crash cannot repeat application even if local files changed', async () => {
    const { state, ciphertextB64 } = await answered();
    const { deps } = harness({ handoff: state.handoff }, { ...state, answerCiphertext: ciphertextB64, applying: true });
    deps.localDigest.mockReturnValue('partially-written');
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('INTAKE_APPLY_INTERRUPTED');
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test.each(['user_id', 'repo_fingerprint', 'runtime_id'] as const)('wrong %s refuses before local/network writes', async (field) => {
    const { deps } = harness({ [field]: 'wrong' });
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('INTAKE_BINDING_MISMATCH');
    expect(deps.report).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });
  test('corrupt request, changed consent and missing checkpoint are never silently replaced', async () => {
    const { state } = await prepared();
    const corrupt = harness({ handoff: state.handoff }, { ...state, request: { ...state.request, readonlyNames: false } });
    await expect(executeFlowAdd(FLOW, options, corrupt.deps)).rejects.toThrow('INTAKE_CHECKPOINT_INVALID');
    const consent = harness({ handoff: state.handoff, decision_id: 'other' }, state);
    await expect(executeFlowAdd(FLOW, options, consent.deps)).rejects.toThrow('INTAKE_CONSENT_CHANGED');
    const missing = harness({ handoff: state.handoff });
    await expect(executeFlowAdd(FLOW, options, missing.deps)).rejects.toThrow('INTAKE_CHECKPOINT_MISSING');
    expect(missing.deps.create).not.toHaveBeenCalled();
  });
  test('service refusal before apply performs no secret write', async () => {
    const { resumed: { deps } } = await answered();
    deps.report.mockRejectedValue(new Error('ADD_REMOTE_CHANGED'));
    await expect(executeFlowAdd(FLOW, options, deps)).rejects.toThrow('ADD_REMOTE_CHANGED');
    expect(deps.apply).not.toHaveBeenCalled();
  });
});
