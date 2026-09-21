import type { CliOptions } from '../types/index';
import { CapyCommand } from '../commands/capyCommand';
import { ProjectManager } from '../core/projectManager';
import { runComposedDeviceGrant } from '../commands/composedDeviceGrant';
import { runWithFlowInteraction } from './flowInteraction';

/** Pair supplies identity/custody; the existing root command owns everything after it. */
export async function runCapyFlow(options: CliOptions, devMode: boolean): Promise<void> {
  const execute = (organizationId?: string, expectedUserId?: string) => runWithFlowInteraction(
    () => new CapyCommand({...options, web:false}, devMode).execute(),
    devMode,
    { command: 'capy', continuationTool: 'capy_onboard_continue', organizationId, expectedUserId },
  );
  try { await execute(); }
  catch (error) {
    if (!(error instanceof Error)
      || !['PAIR_REQUIRED', 'CONVERSATION_RUNTIME_UNAVAILABLE'].includes(error.message)) throw error;
    const existing = await new ProjectManager().detectProjectState();
    const expectedUserId = options.expectedUserId ?? (existing.initialized ? existing.userId : undefined);
    const code = await runComposedDeviceGrant(undefined, expectedUserId, async continuation => {
      const manager = new ProjectManager();
      const project = await manager.detectProjectState();
      if (project.initialized && project.userId && project.userId !== continuation.userId) throw new Error('AUTH_ACCOUNT_MISMATCH');
      manager.writeSyncStateUserId(continuation.userId);
      await execute(continuation.organizationId, continuation.userId);
    });
    if (code !== 0) throw new Error('PAIR_FAILED');
  }
}
