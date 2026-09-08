/** Keep/service owns onboarding; this executor performs only typed local pairing work. */
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { hostname } from 'os';
import { AuthService } from '../auth/authService';
import type { AuthResult } from '../types/index';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { getGlobalCapyDir } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { ServiceClient, type KeyWrapperMetadata, type KeyWrapperPayload } from '../service/serviceClient';
import { BrokerClient, type BrokerConnection, type PollAnswerResult } from '../service/brokerClient';
import { exportConnectionPrivateKeyB64, importConnectionKeypair } from '../service/brokerEnvelope';
import { runGrantCeremony, type GrantedKeyMaterial, type GrantOps } from '../auth/deviceKey/grant';
import { createDeviceKeyServiceOps } from '../auth/deviceKey/serviceOps';
import { isWellFormedPrfOutput } from '../auth/deviceKey/crypto';
import type { GrantSuccess, CeremonyTransport } from '../auth/deviceKey/ceremonyTransport';
import { keepOrigin } from '../ui/screens/keepScreens';
import { acquirePairAttemptLease, releasePairAttemptLease } from '../auth/pairing/pairAttemptLease';
import { assertRuntimePairingUser, readRuntimePairing, recoverFilesystemRuntimePairingWhileLeaseHeld,
  registerFilesystemRuntimePairing } from '../auth/pairing/runtimePairing';
import { runtimePairingEnvironment } from '../auth/pairing/runtimePairingEnvironment';
import { spawnGrantDaemon } from '../auth/deviceKey/grantHolder';

export interface FlowPairOptions {
  readonly expectedUserId: string;
  readonly serviceOrigin: string;
  readonly json?: boolean;
  /** Runtime-only pairing deliberately binds to the durable runtime id, never a repository. */
  readonly runtimeOnly?: boolean;
}
export interface PairRuntimeView {
  readonly flow_id: string;
  readonly user_id: string;
  readonly custody_org_id: string;
  readonly phase: 'authentication' | 'pairing' | 'paired';
  readonly runtime_id: string | null;
  readonly repo_fingerprint: string | null;
  readonly receipt_id: string | null;
}
interface PairPublicHandoff {
  readonly connection_id: string;
  readonly url: string;
  readonly expires_at: string;
}
interface GrantSnapshot {
  readonly rows: readonly KeyWrapperMetadata[];
  readonly payloads: readonly { readonly id: string; readonly payload: KeyWrapperPayload }[];
}
type FilesystemGrantSuccess = GrantSuccess & { readonly custody: 'filesystem' };
export interface PairCheckpoint {
  readonly version: 1;
  readonly flowId: string;
  readonly userId: string;
  readonly serviceOrigin: string;
  readonly repositoryFingerprint: string;
  readonly runtimeId: string;
  readonly custodyOrgId: string;
  readonly receiptId: string;
  readonly handoff: PairPublicHandoff;
  readonly connection?: { readonly publicKeyB64: string; readonly privateKeyB64: string };
  readonly snapshot?: GrantSnapshot;
  readonly answer?: FilesystemGrantSuccess;
  readonly credentialId?: string;
  readonly installed?: true;
  readonly completed?: true;
}
type PairReport = { readonly action: 'attach'; readonly runtime_id: string; readonly repo_fingerprint: string }
  | { readonly action: 'reuse'; readonly runtime_id: string; readonly repo_fingerprint: string;
      readonly source_flow_id: string; readonly receipt_id: string }
  | { readonly action: 'handoff'; readonly runtime_id: string; readonly repo_fingerprint: string;
      readonly connection_id: string; readonly url: string }
  | { readonly action: 'complete'; readonly runtime_id: string; readonly repo_fingerprint: string;
      readonly connection_id: string; readonly credential_id: string; readonly receipt_id: string };
export interface PairExecutorDependencies {
  readonly now: () => number;
  readonly repositoryFingerprint: string;
  readonly runtimeId: () => string;
  readonly read: () => PairCheckpoint | null;
  readonly save: (state: PairCheckpoint) => void;
  readonly view: () => Promise<PairRuntimeView>;
  readonly report: (body: PairReport) => Promise<PairRuntimeView>;
  readonly wrappers: GrantOps;
  readonly createConnection: () => Promise<BrokerConnection>;
  readonly poll: (connection: BrokerConnection) => Promise<PollAnswerResult>;
  readonly persist: (material: GrantedKeyMaterial, orgId: string) => Promise<void>;
  readonly existingCredential: () => Promise<string | null>;
  readonly keepOrigin: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PairExecutorError extends Error { constructor(readonly code: string) { super(code); } }
const reject = (code: string): never => { throw new PairExecutorError(code); };
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function validateArguments(flowId: string, options: FlowPairOptions): void {
  if (!UUID.test(flowId) || !/^user_[A-Za-z0-9]+$/.test(options.expectedUserId)) reject('PAIR_ARGUMENT_INVALID');
  const origin = new URL(options.serviceOrigin);
  const devHttp = origin.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.hostname.endsWith('.ts.net'));
  if (origin.origin !== options.serviceOrigin || (origin.protocol !== 'https:' && !devHttp)) reject('PAIR_ENVIRONMENT_MISMATCH');
}

/** Only a missing/ended local session can be repaired by the readiness authenticator. */
export function requirePairSilentAuthentication(result: AuthResult, expectedUserId: string): void {
  if (result.success) {
    if (result.user_id !== expectedUserId) return reject('PAIR_ACCOUNT_MISMATCH');
    return;
  }
  if (['no_session', 'session_ended'].includes(result.error_code ?? '')) return reject('PAIR_AUTHENTICATION_REQUIRED');
  if (result.error_code === 'org_not_found') return reject('PAIR_SIGNUP_REQUIRED');
  if (result.error_code === 'network') return reject('PAIR_AUTH_NETWORK_UNAVAILABLE');
  if (result.error_code === 'server_error') return reject('PAIR_AUTH_SERVICE_UNAVAILABLE');
  return reject('PAIR_AUTH_SERVICE_UNAVAILABLE');
}

function pending(state: PairCheckpoint) {
  return { ok: true, flow_id: state.flowId, stage: 'pairing_pending', handoff: state.handoff,
    continuation: { tool: 'capy_onboard', args: { flow_id: state.flowId } } } as const;
}
function paired(state: PairCheckpoint) {
  return { ok: true, flow_id: state.flowId, stage: 'paired',
    message: 'This machine is connected to Capy.',
    continuation: { tool: 'capy_onboard', args: { flow_id: state.flowId } } } as const;
}
function validateView(view: PairRuntimeView, flowId: string, userId: string): void {
  if (view.flow_id !== flowId || view.user_id !== userId) reject('PAIR_ACCOUNT_MISMATCH');
  if (view.phase === 'authentication') reject('PAIR_AUTHENTICATION_REQUIRED');
  if (!view.custody_org_id || !['pairing', 'paired'].includes(view.phase)) reject('PAIR_SERVICE_RESPONSE_INVALID');
}
async function snapshotGrant(ops: GrantOps): Promise<GrantSnapshot> {
  const rows = (await ops.listWrappers()).filter((row) => row.type === 'wrapped_k_local' && !row.deleted_at);
  if (!rows.length || rows.length > 32) return reject('PAIR_DEVICE_KEYS_UNAVAILABLE');
  const payloads = await rows.reduce<Promise<GrantSnapshot['payloads']>>(async (previous, row) => {
    const collected = await previous;
    return [...collected, { id: row.id, payload: await ops.fetchWrapper(row.id) }];
  }, Promise.resolve([]));
  return { rows, payloads };
}
function snapshotOps(snapshot: GrantSnapshot): GrantOps {
  return { listWrappers: async () => [...snapshot.rows], fetchWrapper: async (id) =>
    snapshot.payloads.find((item) => item.id === id)?.payload ?? reject('PAIR_CHECKPOINT_INVALID') };
}
async function grantCandidates(userId: string, snapshot: GrantSnapshot): Promise<readonly { readonly credentialId: string; readonly prfSalt: string }[]> {
  // Reuse the ordinary grant's wrapper validation and candidate construction.
  class Candidates extends Error { constructor(readonly candidates: readonly { readonly credentialId: string; readonly prfSalt: string }[]) { super('candidates'); } }
  const ceremony: CeremonyTransport = {
    requestEnrollment: async () => reject('PAIR_CEREMONY_INVALID'), requestUnlock: async () => reject('PAIR_CEREMONY_INVALID'),
    requestGrant: async (request) => { throw new Candidates(request.candidates); },
  };
  try { await runGrantCeremony({ userId, ceremony, ops: snapshotOps(snapshot) }); }
  catch (error) { if (error instanceof Candidates) return error.candidates; throw error; }
  return reject('PAIR_CEREMONY_INVALID');
}
function parseAnswer(plaintext: string): FilesystemGrantSuccess {
  const body = JSON.parse(plaintext) as Record<string, unknown>;
  if (body.v !== 1 || body.flow !== 'device-key' || body.ceremony !== 'grant') return reject('PAIR_ANSWER_INVALID');
  if (body.ok === false) return reject(body.code === 'cancelled' ? 'PAIR_APPROVAL_CANCELLED' : 'PAIR_APPROVAL_FAILED');
  if (body.custody !== 'filesystem') return reject('PAIR_CUSTODY_APPROVAL_REQUIRED');
  if (body.ok !== true || typeof body.credentialId !== 'string' || typeof body.prfOutput !== 'string'
    || !isWellFormedPrfOutput(body.prfOutput)) return reject('PAIR_ANSWER_INVALID');
  return { ok: true, credentialId: body.credentialId, prfOutput: body.prfOutput, custody: 'filesystem' };
}

async function finishPairing(state: PairCheckpoint, deps: PairExecutorDependencies): Promise<ReturnType<typeof paired>> {
  const installed = await (async (): Promise<PairCheckpoint> => {
    if (state.installed) {
      if (await deps.existingCredential() !== state.credentialId) return reject('PAIR_LOCAL_CUSTODY_MISSING');
      return state;
    }
    if (!state.answer || !state.snapshot) return reject('PAIR_CHECKPOINT_INVALID');
    if (state.answer.custody !== 'filesystem') return reject('PAIR_CUSTODY_APPROVAL_REQUIRED');
    const answer = state.answer;
    const ceremony: CeremonyTransport = {
      requestEnrollment: async () => reject('PAIR_CEREMONY_INVALID'), requestUnlock: async () => reject('PAIR_CEREMONY_INVALID'),
      requestGrant: async () => answer,
    };
    const grant = await runGrantCeremony({ userId: state.userId, ops: snapshotOps(state.snapshot), ceremony });
    if (!grant.ok) return reject('PAIR_APPROVAL_FAILED');
    await deps.persist(grant.material, state.custodyOrgId);
    const next: PairCheckpoint = { ...state, installed: true, credentialId: grant.material.credentialId,
      connection: undefined, answer: undefined, snapshot: undefined };
    deps.save(next);
    return next;
  })();
  const result = await deps.report({ action: 'complete', runtime_id: state.runtimeId,
    repo_fingerprint: state.repositoryFingerprint, connection_id: state.handoff.connection_id,
    credential_id: installed.credentialId!, receipt_id: state.receiptId });
  if (result.phase !== 'paired' || result.flow_id !== state.flowId || result.user_id !== state.userId
    || result.custody_org_id !== state.custodyOrgId || result.receipt_id !== state.receiptId
    || result.runtime_id !== state.runtimeId || result.repo_fingerprint !== state.repositoryFingerprint) {
    return reject('PAIR_COMPLETION_NOT_ACKNOWLEDGED');
  }
  const completed = { ...installed, completed: true as const };
  deps.save(completed);
  return paired(completed);
}

export async function executeFlowPair(flowId: string, options: FlowPairOptions, deps: PairExecutorDependencies) {
  validateArguments(flowId, options);
  const existing = deps.read();
  if (existing && (existing.version !== 1 || existing.flowId !== flowId || existing.userId !== options.expectedUserId
    || existing.serviceOrigin !== options.serviceOrigin || existing.repositoryFingerprint !== deps.repositoryFingerprint
    || !UUID.test(existing.runtimeId) || !UUID.test(existing.receiptId) || !existing.handoff)) reject('PAIR_CHECKPOINT_MISMATCH');
  const view = await deps.view();
  validateView(view, flowId, options.expectedUserId);
  const runtimeId = existing?.runtimeId ?? deps.runtimeId();
  if ((view.runtime_id && view.runtime_id !== runtimeId)
    || (view.repo_fingerprint && view.repo_fingerprint !== deps.repositoryFingerprint)) reject('PAIR_RUNTIME_MISMATCH');
  if (existing && existing.custodyOrgId !== view.custody_org_id) reject('PAIR_CUSTODY_CONTEXT_CHANGED');
  await deps.report({ action: 'attach', runtime_id: runtimeId, repo_fingerprint: deps.repositoryFingerprint });
  if (existing?.installed) return finishPairing(existing, deps);
  if (existing?.answer) return finishPairing(existing, deps);
  if (existing) {
    if (Date.parse(existing.handoff.expires_at) <= deps.now()) return reject('PAIR_CEREMONY_EXPIRED');
    if (!existing.connection || !existing.snapshot) return reject('PAIR_CHECKPOINT_INVALID');
    await deps.report({ action: 'handoff', runtime_id: runtimeId, repo_fingerprint: deps.repositoryFingerprint,
      connection_id: existing.handoff.connection_id, url: existing.handoff.url });
    const result = await deps.poll({ connectionId: existing.handoff.connection_id,
      expiresAt: existing.handoff.expires_at,
      keypair: importConnectionKeypair(existing.connection.publicKeyB64, existing.connection.privateKeyB64) });
    if (result.kind === 'pending') return pending(existing);
    if (result.kind !== 'answered') return reject(result.kind === 'consumed' ? 'PAIR_ANSWER_LOST_RESTART_REQUIRED'
      : result.kind === 'expired' ? 'PAIR_CEREMONY_EXPIRED' : 'PAIR_CEREMONY_UNAVAILABLE');
    const delivered = { ...existing, answer: parseAnswer(result.plaintext) };
    // Persist before installation; consumed-without-checkpoint is a distinct fail-closed recovery case.
    deps.save(delivered);
    return finishPairing(delivered, deps);
  }
  if (await deps.existingCredential()) return reject('PAIR_EXISTING_REQUIRES_PROOF');
  const snapshot = await snapshotGrant(deps.wrappers);
  const candidates = await grantCandidates(options.expectedUserId, snapshot);
  if (candidates.some((candidate) => candidate.credentialId.length > 1400)) return reject('PAIR_CEREMONY_INVALID');
  const fragment = `#r=${Buffer.from(JSON.stringify({ v: 1, ceremony: 'grant', custody: 'filesystem', candidates })).toString('base64url')}`;
  if (fragment.length > 16384) return reject('PAIR_CEREMONY_INVALID');
  const connection = await deps.createConnection();
  const url = new URL(`/flow/device-key?${new URLSearchParams({ c: connection.connectionId })}`, deps.keepOrigin).toString() + fragment;
  const state: PairCheckpoint = { version: 1, flowId, userId: options.expectedUserId,
    serviceOrigin: options.serviceOrigin, repositoryFingerprint: deps.repositoryFingerprint, runtimeId,
    custodyOrgId: view.custody_org_id, receiptId: randomUUID(),
    handoff: { connection_id: connection.connectionId, url, expires_at: connection.expiresAt },
    connection: { publicKeyB64: connection.keypair.publicKeyB64, privateKeyB64: exportConnectionPrivateKeyB64(connection.keypair) }, snapshot };
  deps.save(state);
  await deps.report({ action: 'handoff', runtime_id: runtimeId, repo_fingerprint: deps.repositoryFingerprint,
    connection_id: connection.connectionId, url });
  return pending(state);
}

export function readProtectedJson<T>(path: string): T | null {
  assertCheckpointDirectories(path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576
    || (process.getuid && stat.uid !== process.getuid())) return reject('PAIR_CHECKPOINT_PERMISSIONS');
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function saveProtectedJson(path: string, value: unknown): void {
  assertCheckpointDirectories(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stat = lstatSync(dirname(path));
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) return reject('PAIR_CHECKPOINT_PERMISSIONS');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function assertCheckpointDirectories(path: string): void {
  const home = getGlobalCapyDir();
  const parts = relative(home, dirname(path)).split(sep);
  if (parts.includes('..')) return reject('PAIR_CHECKPOINT_PERMISSIONS');
  for (const directory of [home, ...parts.map((_part, index) => join(home, ...parts.slice(0, index + 1)))]) {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) return reject('PAIR_CHECKPOINT_PERMISSIONS');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

const serviceCodes: readonly string[] = [
  'ONBOARD_RUNTIME_SESSION_REQUIRED', 'FLOW_OPEN_FOR_OTHER_REPO', 'ONBOARD_RUNTIME_MISMATCH',
  'ONBOARD_RUNTIME_ATTACH_REQUIRED', 'ONBOARD_PAIRING_UNAVAILABLE', 'ONBOARD_PAIRING_HANDOFF_INVALID',
  'ONBOARD_PAIRING_CONFLICT', 'ONBOARD_PAIRING_EXPIRED', 'ONBOARD_PAIRING_NOT_DELIVERED',
  'ONBOARD_PAIRING_CREDENTIAL_UNAVAILABLE', 'ONBOARD_PAIRING_RECEIPT_CONFLICT', 'ONBOARD_RUNTIME_CONFLICT',
  'ONBOARD_FLOW_EXPIRED',
];
function errorMessage(code: string): string {
  if (['PAIR_CEREMONY_EXPIRED', 'ONBOARD_PAIRING_EXPIRED', 'ONBOARD_FLOW_EXPIRED', 'PAIR_ANSWER_LOST_RESTART_REQUIRED'].includes(code)) {
    return 'This pairing request can no longer be completed. Ask your agent to start a fresh pairing request.';
  }
  if (['PAIR_AUTHENTICATION_REQUIRED', 'ONBOARD_RUNTIME_SESSION_REQUIRED'].includes(code)) {
    return 'Ask your agent to resume sign-in for this session, then retry connecting this machine.';
  }
  if (code === 'PAIR_EXISTING_REQUIRES_PROOF') return 'This machine is already paired. Ask your agent to resume its original onboarding request.';
  if (code === 'PAIR_APPROVAL_CANCELLED') return 'Pairing was cancelled. Your account is unchanged.';
  if (code === 'PAIR_CUSTODY_APPROVAL_REQUIRED') return 'The browser did not approve persistent pairing. Ask your agent to start a fresh pairing request and review its storage disclosure.';
  return 'Pairing could not finish. Ask your agent to check this request and retry; your account is unchanged.';
}

/** A completed receipt is reusable only with this exact runtime, account, and deployment binding. */
function completedPairCheckpoint(userId: string, serviceOrigin: string, runtimeId: string, credentialId: string): PairCheckpoint | null {
  const directory = join(getGlobalCapyDir(), 'auth', 'authentication-flows');
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory)
    .filter((name) => /^pair-[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => readProtectedJson<PairCheckpoint>(join(directory, name)))
    .filter((state): state is PairCheckpoint => state !== null && state.completed === true
      && state.userId === userId && state.serviceOrigin === serviceOrigin
      && state.runtimeId === runtimeId && state.credentialId === credentialId && Boolean(state.receiptId));
  return candidates.reduce<PairCheckpoint | null>((selected, candidate) =>
    selected === null || candidate.flowId > selected.flowId ? candidate : selected, null);
}

export async function executeLocalFlowPair(flowId: string, options: FlowPairOptions, devMode = false) {
    validateArguments(flowId, options);
    if (new URL(resolveActiveUrl(devMode)).origin !== options.serviceOrigin) return reject('PAIR_ENVIRONMENT_MISMATCH');
    const backend = new FileSessionStorageBackend();
    const session = backend.load(options.expectedUserId);
    if (!session?.refresh_token || session.user_id !== options.expectedUserId) return reject('PAIR_AUTHENTICATION_REQUIRED');
    assertRuntimePairingUser(options.expectedUserId);
    const checkpointPath = join(getGlobalCapyDir(), 'auth', 'authentication-flows', `pair-${flowId}.json`);
    const runtimePath = join(getGlobalCapyDir(), 'auth', 'authentication-flows', 'runtime-id.json');
    const lease = acquirePairAttemptLease();
    try {
      const runtimeId = () => {
        const existing = readProtectedJson<{ readonly id: string }>(runtimePath);
        if (existing) return UUID.test(existing.id) ? existing.id : reject('PAIR_CHECKPOINT_INVALID');
        const id = randomUUID(); saveProtectedJson(runtimePath, { id }); return id;
      };
      const fingerprint = options.runtimeOnly
        ? runtimeId()
        : sha256(realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'],
          { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));
      const prior = readProtectedJson<PairCheckpoint>(checkpointPath);
      if (prior && (prior.userId !== options.expectedUserId || prior.serviceOrigin !== options.serviceOrigin
        || prior.repositoryFingerprint !== fingerprint)) return reject('PAIR_CHECKPOINT_MISMATCH');
      const auth = new AuthService(options.serviceOrigin, devMode, options.expectedUserId);
      const authOrgId = prior?.custodyOrgId ?? session.organizations[0]?.id;
      if (!authOrgId) return reject('PAIR_SIGNUP_REQUIRED');
      const authenticated = await auth.authenticateSilent(authOrgId);
      requirePairSilentAuthentication(authenticated, options.expectedUserId);
      const token = async () => (await auth.getValidToken())?.access_token ?? reject('PAIR_AUTHENTICATION_REQUIRED');
      const request = async (body?: PairReport): Promise<PairRuntimeView> => {
        const response = await fetch(`${options.serviceOrigin}/flows/${flowId}/runtime`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { readonly code?: unknown };
          return reject(typeof body.code === 'string' && serviceCodes.includes(body.code) ? body.code : 'PAIR_SERVICE_REFUSED');
        }
        return response.json() as Promise<PairRuntimeView>;
      };
      const existingCredential = async () => {
        const record = readRuntimePairing();
        if (!record) return null;
        if (record.version !== 1 || !record.filesystemCustody) return reject('PAIR_EXISTING_REQUIRES_PROOF');
        const restored = await recoverFilesystemRuntimePairingWhileLeaseHeld({
          environment: runtimePairingEnvironment(devMode), expectedUserId: options.expectedUserId,
        }, lease);
        return restored?.credentialId ?? null;
      };
      const reusableCredential = !prior ? await existingCredential() : null;
      if (reusableCredential) {
        const source = completedPairCheckpoint(options.expectedUserId, options.serviceOrigin, runtimeId(), reusableCredential);
        if (!source) return reject('PAIR_EXISTING_REQUIRES_PROOF');
        const reused = await request({ action: 'reuse', runtime_id: runtimeId(), repo_fingerprint: fingerprint,
          source_flow_id: source.flowId, receipt_id: source.receiptId });
        if (reused.phase !== 'paired' || reused.flow_id !== flowId || reused.user_id !== options.expectedUserId
          || reused.runtime_id !== runtimeId() || reused.repo_fingerprint !== fingerprint
          || reused.receipt_id !== source.receiptId || reused.custody_org_id !== source.custodyOrgId) {
          return reject('PAIR_COMPLETION_NOT_ACKNOWLEDGED');
        }
        // A source receipt proves this exact runtime; the new parent still needs
        // its own durable local correlation for subsequent setup commands.
        saveProtectedJson(checkpointPath, {
          ...source, flowId, repositoryFingerprint: fingerprint,
          connection: undefined, snapshot: undefined, answer: undefined, completed: true,
        });
        return { ok: true as const, flow_id: flowId, stage: 'paired' as const,
          continuation: { tool: 'capy_onboard' as const, args: { flow_id: flowId } } };
      }
      const view = await request();
      validateView(view, flowId, options.expectedUserId);
      if (view.custody_org_id !== authOrgId) {
        const pinned = await auth.authenticateSilent(view.custody_org_id);
        requirePairSilentAuthentication(pinned, options.expectedUserId);
      }
      const broker = new BrokerClient(options.serviceOrigin, token);
      const client = new ServiceClient(options.serviceOrigin, devMode);
      client.setTokenProvider(() => auth.getValidToken());
      const { ops } = createDeviceKeyServiceOps(client, auth);
      const result = await executeFlowPair(flowId, options, {
        now: Date.now, repositoryFingerprint: fingerprint, view: async () => view, report: request,
        read: () => readProtectedJson<PairCheckpoint>(checkpointPath), save: (state) => saveProtectedJson(checkpointPath, state),
        runtimeId,
        keepOrigin: keepOrigin(), wrappers: ops,
        createConnection: () => broker.createConnection({ purpose: 'device-key', machineName: hostname(), ttlSeconds: 900 }),
        poll: (connection) => broker.pollAnswer(connection, 20),
        existingCredential,
        persist: async (material, orgId) => {
          const handle = await spawnGrantDaemon(material, { ttlMs: null, persistRuntimePairing: false });
          await registerFilesystemRuntimePairing(runtimePairingEnvironment(devMode), orgId, material, handle);
        },
      });
      return result;
    } finally { releasePairAttemptLease(lease); }
}

export async function runFlowPairCommand(flowId: string, options: FlowPairOptions, devMode = false): Promise<number> {
  try {
    const result = await executeLocalFlowPair(flowId, options, devMode);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const code = error instanceof PairExecutorError ? error.code : 'PAIR_EXECUTOR_FAILED';
    console.log(JSON.stringify({ ok: false, flow_id: flowId, code, message: errorMessage(code) }));
    return 1;
  }
}
