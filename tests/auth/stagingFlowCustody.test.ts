import { expect, mock, test } from 'bun:test';
import { randomUUID, verify } from 'node:crypto';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { establishStagingFlowCustody, type StagingFlowCustodyInput } from '../../src/auth/stagingFlowCustody';

const session = randomUUID();
const input: StagingFlowCustodyInput = { serviceOrigin: 'https://staging-api.invalid', userId: 'user_synthetic',
  organizationId: 'org_synthetic', runtimeId: randomUUID(), repoFingerprint: `sha256:${'a'.repeat(64)}`,
  keys: mintConnectionKeypair(), accessToken: `synthetic.${Buffer.from(JSON.stringify({ sub: 'user_synthetic', sid: session })).toString('base64url')}.synthetic` };
const receipt = { flow_id: randomUUID(), user_id: input.userId, stage: 'authenticated', expires_at: new Date(Date.now() + 60000).toISOString(),
  runtime_binding: { v: 1, organizationId: input.organizationId, runtimeId: input.runtimeId, repoFingerprint: input.repoFingerprint,
    clientPubkey: input.keys.publicKeyB64, serviceOrigin: input.serviceOrigin } } as const;
const inspect = async () => ({ kind: 'verified', orgId: input.organizationId }) as const;

test('acknowledges verified custody with a signature bound to the token session and exact target', async () => {
  const acknowledge = mock(async () => receipt);
  expect(await establishStagingFlowCustody(input, { inspect, acknowledge })).toEqual({ flowId: receipt.flow_id, expiresAt: receipt.expires_at });
  const [body, token] = acknowledge.mock.calls[0] as unknown as readonly [Readonly<Record<string, unknown>>, string];
  expect(token).toBe(input.accessToken);
  expect(Object.keys(body).toSorted()).toEqual(['organization_id', 'runtime_id', 'repo_fingerprint', 'client_pubkey', 'service_origin', 'proof'].toSorted());
  const payload = Buffer.from(`capy.staging-custody.v1\n${JSON.stringify([input.userId, session, input.organizationId,
    input.runtimeId, input.repoFingerprint, input.keys.publicKeyB64, input.serviceOrigin])}`, 'utf8');
  expect(verify('sha256', payload, input.keys.privateKey, Buffer.from(String(body.proof), 'base64'))).toBe(true);
});

test('missing, invalid or different-organization custody never reaches the service', async () => {
  for (const custody of [{ kind: 'missing' }, { kind: 'invalid' }, { kind: 'verified', orgId: 'org_other' }] as const) {
    const acknowledge = mock(async () => receipt);
    await expect(establishStagingFlowCustody(input, { inspect: async () => custody, acknowledge })).rejects.toThrow();
    expect(acknowledge).not.toHaveBeenCalled();
  }
});

test('refuses another identity, missing session, expired receipt or changed target without a downgrade', async () => {
  const acknowledge = mock(async () => receipt);
  for (const claims of [{ sub: 'user_other', sid: session }, { sub: input.userId }]) {
    const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
    await expect(establishStagingFlowCustody({ ...input, accessToken: token }, { inspect, acknowledge })).rejects.toThrow('AUTH_FLOW_SESSION_REQUIRED');
  }
  expect(acknowledge).not.toHaveBeenCalled();
  for (const response of [{ ...receipt, expires_at: 'invalid' }, { ...receipt, expires_at: new Date(0).toISOString() },
    { ...receipt, runtime_binding: { ...receipt.runtime_binding, organizationId: 'org_other' } },
    { ...receipt, runtime_binding: { ...receipt.runtime_binding, clientPubkey: mintConnectionKeypair().publicKeyB64 } }]) {
    await expect(establishStagingFlowCustody(input, { inspect, acknowledge: async () => response })).rejects.toThrow('AUTH_FLOW_BINDING_MISMATCH');
  }
});
