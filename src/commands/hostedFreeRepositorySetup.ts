import type { AuthService } from '../auth/authService';
import { isInitRunFingerprint } from '../auth/initRunContract';
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES } from '../types';
import { askHostedInitChannel, HostedInitChannelError } from '../ui/hostedInitChannel';
import type { HostedInitWizardSession } from '../ui/hostedInitWizardSession';
import { SetupCommand } from './setupCommand';

type JsonResult = Readonly<Record<string, unknown>>;
export type HostedFreeSetupTarget = Readonly<{
  orgId: string; orgName: string; projectId: string; projectName: 'default'; branch: 'development';
}>;
type ConfirmationRequest = Readonly<{ flow_id: string; kind: 'onboard_plan'; decision_id: string }>;
type FreeSyncAction = 'push_root_env' | 'fetch_remote' | 'create_empty_remote_marker';
export type HostedFreeSetupPresentation = Readonly<{
  kind: 'onboard_plan'; state: 'ready'; request: ConfirmationRequest;
  summary: Readonly<{
    project: 'default'; branch: 'development'; operation: 'setup'; sync_action: FreeSyncAction;
    variable_names: readonly string[]; write_paths: readonly string[]; removed_names: readonly string[];
  }>;
}>;
export type HostedFreeSetupResult =
  | Readonly<{ kind: 'applied'; session: HostedInitWizardSession; planHash: string }>
  | Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }>
  | Readonly<{ kind: 'failed'; session: HostedInitWizardSession; error: unknown }>;

const record = (value: unknown): value is JsonResult =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: JsonResult, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const names = (value: unknown): value is readonly string[] => Array.isArray(value)
  && value.length <= 2000
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 255 && !/[\u0000-\u001f\u007f-\u009f]/u.test(item))
  && new Set(value).size === value.length;
const reject = (code = 'INIT_RUN_INVALID'): never => {
  throw new CapyError('Hosted repository setup could not be verified', code);
};
const requireSuccess = (value: JsonResult): void => {
  if (value.ok === true) return;
  reject(typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value.code)
    ? value.code : ERROR_CODES.SERVICE_ERROR);
};
const matchesTarget = (value: JsonResult, target: HostedFreeSetupTarget): boolean =>
  value.action === 'adopt_project' && value.sync_mode === 'free' && value.keep_lock_path === null
  && value.branch === target.branch
  && record(value.org) && value.org.id === target.orgId && value.org.name === target.orgName
  && record(value.project) && value.project.id === target.projectId
  && value.project.name === target.projectName && value.project.status === 'existing';

/** Project only the existing setup plan's names and paths; never its command or secret values. */
export function hostedFreeSetupPresentation(
  value: JsonResult, target: HostedFreeSetupTarget, runId: string,
): HostedFreeSetupPresentation {
  requireSuccess(value);
  if (!matchesTarget(value, target) || !isInitRunFingerprint(value.plan_hash)
    || !record(value.env) || !names(value.env.variable_names)
    || !names(value.will_write) || !value.will_write.every(path => path === '.env')
    || !names(value.removed_remote_variable_names) || value.removed_remote_variable_names.length !== 0
    || typeof value.sync_action !== 'string'
    || !['push_root_env', 'fetch_remote', 'create_empty_remote_marker'].includes(value.sync_action)) {
    return reject();
  }
  return {
    kind: 'onboard_plan', state: 'ready',
    request: { flow_id: runId, kind: 'onboard_plan', decision_id: value.plan_hash },
    summary: {
      project: 'default', branch: 'development', operation: 'setup',
      sync_action: value.sync_action as FreeSyncAction,
      variable_names: [...value.env.variable_names], write_paths: [...value.will_write], removed_names: [],
    },
  };
}

/** Await the actual existing executor, including errors after its reported result. */
async function captureSetup(run: (report: (result: JsonResult) => void) => Promise<void>): Promise<JsonResult> {
  const reported = Promise.withResolvers<JsonResult>();
  const completed = Promise.resolve().then(() => run(reported.resolve))
    .then(() => { reported.reject(new CapyError('Setup returned no result', 'SETUP_RESULT_MISSING')); }, error => {
      reported.reject(error);
      throw error;
    });
  const [result] = await Promise.all([reported.promise, completed]);
  return result;
}

export async function runHostedFreeRepositorySetup(input: Readonly<{
  target: HostedFreeSetupTarget;
  authService: AuthService;
  serviceClient: ServiceClient;
  session: HostedInitWizardSession;
  devMode: boolean;
  envPath?: string;
  /** A test seam around the real SetupCommand plan/confirm API, not another executor. */
  execute?: (confirm?: string) => Promise<JsonResult>;
}>): Promise<HostedFreeSetupResult> {
  const { target } = input;
  const guard = (): void => {
    const { channel } = input.session;
    if (input.session.ended || channel.now() >= channel.deadline) throw new HostedInitChannelError('INIT_RUN_EXPIRED');
    input.authService.assertRefreshAuthorityAvailable();
    const token = input.authService.getToken();
    if (input.authService.getServiceApiUrl() !== channel.binding.service_origin
      || input.authService.getOrganizationId() !== target.orgId
      || token?.user_id !== channel.binding.subject_user_id || token.organization_id !== target.orgId) {
      throw new HostedInitChannelError('INIT_BINDING_MISMATCH');
    }
  };
  const execute = input.execute ?? ((confirm?: string) => captureSetup(report =>
    new SetupCommand({ envPath: input.envPath }, input.devMode, report, {
      authService: input.authService, serviceClient: input.serviceClient, checkOperation: guard,
    }).execute({ org: target.orgId, project: target.projectId,
      expectedUserId: input.session.channel.binding.subject_user_id, expectedSyncMode: 'free', confirm })));
  const planned = await (async () => {
    try {
      guard();
      const plan = await execute();
      guard();
      return { kind: 'ready' as const, presentation: hostedFreeSetupPresentation(plan, target, input.session.channel.binding.run_id) };
    } catch (error) {
      return { kind: 'failed' as const, session: input.session, error };
    }
  })();
  if (planned.kind === 'failed') return planned;
  const presentation = planned.presentation;
  const answered = await (async () => {
    try {
      return await askHostedInitChannel<boolean, HostedFreeSetupPresentation>({
        channel: input.session.channel, screen: 'flow-confirm', data: presentation,
        decide: payload => {
          if (!exactKeys(payload, ['request', 'approved']) || typeof payload.approved !== 'boolean'
            || !record(payload.request) || !exactKeys(payload.request, ['flow_id', 'kind', 'decision_id'])
            || payload.request.flow_id !== presentation.request.flow_id
            || payload.request.kind !== presentation.request.kind
            || payload.request.decision_id !== presentation.request.decision_id) return reject('INIT_BINDING_MISMATCH');
          return { value: payload.approved };
        },
      });
    } catch (error) {
      return { kind: 'failed' as const, session: input.session, error };
    }
  })();
  if (answered.kind === 'failed') return answered;
  const session: HostedInitWizardSession = {
    ...input.session, channel: answered.channel, step: 'encrypt',
    input: { ...input.session.input, projectCount: 1, project: { kind: 'existing', name: target.projectName },
      branchChoice: 'development', branchName: target.branch, localEnvCount: presentation.summary.variable_names.length },
  };
  if (answered.kind === 'cancelled' || !answered.value) return { kind: 'cancelled', session };
  try {
    guard();
    // SetupCommand recomputes billing, target and plan before its existing hash gate and any apply.
    const applied = await execute(presentation.request.decision_id);
    guard();
    requireSuccess(applied);
    if (!matchesTarget(applied, target) || applied.sync_action !== presentation.summary.sync_action) return reject();
    return { kind: 'applied', session: { ...session, input: { ...session.input, encrypt: true } },
      planHash: presentation.request.decision_id };
  } catch (error) {
    return { kind: 'failed', session, error };
  }
}
