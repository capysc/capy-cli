import { RotateCommand } from './rotateCommand';
import { inspectLocalRotateReadiness } from './rotateReadiness';
import { listManagedKeys, findManagedConnector } from './connectors/shared';
import { ProjectManager } from '../core/projectManager';
import type { RotateOpts } from './connectors/registry';
import { runWithFlowInteraction } from '../ui/flowInteraction';
import { runComposedDeviceGrant } from './composedDeviceGrant';

type Options = RotateOpts & Readonly<{ all?: boolean; skipPrompts?: boolean; provider?: string }>;

export const canRecoverCapyReadiness = (readiness: Awaited<ReturnType<typeof inspectLocalRotateReadiness>>): boolean =>
  readiness.checks.some((check) => check.code === 'ROTATE_CAPY_AUTH' && !check.ready)
  && readiness.checks.every((check) => check.ready || check.code === 'ROTATE_CAPY_AUTH');

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
  const execute = () => runWithFlowInteraction(() => new RotateCommand(devMode).execute(variable, { ...options, web: false, flowProvider: 'workos' }), devMode,
    { command: 'rotate', continuationTool: 'capy_rotate_continue', expectedUserId: options.expectedUserId });
  const recoverThenExecute = async (): Promise<void> => {
    const project = await manager.detectProjectState();
    const expectedUserId = options.expectedUserId ?? project.userId;
    const code = await runComposedDeviceGrant(undefined, expectedUserId, async continuation => {
      if (expectedUserId && expectedUserId !== continuation.userId) throw new Error('AUTH_ACCOUNT_MISMATCH');
      const rechecked = await inspectLocalRotateReadiness({ ...options, devMode, expectedUserId: continuation.userId });
      if (!rechecked.ready) throw new Error('ROTATE_READINESS_RECHECK_FAILED');
      await execute();
    });
    if (code !== 0) throw new Error('PAIR_FAILED');
  };
  if (!readiness.ready && !canRecoverCapyReadiness(readiness)) {
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!readiness.ready) return recoverThenExecute();
  try { await execute(); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'CONVERSATION_RUNTIME_UNAVAILABLE') throw error;
    await recoverThenExecute();
  }
}
