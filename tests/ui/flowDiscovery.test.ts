import { expect, test } from 'bun:test';
import { selectOpenRecoveryFlow } from '../../src/ui/flowDiscovery';
const binding = { flow_id: 'flow', owner_id: 'user', runtime_id: 'runtime', repo_fingerprint: 'repo', client_pubkey: 'key' } as const;
const history = { flow_id: 'flow', owner: 'user', runtime_id: 'runtime', repo_fingerprint: 'repo', client_pubkey: 'key', state: 'active', cli_attached: false } as const;

test('discovery exposes open detached work but not completed or abandoned flows', () => {
  expect(selectOpenRecoveryFlow(history, binding)).toMatchObject({ flow_id: 'flow', cli_attached: false });
  expect(selectOpenRecoveryFlow({ ...history, state: 'done' }, binding)).toBeNull();
  expect(selectOpenRecoveryFlow({ ...history, state: 'cancelled' }, binding)).toBeNull();
});
test('discovery rejects changed user, repository or runtime identity', () => {
  for (const changed of [{ owner: 'other' }, { repo_fingerprint: 'other' }, { runtime_id: 'other' }, { client_pubkey: 'other' }]) {
    expect(() => selectOpenRecoveryFlow({ ...history, ...changed }, binding)).toThrow('CONVERSATION_BINDING_MISMATCH');
  }
});
test('a live flow is reported as attached rather than silently replaced', () => {
  expect(selectOpenRecoveryFlow({ ...history, cli_attached: true }, binding)?.cli_attached).toBe(true);
});
