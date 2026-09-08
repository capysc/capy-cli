import { describe, expect, mock, test } from 'bun:test';
import { executeFlowReadiness, type FlowReadinessOptions } from '../../src/commands/flowReadinessCommand';
import { PairExecutorError } from '../../src/commands/flowPairCommand';

const options: FlowReadinessOptions = {
  flowId: '11111111-1111-4111-8111-111111111111',
  authenticationFlowId: '22222222-2222-4222-8222-222222222222',
  expectedUserId: 'user_test', serviceOrigin: 'https://service.invalid', runtimeOnly: true, continuationTool: 'capy_pair',
};
const handoff = { attemptId: '33333333-3333-4333-8333-333333333333', deviceCodeHash: 'a'.repeat(64),
  url: 'https://auth.invalid/device', userCode: 'ABCD-EFGH', expiresAt: '2099-01-01T00:00:00.000Z' };

describe('instrumented readiness', () => {
  test('returns authentication pending without attempting key pairing or exposing private state', async () => {
    const result = await executeFlowReadiness(options, {
      authenticate: async () => ({ ok: true as const, flow_id: options.authenticationFlowId, stage: 'approval_pending' as const,
        handoff, continuation: { tool: 'capy_authenticate' as const, args: { flow_id: options.authenticationFlowId, handoff } } }),
      pair: async () => { throw new PairExecutorError('PAIR_AUTHENTICATION_REQUIRED'); },
    });
    expect(result.stage).toBe('approval_pending');
    expect(result.continuation).toEqual({ tool: 'capy_pair', args: { flow_id: options.flowId, authentication_handoff: handoff } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  test('reuses an already authenticated pairing executor result without starting another authentication flow', async () => {
    const result = await executeFlowReadiness({ ...options, continuationTool: 'capy_onboard', runtimeOnly: false }, {
      authenticate: async () => { throw new Error('existing readiness must not start authentication'); },
      pair: async () => ({ ok: true as const, flow_id: options.flowId, stage: 'pairing_pending' as const,
        handoff: { connection_id: '33333333-3333-4333-8333-333333333333', url: 'https://keep.invalid/flow/device-key', expires_at: handoff.expiresAt },
        continuation: { tool: 'capy_onboard' as const, args: { flow_id: options.flowId } } }),
    });
    expect(result.stage).toBe('pairing_pending');
    expect(result.continuation).toEqual({ tool: 'capy_onboard', args: { flow_id: options.flowId } });
  });

  test('authentication completion enters pairing and never reports authentication alone as ready', async () => {
    const pair = mock(async () => { throw new PairExecutorError('PAIR_AUTHENTICATION_REQUIRED'); });
    pair.mockImplementationOnce(async () => { throw new PairExecutorError('PAIR_AUTHENTICATION_REQUIRED'); });
    pair.mockImplementationOnce(async () => ({ ok: true as const, flow_id: options.flowId, stage: 'pairing_pending' as const,
      handoff: { connection_id: handoff.attemptId, url: 'https://keep.invalid/flow/device-key', expires_at: handoff.expiresAt },
      continuation: { tool: 'capy_pair' as const, args: { flow_id: options.flowId } } }));
    const result = await executeFlowReadiness(options, {
      authenticate: async () => ({ ok: true as const, flow_id: options.authenticationFlowId, stage: 'authenticated' as const,
        user_id: options.expectedUserId, continuation: { tool: 'capy_authenticate' as const, args: { flow_id: options.authenticationFlowId } } }),
      pair,
    });
    expect(result.stage).toBe('pairing_pending');
    expect(pair).toHaveBeenCalledTimes(2);
  });

  test('invalid correlation and transient pairing failure never fall through to authentication', async () => {
    const authenticate = mock(async () => ({ ok: true as const, flow_id: options.authenticationFlowId, stage: 'authenticated' as const,
      user_id: options.expectedUserId, continuation: { tool: 'capy_authenticate' as const, args: { flow_id: options.authenticationFlowId } } }));
    const pair = mock(async () => { throw new PairExecutorError('PAIR_AUTH_NETWORK_UNAVAILABLE'); });
    await expect(executeFlowReadiness(options, { authenticate, pair })).rejects.toThrow('PAIR_AUTH_NETWORK_UNAVAILABLE');
    expect(authenticate).not.toHaveBeenCalled();
    await expect(executeFlowReadiness({ ...options, flowId: 'not-a-uuid' }, { authenticate, pair })).rejects.toThrow('READINESS_ARGUMENT_INVALID');
    expect(authenticate).not.toHaveBeenCalled();
    expect(pair).toHaveBeenCalledTimes(1);
  });
});
