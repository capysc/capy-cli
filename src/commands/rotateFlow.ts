import { RotateCommand } from './rotateCommand';
import { inspectLocalRotateReadiness } from './rotateReadiness';
import { listManagedKeys, findManagedConnector } from './connectors/shared';
import { ProjectManager } from '../core/projectManager';
import type { RotateOpts } from './connectors/registry';
import { runWithFlowInteraction } from '../ui/flowInteraction';
import { runComposedDeviceGrant } from './composedDeviceGrant';

type Options = RotateOpts & Readonly<{ all?: boolean; skipPrompts?: boolean; provider?: string }>;
/** Inspection precedes conversation creation. Capy pairing and provider CLI installation remain local prerequisites. */
export async function runRotateFlow(variable: string | undefined, options: Options, devMode: boolean): Promise<void> {
  const manager = new ProjectManager();
  const keep = manager.readKeepFile();
  const branch = manager.deriveActiveBranch();
  const targets = keep && branch ? options.all ? listManagedKeys(keep, branch)
    : variable ? [{ connector: findManagedConnector(keep, variable, branch) }] : [] : [];
  const workos = targets.length > 0 ? targets.every(target => target.connector?.provider === 'workos'
    || (!target.connector && options.provider === 'workos')) : options.provider === 'workos';
  if (!workos) throw new Error('ROTATE_FLOW_WORKOS_REQUIRED');
  const readiness = await inspectLocalRotateReadiness({ ...options, devMode });
  if (!readiness.ready) {
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    process.exitCode = 1;
    return;
  }
  const execute = () => runWithFlowInteraction(() => new RotateCommand(devMode).execute(variable, { ...options, web: false, flowProvider: 'workos' }), devMode,
    { command: 'rotate', continuationTool: 'capy_rotate_continue', expectedUserId: options.expectedUserId });
  try { await execute(); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'CONVERSATION_RUNTIME_UNAVAILABLE') throw error;
    const project = await manager.detectProjectState();
    const expectedUserId = options.expectedUserId ?? project.userId;
    const code = await runComposedDeviceGrant(undefined, expectedUserId, async continuation => {
      if (expectedUserId && expectedUserId !== continuation.userId) throw new Error('AUTH_ACCOUNT_MISMATCH');
      await execute();
    });
    if (code !== 0) throw new Error('PAIR_FAILED');
  }
}
