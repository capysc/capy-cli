import { describe, test, expect } from 'bun:test';
import { selectRuntimePair } from '../../src/commands/runCommand';

// Which runtime pair `capy run` reads is decided by variable NAME alone.
//   underscore group = _SECRETS_BLOB + (_DEPLOY_KEY, else _PROJECT_KEY)
//   older pair       = SECRETS_BLOB  + PROJECT_KEY
// The newer names are read first and win; no combination of complete pairs is an error.

const DEPLOY = { _SECRETS_BLOB: 'u-blob', _DEPLOY_KEY: 'deploy-key' };
const PROJECT = { _SECRETS_BLOB: 'u-blob', _PROJECT_KEY: 'project-key' };
const OLDER = { SECRETS_BLOB: 'older-blob', PROJECT_KEY: 'older-key' };

/** The exact refusal text `capy run` has always printed for a half-set `_SECRETS_BLOB` / `_PROJECT_KEY` group. */
const HALF_UNDERSCORE_TODAY =
  'capy run: _SECRETS_BLOB and _PROJECT_KEY must both be set, or neither. Got only one — refusing to guess which mode you meant.';
const HALF_OLDER_TODAY =
  'capy run: SECRETS_BLOB and PROJECT_KEY must both be set, or neither. Got only one — refusing to guess which mode you meant.';

describe('selectRuntimePair', () => {
  test('nothing set is local mode', () => {
    expect(selectRuntimePair({})).toEqual({ kind: 'local' });
    expect(selectRuntimePair({ PATH: '/bin', OTHER: 'x' })).toEqual({ kind: 'local' });
  });

  test('empty strings count as unset', () => {
    expect(selectRuntimePair({ _SECRETS_BLOB: '', _DEPLOY_KEY: '', _PROJECT_KEY: '' })).toEqual({ kind: 'local' });
  });

  describe('the underscore group: _SECRETS_BLOB with _DEPLOY_KEY, else _PROJECT_KEY', () => {
    test('_SECRETS_BLOB + _DEPLOY_KEY uses the deploy key', () => {
      expect(selectRuntimePair({ ...DEPLOY })).toEqual({
        kind: 'underscore',
        keySource: 'deploy',
        raw: { blob: 'u-blob', key: 'deploy-key' },
      });
    });

    test('_SECRETS_BLOB + _PROJECT_KEY uses the project key, as today', () => {
      expect(selectRuntimePair({ ...PROJECT })).toEqual({
        kind: 'underscore',
        keySource: 'project',
        raw: { blob: 'u-blob', key: 'project-key' },
      });
    });

    test('_SECRETS_BLOB with both keys: _DEPLOY_KEY wins', () => {
      expect(selectRuntimePair({ ...DEPLOY, _PROJECT_KEY: 'project-key' })).toEqual({
        kind: 'underscore',
        keySource: 'deploy',
        raw: { blob: 'u-blob', key: 'deploy-key' },
      });
    });
  });

  describe('a half-set underscore group refuses', () => {
    test('_SECRETS_BLOB with no key at all names the keys it accepts', () => {
      const r = selectRuntimePair({ _SECRETS_BLOB: 'b' });
      expect(r.kind).toBe('refused');
      if (r.kind !== 'refused') return;
      expect(r.message).toContain('_SECRETS_BLOB');
      expect(r.message).toContain('_DEPLOY_KEY');
      expect(r.message).toContain('_PROJECT_KEY');
      expect(r.message).toContain('must both be set, or neither');
    });

    test('_PROJECT_KEY without the blob: the text it has always had, byte for byte', () => {
      expect(selectRuntimePair({ _PROJECT_KEY: 'k' })).toEqual({ kind: 'refused', message: HALF_UNDERSCORE_TODAY });
    });

    test('_DEPLOY_KEY without the blob refuses, naming the blob and the deploy key', () => {
      const r = selectRuntimePair({ _DEPLOY_KEY: 'k' });
      expect(r.kind).toBe('refused');
      if (r.kind !== 'refused') return;
      expect(r.message).toContain('_SECRETS_BLOB and _DEPLOY_KEY must both be set, or neither');
    });

    test('both keys without the blob refuses, with the text _PROJECT_KEY has always had', () => {
      expect(selectRuntimePair({ _DEPLOY_KEY: 'k', _PROJECT_KEY: 'p' })).toEqual({
        kind: 'refused',
        message: HALF_UNDERSCORE_TODAY,
      });
    });

    test('it refuses even next to a complete older pair', () => {
      expect(selectRuntimePair({ ...OLDER, _PROJECT_KEY: 'k' }).kind).toBe('refused');
      expect(selectRuntimePair({ ...OLDER, _SECRETS_BLOB: 'b' }).kind).toBe('refused');
      expect(selectRuntimePair({ ...OLDER, _DEPLOY_KEY: 'k' }).kind).toBe('refused');
    });
  });

  describe('the older pair, unchanged', () => {
    test('complete alone: used', () => {
      expect(selectRuntimePair({ ...OLDER })).toEqual({
        kind: 'older',
        raw: { blob: 'older-blob', key: 'older-key' },
      });
    });

    test("half of it refuses with today's text, alone or next to a complete underscore group", () => {
      expect(selectRuntimePair({ SECRETS_BLOB: 'b' })).toEqual({ kind: 'refused', message: HALF_OLDER_TODAY });
      expect(selectRuntimePair({ PROJECT_KEY: 'k' })).toEqual({ kind: 'refused', message: HALF_OLDER_TODAY });
      expect(selectRuntimePair({ ...DEPLOY, SECRETS_BLOB: 'b' })).toEqual({ kind: 'refused', message: HALF_OLDER_TODAY });
      expect(selectRuntimePair({ ...PROJECT, PROJECT_KEY: 'k' })).toEqual({ kind: 'refused', message: HALF_OLDER_TODAY });
    });

    test('a half-set underscore group is reported before a half-set older pair, as today', () => {
      expect(selectRuntimePair({ _PROJECT_KEY: 'k', SECRETS_BLOB: 'b' })).toEqual({
        kind: 'refused',
        message: HALF_UNDERSCORE_TODAY,
      });
    });
  });

  describe('no combination of complete pairs is an error: the underscore group wins', () => {
    test('underscore group (project key) next to the older pair', () => {
      const r = selectRuntimePair({ ...PROJECT, ...OLDER });
      expect(r).toEqual({ kind: 'underscore', keySource: 'project', raw: { blob: 'u-blob', key: 'project-key' } });
    });

    test('underscore group (deploy key) next to the older pair', () => {
      const r = selectRuntimePair({ ...DEPLOY, ...OLDER });
      expect(r).toEqual({ kind: 'underscore', keySource: 'deploy', raw: { blob: 'u-blob', key: 'deploy-key' } });
    });

    test('everything set at once', () => {
      const r = selectRuntimePair({ ...DEPLOY, _PROJECT_KEY: 'project-key', ...OLDER });
      expect(r).toEqual({ kind: 'underscore', keySource: 'deploy', raw: { blob: 'u-blob', key: 'deploy-key' } });
    });
  });

  test('selection is by NAME, never by value shape: a hex value in a blob slot is not re-routed', () => {
    const hex = 'ab'.repeat(32);
    expect(selectRuntimePair({ _SECRETS_BLOB: hex, _PROJECT_KEY: hex })).toEqual({
      kind: 'underscore',
      keySource: 'project',
      raw: { blob: hex, key: hex },
    });
  });

  test('CAPY_-prefixed variables an app stores are never read as a runtime pair', () => {
    expect(selectRuntimePair({ CAPY_API_URL: 'http://x', CAPY_KEEP_ORIGIN: 'y', CAPY_OTHER: 'z' })).toEqual({ kind: 'local' });
  });
});
