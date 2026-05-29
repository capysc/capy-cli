import { describe, it, expect } from 'bun:test';
import { LOCAL_ONLY_DISABLED_COMMANDS } from '../../src/core/localGate';

/**
 * Guards the curated list of commands disabled in local-only mode. If someone
 * adds a new org/team/server command, this snapshot forces a deliberate
 * decision about whether it must be gated — so a server call can't silently
 * leak into local-only mode.
 */
describe('local-only command gating', () => {
  it('disables every org/team/server command', () => {
    const expected = [
      'invite',
      'kick',
      'users',
      'grant-branch',
      'revoke-branch',
      'org',
      'redeem',
      'transport',
      'deploy',
      'connect',
      'rotate',
      'recover',
      'info',
      'branch',
      'checkout',
    ].sort();
    expect([...LOCAL_ONLY_DISABLED_COMMANDS].sort()).toEqual(expected);
  });

  it('does NOT disable the offline-capable commands', () => {
    const allowed = ['run', 'status', 'edit', 'push', 'lock', 'use', 'profile', 'cleanup', 'version', 'help', 'logout', 'decrypt'];
    for (const cmd of allowed) {
      expect(LOCAL_ONLY_DISABLED_COMMANDS).not.toContain(cmd as any);
    }
  });
});
