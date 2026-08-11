/**
 * The ephemerality signal CAP-402's atomic-mint gate keys off — see
 * src/auth/deviceKey/ephemeral.ts's own docblock for why this is the ONLY
 * signal (no hostname sniffing, no container-filesystem heuristics). This
 * file pins the pure read: presence of `CAPY_DEVICE_KEY_GRANT_SOCKET` alone
 * is the answer, nothing more (empty string does not count as "set").
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { configuredGrantSocketPath, isEphemeralEnvironment } from '../../../src/auth/deviceKey/ephemeral';
import { GRANT_SOCKET_ENV_VAR } from '../../../src/auth/deviceKey/grantHolder';

const saved = process.env[GRANT_SOCKET_ENV_VAR];

afterEach(() => {
  if (saved === undefined) delete process.env[GRANT_SOCKET_ENV_VAR];
  else process.env[GRANT_SOCKET_ENV_VAR] = saved;
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
