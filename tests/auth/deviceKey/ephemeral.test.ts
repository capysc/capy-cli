/**
 * The ephemerality signal CAP-402's atomic-mint gate keys off — see
 * src/auth/deviceKey/ephemeral.ts's own docblock for why this is the ONLY
 * signal (no hostname sniffing, no container-filesystem heuristics). This
 * file pins the pure read: presence of `CAPY_DEVICE_KEY_GRANT_SOCKET` alone
 * is the answer, nothing more (empty string does not count as "set").
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  EPHEMERAL_ENV_VAR,
  configuredGrantSocketPath,
  isEphemeralEnvironment,
} from '../../../src/auth/deviceKey/ephemeral';
import { GRANT_SOCKET_ENV_VAR } from '../../../src/auth/deviceKey/grantHolder';

const saved = process.env[GRANT_SOCKET_ENV_VAR];
const savedEphemeral = process.env[EPHEMERAL_ENV_VAR];

afterEach(() => {
  if (saved === undefined) delete process.env[GRANT_SOCKET_ENV_VAR];
  else process.env[GRANT_SOCKET_ENV_VAR] = saved;
  if (savedEphemeral === undefined) delete process.env[EPHEMERAL_ENV_VAR];
  else process.env[EPHEMERAL_ENV_VAR] = savedEphemeral;
});

describe('ephemeral.ts — the grant-socket signal', () => {
  it('is absent by default', () => {
    delete process.env[GRANT_SOCKET_ENV_VAR];
    expect(configuredGrantSocketPath()).toBeNull();
    expect(isEphemeralEnvironment()).toBe(false);
  });

  it('an empty string does not count as "set"', () => {
    process.env[GRANT_SOCKET_ENV_VAR] = '';
    expect(configuredGrantSocketPath()).toBeNull();
    expect(isEphemeralEnvironment()).toBe(false);
  });

  it('any non-empty value is the signal, unparsed and untouched', () => {
    process.env[GRANT_SOCKET_ENV_VAR] = '/tmp/some/grant.sock';
    expect(configuredGrantSocketPath()).toBe('/tmp/some/grant.sock');
    expect(isEphemeralEnvironment()).toBe(true);
  });
});

// The grant socket cannot be the ONLY signal: it appears only after a grant
// succeeds, and a grant needs an already-enrolled door to unlock. A
// brand-new user (Case A) in a sandbox has no door — so at the exact moment
// Case A decides whether it may leave freshly-minted key material on a
// disposable disk, no socket exists. Without this second signal the
// atomic-mint gate would miss the one case it was written to protect.
describe('ephemeral.ts — the up-front declaration (pre-grant Case A)', () => {
  it('an orchestrator can declare ephemerality before any grant exists', () => {
    delete process.env[GRANT_SOCKET_ENV_VAR];
    process.env[EPHEMERAL_ENV_VAR] = '1';
    expect(configuredGrantSocketPath()).toBeNull();
    expect(isEphemeralEnvironment()).toBe(true);
  });

  it('only the exact value "1" counts — no truthy-string guessing', () => {
    delete process.env[GRANT_SOCKET_ENV_VAR];
    for (const value of ['', '0', 'true', 'yes', 'false']) {
      process.env[EPHEMERAL_ENV_VAR] = value;
      expect(isEphemeralEnvironment()).toBe(false);
    }
  });

  it('neither signal present stays non-ephemeral (a laptop is untouched)', () => {
    delete process.env[GRANT_SOCKET_ENV_VAR];
    delete process.env[EPHEMERAL_ENV_VAR];
    expect(isEphemeralEnvironment()).toBe(false);
  });
});
