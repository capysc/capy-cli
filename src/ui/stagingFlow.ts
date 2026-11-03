import { RotateCommand } from '../commands/rotateCommand';
import { listManagedKeys } from '../commands/connectors/shared';
import type { KeepFile } from '../types';
import { CapyCommand } from '../commands/capyCommand';
import { pairForFlow } from '../commands/pairCommand';
import { ProjectManager } from '../core/projectManager';
import { resolveActiveUrl, isLocalOnly } from '../config/profileConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { FlowRuntimeError } from '../errors/flowRuntimeError';
import { runWithFlowInteraction } from './flowInteraction';
import { createJsonLineInteraction, runWithInteraction, currentInteraction, emitInteractionGoal } from './interaction';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { withStagingRepositoryLease } from '../auth/stagingRepositoryLease';

export function assertStagingFlowTargets(service: string, keep: string): void {
  const allowed = (value: string, pinned: string): boolean => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
        && (url.origin === pinned || ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch { return false; }
  };
  if (!allowed(service, 'https://staging-api.capy.sc') || !allowed(keep, 'https://staging-keep.capy.sc')) throw new FlowRuntimeError('STAGING_FLOW_TARGET_INVALID');
}

/** The host keeps the process active; account confirmation remains a human decision. */
export function assertStagingFlowEnvironment(): void {
  if (process.env.CAPY_BIN_NAME !== 'capy-staging' || process.env.CAPY_GLOBAL_DIR_NAME !== '.capy-staging' || isLocalOnly()) throw new FlowRuntimeError('STAGING_BINARY_REQUIRED');
  assertStagingFlowTargets(resolveActiveUrl(true), resolveKeepOrigin());
}

type StagingOperation = Readonly<{
  command: 'capy' | 'rotate';
  continuationTool: 'capy_onboard_continue' | 'capy_rotate_continue';
  operation: () => Promise<void>;
}>;

export async function runStagingFlow(): Promise<void> {
  return runStagingOperation({ command: 'capy', continuationTool: 'capy_onboard_continue',
    operation: () => new CapyCommand({ silentAuthOnly: true, protocol: false }, true).execute() });
}

export function stagingWorkOSRotationTargets(keep: KeepFile | null, branch: string | null, variable: string | undefined, all: boolean): readonly string[] {
  if (!keep || !branch) throw new FlowRuntimeError('ROTATE_FLOW_PROJECT_REQUIRED');
  if (all && variable) throw new FlowRuntimeError('ROTATE_FLOW_TARGET_AMBIGUOUS');
  if (!all && !variable) throw new FlowRuntimeError('ROTATE_FLOW_TARGET_REQUIRED');
  const targets = listManagedKeys(keep, branch).filter(target => all || target.varName === variable);
  if (targets.length === 0) throw new FlowRuntimeError('ROTATE_FLOW_MANAGED_TARGET_REQUIRED');
  if (targets.some(target => target.connector.provider !== 'workos')) throw new FlowRuntimeError('ROTATE_FLOW_PROVIDER_UNSUPPORTED');
  if (targets.some(target => target.connector.source === 'client-id')) throw new FlowRuntimeError('ROTATE_FLOW_TARGET_NOT_ROTATABLE');
  return targets.map(target => target.varName);
}

export async function runStagingRotateFlow(variable: string | undefined, options: Readonly<{ all?: boolean; noPush?: boolean }> = {}): Promise<void> {
  assertStagingFlowEnvironment();
  const manager = new ProjectManager();
  stagingWorkOSRotationTargets(manager.readKeepFile(), manager.deriveActiveBranch(), variable, options.all === true);
  return runStagingOperation({ command: 'rotate', continuationTool: 'capy_rotate_continue', operation: async () => {
    const interaction = currentInteraction();
    if (!interaction) throw new FlowRuntimeError('FLOW_INTERACTION_REQUIRED');
    // Sync and custody are prerequisites. Only the real rotation/push/deploy
    // result may terminate the initiating request.
    const names = await runWithInteraction({ ...interaction, goal: async () => undefined },
      () => new RotateCommand(true).execute(variable, { ...options, allowedProviders: ['workos'] }));
    await emitInteractionGoal({ flow: 'rotate', goal: 'credentials_rotated', status: names.length > 0 ? 'succeeded' : 'skipped',
      result: { variables: names, delivery: options.noPush ? 'local_only' : 'rotation_pipeline' } });
  } });
}

async function runStagingOperation(descriptor: StagingOperation): Promise<void> {
  assertStagingFlowEnvironment();
  return withStagingRepositoryLease(resolveInitRunIdentity().repositoryRoot, () => runStagingOperationWithLease(descriptor));
}

async function runStagingOperationWithLease(descriptor: StagingOperation): Promise<void> {
  const manager = new ProjectManager();
  const project = await manager.detectProjectState();
  const expectedUserId = project.initialized ? project.userId : undefined;
  const organizationId = project.initialized ? project.organizationId : undefined;
  const execute = (organization = organizationId, owner = expectedUserId): Promise<void> => runWithFlowInteraction(
    descriptor.operation, true,
    { command: descriptor.command, continuationTool: descriptor.continuationTool, organizationId: organization, expectedUserId: owner },
  );
  try { await execute(); }
  catch (error) {
    if (!(error instanceof FlowRuntimeError) || error.code !== 'PAIR_REQUIRED') throw error;
    const controller = new AbortController();
    const paired = await (async () => {
      try {
        return await runWithInteraction(createJsonLineInteraction(process.stdin, process.stdout, controller.signal), () => pairForFlow({
          json: true, flow: true, signup: descriptor.command === 'capy', devMode: true, expectedUserId, organizationId,
          ...(descriptor.command === 'capy'
            ? { title: 'Set up this project', description: 'Sign in, protect or reuse Transport, and enable this location before reviewing project setup.' }
            : { title: 'Rotate project credentials', description: 'Sign in and reuse your current custody before reviewing WorkOS credential rotation.' }),
        }));
      } finally { controller.abort(); }
    })();
    const selected = organizationId ? paired.paired.find(entry => entry.org_id === organizationId) : paired.paired[0];
    if (!selected || selected.user_id !== paired.userId) throw new FlowRuntimeError('AUTH_ACCOUNT_MISMATCH');
    manager.writeSyncStateUserId(paired.userId);
    await execute(selected.org_id, paired.userId);
  }
}
