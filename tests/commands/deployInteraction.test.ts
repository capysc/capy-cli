import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeployTarget } from '../../src/commands/deployCommand';
import { ExitPromptError, runWithInteraction, type InteractionQuestion } from '../../src/ui/interaction';

type QuestionView = Readonly<{ text: string; input: Readonly<{ kind: string; choices?: readonly Readonly<{ label: string; value: string }>[]; default?: unknown }> }>;
type Answer = string | readonly string[] | Readonly<{ choice: string }>;
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'capy-rotate-deploy-interaction-'));
  writeFileSync(join(cwd, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: 'org-fixture', project_id: 'project-fixture',
    variables: { API_KEY: [{ branch: 'development' }], DATABASE_URL: [{ branch: 'development' }] } }));
  writeFileSync(join(cwd, '.env'), 'API_KEY=never-render-this-value\nDATABASE_URL=never-render-this-either\n');
  return cwd;
};
const valueFor = (view: QuestionView, answer: Answer): unknown => {
  if (typeof answer === 'string') return answer;
  const token = (label: string) => {
    const choice = view.input.choices?.find(choice => choice.label.replace(/\x1b\[[0-9;]*m/g, '').startsWith(label));
    if (!choice) throw new Error(`Missing offered choice: ${label}`);
    return choice.value;
  };
  return 'choice' in answer ? token(answer.choice) : answer.map(token);
};

describe('deployment setup through the shared CLI Interaction', () => {
  for (const selectedKind of [undefined, 'cf-worker'] as const) {
  test(`asks every setting and preserves the ${selectedKind ?? 'interactive'} adapter selection`, async () => {
    const cwd = fixture();
    if (selectedKind) {
      mkdirSync(join(cwd, '.capy'), { recursive: true });
      writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify({ version: '1', targets: { other: { name: 'other', kind: 'vercel' } } }));
    }
    const answers: readonly Answer[] = [...(selectedKind ? [] : [{ choice: 'Cloudflare Workers' }]), { choice: 'development' }, 'fixture-worker', '.', ['API_KEY'], { choice: 'Deploy directly' }, 'fixture-target'];
    const output = mock(() => {});
    const prompted = mock(async <T>(question: InteractionQuestion<T>): Promise<T | null> => {
      const view = question.view as QuestionView;
      const answer = answers[prompted.mock.calls.length - 1];
      if (view.input.kind === 'checkbox') expect(question.decide({ value: [] })).toEqual({ error: 'select at least one' });
      const result = question.decide({ value: valueFor(view, answer) });
      if ('error' in result) throw new Error(result.error);
      return result.value;
    });
    try {
      const target = await runWithInteraction({ output, progress: () => {}, goal: () => {}, prompt: prompted }, () => ensureDeployTarget(cwd, {}, selectedKind));
      expect(prompted).toHaveBeenCalledTimes(answers.length);
      expect(target).toEqual({ name: 'fixture-target', kind: 'cf-worker', branch: 'development',
        vars: ['API_KEY'], knownVars: ['API_KEY', 'DATABASE_URL'], options: { workerName: 'fixture-worker', workerDir: '.' }, mode: 'direct', gitBaseBranch: undefined });
      expect(JSON.parse(readFileSync(join(cwd, '.capy/deploy.json'), 'utf8')).targets['fixture-target']).toMatchObject({ vars: ['API_KEY'], options: { workerName: 'fixture-worker', workerDir: '.' } });
      expect(JSON.stringify(output.mock.calls)).not.toContain('never-render-this');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  }
  test('remote cancellation stops setup before saving a target', async () => {
    const cwd = fixture();
    try {
      await expect(runWithInteraction({ output: () => {}, progress: () => {}, goal: () => {}, prompt: async () => null },
        () => ensureDeployTarget(cwd))).rejects.toBeInstanceOf(ExitPromptError);
      expect(() => readFileSync(join(cwd, '.capy/deploy.json'))).toThrow();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
