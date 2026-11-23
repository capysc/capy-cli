import { describe, test, expect, mock, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderYamlPatch,
  readCliVersion,
  pushRuntimePair,
  confirmOverwrite,
  type SecretIo,
} from '../../src/commands/githubActionsConnector';

// SAFETY: nothing here may reach the real `gh`. The connector is only ever exercised through an injected
// `SecretIo` fake and the pure helpers; `runGithubActionsConnector` is never called from a test.

const VERSION = readFileSync(
  join(__dirname, '..', '..', 'VERSION'),
  'utf-8',
).trim();

describe('githubActionsConnector — readCliVersion', () => {
  test('returns the version from package.json', () => {
    expect(readCliVersion()).toBe(VERSION);
  });
});

describe('githubActionsConnector — renderYamlPatch', () => {
  test('repo-secret form pins the npm install version and uses raw env var names', () => {
    const yaml = renderYamlPatch('9.9.9', null);
    expect(yaml).toContain('npm install -g @capysc/cli@9.9.9');
    expect(yaml).toContain('_SECRETS_BLOB: ${{ secrets._SECRETS_BLOB }}');
    expect(yaml).toContain('_DEPLOY_KEY:  ${{ secrets._DEPLOY_KEY }}');
    expect(yaml).toContain('capy run -- <your existing deploy command>');
  });

  test('repo-secret form does NOT include any environment reminder', () => {
    const yaml = renderYamlPatch('9.9.9', null);
    expect(yaml).not.toContain('environment:');
  });

  test('environment-secret form includes a job-pin reminder for the chosen env', () => {
    const yaml = renderYamlPatch('9.9.9', 'production');
    expect(yaml).toContain('environment: production');
    // Reminder must come BEFORE the install step so users see it first.
    expect(yaml.indexOf('environment: production')).toBeLessThan(
      yaml.indexOf('npm install -g'),
    );
  });

  test('uses the new names, and never the project-key names or the CAPY_-prefixed ones', () => {
    const yaml = renderYamlPatch(VERSION, null);
    expect(yaml).not.toContain('PROJECT_KEY');
    expect(yaml).not.toMatch(/(^|[^_A-Za-z])SECRETS_BLOB/m);
    expect(yaml).not.toContain('CAPY_');
  });
});

/** A `SecretIo` stand-in that records every secret write. It has no delete, because the real interface has none. */
function fakeIo(failOn: readonly string[] = []) {
  const set = mock((name: string, _value: string, _env: string | null) =>
    failOn.includes(name) ? { ok: false, stderr: 'boom' } : { ok: true, stderr: '' },
  );
  const io: SecretIo = { set };
  return { io, sets: () => set.mock.calls };
}

describe('githubActionsConnector — what lands on GitHub', () => {
  const minted = { secretsBlob: 'BLOB', deployKey: 'f'.repeat(64) };

  test('pushes exactly _SECRETS_BLOB and _DEPLOY_KEY: the blob and the per-deploy key', () => {
    const { io, sets } = fakeIo();
    expect(pushRuntimePair(io, minted, 'production')).toEqual({ ok: true });
    expect(sets()).toEqual([
      ['_SECRETS_BLOB', 'BLOB', 'production'],
      ['_DEPLOY_KEY', 'f'.repeat(64), 'production'],
    ]);
  });

  test('a failed push names the secret that failed and stops', () => {
    const { io, sets } = fakeIo(['_SECRETS_BLOB']);
    expect(pushRuntimePair(io, minted, null)).toEqual({ ok: false, name: '_SECRETS_BLOB', stderr: 'boom' });
    expect(sets()).toHaveLength(1);
  });

  test('the connector can never delete a secret: SecretIo has no delete and the source never asks gh to', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'commands', 'githubActionsConnector.ts'), 'utf-8');
    expect(source).not.toMatch(/['"`]delete['"`]/);
    expect(source).not.toMatch(/\bremove\s*[(:]/);
    expect(source).not.toContain('removeLegacySecrets');
  });
});

describe('githubActionsConnector — overwrite confirmation', () => {
  const quiet = () => spyOn(console, 'log').mockImplementation(() => undefined);

  test('asks when _SECRETS_BLOB already exists', async () => {
    const log = quiet();
    const ask = mock(async (_m: string) => true);
    expect(await confirmOverwrite(new Set(['_SECRETS_BLOB']), null, {}, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain('_SECRETS_BLOB');
    expect(ask.mock.calls[0][0]).not.toContain('_DEPLOY_KEY');
    log.mockRestore();
  });

  test('asks when _DEPLOY_KEY already exists', async () => {
    const log = quiet();
    const ask = mock(async (_m: string) => true);
    expect(await confirmOverwrite(new Set(['_DEPLOY_KEY']), 'production', {}, ask)).toBe(true);
    expect(ask.mock.calls[0][0]).toContain('_DEPLOY_KEY');
    expect(ask.mock.calls[0][0]).toContain('environment "production"');
    log.mockRestore();
  });

  test('names both when both exist', async () => {
    const log = quiet();
    const ask = mock(async (_m: string) => true);
    await confirmOverwrite(new Set(['_SECRETS_BLOB', '_DEPLOY_KEY']), null, {}, ask);
    expect(ask.mock.calls[0][0]).toContain('_SECRETS_BLOB + _DEPLOY_KEY');
    log.mockRestore();
  });

  test('does not ask for the older names: they are not overwritten, so there is nothing to confirm', async () => {
    const ask = mock(async (_m: string) => true);
    expect(await confirmOverwrite(new Set(['SECRETS_BLOB', 'PROJECT_KEY', '_PROJECT_KEY']), null, {}, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  test('does not ask when gh could not list the secrets, or none clash', async () => {
    const ask = mock(async (_m: string) => true);
    expect(await confirmOverwrite(null, null, {}, ask)).toBe(true);
    expect(await confirmOverwrite(new Set(), null, {}, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  test('--yes overwrites without asking', async () => {
    const log = quiet();
    const ask = mock(async (_m: string) => false);
    expect(await confirmOverwrite(new Set(['_SECRETS_BLOB']), null, { yes: true }, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test('answering no stops the run', async () => {
    const log = quiet();
    expect(await confirmOverwrite(new Set(['_SECRETS_BLOB']), null, {}, async () => false)).toBe(false);
    log.mockRestore();
  });

  test('an aborted prompt (Ctrl+C) rejects, so the run never falls through to mint and push', async () => {
    const abort = Object.assign(new Error('prompt aborted'), { name: 'ExitPromptError' });
    const outcome = await confirmOverwrite(new Set(['_DEPLOY_KEY']), null, {}, async () => {
      throw abort;
    }).then(
      () => 'proceeded',
      (e: unknown) => e,
    );
    expect(outcome).toBe(abort);
  });
});
