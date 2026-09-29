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

  test('the tokenEnv question itself is never asked', async () => {
    await resolveAdapterOptions(adapter, '/tmp', [], {}, { tokenEnv: 'WHATEVER' });
    const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{ name: string }>;
    expect(lastCallQuestions.map((q) => q.name)).not.toContain('tokenEnv');
  });

  // ── CAP-679 follow-up (item 6): a target configures exactly one of
  // composeId/applicationId, and the picker now asks which kind up front —
  // see `resolveAdapterOptions`'s Dokploy branch in deployCommand.ts. ──
  describe('Compose vs Application kind', () => {
    test('the picker asks baseUrl, kind, and then EITHER composeId OR applicationId (never both)', async () => {
      await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{ name: string }>;
      expect(lastCallQuestions.map((q) => q.name)).toEqual(['baseUrl', 'kind', 'composeId', 'applicationId']);
    });

    test('picking Compose returns composeId, never applicationId', async () => {
      promptMock.mockImplementationOnce(async () => ({
        baseUrl: 'https://dokploy.example.com',
        kind: 'compose',
        composeId: 'compose_1',
      }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_1' });
      expect(Object.prototype.hasOwnProperty.call(options, 'applicationId')).toBe(false);
    });

    test('picking Application returns applicationId, never composeId', async () => {
      promptMock.mockImplementationOnce(async () => ({
        baseUrl: 'https://dokploy.example.com',
        kind: 'application',
        applicationId: 'app_1',
      }));
      const options = await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_1' });
      expect(Object.prototype.hasOwnProperty.call(options, 'composeId')).toBe(false);
    });

    test('re-editing a Compose target defaults the kind question to Compose', async () => {
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { baseUrl: 'https://x', composeId: 'compose_old' });
      const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{
        name: string;
        default?: unknown;
      }>;
      expect(lastCallQuestions.find((q) => q.name === 'kind')?.default).toBe('compose');
      expect(lastCallQuestions.find((q) => q.name === 'composeId')?.default).toBe('compose_old');
    });

    test('re-editing an Application target defaults the kind question to Application', async () => {
      await resolveAdapterOptions(adapter, '/tmp', [], {}, { baseUrl: 'https://x', applicationId: 'app_old' });
      const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{
        name: string;
        default?: unknown;
      }>;
      expect(lastCallQuestions.find((q) => q.name === 'kind')?.default).toBe('application');
      expect(lastCallQuestions.find((q) => q.name === 'applicationId')?.default).toBe('app_old');
    });

    test('a brand-new target defaults the kind question to Compose', async () => {
      await resolveAdapterOptions(adapter, '/tmp', [], {}, {});
      const lastCallQuestions = promptMock.mock.calls[promptMock.mock.calls.length - 1][0] as ReadonlyArray<{
        name: string;
        default?: unknown;
      }>;
      expect(lastCallQuestions.find((q) => q.name === 'kind')?.default).toBe('compose');
    });

    test('switching kind on re-edit drops the OTHER id — an Application target re-edited to Compose loses applicationId', async () => {
      promptMock.mockImplementationOnce(async () => ({
        baseUrl: 'https://dokploy.example.com',
        kind: 'compose',
        composeId: 'compose_new',
      }));
      const options = await resolveAdapterOptions(
        adapter,
        '/tmp',
        [],
        {},
        { baseUrl: 'https://old', applicationId: 'app_old' },
      );
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_new' });
      expect(Object.prototype.hasOwnProperty.call(options, 'applicationId')).toBe(false);
    });

    test('switching kind the other way (Compose → Application) loses composeId', async () => {
      promptMock.mockImplementationOnce(async () => ({
        baseUrl: 'https://dokploy.example.com',
        kind: 'application',
        applicationId: 'app_new',
      }));
      const options = await resolveAdapterOptions(
        adapter,
        '/tmp',
        [],
        {},
        { baseUrl: 'https://old', composeId: 'compose_old' },
      );
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', applicationId: 'app_new' });
      expect(Object.prototype.hasOwnProperty.call(options, 'composeId')).toBe(false);
    });

    test('tokenEnv still survives a Compose re-edit, byte for byte', async () => {
      promptMock.mockImplementationOnce(async () => ({
        baseUrl: 'https://dokploy.example.com',
        kind: 'compose',
        composeId: 'compose_1',
      }));
      const options = await resolveAdapterOptions(
        adapter,
        '/tmp',
        [],
        {},
        { composeId: 'compose_old', tokenEnv: 'MY_TOKEN' },
      );
      expect(options).toEqual({ baseUrl: 'https://dokploy.example.com', composeId: 'compose_1', tokenEnv: 'MY_TOKEN' });
    });
  });
});
