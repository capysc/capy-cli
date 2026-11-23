import { FlowRuntimeError } from '../errors/flowRuntimeError';
import { sign } from 'node:crypto';
import type { ConnectionKeypair } from '../service/brokerEnvelope';
import type { ExistingFilesystemCustody } from './pairing/existingFilesystemCustody';

type Data = Readonly<Record<string, unknown>>;
export interface StagingFlowCustodyInput {
  readonly serviceOrigin: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly runtimeId: string;
  readonly repoFingerprint: string;
  readonly keys: ConnectionKeypair;
  readonly accessToken: string;
}
export interface StagingFlowCustodyDependencies {
  readonly inspect: (input: Readonly<{ serviceOrigin: string; userId: string; organizationId: string }>) => Promise<ExistingFilesystemCustody>;
  readonly acknowledge: (body: Data, token: string) => Promise<Data>;
}
const refuse = (code: string): never => { throw new FlowRuntimeError(code); };
const record = (value: unknown): Data | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : null;

/** A receipt acknowledges locally verified custody; it never transmits a root or master key. */
export async function establishStagingFlowCustody(
  input: StagingFlowCustodyInput,
  dependencies: StagingFlowCustodyDependencies,
): Promise<Readonly<{ flowId: string; expiresAt: string }>> {
  const custody = await dependencies.inspect({ serviceOrigin: input.serviceOrigin, userId: input.userId, organizationId: input.organizationId });
  if (custody.kind !== 'verified' || custody.orgId !== input.organizationId) return refuse(custody.kind === 'missing' ? 'PAIR_REQUIRED' : 'CUSTODY_VERIFICATION_FAILED');
  const identity: unknown = (() => {
    try { return JSON.parse(Buffer.from(input.accessToken.split('.')[1], 'base64url').toString('utf8')); }
    catch { return null; }
  })();
  const claims = record(identity);
  if (claims?.sub !== input.userId || typeof claims.sid !== 'string' || !claims.sid) return refuse('AUTH_FLOW_SESSION_REQUIRED');
  const unsigned = { organization_id: input.organizationId, runtime_id: input.runtimeId,
    repo_fingerprint: input.repoFingerprint, client_pubkey: input.keys.publicKeyB64, service_origin: input.serviceOrigin };
  const payload = Buffer.from(`capy.staging-custody.v1\n${JSON.stringify([input.userId, claims.sid,
    unsigned.organization_id, unsigned.runtime_id, unsigned.repo_fingerprint, unsigned.client_pubkey, unsigned.service_origin])}`, 'utf8');
  const response = await dependencies.acknowledge({ ...unsigned, proof: sign('sha256', payload, input.keys.privateKey).toString('base64') }, input.accessToken);
  const binding = record(response.runtime_binding);
  if (response.stage !== 'authenticated' || response.user_id !== input.userId || typeof response.flow_id !== 'string'
    || typeof response.expires_at !== 'string' || Date.parse(response.expires_at) <= Date.now() || !Number.isFinite(Date.parse(response.expires_at))
    || binding?.v !== 1 || binding.organizationId !== input.organizationId || binding.runtimeId !== input.runtimeId
    || binding.repoFingerprint !== input.repoFingerprint || binding.clientPubkey !== input.keys.publicKeyB64 || binding.serviceOrigin !== input.serviceOrigin) return refuse('AUTH_FLOW_BINDING_MISMATCH');
  return { flowId: response.flow_id, expiresAt: response.expires_at };
}

