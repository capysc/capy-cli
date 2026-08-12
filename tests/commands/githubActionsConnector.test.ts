import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderYamlPatch,
  readCliVersion,
} from '../../src/commands/githubActionsConnector';

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
  test('repo-secret form pins the npm install version and uses the current-generation var names', () => {
    const yaml = renderYamlPatch('9.9.9', null);
    expect(yaml).toContain('npm install -g @capysc/cli@9.9.9');
    expect(yaml).toContain('_CAPY_SECRETS_BLOB: ${{ secrets._CAPY_SECRETS_BLOB }}');
    expect(yaml).toContain('_CAPY_DEPLOY_KEY:  ${{ secrets._CAPY_DEPLOY_KEY }}');
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

  // CAP-411 reverses the guard this test used to encode: the un-prefixed
  // SECRETS_BLOB/PROJECT_KEY pair carried the raw project key, and the fix is
  // exactly to stop shipping that value under any name. New mints — GitHub
  // Actions included — now use the `_CAPY_` prefix on purpose, matching
  // `capy run`'s selection table (reservedVars.ts) and reserved on day one by
  // the prefix rule (CAP-424). The legacy pair keeps working for tokens
  // already out in the wild; this connector never mints one on purpose.
  test('uses the current-generation secret names (_CAPY_ prefix), never the legacy pair', () => {
    const yaml = renderYamlPatch(VERSION, null);
    expect(yaml).toContain('_CAPY_SECRETS_BLOB');
    expect(yaml).toContain('_CAPY_DEPLOY_KEY');
    expect(yaml).not.toMatch(/[^_]SECRETS_BLOB|^SECRETS_BLOB/);
    expect(yaml).not.toMatch(/PROJECT_KEY/);
  });
});
