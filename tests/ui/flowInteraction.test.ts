import { describe, expect, test } from 'bun:test';
import { flowTurnPayload } from '../../src/ui/flowInteraction';

describe('Flow turn payloads', () => {
  test('preserves CLI event order and omits presentation when the CLI did not supply it', () => {
    const messages = [
      { type: 'output' as const, data: { text: 'Preparing repository' } },
      { type: 'progress' as const, data: { status: 'success', text: 'First sync complete' } },
    ] as const;

    expect(flowTurnPayload(messages, {
      type: 'prompt',
      data: { question: { text: 'Continue?' } },
    })).toEqual({
      type: 'turn',
      messages,
      question: { text: 'Continue?' },
    });
  });

  test('carries only explicit presentation metadata on the existing turn boundary', () => {
    const payload = flowTurnPayload([], {
      type: 'goal',
      data: {
        status: 'succeeded',
        presentation: { title: 'Repository ready', component: 'repository-sync' },
      },
    });

    expect(payload).toEqual({
      type: 'turn',
      messages: [],
      outcome: {
        status: 'succeeded',
      },
      presentation: { title: 'Repository ready', component: 'repository-sync' },
    });
  });

  test('does not infer presentation from ordinary CLI text', () => {
    expect(flowTurnPayload([], {
      type: 'goal',
      data: { status: 'succeeded', message: 'Repository ready\nOpen the dashboard.' },
    })).not.toHaveProperty('presentation');
  });
});
