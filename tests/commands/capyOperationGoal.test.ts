import { expect, mock, test } from 'bun:test';
import { CapyCommand } from '../../src/commands/capyCommand';
import { runWithInteraction, type InteractionGoal } from '../../src/ui/interaction';

const methods = CapyCommand.prototype as unknown as Readonly<{
  execute: (this: unknown) => Promise<void>;
  initializeProjectWithLocalWizard: (this: unknown) => Promise<InteractionGoal>;
}>;

for (const status of ['succeeded', 'cancelled', 'failed-after-consent'] as const) {
  test(`the actual initialization caller preserves ${status}`, async () => {
    const result = await methods.initializeProjectWithLocalWizard.call({
      options: { web: false },
      runInitialization: async () => ({
        wizard: null, status,
        target: { orgId: 'org', projectId: 'project', branch: 'development' },
        failure: { code: 'SYNC_REJECTED', reason: 'The service rejected the write.' },
      }),
    });
    expect(result.status).toBe(status === 'failed-after-consent' ? 'failed' : status);
    if (status === 'failed-after-consent') expect(result).toMatchObject({ code: 'SYNC_REJECTED', message: 'The service rejected the write.' });
  });
}

test('root routing binds onboarding before calling the operation and preserves its failure', async () => {
  const terminal = mock(async (_goal: InteractionGoal) => undefined);
  await runWithInteraction({ output: () => undefined, progress: () => undefined, prompt: async () => null, goal: terminal }, () => methods.execute.call({
    projectManager: { detectProjectState: async () => ({ initialized: false }), readSyncState: () => null },
    initializeProject: async () => ({ status: 'failed', code: 'SYNC_REJECTED' }),
    debugError: () => undefined,
  }));
  expect(terminal.mock.calls).toEqual([[{ flow: 'init-wizard', goal: 'repository_onboarded', status: 'failed', code: 'SYNC_REJECTED' }]]);
});
