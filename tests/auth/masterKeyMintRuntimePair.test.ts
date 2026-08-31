import { describe, expect, mock, test } from 'bun:test';
import { join } from 'path';

const PROJECT_KEY = 'a'.repeat(64);
const resolveFromRuntimePair = mock(async () => PROJECT_KEY);

mock.module(join(import.meta.dir, '../../src/auth/deviceKey/ephemeral.ts'), () => ({
  configuredGrantSocketPath: () => '/runtime-pair/grant.sock',
}));

mock.module(join(import.meta.dir, '../../src/sync/freeSyncKeyResolver.ts'), () => ({
  resolveFreeSyncProjectKey: resolveFromRuntimePair,
}));

import { resolveProjectKeyWithMintFallback } from '../../src/auth/masterKeyMint';

describe('resolveProjectKeyWithMintFallback runtime-pair custody', () => {
  test('uses the configured runtime grant before the disk/mint path', async () => {
    const keyServiceOps = {
      coDecrypt: async () => '',
      wrapOuterLayer: async () => '',
    };
    const grantResolutionOps = {
      fetchKeyEnc: async () => '',
      coDecrypt: async () => '',
    };
    const key = await resolveProjectKeyWithMintFallback({
      orgId: 'org-test',
      projectId: 'project-test',
      userId: 'user-test',
      serviceClient: {} as never,
      keyServiceOps,
      grantResolutionOps,
    });

    expect(key).toBe(PROJECT_KEY);
    expect(resolveFromRuntimePair).toHaveBeenCalledWith(
      'org-test',
      'project-test',
      'user-test',
      keyServiceOps,
      grantResolutionOps,
    );
  });
});
