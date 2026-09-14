import { describe, expect, test, mock } from 'bun:test';
import inquirer from 'inquirer';
import { prompt, runWithInteraction, ExitPromptError, type Interaction, type InteractionQuestion } from '../../src/ui/interaction';

const adapter = (answer: (question: InteractionQuestion<unknown>) => unknown): Interaction => ({
  output: () => undefined, progress: () => undefined, goal: () => undefined,
  prompt: async <T>(question: InteractionQuestion<T>) => {
    const decided = question.decide({ value: answer(question) });
    if ('error' in decided) throw new Error(decided.error);
    return decided.value;
  },
});

describe('ordinary CLI question adapter', () => {
  test('asks all fields in order with prior answers, filters, and conditional questions', async () => {
    const question = mock((input: InteractionQuestion<unknown>) => {
      const view = input.view as { text: string };
      return view.text === 'Worker name' ? '  worker  ' : 'apps/worker';
    });
    const result = await runWithInteraction(adapter(question), () => prompt([
      { name: 'name', message: 'Worker name', filter: (value: string) => value.trim() },
      { name: 'directory', message: (answers: { name: string }) => `Directory for ${answers.name}`, when: (answers: { name: string }) => answers.name === 'worker' },
      { name: 'unused', message: 'Not asked', when: false },
    ]));
    expect(result).toEqual({ name: 'worker', directory: 'apps/worker' });
    expect(question.mock.calls.map(([input]) => (input.view as { text: string }).text)).toEqual(['Worker name', 'Directory for worker']);
  });

  test('checkbox decodes tokens, preserves defaults, rejects duplicate/disabled/unknown choices', async () => {
    const choices = [{ name: 'API', value: 'API_KEY', checked: true }, new inquirer.Separator(),
      { name: 'Public', value: 'PUBLIC_ID' }, { name: 'Unavailable', value: 'DISABLED', disabled: true }];
    const result = await runWithInteraction(adapter(question => {
      expect(question.view).toEqual({ text: 'Variables', input: { kind: 'checkbox', choices: [
        { label: 'API', value: 'choice:0', disabled: false }, { label: 'Public', value: 'choice:2', disabled: false },
        { label: 'Unavailable', value: 'choice:3', disabled: true },
      ], default: ['choice:0'] } });
      for (const invalid of [['choice:0', 'choice:0'], ['choice:3'], ['unknown'], 'choice:0']) {
        expect(question.decide({ value: invalid })).toHaveProperty('error');
      }
      return ['choice:0', 'choice:2'];
    }), () => prompt([{ name: 'vars', type: 'checkbox', message: 'Variables', choices,
      validate: (values: readonly string[]) => values.length > 0 || 'Select a variable.' }]));
    expect(result).toEqual({ vars: ['API_KEY', 'PUBLIC_ID'] });
  });

  test('object and null choices remain original CLI values without exposing objects', async () => {
    const original = { projectId: 'project_fixture', internal: 'not-a-browser-field' };
    const result = await runWithInteraction(adapter(question => {
      expect(JSON.stringify(question.view)).not.toContain('not-a-browser-field');
      return (question.view as { text: string }).text === 'Project' ? 'choice:0' : 'choice:1';
    }), () => prompt([
      { name: 'project', type: 'list', message: 'Project', choices: [{ name: 'Fixture', value: original }] },
      { name: 'optional', type: 'list', message: 'Optional', choices: [{ name: 'Fixture', value: original }, { name: 'None', value: null }] },
    ]));
    expect(result.project).toBe(original);
    expect(result.optional).toBeNull();
  });

  test('EOF/cancel is separate from an accepted null choice', async () => {
    const interaction: Interaction = { ...adapter(() => true), prompt: async () => null };
    await expect(runWithInteraction(interaction, () => prompt([{ name: 'x', type: 'confirm', message: 'Proceed?' }]))).rejects.toBeInstanceOf(ExitPromptError);
  });
});
