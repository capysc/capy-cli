import { randomUUID, sign } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { verifyFlowAgentChallenge } from '../../src/commands/flowAgentCommand';

describe('Flow attachment runtime authentication', () => {
  test('requires possession of the service-bound runtime key before disclosing a token', () => {
    const runtime = mintConnectionKeypair();
    const impostor = mintConnectionKeypair();
    const flowId = randomUUID();
    const nonce = randomUUID();
    const payload = Buffer.from(`capy.flow.agent.v1\n${flowId}\n${nonce}`);
    const response = { v: 1, flow_id: flowId, nonce, signature: sign('sha256', payload, runtime.privateKey).toString('base64') };
    expect(verifyFlowAgentChallenge(runtime.publicKeyB64, flowId, nonce, response)).toBe(true);
    expect(verifyFlowAgentChallenge(runtime.publicKeyB64, flowId, nonce, {
      ...response, signature: sign('sha256', payload, impostor.privateKey).toString('base64'),
    })).toBe(false);
    expect(verifyFlowAgentChallenge(runtime.publicKeyB64, randomUUID(), nonce, response)).toBe(false);
    expect(verifyFlowAgentChallenge(runtime.publicKeyB64, flowId, randomUUID(), response)).toBe(false);
    expect(verifyFlowAgentChallenge('malformed', flowId, nonce, response)).toBe(false);
  });
});
