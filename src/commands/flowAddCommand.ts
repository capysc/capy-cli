/** Keep-owned secret intake: bounded handoffs, protected envelopes, canonical snapshot write. */
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { lock } from 'proper-lockfile';
import { AuthService } from '../auth/authService';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { assertRuntimePairingUser, recoverFilesystemRuntimePairing } from '../auth/pairing/runtimePairing';
import { runtimePairingEnvironment } from '../auth/pairing/runtimePairingEnvironment';
import { getGlobalCapyDir } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { BrokerClient, type BrokerConnection, type PollExchangeResult } from '../service/brokerClient';
import { exportConnectionPrivateKeyB64, importConnectionKeypair, openEnvelope } from '../service/brokerEnvelope';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { CapyError, type KeepFile } from '../types';
import { keepFlowUrl } from '../ui/screens/keepScreens';
import { buildSecretIntakeData, parseVars, type SecretPair } from '../ui/secretIntakeScreen';
import { overwriteNotice } from './addCommand';
import { readProtectedJson, saveProtectedJson, type PairCheckpoint } from './flowPairCommand';
import type { RepositoryTarget } from './flowSetupCommand';
import { resolveBoundIntakeContext } from './connectors/boundIntakeContext';
import { syncResolvedSnapshot } from './connectors/shared';

export interface FlowAddOptions { readonly expectedUserId: string; readonly serviceOrigin: string; readonly json?: boolean; readonly cancel?: boolean }
interface Handoff { readonly connection_id: string; readonly url: string; readonly expires_at: string }
export interface IntakeView {
  readonly flow_id: string; readonly onboarding_flow_id: string; readonly user_id: string;
  readonly runtime_id: string; readonly repo_fingerprint: string; readonly target: RepositoryTarget;
  readonly variable_names: readonly string[]; readonly stage: string; readonly expires_at: string;
  readonly next_action: 'observe' | 'approve_create_env' | 'intake' | 'done' | 'cancelled';
  readonly decision_id: string | null; readonly create_env_approved: boolean;
  readonly local_state_digest: string | null; readonly base_keep_hash: string | null;
  readonly handoff: Handoff | null; readonly receipt_id: string | null;
}
type Json = Readonly<Record<string, unknown>>;
export interface IntakeCheckpoint {
  readonly flowId: string; readonly parentId: string; readonly userId: string; readonly serviceOrigin: string;
  readonly runtimeId: string; readonly fingerprint: string; readonly intentDigest: string;
  readonly decisionId: string | null; readonly localDigest: string; readonly baseKeepHash: string | null;
  readonly handoff: Handoff; readonly receiptId: string; readonly request: Json; readonly requestDigest: string;
  readonly connection?: { readonly publicKeyB64: string; readonly privateKeyB64: string };
  readonly requestSent?: true; readonly answerCiphertext?: string; readonly applying?: true;
  readonly applied?: { readonly remoteKeepHash: string; readonly localDigest: string }; readonly completed?: true;
}
export interface IntakeDependencies {
  readonly view: () => Promise<IntakeView>; readonly report: (body: Json) => Promise<IntakeView>;
  readonly fingerprint: string; readonly runtimeId: string; readonly now: () => number;
  readonly read: () => IntakeCheckpoint | null; readonly save: (checkpoint: IntakeCheckpoint) => void;
  readonly observe: () => Promise<Json>; readonly localDigest: () => string;
  readonly create: () => Promise<BrokerConnection>;
  readonly url: (id: string) => string;
  readonly poll: (connection: BrokerConnection, waitSeconds: number) => Promise<PollExchangeResult>;
  readonly send: (connection: BrokerConnection, pageKey: string, payload: string) => Promise<{ readonly kind: string }>;
  readonly apply: (pairs: readonly SecretPair[], baseHash: string | null, localDigest: string) => Promise<{ readonly remoteKeepHash: string; readonly localDigest: string }>;
}
class IntakeError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new IntakeError(code); };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const intentDigest = (view: IntakeView) => sha(JSON.stringify({ parent: view.onboarding_flow_id,
  org: view.target.org_id, project: view.target.project_id, branch: view.target.branch, mode: view.target.sync_mode,
  names: view.variable_names }));
const publicResult = (view: IntakeView, handoff?: Handoff) => ({ ok: true, flow_id: view.flow_id,
  stage: view.next_action === 'done' ? 'done' : 'intake_pending', ...(handoff ? { handoff } : {}),
  continuation: { tool: 'capy_add', args: { flow_id: view.flow_id } } });
function connectionOf(state: IntakeCheckpoint): BrokerConnection {
  if (!state.connection) return fail('INTAKE_CHECKPOINT_INVALID');
  return { connectionId: state.handoff.connection_id, expiresAt: state.handoff.expires_at,
    keypair: importConnectionKeypair(state.connection.publicKeyB64, state.connection.privateKeyB64) };
}
function exactPairs(plaintext: string, names: readonly string[]): readonly SecretPair[] {
  const body = JSON.parse(plaintext) as { readonly v?: number; readonly vars?: unknown };
  const pairs = body.v === 1 ? parseVars(body.vars) : null;
  if (!pairs || pairs.length !== names.length || new Set(pairs.map((pair) => pair.name)).size !== names.length
    || pairs.some((pair) => !names.includes(pair.name))) return fail('INTAKE_NAMES_CHANGED');
  return pairs;
}

export async function executeFlowAdd(flowId: string, options: FlowAddOptions, deps: IntakeDependencies): Promise<Json> {
  const checked = (view: IntakeView): IntakeView => {
    if (view.flow_id !== flowId || view.user_id !== options.expectedUserId || view.runtime_id !== deps.runtimeId
      || view.repo_fingerprint !== deps.fingerprint) return fail('INTAKE_BINDING_MISMATCH');
    if (!view.target || !Array.isArray(view.variable_names) || view.variable_names.length === 0
      || view.variable_names.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      || new Set(view.variable_names).size !== view.variable_names.length) return fail('INTAKE_SERVICE_RESPONSE_INVALID');
    return view;
  };
  const view = checked(await deps.view());
  const report = async (body: Json) => checked(await deps.report({ runtime_id: deps.runtimeId, repo_fingerprint: deps.fingerprint, ...body }));
  const prior = deps.read();
  if (prior && (prior.flowId !== flowId || prior.parentId !== view.onboarding_flow_id || prior.userId !== options.expectedUserId
    || prior.serviceOrigin !== options.serviceOrigin || prior.runtimeId !== deps.runtimeId || prior.fingerprint !== deps.fingerprint
    || prior.intentDigest !== intentDigest(view))) return fail('INTAKE_CHECKPOINT_MISMATCH');
  if (options.cancel) {
    if (prior?.applying || prior?.applied || prior?.completed || view.next_action === 'done') return fail('INTAKE_CANCEL_TOO_LATE');
    const connectionId = prior?.handoff.connection_id ?? view.handoff?.connection_id;
    const cancelled = await report({ action: 'cancel', ...(connectionId ? { connection_id: connectionId } : {}) });
    if (cancelled.next_action !== 'cancelled') return fail('INTAKE_CANCELLATION_NOT_ACKNOWLEDGED');
    return { ok: true, flow_id: flowId, stage: 'cancelled' };
  }
  if (view.next_action === 'cancelled') return { ok: true, flow_id: flowId, stage: 'cancelled' };
  if (view.next_action === 'done') return publicResult(view);
  if (view.next_action === 'observe') {
    const { overwrite_variable_names: _displayOnlyNames, ...observed } = await deps.observe();
    return publicResult(await report({ action: 'observe', ...observed }));
  }
  if (view.next_action === 'approve_create_env') return publicResult(view);
  if (view.next_action !== 'intake' || !view.local_state_digest) return fail('INTAKE_NOT_READY');
  const state = await (async (): Promise<IntakeCheckpoint> => {
    if (prior) return prior;
    if (view.handoff) return fail('INTAKE_CHECKPOINT_MISSING');
    const observed = await deps.observe();
    if (deps.localDigest() !== view.local_state_digest) return fail('INTAKE_LOCAL_CHANGED');
    const existing = (observed.overwrite_variable_names ?? observed.existing_variable_names) as readonly string[];
    const data = buildSecretIntakeData({ vars: view.variable_names.map((name) => ({ name })), open: false }, '');
    const request = { ...data, nonTty: undefined, readonlyNames: true,
      reason: [overwriteNotice(view.variable_names.filter((name) => existing.includes(name))),
        `Save to ${view.target.project_name} / ${view.target.branch}.`].filter(Boolean).join(' ') };
    const connection = await deps.create();
    const created: IntakeCheckpoint = { flowId, parentId: view.onboarding_flow_id, userId: options.expectedUserId,
      serviceOrigin: options.serviceOrigin, runtimeId: deps.runtimeId, fingerprint: deps.fingerprint, intentDigest: intentDigest(view),
      decisionId: view.decision_id, localDigest: view.local_state_digest, baseKeepHash: view.base_keep_hash,
      handoff: { connection_id: connection.connectionId, url: deps.url(connection.connectionId), expires_at: connection.expiresAt },
      connection: { publicKeyB64: connection.keypair.publicKeyB64, privateKeyB64: exportConnectionPrivateKeyB64(connection.keypair) },
      receiptId: randomUUID(), request, requestDigest: sha(JSON.stringify(request)) };
    deps.save(created); return created;
  })();
  if (sha(JSON.stringify(state.request)) !== state.requestDigest) return fail('INTAKE_CHECKPOINT_INVALID');
  if (state.applying && !state.applied) return fail('INTAKE_APPLY_INTERRUPTED');
  if (!state.applied && deps.localDigest() !== state.localDigest) return fail('INTAKE_LOCAL_CHANGED');
  if (state.decisionId !== view.decision_id || state.baseKeepHash !== view.base_keep_hash) return fail('INTAKE_CONSENT_CHANGED');
  if (!state.applied && Date.parse(state.handoff.expires_at) <= deps.now()) return fail('INTAKE_EXPIRED');
  if (!prior || !view.handoff) {
    await report({ action: 'handoff', connection_id: state.handoff.connection_id, url: state.handoff.url, request_digest: state.requestDigest });
    return publicResult(view, state.handoff);
  }
  if (view.handoff.connection_id !== state.handoff.connection_id) return fail('INTAKE_CHECKPOINT_MISMATCH');
  const saved = await (async (): Promise<IntakeCheckpoint | null> => {
    if (state.applied || state.answerCiphertext) return state;
    const connection = connectionOf(state);
    // The result endpoint waits for an answer, not page attachment. Waiting
    // before sending our request delays even an already-attached page by the
    // full answer timeout. Read once now; long-poll only after request delivery.
    const result = await deps.poll(connection, state.requestSent ? 20 : 0);
    if (result.kind === 'answered') {
      const answered = { ...state, answerCiphertext: result.ciphertextB64 };
      deps.save(answered); return answered;
    }
    if (result.kind !== 'pending') return fail(result.kind === 'consumed' ? 'INTAKE_ANSWER_LOST' : result.kind === 'expired' ? 'INTAKE_EXPIRED' : 'INTAKE_BROKER_FAILED');
    if (result.pagePubkeyB64 && !state.requestSent) {
      const sent = await deps.send(connection, result.pagePubkeyB64, JSON.stringify(state.request));
      if (!['sent', 'already_sent'].includes(sent.kind)) return fail('INTAKE_REQUEST_FAILED');
      deps.save({ ...state, requestSent: true });
    }
    return null;
  })();
  if (!saved) return publicResult(view, state.handoff);
  const applied = await (async (): Promise<IntakeCheckpoint> => {
    if (saved.applied) return saved;
    if (saved.applying) return fail('INTAKE_APPLY_INTERRUPTED');
    if (!saved.answerCiphertext) return fail('INTAKE_CHECKPOINT_INVALID');
    const opened = openEnvelope({ ciphertextB64: saved.answerCiphertext, connectionId: saved.handoff.connection_id, keypair: connectionOf(saved).keypair });
    if (!opened.ok) return fail('INTAKE_BAD_ENVELOPE');
    const pairs = exactPairs(opened.plaintext, view.variable_names);
    await report({ action: 'applying', connection_id: saved.handoff.connection_id, receipt_id: saved.receiptId,
      base_keep_hash: saved.baseKeepHash, local_state_digest: saved.localDigest });
    deps.save({ ...saved, applying: true });
    const result = await deps.apply(pairs, saved.baseKeepHash, saved.localDigest);
    const next = { ...saved, applying: true as const, applied: result, answerCiphertext: undefined, connection: undefined };
    deps.save(next); return next;
  })();
  if (deps.localDigest() !== applied.applied!.localDigest) return fail('INTAKE_LOCAL_CHANGED');
  const completed = await report({ action: 'complete', connection_id: applied.handoff.connection_id, receipt_id: applied.receiptId,
    variable_names: view.variable_names, remote_keep_hash: applied.applied!.remoteKeepHash, local_state_digest: applied.applied!.localDigest,
    org_id: view.target.org_id, project_id: view.target.project_id, branch: view.target.branch });
  if (completed.next_action !== 'done' || completed.receipt_id !== applied.receiptId) return fail('INTAKE_COMPLETION_NOT_ACKNOWLEDGED');
  deps.save({ ...applied, completed: true }); return publicResult(completed);
}

export async function runFlowAddCommand(flowId: string, options: FlowAddOptions, devMode = false): Promise<number> {
  try {
    if (!UUID.test(flowId) || !/^user_[A-Za-z0-9]+$/.test(options.expectedUserId)) return fail('INTAKE_ARGUMENT_INVALID');
    if (new URL(resolveActiveUrl(devMode)).origin !== options.serviceOrigin) return fail('INTAKE_ENVIRONMENT_MISMATCH');
    const root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (root !== realpathSync(process.cwd())) return fail('INTAKE_REPOSITORY_ROOT_REQUIRED');
    const fingerprint = sha(root);
    const session = new FileSessionStorageBackend().load(options.expectedUserId);
    if (!session?.refresh_token || session.user_id !== options.expectedUserId) return fail('INTAKE_SIGN_IN_REQUIRED');
    assertRuntimePairingUser(options.expectedUserId);
    const restored = await recoverFilesystemRuntimePairing({ environment: runtimePairingEnvironment(devMode), expectedUserId: options.expectedUserId });
    if (!restored) return fail('INTAKE_PAIRING_REQUIRED');
    const auth = new AuthService(options.serviceOrigin, devMode, options.expectedUserId);
    const identity = await auth.authenticateSilent(restored.filesystemCustody?.orgId);
    if (!identity.success || identity.user_id !== options.expectedUserId) return fail('INTAKE_SIGN_IN_REQUIRED');
    const token = async () => (await auth.getValidToken())?.access_token ?? fail('INTAKE_SIGN_IN_REQUIRED');
    const request = async (body?: Json): Promise<IntakeView> => {
      const response = await fetch(`${options.serviceOrigin}/flows/${flowId}/secret-intake`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { readonly code?: unknown };
        return fail(typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INTAKE_SERVICE_REFUSED');
      }
      return response.json() as Promise<IntakeView>;
    };
    const view = await request();
    if (!UUID.test(view.onboarding_flow_id)) return fail('INTAKE_SERVICE_RESPONSE_INVALID');
    const directory = join(getGlobalCapyDir(), 'auth', 'authentication-flows');
    const paired = readProtectedJson<PairCheckpoint>(join(directory, `pair-${view.onboarding_flow_id}.json`));
    if (!paired?.completed || paired.userId !== options.expectedUserId || paired.serviceOrigin !== options.serviceOrigin
      || paired.repositoryFingerprint !== fingerprint || paired.runtimeId !== view.runtime_id || paired.credentialId !== restored.credentialId) {
      return fail('INTAKE_PAIRING_MISMATCH');
    }
    const service = new ServiceClient(options.serviceOrigin, devMode);
    service.setTokenProvider(() => auth.getValidToken());
    const broker = new BrokerClient(options.serviceOrigin, token);
    const checkpointPath = join(directory, `intake-${flowId}.json`);
    // Reuse the existing lock library; competing commands never mint two requests or apply twice.
    const release = await lock(checkpointPath, { realpath: false, lockfilePath: `${checkpointPath}.lease`, retries: 0, stale: 30_000 });
    try {
      const localDigest = () => sha(JSON.stringify(['.env', 'keep.lock', '.capy/branch'].map((name) => {
        const path = join(root, name); return [name, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null];
      })));
      const context = () => resolveBoundIntakeContext({ target: view.target, expectedUserId: options.expectedUserId, auth, service });
      const result = await executeFlowAdd(flowId, options, {
        view: async () => view, report: request, fingerprint, runtimeId: paired.runtimeId, now: Date.now,
        read: () => readProtectedJson<IntakeCheckpoint>(checkpointPath), save: (checkpoint) => saveProtectedJson(checkpointPath, checkpoint),
        localDigest,
        observe: async () => {
          const ctx = await context();
          return { env_exists: existsSync(join(root, '.env')), existing_variable_names: Object.keys(ctx.fileManager.readEnvFile()),
            overwrite_variable_names: Object.keys(ctx.localPlaintext),
            local_state_digest: localDigest(), keep_lock: ctx.lockless ? null
              : { org_id: ctx.orgId, project_id: ctx.projectId, branch: ctx.branch } };
        },
        create: () => broker.createConnection({ purpose: 'secret-intake', machineName: hostname(), ttlSeconds: 900 }),
        url: (id) => keepFlowUrl('secret-intake', id), poll: (connection, waitSeconds) => broker.pollExchange(connection, waitSeconds),
        send: (connection, pageKey, payload) => broker.sendRequest(connection, pageKey, payload),
        apply: async (pairs, baseHash, expectedLocalDigest) => {
          const ctx = await context();
          const expectedHash = baseHash ?? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
          if (ctx.base_keep_hash !== expectedHash) return fail('INTAKE_REMOTE_CHANGED');
          if (localDigest() !== expectedLocalDigest) return fail('INTAKE_LOCAL_CHANGED');
          const finalValues = { ...ctx.localPlaintext, ...Object.fromEntries(pairs.map((pair) => [pair.name, pair.value])) };
          await syncResolvedSnapshot(ctx, finalValues, { primaryVarNames: pairs.map((pair) => pair.name),
            confirmOverwrite: async () => false, reportStatus: (message) => console.error(message) });
          const remote = await service.getDecryptData(ctx.projectId, ctx.branch, undefined, true);
          if (!remote.keep_file) return fail('INTAKE_REMOTE_MISSING');
          return { remoteKeepHash: SyncEngine.computeKeepHash(JSON.parse(remote.keep_file) as KeepFile, ctx.branch), localDigest: localDigest() };
        },
      });
      console.log(JSON.stringify(result)); return 0;
    } finally { await release(); }
  } catch (error) {
    const code = error instanceof IntakeError || error instanceof CapyError ? error.code : 'INTAKE_EXECUTOR_FAILED';
    const message = ['INTAKE_ANSWER_LOST', 'INTAKE_EXPIRED', 'INTAKE_LOCAL_CHANGED', 'INTAKE_NAMES_CHANGED'].includes(code)
      ? 'This secure intake can no longer be resumed safely. Ask your agent to cancel this request, then start a fresh one in Keep.'
      : code === 'INTAKE_APPLY_INTERRUPTED' ? 'Saving was interrupted. Ask your agent to check the existing result before retrying; no writes were repeated.'
        : 'The secrets were not confirmed saved. Ask your agent to check this request and resume securely in Keep.';
    console.log(JSON.stringify({ ok: false, flow_id: flowId, code, message })); return 1;
  }
}
