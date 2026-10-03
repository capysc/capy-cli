import { describe, test, expect } from 'bun:test';
import inquirer from 'inquirer';
import { searchableChoices, searchableSelectQuestion } from '../../src/ui/searchPrompts';
import { initProjectQuestion, orgProjectQuestion, discoveryProjectQuestion } from '../../src/ui/projectQuestions';
import { fakeTerminal, KEYS } from '../helpers/fakeTerminal';

const PROJECTS = [
  { id: 'p1', name: 'billing-api' },
  { id: 'p2', name: 'Web-Frontend' },
  { id: 'p3', name: 'billing-worker' },
  { id: 'p4', name: 'docs' },
];
const NEW = '__new__';

/** Runs `question` through the real inquirer `search` prompt, typing `keys`, and returns the answer. */
async function run(question: any, ...keys: string[]) {
  const t = fakeTerminal();
  const prompt = inquirer.createPromptModule({ input: t.input as any, output: t.output as any });
  const pending = prompt([question]);
  await t.wait(30);
  await t.type(...keys);
  const answers = (await pending) as Record<string, unknown>;
  return { answers, screen: t.screen() };
}

describe('searchableChoices (the source behind every single-select project picker)', () => {
  const choices = PROJECTS.map((p) => ({ name: p.name, value: p.id }));

  test('no term: every choice, in order', () => {
    expect(searchableChoices(choices, undefined).map((c) => c.value)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(searchableChoices(choices, '').map((c) => c.value)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('a term filters case-insensitively by substring', () => {
    expect(searchableChoices(choices, 'BILLING').map((c) => c.value)).toEqual(['p1', 'p3']);
    expect(searchableChoices(choices, 'front').map((c) => c.value)).toEqual(['p2']);
    expect(searchableChoices(choices, 'zzz')).toEqual([]);
  });

  test('the default comes first, with and without a filter', () => {
    expect(searchableChoices(choices, undefined, 'p3').map((c) => c.value)).toEqual(['p3', 'p1', 'p2', 'p4']);
    expect(searchableChoices(choices, 'billing', 'p3').map((c) => c.value)).toEqual(['p3', 'p1']);
    // A default the filter hides is simply not shown.
    expect(searchableChoices(choices, 'docs', 'p3').map((c) => c.value)).toEqual(['p4']);
  });

  test('the question is an inquirer search prompt that stores its answer under `name`', () => {
    const q = searchableSelectQuestion({ name: 'x', message: 'M', choices, default: 'p2' });
    expect(q.type).toBe('search');
    expect(q.name).toBe('x');
    expect(q.message).toBe('M');
    expect(q.source('web').map((c: any) => c.value)).toEqual(['p2']);
  });
});

describe('capy (init) project picker — "Which project do you want to use?"', () => {
  test('keeps its message and puts "New project" first and pre-selected', async () => {
    const q = initProjectQuestion(PROJECTS, NEW);
    expect(q.message).toBe('Which project do you want to use?');
    expect(q.source(undefined)[0]).toEqual({ name: 'New project', value: NEW });
    const { answers } = await run(q, KEYS.enter);
    expect(answers.projectChoice).toBe(NEW);
  });

  test('typing filters the list and Enter selects the filtered item', async () => {
    const { answers, screen } = await run(initProjectQuestion(PROJECTS, NEW), 'w', 'e', 'b', KEYS.enter);
    expect(answers.projectChoice).toBe('p2');
    expect(screen).toContain('Web-Frontend');
  });

  test('the "New project" row stays reachable: by its own label, or by clearing the filter', async () => {
    const byLabel = await run(initProjectQuestion(PROJECTS, NEW), 'n', 'e', 'w', KEYS.enter);
    expect(byLabel.answers.projectChoice).toBe(NEW);
    const cleared = await run(initProjectQuestion(PROJECTS, NEW), 'd', 'o', KEYS.backspace, KEYS.backspace, KEYS.enter);
    expect(cleared.answers.projectChoice).toBe(NEW);
  });

  test('a filter that matches nothing offers nothing, so Enter cannot pick "New project" by accident', () => {
    const q = initProjectQuestion(PROJECTS, NEW);
    expect(q.source('zzz')).toEqual([]);
  });
});

describe('capy org project picker — "Select project:"', () => {
  test('keeps its message; no default, so the first project leads', async () => {
    const q = orgProjectQuestion(PROJECTS);
    expect(q.message).toBe('Select project:');
    const { answers } = await run(q, KEYS.enter);
    expect(answers.projectId).toBe('p1');
  });

  test('typing filters the list and Enter selects the filtered item', async () => {
    const { answers } = await run(orgProjectQuestion(PROJECTS), 'w', 'o', 'r', 'k', KEYS.enter);
    expect(answers.projectId).toBe('p3');
  });

  test('arrow keys still move within the filtered list', async () => {
    const { answers } = await run(orgProjectQuestion(PROJECTS), 'b', 'i', 'l', KEYS.down, KEYS.enter);
    expect(answers.projectId).toBe('p3');
  });
});

describe('Dokploy discovery project picker — "Which project should this folder use?"', () => {
  test('keeps its message and the "New project (<name>)" row first and pre-selected', async () => {
    const q = discoveryProjectQuestion(PROJECTS, 'my-app', NEW);
    expect(q.message).toBe('Which project should this folder use?');
    expect(q.source('')[0]).toEqual({ name: 'New project (my-app)', value: NEW });
    const { answers } = await run(q, KEYS.enter);
    expect(answers.projectChoice).toBe(NEW);
  });

  test('typing filters the list and Enter selects the filtered item', async () => {
    const { answers } = await run(discoveryProjectQuestion(PROJECTS, 'my-app', NEW), 'd', 'o', 'c', KEYS.enter);
    expect(answers.projectChoice).toBe('p4');
  });

  test('the new-project row is reachable by its own label (including the default name)', async () => {
    const byLabel = await run(discoveryProjectQuestion(PROJECTS, 'my-app', NEW), 'm', 'y', '-', 'a', KEYS.enter);
    expect(byLabel.answers.projectChoice).toBe(NEW);
  });
});
