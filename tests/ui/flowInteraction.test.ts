import { describe, expect, mock, test } from 'bun:test';
import { flowQueueStep, flowTurnPayload, isHumanFlowRun } from '../../src/ui/flowInteraction';

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

  test('persists the declared invocation and terminal goal inside encrypted turn payloads', () => {
    const invocation = { flow: 'init-wizard', goal: 'repository_onboarded' };
    expect(flowTurnPayload([], { type: 'prompt', data: { invocation, question: { text: 'Encrypt?' } } }))
      .toMatchObject({ invocation, question: { text: 'Encrypt?' } });
    expect(flowTurnPayload([], { type: 'goal', data: { ...invocation, status: 'succeeded', result: { secrets_encrypted: true } } }))
      .toMatchObject({ outcome: { ...invocation, status: 'succeeded', result: { secrets_encrypted: true } } });
  });

  test('does not infer presentation from ordinary CLI text', () => {
    expect(flowTurnPayload([], {
      type: 'goal',
      data: { status: 'succeeded', message: 'Repository ready\nOpen the dashboard.' },
    })).not.toHaveProperty('presentation');
  });

  test('flushes buffered CLI output before a provider-auth handoff', () => {
    const buffered = flowQueueStep([], { type: 'output', data: { text: 'Opening provider login' } });
    const flushed = flowQueueStep(buffered.nextItems, {
      type: 'progress',
      data: { status: 'start', text: 'Sign in with WorkOS', provider_auth: { state: 'pending' } },
    });

    expect(flushed).toEqual({
      nextItems: [],
      writes: [
        { type: 'output', data: { text: 'Opening provider login' } },
        { type: 'progress', data: { status: 'start', text: 'Sign in with WorkOS', provider_auth: { state: 'pending' } } },
      ],
    });
  });

  test('keeps the browser answer correlation on the closing prompt turn', () => {
    const step = flowQueueStep([{ type: 'progress', data: { status: 'success', text: 'Repository inspected' } }], {
      type: 'prompt',
      correlation: 'request-123',
      data: { question: { text: 'Apply this setup?' } },
    });

    expect(step).toEqual({
      nextItems: [],
      writes: [{
        type: 'prompt',
        correlation: 'request-123',
        data: {
          type: 'turn',
          messages: [{ type: 'progress', data: { status: 'success', text: 'Repository inspected' } }],
          question: { text: 'Apply this setup?' },
        },
      }],
    });
  });
});

describe('Who gets the human path', () => {
  const opened = () => 'default-browser';
  const suppressed = () => 'suppressed';

  test('only a terminal run that asked for the handoff and may open a browser', () => {
    expect(isHumanFlowRun(true, true, opened)).toBe(true);
  });

  test('an agent or piped stdout keeps the JSON contract', () => {
    expect(isHumanFlowRun(true, undefined, opened)).toBe(false);
    expect(isHumanFlowRun(true, false, opened)).toBe(false);
  });

  test('a run that may not open a browser keeps the JSON contract', () => {
    expect(isHumanFlowRun(true, true, suppressed)).toBe(false);
  });

  test('a command that never asked for the handoff never consults the browser plan', () => {
    const plan = mock(() => 'default-browser');
    expect(isHumanFlowRun(undefined, true, plan)).toBe(false);
    expect(isHumanFlowRun(false, true, plan)).toBe(false);
    expect(plan).not.toHaveBeenCalled();
  });
});
