import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalCapyDir } from '../config/globalConfig';
import { exportConnectionPrivateKeyB64, importConnectionKeypair, type ConnectionKeypair } from '../service/brokerEnvelope';

type Json = Readonly<Record<string, unknown>>;

export type FlowRecoveryBinding = Readonly<{
  readonly flow_id: string;
  readonly runtime_id: string;
  readonly origin: string;
  readonly owner_id: string;
  readonly organization_id: string;
  readonly repo_fingerprint: string;
  readonly client_pubkey: string;
}>;

export type FlowRecoveryBootstrap = Readonly<{
  readonly binding: FlowRecoveryBinding;
  readonly keys: ConnectionKeypair;
}>;

type EncryptedRecord = Readonly<{ readonly v: 1; readonly iv: string; readonly ct: string }>;

const RECORD_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(',')}}`
  : JSON.stringify(value);
const record = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const bootstrapAad = (binding: Readonly<Pick<FlowRecoveryBinding, 'flow_id' | 'origin' | 'owner_id' | 'organization_id' | 'repo_fingerprint'>>): Buffer => Buffer.from(canonical({
  flow_id: binding.flow_id,
  origin: binding.origin,
  owner_id: binding.owner_id,
  organization_id: binding.organization_id,
  repo_fingerprint: binding.repo_fingerprint,
}));
const checkpointAad = (binding: FlowRecoveryBinding): Buffer => Buffer.from(canonical(binding));
const derive = (root: Buffer, purpose: 'bootstrap' | 'checkpoint'): Buffer => Buffer.from(hkdfSync(
  'sha256', root, Buffer.alloc(0), Buffer.from(`capy.flow.recovery.v${RECORD_VERSION}|${purpose}`), 32,
));
const encrypt = (key: Buffer, aad: Buffer, value: Json): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(Buffer.from(canonical(value))), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({ v: RECORD_VERSION, iv: iv.toString('base64'), ct: ct.toString('base64') } satisfies EncryptedRecord)).toString('base64');
};
const parseEncrypted = (value: string): EncryptedRecord | null => {
  try {
    const parsed = record(JSON.parse(Buffer.from(value, 'base64').toString('utf8')));
    const iv = string(parsed?.iv);
    const ct = string(parsed?.ct);
    return parsed?.v === RECORD_VERSION && iv !== null && ct !== null && BASE64.test(iv) && BASE64.test(ct)
      && Buffer.from(iv, 'base64').length === IV_BYTES && Buffer.from(ct, 'base64').length > TAG_BYTES
      ? { v: RECORD_VERSION, iv, ct }
      : null;
  } catch { return null; }
};
const decrypt = (key: Buffer, aad: Buffer, value: string): Json | null => {
  const encrypted = parseEncrypted(value);
  if (!encrypted) return null;
  try {
    const ct = Buffer.from(encrypted.ct, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return record(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]).toString('utf8')));
  } catch { return null; }
};
const sameBinding = (left: FlowRecoveryBinding, right: FlowRecoveryBinding): boolean => canonical(left) === canonical(right);
const bootstrapPath = (organizationId: string, userId: string, flowId: string): string => join(getGlobalCapyDir(), 'orgs', organizationId, 'users', userId, 'flows', `${flowId}.enc`);
const bootstrapDirectory = (organizationId: string, userId: string): string => join(getGlobalCapyDir(), 'orgs', organizationId, 'users', userId, 'flows');
const writePrivate = (path: string, content: string): void => {
  const directory = join(path, '..');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
};
const read = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); }
  catch { return null; }
};
const bootstrapValue = (binding: FlowRecoveryBinding, keys: ConnectionKeypair): Json => ({
  v: RECORD_VERSION,
  binding,
  private_key: exportConnectionPrivateKeyB64(keys),
});
const parseBootstrap = (value: Json, expected: Readonly<Pick<FlowRecoveryBinding, 'flow_id' | 'origin' | 'owner_id' | 'organization_id' | 'repo_fingerprint'>>): FlowRecoveryBootstrap | null => {
  const binding = record(value.binding);
  const privateKey = string(value.private_key);
  const candidate = binding === null ? null : {
    flow_id: string(binding.flow_id), runtime_id: string(binding.runtime_id), origin: string(binding.origin), owner_id: string(binding.owner_id),
    organization_id: string(binding.organization_id), repo_fingerprint: string(binding.repo_fingerprint), client_pubkey: string(binding.client_pubkey),
  };
  if (!candidate || Object.values(candidate).some(field => field === null) || !privateKey) return null;
  const resolved = candidate as FlowRecoveryBinding;
  const matches = resolved.flow_id === expected.flow_id && resolved.origin === expected.origin && resolved.owner_id === expected.owner_id
    && resolved.organization_id === expected.organization_id && resolved.repo_fingerprint === expected.repo_fingerprint;
  if (!matches) return null;
  try { return { binding: resolved, keys: importConnectionKeypair(resolved.client_pubkey, privateKey) }; }
  catch { return null; }
};

/** Persists only an AEAD ciphertext; the local root is never copied into this record. */
export const saveFlowRecoveryBootstrap = (root: Buffer, binding: FlowRecoveryBinding, keys: ConnectionKeypair, path = bootstrapPath(binding.organization_id, binding.owner_id, binding.flow_id)): void => {
  const encrypted = encrypt(derive(root, 'bootstrap'), bootstrapAad(binding), bootstrapValue(binding, keys));
  writePrivate(path, encrypted);
};

/** Refuses any local record whose authenticated identity, origin, or repository differs. */
export const loadFlowRecoveryBootstrap = (
  root: Buffer,
  expected: Readonly<Pick<FlowRecoveryBinding, 'flow_id' | 'origin' | 'owner_id' | 'organization_id' | 'repo_fingerprint'>>,
  path = bootstrapPath(expected.organization_id, expected.owner_id, expected.flow_id),
): FlowRecoveryBootstrap | null => {
  const encrypted = read(path);
  return encrypted === null ? null : parseBootstrap(decrypt(derive(root, 'bootstrap'), bootstrapAad(expected), encrypted) ?? {}, expected);
};

/** Lists only records that authenticate to this exact account, origin, and repository. */
export const findFlowRecoveryBootstraps = (
  root: Buffer,
  expected: Readonly<Pick<FlowRecoveryBinding, 'origin' | 'owner_id' | 'organization_id' | 'repo_fingerprint'>>,
): readonly FlowRecoveryBootstrap[] => {
  const names = (() => {
    try { return readdirSync(bootstrapDirectory(expected.organization_id, expected.owner_id)); }
    catch { return []; }
  })();
  return names.filter(name => name.endsWith('.enc')).flatMap(name => {
    const flowId = name.slice(0, -4);
    const loaded = loadFlowRecoveryBootstrap(root, { ...expected, flow_id: flowId });
    return loaded === null ? [] : [loaded];
  });
};

/** Opaque state for the service checkpoint. The server stores the returned ciphertext unchanged. */
export const sealFlowRecoveryCheckpoint = (root: Buffer, binding: FlowRecoveryBinding, checkpoint: Json): string =>
  encrypt(derive(root, 'checkpoint'), checkpointAad(binding), { v: RECORD_VERSION, binding, checkpoint });

/** Opens an opaque checkpoint only under the exact same local root and flow binding. */
export const openFlowRecoveryCheckpoint = (root: Buffer, binding: FlowRecoveryBinding, envelope: string): Json | null => {
  const opened = decrypt(derive(root, 'checkpoint'), checkpointAad(binding), envelope);
  const storedBinding = record(opened?.binding);
  const checkpoint = record(opened?.checkpoint);
  const parsedBinding = storedBinding === null ? null : {
    flow_id: string(storedBinding.flow_id), runtime_id: string(storedBinding.runtime_id), origin: string(storedBinding.origin), owner_id: string(storedBinding.owner_id),
    organization_id: string(storedBinding.organization_id), repo_fingerprint: string(storedBinding.repo_fingerprint), client_pubkey: string(storedBinding.client_pubkey),
  };
  return opened?.v === RECORD_VERSION && checkpoint !== null && parsedBinding !== null && Object.values(parsedBinding).every(field => field !== null)
    && sameBinding(parsedBinding as FlowRecoveryBinding, binding) ? checkpoint : null;
};
