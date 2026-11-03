import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { loadFlowRecoveryBootstrap, openFlowRecoveryCheckpoint, saveFlowRecoveryBootstrap, sealFlowRecoveryCheckpoint, type FlowRecoveryBinding } from '../../src/ui/flowRecoveryStore';

const binding: FlowRecoveryBinding = {
  flow_id: '11111111-1111-4111-8111-111111111111',
  runtime_id: '22222222-2222-4222-8222-222222222222',
  origin: 'https://flow.fixture.test',
  owner_id: 'user-fixture',
  organization_id: 'org-fixture',
  repo_fingerprint: 'sha256:fixture',
  client_pubkey: mintConnectionKeypair().publicKeyB64,
};

describe('Flow recovery checkpoint encryption', () => {
  test('keeps journal content opaque and binds it to the exact flow identity', () => {
    const root = Buffer.alloc(32, 7);
    const checkpoint = { journal: [{ id: 'message-1', data: { summary: 'private repository finding' } }], agent_state: { application_id: 'application-1' } } as const;
    const envelope = sealFlowRecoveryCheckpoint(root, binding, checkpoint);

    expect(envelope).not.toContain('private repository finding');
    expect(openFlowRecoveryCheckpoint(root, binding, envelope)).toEqual(checkpoint);
    expect(openFlowRecoveryCheckpoint(Buffer.alloc(32, 8), binding, envelope)).toBeNull();
    expect(openFlowRecoveryCheckpoint(root, { ...binding, repo_fingerprint: 'sha256:other' }, envelope)).toBeNull();
  });

  test('stores the connection private key only in the encrypted local bootstrap', () => {
    const root = Buffer.alloc(32, 7);
    const keys = mintConnectionKeypair();
    const keyBinding = { ...binding, client_pubkey: keys.publicKeyB64 };
    const directory = mkdtempSync(join(tmpdir(), 'capy-flow-recovery-'));
    const path = join(directory, 'flow.enc');
    try {
      saveFlowRecoveryBootstrap(root, keyBinding, keys, path);
      const encoded = readFileSync(path, 'utf8');
      const restored = loadFlowRecoveryBootstrap(root, {
        flow_id: keyBinding.flow_id, origin: keyBinding.origin, owner_id: keyBinding.owner_id,
        organization_id: keyBinding.organization_id, repo_fingerprint: keyBinding.repo_fingerprint,
      }, path);
      expect(encoded).not.toContain(keys.publicKeyB64);
      expect(restored?.binding).toEqual(keyBinding);
      expect(restored?.keys.publicKeyB64).toBe(keys.publicKeyB64);
      expect(loadFlowRecoveryBootstrap(root, { ...binding, owner_id: 'other-user' }, path)).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
