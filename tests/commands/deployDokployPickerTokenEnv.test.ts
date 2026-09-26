/**
 * `capy deploy`'s picker (CAP-664): a NEW Dokploy target is no longer asked
 * for `tokenEnv` at all — the org system store is the default source now
 * (see `docs/dokploy-deploy-adapter.md`'s "Token resolution"). An EXISTING
 * target's saved `tokenEnv` (from before the system store existed, or set
 * via `--token-env`) must still survive re-entering the picker to edit
 * something else — additive, never silently dropped.
 *
 * Drives `resolveAdapterOptions` directly rather than the whole multi-prompt
 * `runPicker` flow: its return value becomes `target.options` verbatim
 * (`runPicker`'s `options` var) and is then written to `.capy/deploy.json`
 * verbatim (`upsertTarget`) — so "this function's result has no `tokenEnv`
 * key for a new target" and "`.capy/deploy.json` has no `tokenEnv` for a new
 * target" are the same fact, proved once instead of through a second,
 * heavier end-to-end run that would have to script the whole prompt
 * sequence (branch, adapter options, var checkbox, mode, name) just to
 * reach the one field this is actually about.
 *
 * mock.module('inquirer', ...) is process-wide: this file runs isolated
 * (tests/run-tests.sh).
 */
import { describe, test, expect, mock } from 'bun:test';

const promptMock = mock(async () => ({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_1' }));
mock.module('inquirer', () => ({
  default: { prompt: promptMock },
}));

import { resolveAdapterOptions } from '../../src/commands/deployCommand';
import { getAdapter } from '../../src/deploy/registry';

describe('capy deploy picker — dokploy tokenEnv (CAP-664)', () => {
  const adapter = getAdapter('dokploy');
  if (!adapter) throw new Error('dokploy adapter not registered');

  test('a NEW target (no existing options) gets no tokenEnv key at all', async () => {
    const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
    expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_1' });
    expect(Object.prototype.hasOwnProperty.call(options, 'tokenEnv')).toBe(false);
  });

  test("an EXISTING target's tokenEnv survives an edit, byte for byte", async () => {
    const existingOpts = {
      baseUrl: 'https://old.example.com',
      applicationId: 'app_old',
      tokenEnv: 'MY_OLD_TOKEN_VAR',
    };
    const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, existingOpts);
    // The prompt answers win for baseUrl/applicationId (the user re-entered
    // or confirmed them) — only tokenEnv is carried through untouched,
    // because there was never a question for it to come from.
    expect(options).toEqual({
      baseUrl: 'https://dokploy.example.com',
      applicationId: 'app_1',
      tokenEnv: 'MY_OLD_TOKEN_VAR',
    });
  });

  test('the tokenEnv question itself is never asked — the prompt only ever receives baseUrl + applicationId', async () => {
    await resolveAdapterOptions(adapter, '/tmp', [], {}, { tokenEnv: 'WHATEVER' });
    const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{ name: string }>;
    expect(lastCallQuestions.map((q) => q.name)).toEqual(['baseUrl', 'applicationId']);
  });
});
