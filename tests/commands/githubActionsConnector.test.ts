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
  test('repo-secret form pins the npm install version and uses raw env var names', () => {
    const yaml = renderYamlPatch('9.9.9', null);
    expect(yaml).toContain('npm install -g @capysc/cli@9.9.9');
    expect(yaml).toContain('SECRETS_BLOB: ${{ secrets.SECRETS_BLOB }}');
    expect(yaml).toContain('PROJECT_KEY:  ${{ secrets.PROJECT_KEY }}');
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

  test('uses the secret names capy run actually reads (no CAPY_ prefix)', () => {
    const yaml = renderYamlPatch(VERSION, null);
    // Guards against a future "namespace collision" temptation. capy run
    // reads SECRETS_BLOB + PROJECT_KEY verbatim; renaming forces users to
    // maintain a mismatch.
    expect(yaml).not.toMatch(/CAPY_SECRETS_BLOB|CAPY_PROJECT_KEY/);
  });
});
