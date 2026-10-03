/**
 * CAP-700: the project pickers that live inside bigger commands are wired to
 * the type-to-filter prompt. `mock.module('inquirer', ...)` is process-wide:
 * this file runs isolated (tests/run-tests.sh).
 *
 * The keystroke behaviour of the prompt itself is tested against the real
 * inquirer prompt in tests/ui/searchPrompts.test.ts; here we check that each
 * call site asks that prompt, with its own message, default and special row.
 */
import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test';

const promptMock = mock(async (_questions: any) => ({ projectChoice: 'chosen' }));
mock.module('inquirer', () => ({
  default: { prompt: promptMock, Separator: class {} },
}));

afterAll(() => {
  mock.restore();
});

import {
  defaultAskExistingOrNewProject,
  DISCOVERY_NEW_PROJECT,
} from '../../src/commands/connectors/dokploy';
import {
  orderProjectsForPicker,
  vercelProjectQuestion,
  type PickableProject,
} from '../../src/deploy/adapters/vercel';

beforeEach(() => {
  promptMock.mockClear();
});

describe('Dokploy discovery — "Which project should this folder use?"', () => {
  const existing = [
    { id: 'p1', name: 'billing-api' },
    { id: 'p2', name: 'web-frontend' },
  ];

  test('asks a searchable question; the new-project row leads and is the default', async () => {
    const answer = await defaultAskExistingOrNewProject(existing, 'my-app');
    expect(answer).toBe('chosen');
    const [questions] = promptMock.mock.calls[0] as any[];
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.type).toBe('search');
    expect(q.message).toBe('Which project should this folder use?');
    expect(q.source('').map((c: any) => c.value)).toEqual([DISCOVERY_NEW_PROJECT, 'p1', 'p2']);
    expect(q.source('')[0].name).toBe('New project (my-app)');
  });

  test('typing filters, and the new-project row is matched on its own label', async () => {
    await defaultAskExistingOrNewProject(existing, 'my-app');
    const q = (promptMock.mock.calls[0] as any[])[0][0];
    expect(q.source('web').map((c: any) => c.value)).toEqual(['p2']);
    expect(q.source('my-app').map((c: any) => c.value)).toEqual([DISCOVERY_NEW_PROJECT]);
    expect(q.source('zzz')).toEqual([]);
  });
});

describe('Vercel link picker — "Which Vercel project is this?"', () => {
  const projects: PickableProject[] = [
    { projectId: 'a', projectName: 'zebra', orgId: 'o1', scopeLabel: 'acme' },
    { projectId: 'b', projectName: 'my-app', orgId: 'o1', scopeLabel: 'acme' },
    { projectId: 'c', projectName: 'alpha', orgId: 'o2', scopeLabel: 'me' },
  ];

  test('the project named like the directory comes first, the rest by name, and the input is untouched', () => {
    const before = projects.map((p) => p.projectId);
    expect(orderProjectsForPicker(projects, 'my-app').map((p) => p.projectId)).toEqual(['b', 'c', 'a']);
    expect(projects.map((p) => p.projectId)).toEqual(before);
  });

  test('keeps its message, lists scope/project rows, and keeps the "None of these" row', () => {
    const q = vercelProjectQuestion(projects);
    expect(q.type).toBe('search');
    expect(q.message).toBe('Which Vercel project is this?');
    const rows = q.source('');
    expect(rows.map((c: any) => c.name)).toEqual([
      'acme/zebra',
      'acme/my-app',
      'me/alpha',
      'None of these — run `vercel link` instead',
    ]);
    expect(rows[3].value).toBeNull();
  });

  test('typing filters across scope and name; the "None of these" row is matched on its own label', () => {
    const q = vercelProjectQuestion(projects);
    expect(q.source('me/al').map((c: any) => c.value?.projectId)).toEqual(['c']);
    expect(q.source('my-a').map((c: any) => c.value?.projectId)).toEqual(['b']);
    expect(q.source('none of').map((c: any) => c.value)).toEqual([null]);
  });
});
