import { RotateCommand } from './rotateCommand';
import { inspectLocalRotateReadiness } from './rotateReadiness';
import { listManagedKeys, findManagedConnector } from './connectors/shared';
import { ProjectManager } from '../core/projectManager';
import type { RotateOpts } from './connectors/registry';
import { runWithFlowInteraction } from '../ui/flowInteraction';

type Options = RotateOpts & Readonly<{ all?: boolean; skipPrompts?: boolean; provider?: string }>;
/** Inspection precedes conversation creation. Pair and provider login remain local prerequisites. */
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
  await runWithFlowInteraction(() => new RotateCommand(devMode).execute(variable, { ...options, web: false, flowProvider: 'workos' }), devMode,
    { command: 'rotate', continuationTool: 'capy_rotate_continue', expectedUserId: options.expectedUserId });
}
