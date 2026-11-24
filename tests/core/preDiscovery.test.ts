/**
 * Pre-discovery for `capy setup` (CAP-891): local signals only, names only, and the next command for each provider.
 */
import { describe, expect, test } from 'bun:test';
import { preDiscover, type PreDiscoveryInput } from '../../src/core/preDiscovery';

function input(over: Partial<PreDiscoveryInput> = {}): PreDiscoveryInput {
  return { exists: () => false, envNames: [], envIsSet: () => false, bin: 'capy', ...over };
}

describe('preDiscover', () => {
  test('a folder with no signals lists nothing', () => {
    expect(preDiscover(input())).toEqual([]);
  });

  test('a Vercel project file lists vercel with the discovery dry run and the token to save', () => {
    const found = preDiscover(input({ exists: (p) => p === '.vercel/project.json' }));
    expect(found).toEqual([
      {
        provider: 'vercel',
        found: ['.vercel/project.json'],
        token: { name: '_CONNECTOR_VERCEL_TOKEN', state: 'unknown', env: 'VERCEL_TOKEN', set: 'capy system set _CONNECTOR_VERCEL_TOKEN' },
        next: 'capy connect vercel --discover --dry-run --json',
      },
    ]);
  });

  test('the token is present only when its environment variable is set', () => {
    const [vercel] = preDiscover(input({ exists: (p) => p === 'vercel.json', envIsSet: (n) => n === 'VERCEL_TOKEN' }));
    expect(vercel?.token?.state).toBe('present');
  });

  test('Dokploy is listed from variable names, since it leaves no file in a repo', () => {
    const fromDotEnv = preDiscover(input({ envNames: ['DOKPLOY_URL'] }));
    expect(fromDotEnv.map((i) => [i.provider, i.found, i.token?.state])).toEqual([['dokploy', ['.env:DOKPLOY_URL'], 'unknown']]);
    const fromEnv = preDiscover(input({ envIsSet: (n) => n === 'DOKPLOY_API_KEY' }));
    expect(fromEnv.map((i) => [i.provider, i.found, i.token?.state, i.next])).toEqual([
      ['dokploy', ['env:DOKPLOY_API_KEY'], 'present', 'capy connect dokploy --discover --dry-run --json'],
    ]);
  });

  test('Stripe and WorkOS are listed from .env names, with no token and the connect command', () => {
    const found = preDiscover(input({ envNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'WORKOS_API_KEY', 'WORKOS_CLIENT_ID'] }));
    expect(found).toEqual([
      { provider: 'stripe', found: ['.env:STRIPE_SECRET_KEY'], next: 'capy connect stripe' },
      { provider: 'workos', found: ['.env:WORKOS_API_KEY', '.env:WORKOS_CLIENT_ID'], next: 'capy connect workos' },
    ]);
  });

  test('the next commands start with the binary that ran', () => {
    const [vercel] = preDiscover(input({ exists: (p) => p === 'vercel.json', bin: 'capy-staging' }));
    expect(vercel?.next).toBe('capy-staging connect vercel --discover --dry-run --json');
    expect(vercel?.token?.set).toBe('capy-staging system set _CONNECTOR_VERCEL_TOKEN');
  });
});
