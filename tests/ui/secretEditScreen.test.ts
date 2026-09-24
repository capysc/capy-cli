import { describe, expect, mock, test } from 'bun:test';

mock.module('../../src/config/globalConfig', () => ({ readLocalRoot: () => null }));

const { runSecretEditViaKeep } = await import('../../src/ui/secretEditScreen');

describe('runSecretEditViaKeep', () => {
  test('fails descriptively when this user has no existing local root for the org', async () => {
    const outcome = await runSecretEditViaKeep({
      serviceApiUrl: 'https://service.invalid',
      getToken: () => 'unused',
      userId: 'user-1',
      orgId: 'org-1',
      projectName: 'project',
      branchName: 'branch',
      vars: [{ name: 'API_KEY', value: 'secret' }],
      keepHash: 'keep-hash',
      applyEdits: async () => ({ ok: true, keepHash: 'unused' }),
    });

    expect(outcome).toEqual({ kind: 'declined', code: 'missing_local_root' });
  });
});
