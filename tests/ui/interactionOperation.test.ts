import { describe, expect, mock, test } from 'bun:test';
import { currentInteractionInvocation, emitInteractionGoal, runInteractionOperation, runWithInteraction, type Interaction, type InteractionGoal } from '../../src/ui/interaction';

const invocation = { flow: 'init-wizard', goal: 'repository_onboarded' } as const;
const adapter = (goal: Interaction['goal']): Interaction => ({
  output: () => undefined, progress: () => undefined, prompt: async () => null, goal,
});
const failed = (error: unknown): InteractionGoal => ({ status: 'failed', message: error instanceof Error ? error.message : 'Failed' });

describe('operation-owned terminal outcomes', () => {
  test('prerequisite success cannot finish onboarding; terminal waits for required writes', async () => {
    const terminal = mock(async (_outcome: InteractionGoal) => undefined);
    const writes = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const run = runWithInteraction(adapter(terminal), () => runInteractionOperation(invocation, async () => {
      expect(currentInteractionInvocation()).toEqual(invocation);
      await emitInteractionGoal({ status: 'succeeded', goal: 'authentication' });
      entered.resolve();
      await writes.promise;
      return { status: 'succeeded', result: { secrets_encrypted: true } };
    }, failed));
    await entered.promise;
    expect(terminal).not.toHaveBeenCalled();
    writes.resolve();
    await run;
    expect(terminal.mock.calls).toEqual([[{ ...invocation, status: 'succeeded', result: { secrets_encrypted: true } }]]);
    expect(currentInteractionInvocation()).toBeUndefined();
  });

  for (const status of ['succeeded', 'skipped', 'cancelled', 'failed'] as const) {
    test(`preserves the operation's ${status} outcome exactly once`, async () => {
      const terminal = mock(async (_outcome: InteractionGoal) => undefined);
      await runWithInteraction(adapter(terminal), () => runInteractionOperation(invocation, async () => ({ status }), failed));
      expect(terminal.mock.calls).toEqual([[{ ...invocation, status }]]);
    });
  }

  test('failed required write produces failure, never success', async () => {
    const terminal = mock(async (_outcome: InteractionGoal) => undefined);
    await runWithInteraction(adapter(terminal), () => runInteractionOperation(invocation, async () => { throw new Error('sync rejected'); }, failed));
    expect(terminal.mock.calls).toEqual([[{ ...invocation, status: 'failed', message: 'sync rejected' }]]);
  });

  test('terminal transport rejection propagates without trying a second goal', async () => {
    const terminal = mock(async (_outcome: InteractionGoal) => { throw new Error('transport closed'); });
    await expect(runWithInteraction(adapter(terminal), () => runInteractionOperation(invocation, async () => ({ status: 'succeeded' }), failed))).rejects.toThrow('transport closed');
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test('an interruption escapes without publishing a terminal outcome', async () => {
    const terminal = mock(async (_outcome: InteractionGoal) => undefined);
    const interrupted = new Error('INIT_RUN_EXPIRED');
    await expect(runWithInteraction(adapter(terminal), () => runInteractionOperation(invocation,
      async () => { throw interrupted; },
      error => { throw error; },
    ))).rejects.toBe(interrupted);
    expect(terminal).not.toHaveBeenCalled();
  });

  test('does not declare onboarding for an unrelated command', async () => {
    const terminal = mock(async (_outcome: InteractionGoal) => undefined);
    await runWithInteraction(adapter(terminal), () => runInteractionOperation(undefined, async () => ({ status: 'succeeded' }), failed));
    expect(terminal.mock.calls).toEqual([[{ status: 'succeeded' }]]);
  });
});
