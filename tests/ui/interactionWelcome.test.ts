import { describe, expect, test } from 'bun:test';
import { emitInteractionWelcome, runWithInteraction } from '../../src/ui/interaction';

describe('Interaction welcome metadata', () => {
  test('is delivered only to an installed interaction without terminal output', async () => {
    const received = Promise.withResolvers<unknown>();
    await runWithInteraction({
      output: event => { received.resolve(event); },
      progress: () => undefined,
      prompt: async () => null,
      goal: () => undefined,
    }, async () => {
      emitInteractionWelcome({ username: null, project: 'web', organization: 'Northwind', branch: 'main', flowName: 'Sync' });
    });

    expect(await received.promise).toEqual({
      text: '',
      welcome: { username: null, project: 'web', organization: 'Northwind', branch: 'main', flowName: 'Sync' },
    });
  });
});
