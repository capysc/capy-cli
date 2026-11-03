import type { Command } from 'commander';

const stagingFlowAction = async (operation: () => Promise<void>): Promise<void> => {
  try { await operation(); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'STAGING_FLOW_FAILED';
    console.log(JSON.stringify(code === 'FLOW_CANCELLED' ? { ok: true, outcome: 'cancelled', code } : { ok: false, code }));
    process.exitCode = code === 'FLOW_CANCELLED' ? 0 : 1;
  }
};

export function registerStagingFlowCommands(program: Command): void {
  const hidden = process.env.CAPY_BIN_NAME !== 'capy-staging';

  program.command('onboard', { hidden })
    .description('Run the staging browser flow with an active host continuation')
    .option('--json', 'emit flow handoffs and host events as JSON')
    .action(async () => stagingFlowAction(async () => {
      const { runStagingFlow } = await import('../ui/stagingFlow');
      await runStagingFlow();
    }));

  program.command('rotate-flow [variable]', { hidden })
    .description('Run the staging WorkOS rotation browser flow')
    .option('--all', 'rotate all managed WorkOS keys on the active branch')
    .option('--no-push', 'rotate locally without pushing or deploying')
    .option('--json', 'emit flow handoffs and host events as JSON')
    .action(async (variable, options) => stagingFlowAction(async () => {
      const { runStagingRotateFlow } = await import('../ui/stagingFlow');
      await runStagingRotateFlow(variable, { all: options.all === true, noPush: options.push === false });
    }));

  program.command('flow', { hidden })
    .description('Attach to an active staging flow or reconnect its supported checkpoint')
    .requiredOption('--id <flow-id>', 'the exact flow to attach')
    .option('--json', 'emit the host attachment protocol')
    .option('--resume', 'resume a supported project-setup checkpoint')
    .option('--abandon', 'cancel this flow without replaying its command')
    .action(async (options) => stagingFlowAction(async () => {
      const { assertStagingFlowEnvironment } = await import('../ui/stagingFlow');
      assertStagingFlowEnvironment();
      if (options.resume || options.abandon) {
        const { runResumedFlowInteraction } = await import('../ui/flowInteraction');
      if (options.resume && !options.abandon) {
        const { resolveInitRunIdentity } = await import('../auth/initRunIdentity');
        const { withStagingRepositoryLease } = await import('../auth/stagingRepositoryLease');
        await withStagingRepositoryLease(resolveInitRunIdentity().repositoryRoot, () => runResumedFlowInteraction(options.id, true));
        return;
      }
        await runResumedFlowInteraction(options.id, true, options.abandon === true);
        return;
      }
      const { runFlowAgentCommand } = await import('./flowAgentCommand');
      process.exitCode = await runFlowAgentCommand(process.stdin, process.stdout, { flowId: options.id, devMode: true });
    }));

}
