/** Bounded local executor for Keep-owned repository setup. Never grants consent itself. */
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync, readFileSync } from 'fs';
import { join } from 'path';
import { AuthService, silentAuthFailureMessage } from '../auth/authService';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { assertRuntimePairingUser, recoverFilesystemRuntimePairing } from '../auth/pairing/runtimePairing';
import { runtimePairingEnvironment } from '../auth/pairing/runtimePairingEnvironment';
import { getGlobalCapyDir } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import type { KeepFile } from '../types';
import { SetupCommand } from './setupCommand';
import { SyncCommand } from './syncCommand';
import { readProtectedJson, saveProtectedJson, type PairCheckpoint } from './flowPairCommand';
import { applyRepositoryEdits, composeRepositoryPlan, prepareRepository, RepositoryPreparationError, type RepositoryDiscovery } from '../core/repositoryPreparation';

export interface FlowSetupOptions { readonly expectedUserId: string; readonly serviceOrigin: string; readonly json?: boolean }
export interface RepositoryTarget {
  readonly org_id: string; readonly project_id: string; readonly project_name: string;
  readonly branch: string;
}
export interface RepositoryView {
  readonly flow_id: string; readonly user_id: string; readonly runtime_id: string; readonly repo_fingerprint: string;
  readonly next_action: 'observe' | 'choose_attribution' | 'plan' | 'approve_plan' | 'apply' | 'sync' | 'verify' | 'done';
  readonly attribution: RepositoryTarget | null;
  readonly discovery?: RepositoryDiscovery | null;
  readonly approval: 'approved' | 'declined' | null;
  readonly plan: null | { readonly plan_hash: string; readonly cli_plan_hash: string; readonly operation: 'setup' | 'sync' };
}
export interface RepositoryReceipt {
  readonly flowId: string; readonly userId: string; readonly serviceOrigin: string;
  readonly fingerprint: string; readonly runtimeId: string; readonly planHash: string;
  readonly receiptId: string; readonly target: RepositoryTarget; readonly phase: 'applying' | 'applied';
  readonly localHash?: string;
}
type JsonResult = Readonly<Record<string, unknown>>;
export interface SetupExecutorDependencies {
  readonly runtimeId: string; readonly fingerprint: string;
  readonly view: () => Promise<RepositoryView>;
  readonly report: (body: JsonResult) => Promise<RepositoryView>;
  readonly observe: () => JsonResult;
  readonly plan: (target: RepositoryTarget, operation?: 'setup' | 'sync') => Promise<JsonResult>;
  readonly apply: (target: RepositoryTarget, operation: 'setup' | 'sync', hash: string) => Promise<JsonResult>;
  readonly read: () => RepositoryReceipt | null;
  readonly save: (receipt: RepositoryReceipt) => void;
  readonly localDigest: () => string;
  readonly verify: (target: RepositoryTarget) => Promise<{ readonly remote_keep_hash: string | null }>;
}
type SetupFailureStage = 'resolve_project' | 'resolve_key' | 'push';
class SetupFlowError extends Error {
  constructor(readonly code: string, readonly failureStage?: SetupFailureStage) { super(code); }
}
const reject = (code: string): never => { throw new SetupFlowError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const output = (view: RepositoryView) => ({ ok: true, flow_id: view.flow_id,
  stage: view.next_action === 'done' ? 'done' : 'repository_pending',
  ...(view.next_action === 'done' ? { message: 'Capy is ready for this repository.' } : {}),
  continuation: { tool: 'capy_onboard', args: { flow_id: view.flow_id } } });
const requireResult = (result: JsonResult): JsonResult => {
  if (result.ok === true) return result;
  const code = typeof result.code === 'string' && /^[A-Z0-9_]+$/.test(result.code)
    ? result.code : 'SETUP_OPERATION_FAILED';
  const stage = result.failure_stage;
  throw new SetupFlowError(code,
    stage === 'resolve_project' || stage === 'resolve_key' || stage === 'push' ? stage : undefined);
};

/** Only coded failures and allowlisted stages cross the public JSON boundary. */
export function setupFailureResult(flowId: string, error: unknown): JsonResult {
  const code = error instanceof SetupFlowError || error instanceof RepositoryPreparationError ? error.code : 'SETUP_EXECUTOR_FAILED';
  return { ok: false, flow_id: flowId, code,
    ...(error instanceof SetupFlowError && error.failureStage ? { failure_stage: error.failureStage } : {}),
    message: code === 'SETUP_APPLY_INTERRUPTED' ? 'Setup was interrupted while applying. Ask your agent to check the repository before retrying; no changes were repeated.'
      : 'Setup could not finish. Ask your agent to check the reported issue and resume this request.' };
}
const sameTarget = (left: RepositoryTarget, right: RepositoryTarget): boolean =>
  left.org_id === right.org_id && left.project_id === right.project_id && left.project_name === right.project_name
  && left.branch === right.branch;

export async function executeFlowSetup(flowId: string, options: FlowSetupOptions, deps: SetupExecutorDependencies): Promise<JsonResult> {
  const checked = (view: RepositoryView): RepositoryView => {
    if (view.flow_id !== flowId || view.user_id !== options.expectedUserId || view.runtime_id !== deps.runtimeId
      || view.repo_fingerprint !== deps.fingerprint) return reject('SETUP_FLOW_BINDING_MISMATCH');
    if (!['observe', 'choose_attribution', 'plan', 'approve_plan', 'apply', 'sync', 'verify', 'done'].includes(view.next_action)) {
      return reject('SETUP_SERVICE_RESPONSE_INVALID');
    }
    return view;
  };
  const view = checked(await deps.view());
  const report = async (body: JsonResult): Promise<JsonResult> => output(checked(await deps.report(body)));
  const base = { runtime_id: deps.runtimeId, repo_fingerprint: deps.fingerprint };
  const prior = deps.read();
  if (prior && (prior.flowId !== flowId || prior.userId !== options.expectedUserId || prior.serviceOrigin !== options.serviceOrigin
    || prior.fingerprint !== deps.fingerprint || prior.runtimeId !== deps.runtimeId)) return reject('SETUP_RECEIPT_MISMATCH');
  if (view.next_action === 'observe') return report({ action: 'observe', ...base, ...deps.observe() });
  if (['choose_attribution', 'approve_plan', 'done'].includes(view.next_action)) return output(view);
  const target = view.attribution ?? reject('SETUP_ATTRIBUTION_REQUIRED');
  if (view.next_action === 'plan') {
    const plan = requireResult(await deps.plan(target));
    return report({ action: 'plan', ...base, cli_plan_hash: plan.plan_hash,
      operation: plan.action === 'sync' ? 'sync' : 'setup',
      env_variable_names: plan.env_variable_names ?? (plan.env as { readonly variable_names?: unknown })?.variable_names ?? [],
      will_write: plan.will_write, sync_action: plan.sync_action, removed_remote_variable_names: plan.removed_remote_variable_names,
      ...(plan.summary ? { summary: plan.summary } : {}) });
  }
  const approved = view.plan ?? reject('SETUP_PLAN_REQUIRED');
  if (view.approval !== 'approved') return reject('SETUP_APPROVAL_REQUIRED');
  if (prior && (prior.planHash !== approved.cli_plan_hash || !sameTarget(prior.target, target))) {
    return reject('SETUP_RECEIPT_MISMATCH');
  }
  const receipt = await (async (): Promise<RepositoryReceipt> => {
    if (prior?.phase === 'applied') return prior;
    if (prior) return reject('SETUP_APPLY_INTERRUPTED');
    if (view.next_action !== 'apply') return reject('SETUP_RECEIPT_REQUIRED');
    const plan = requireResult(await deps.plan(target, approved.operation));
    if (plan.plan_hash !== approved.cli_plan_hash) return reject('PLAN_CHANGED');
    const starting: RepositoryReceipt = { flowId, userId: options.expectedUserId, serviceOrigin: options.serviceOrigin,
      fingerprint: deps.fingerprint, runtimeId: deps.runtimeId, planHash: approved.cli_plan_hash,
      receiptId: randomUUID(), target, phase: 'applying' };
    deps.save(starting);
    requireResult(await deps.apply(target, approved.operation, approved.cli_plan_hash));
    const completed: RepositoryReceipt = { ...starting, phase: 'applied', localHash: deps.localDigest() };
    deps.save(completed);
    return completed;
  })();
  if (receipt.localHash !== deps.localDigest()) return reject('SETUP_LOCAL_STATE_CHANGED');
  const observed = await deps.verify(target);
  return report({ action: view.next_action === 'apply' ? 'applied' : view.next_action === 'sync' ? 'synced' : 'verify',
    ...base, plan_hash: approved.plan_hash, receipt_id: receipt.receiptId, ...observed,
    org_id: target.org_id, project_id: target.project_id, branch: target.branch });
}

/** Capture one typed result without swapping stdout or exposing decrypted values. */
function capture(run: (report: (result: JsonResult) => void) => Promise<void>): Promise<JsonResult> {
  return new Promise((resolve, reject) => {
    void run(resolve).then(() => reject(new SetupFlowError('SETUP_RESULT_MISSING')), reject);
  });
}

export async function runFlowSetupCommand(flowId: string, options: FlowSetupOptions, devMode = false): Promise<number> {
  try {
    if (!UUID.test(flowId) || !/^user_[A-Za-z0-9]+$/.test(options.expectedUserId)) return reject('SETUP_ARGUMENT_INVALID');
    if (new URL(resolveActiveUrl(devMode)).origin !== options.serviceOrigin) return reject('SETUP_ENVIRONMENT_MISMATCH');
    const root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (realpathSync(process.cwd()) !== root) return reject('SETUP_RUN_FROM_REPOSITORY_ROOT');
    const fingerprint = createHash('sha256').update(root).digest('hex');
    const directory = join(getGlobalCapyDir(), 'auth', 'authentication-flows');
    const paired = readProtectedJson<PairCheckpoint>(join(directory, `pair-${flowId}.json`));
    if (!paired?.completed || paired.userId !== options.expectedUserId || paired.serviceOrigin !== options.serviceOrigin
      || paired.repositoryFingerprint !== fingerprint) return reject('SETUP_PAIRING_REQUIRED');
    const session = new FileSessionStorageBackend().load(options.expectedUserId);
    if (!session?.refresh_token || session.user_id !== options.expectedUserId) return reject('SETUP_SIGN_IN_REQUIRED');
    assertRuntimePairingUser(options.expectedUserId);
    const restored = await recoverFilesystemRuntimePairing({ environment: runtimePairingEnvironment(devMode), expectedUserId: options.expectedUserId });
    if (!restored || restored.credentialId !== paired.credentialId) return reject('SETUP_PAIRING_REQUIRED');
    const auth = new AuthService(options.serviceOrigin, devMode, options.expectedUserId);
    const identity = await auth.authenticateSilent(paired.custodyOrgId);
    if (!identity.success || identity.user_id !== options.expectedUserId) {
      console.error(`flow setup: ${silentAuthFailureMessage(identity)}`);
      return reject('SETUP_SIGN_IN_REQUIRED');
    }
    const request = async (body?: JsonResult): Promise<RepositoryView> => {
      const token = await auth.getValidToken();
      if (!token?.access_token) return reject('SETUP_SIGN_IN_REQUIRED');
      const response = await fetch(`${options.serviceOrigin}/flows/${flowId}/repository`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { readonly code?: unknown };
        return reject(typeof error.code === 'string' && /^ONBOARD_[A-Z_]+$/.test(error.code) ? error.code : 'SETUP_SERVICE_REFUSED');
      }
      return response.json() as Promise<RepositoryView>;
    };
    const manager = new ProjectManager(root);
    const files = new FileManager();
    const receiptPath = join(directory, `setup-${flowId}.json`);
    const current = await request();
    const discovery = current.discovery;
    const binary = devMode ? 'capy-dev' : process.env.CAPY_BIN_NAME || 'capy';
    const commands = (target: RepositoryTarget, operation: 'setup' | 'sync', confirm?: string) => capture((report) => operation === 'setup'
      ? new SetupCommand({}, devMode, report).execute({ org: target.org_id, project: target.project_id, expectedUserId: options.expectedUserId, confirm })
      : new SyncCommand({ org: target.org_id, project: target.project_id, expectedUserId: options.expectedUserId }, devMode, report)
        .execute(confirm ? { confirm } : { plan: true }));
    const prepared = async (target: RepositoryTarget, operation: 'setup' | 'sync') => {
      const base = requireResult(await commands(target, operation));
      const preparation = discovery ? prepareRepository(root, discovery, binary) : null;
      return { base, preparation, plan: preparation ? composeRepositoryPlan(base, preparation) : base };
    };
    const result = await executeFlowSetup(flowId, options, {
      runtimeId: paired.runtimeId, fingerprint, view: async () => current, report: request,
      read: () => readProtectedJson<RepositoryReceipt>(receiptPath), save: (receipt) => saveProtectedJson(receiptPath, receipt),
      localDigest: () => createHash('sha256').update(JSON.stringify([...new Set(['.env', 'keep.lock', '.capy/branch',
        ...(discovery ? ['package.json', 'Procfile', ...discovery.evidence_files] : [])])].map((name) => {
        const path = join(root, name);
        return [name, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null];
      }))).digest('hex'),
      observe: () => {
        const keep = manager.readKeepFile();
        const branch = keep ? manager.deriveActiveBranch() : null;
        if (keep && !branch) return reject('SETUP_BRANCH_REQUIRED');
        return { keep_lock: keep ? { org_id: keep.org_id, project_id: keep.project_id, branch } : null,
          env: { exists: existsSync(join(root, '.env')), variable_names: Object.keys(files.readEnvFile()) } };
      },
      plan: async (target, operation) => (await prepared(target, operation ?? (existsSync(manager.getKeepPath()) ? 'sync' : 'setup'))).plan,
      apply: async (target, operation, hash) => {
        const checked = await prepared(target, operation);
        if (checked.plan.plan_hash !== hash || typeof checked.base.plan_hash !== 'string') return reject('PLAN_CHANGED');
        const applied = requireResult(await commands(target, operation, checked.base.plan_hash));
        if (checked.preparation) applyRepositoryEdits(root, checked.preparation.edits);
        return applied;
      },
      verify: async (target) => {
        const keep = manager.readKeepFile();
        if (!keep || keep.org_id !== target.org_id || keep.project_id !== target.project_id) return reject('SETUP_LOCAL_TARGET_MISMATCH');
        const values = files.readEnvFile();
        if (Object.keys(values).length > 0) {
          const meta = files.readEnvMeta();
          if (meta.org_id !== target.org_id || meta.project_id !== target.project_id || meta.branch !== target.branch
            || Object.values(values).some((value) => !value.startsWith('capy:'))) return reject('SETUP_LOCAL_TARGET_MISMATCH');
        }
        const scoped = await auth.authenticateSilent(target.org_id);
        if (!scoped.success || scoped.user_id !== options.expectedUserId) {
          console.error(`flow setup: ${silentAuthFailureMessage(scoped)}`);
          return reject('SETUP_SIGN_IN_REQUIRED');
        }
        const service = new ServiceClient(options.serviceOrigin, devMode);
        service.setTokenProvider(() => auth.getValidToken());
        const remote = await service.getDecryptData(target.project_id, target.branch, undefined, true);
        return { remote_keep_hash: remote.keep_file ? SyncEngine.computeKeepHash(JSON.parse(remote.keep_file) as KeepFile, target.branch) : null };
      },
    });
    console.log(JSON.stringify(result)); return 0;
  } catch (error) {
    console.log(JSON.stringify(setupFailureResult(flowId, error)));
    return 1;
  }
}
