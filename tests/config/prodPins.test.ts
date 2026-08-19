import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PINNED_ENV_VARS,
  applyProdPins,
  formatPinNotice,
  getShellPinnedEnv,
  resetShellPinnedEnv,
} from '../../src/config/prodPins';

// applyProdPins takes the env as a parameter, so these tests drive throwaway
// objects rather than mutating the real process.env — except where the
// capture-for-`capy run` behavior is under test, which is keyed on identity.
beforeEach(() => {
  resetShellPinnedEnv();
  for (const name of PINNED_ENV_VARS) delete process.env[name];
});

describe('applyProdPins', () => {
  it('strips a service override and reports it', () => {
    const env = { CAPY_API_URL: 'http://localhost:3001', PATH: '/usr/bin' };
    const stripped = applyProdPins(env);

    expect(stripped).toEqual(['CAPY_API_URL']);
    expect(env.CAPY_API_URL).toBeUndefined();
  });

  it('leaves everything it does not own alone', () => {
    const env = {
      CAPY_API_URL: 'http://localhost:3001',
      CAPY_VERBOSE: '1',
      CAPY_NO_AUTOCOMMIT: '1',
      CAPY_WEB_NO_OPEN: '1',
      DATABASE_URL: 'postgres://localhost/app',
    };
    applyProdPins(env);

    // Behavior toggles and unrelated project secrets are none of its business.
    expect(env.CAPY_VERBOSE).toBe('1');
    expect(env.CAPY_NO_AUTOCOMMIT).toBe('1');
    expect(env.CAPY_WEB_NO_OPEN).toBe('1');
    expect(env.DATABASE_URL).toBe('postgres://localhost/app');
  });

  it('strips every targeting and state-selecting variable', () => {
    const env: Record<string, string> = {
      CAPY_API_URL: 'http://localhost:3001',
      CAPY_KEEP_ORIGIN: 'http://keep.localhost:3002',
      CAPY_GLOBAL_DIR_NAME: '.capy-dev',
      CAPY_PROFILE: 'byoc-test',
      CAPY_TEST_EMAIL: 'e2e@example.com',
      CAPY_TEST_PASSWORD: 'hunter2',
    };
    const stripped = applyProdPins(env);

    expect(stripped.sort()).toEqual([...PINNED_ENV_VARS].sort());
    expect(Object.keys(env)).toEqual([]);
  });

  it('reports nothing on a clean environment', () => {
    expect(applyProdPins({ PATH: '/usr/bin' })).toEqual([]);
  });

  it('drops an empty override rather than passing it to a URL resolver', () => {
    const env = { CAPY_API_URL: '' };
    expect(applyProdPins(env)).toEqual(['CAPY_API_URL']);
    expect('CAPY_API_URL' in env).toBe(false);
  });

  it('is idempotent', () => {
    const env = { CAPY_API_URL: 'http://localhost:3001' };
    applyProdPins(env);
    expect(applyProdPins(env)).toEqual([]);
  });
});

describe('getShellPinnedEnv', () => {
  it('captures what it took from the real environment, for capy run', () => {
    process.env.CAPY_API_URL = 'http://localhost:3001';
    applyProdPins(process.env);

    // The CLI stops seeing it...
    expect(process.env.CAPY_API_URL).toBeUndefined();
    // ...but `capy run` can still hand it to a child that wants it, which is
    // exactly capy-mcp's case.
    expect(getShellPinnedEnv()).toEqual({ CAPY_API_URL: 'http://localhost:3001' });
  });

  it('is empty when nothing was stripped, so callers can spread it blind', () => {
    applyProdPins(process.env);
    expect(getShellPinnedEnv()).toEqual({});
  });

  it('does not capture from a caller-supplied env object', () => {
    applyProdPins({ CAPY_API_URL: 'http://localhost:3001' });
    expect(getShellPinnedEnv()).toEqual({});
  });
});

describe('formatPinNotice', () => {
  it('says nothing when nothing was stripped', () => {
    expect(formatPinNotice([])).toBeNull();
  });

  it('names the variables it ignored and points at the supported routes', () => {
    const notice = formatPinNotice(['CAPY_API_URL', 'CAPY_PROFILE']);
    expect(notice).toContain('CAPY_API_URL');
    expect(notice).toContain('CAPY_PROFILE');
    expect(notice).toContain('capy byoc');
  });
});
