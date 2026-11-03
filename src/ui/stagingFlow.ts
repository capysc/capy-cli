import { CapyCommand } from '../commands/capyCommand';
import { pairForFlow } from '../commands/pairCommand';
import { ProjectManager } from '../core/projectManager';
import { resolveActiveUrl, isLocalOnly } from '../config/profileConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { FlowRuntimeError } from '../errors/flowRuntimeError';
import { runWithFlowInteraction } from './flowInteraction';
import { createJsonLineInteraction, runWithInteraction } from './interaction';
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

export async function runStagingFlow(): Promise<void> {
  assertStagingFlowEnvironment();
  return withStagingRepositoryLease(resolveInitRunIdentity().repositoryRoot, runStagingFlowWithLease);
}

async function runStagingFlowWithLease(): Promise<void> {
  const manager = new ProjectManager();
  const project = await manager.detectProjectState();
  const expectedUserId = project.initialized ? project.userId : undefined;
  const organizationId = project.initialized ? project.organizationId : undefined;
  const execute = (organization = organizationId, owner = expectedUserId): Promise<void> => runWithFlowInteraction(
    () => new CapyCommand({ silentAuthOnly: true, protocol: false }, true).execute(), true,
    { command: 'capy', continuationTool: 'capy_onboard_continue', organizationId: organization, expectedUserId: owner },
  );
  try { await execute(); }
  catch (error) {
    if (!(error instanceof FlowRuntimeError) || error.code !== 'PAIR_REQUIRED') throw error;
    const controller = new AbortController();
    const paired = await (async () => {
      try {
        return await runWithInteraction(createJsonLineInteraction(process.stdin, process.stdout, controller.signal), () => pairForFlow({
          json: true, flow: true, signup: true, devMode: true, expectedUserId, organizationId,
          title: 'Set up this project', description: 'Sign in, protect or reuse Transport, and enable this location before reviewing project setup.',
        }));
      } finally { controller.abort(); }
    })();
    const selected = organizationId ? paired.paired.find(entry => entry.org_id === organizationId) : paired.paired[0];
    if (!selected || selected.user_id !== paired.userId) throw new FlowRuntimeError('AUTH_ACCOUNT_MISMATCH');
    manager.writeSyncStateUserId(paired.userId);
    await execute(selected.org_id, paired.userId);
  }
}
