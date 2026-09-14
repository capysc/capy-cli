import { describe, expect, test } from 'bun:test';
import { resolveInitRunTransportMode, usesHostedInitTransport } from '../../src/auth/initRunTransportMode';

describe('resolveInitRunTransportMode', () => {
  test('makes hosted the ordinary web transport and keeps local explicit', () => {
    expect(resolveInitRunTransportMode(undefined)).toBe('hosted');
    expect(resolveInitRunTransportMode('')).toBe('hosted');
    expect(resolveInitRunTransportMode('hosted')).toBe('hosted');
    expect(resolveInitRunTransportMode('local')).toBe('local');
  });

  test('refuses an unknown mode before any run can be created', () => {
    const error = (() => {
      try {
        return resolveInitRunTransportMode('fallback');
      } catch (cause) {
        return cause;
      }
    })();
    expect(error).toMatchObject({ code: 'INIT_RUN_CONFIGURATION' });
  });

  test('uses the hosted path for web runs and the onboarding rollout', () => {
    expect(usesHostedInitTransport(true, undefined)).toBe(true);
    expect(usesHostedInitTransport(false, '1')).toBe(true);
    expect(usesHostedInitTransport(false, undefined)).toBe(false);
    expect(usesHostedInitTransport(false, '0')).toBe(false);
  });
});
