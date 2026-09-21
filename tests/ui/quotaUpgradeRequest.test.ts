import { expect, mock, spyOn, test } from 'bun:test';
import { ServiceClient } from '../../src/service/serviceClient';
import { runWithInteraction, type InteractionQuestion } from '../../src/ui/interaction';
import { keepOrigin } from '../../src/ui/screens/keepScreens';
const quota = { code: 'QUOTA_EXCEEDED', kind: 'project', error: 'Upgrade required', upgrade_url: `${keepOrigin()}/billing?organization=org-one` };
const create = () => new ServiceClient('https://service.invalid').initializeProject('example', 'org-one');

test('quota check remains authoritative when the user checks payment before paying', async () => {
  const fetcher = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(quota, { status: 402 }))
    .mockResolvedValueOnce(Response.json(quota, { status: 402 }))
    .mockResolvedValueOnce(Response.json({ id: 'project-one', name: 'example', organization_id: 'org-one' }));
  const question = mock(async <T>(input: InteractionQuestion<T>) => {
    const decided = input.decide({ value: true });
    return 'value' in decided ? decided.value : null;
  });
  try {
    const result = await runWithInteraction({ output: () => undefined, progress: () => undefined, goal: () => undefined, prompt: question }, create);
    expect(result.project_id).toBe('project-one');
    expect(question).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array.from({ length: 3 }, () => 'https://service.invalid/projects'));
  } finally { fetcher.mockRestore(); }
});

test('declining payment performs no retry or checkout mutation', async () => {
  const fetcher = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(quota, { status: 402 }));
  try {
    await expect(runWithInteraction({ output: () => undefined, progress: () => undefined, goal: () => undefined, prompt: async () => null }, create)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { fetcher.mockRestore(); }
});
