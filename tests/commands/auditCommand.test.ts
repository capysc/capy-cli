import { describe, expect, it, jest } from 'bun:test';
import { Command } from 'commander';
import { auditSearchOptions, registerAuditCommand } from '../../src/commands/auditCommand';
import { createAuditClient } from '../../src/service/auditClient';
import type { ServiceToken } from '../../src/types';

describe('audit CLI and transport', () => {
  it('registers all search attributes and sort options', () => {
    const program = new Command();
    registerAuditCommand(program);
    const command = program.commands.find(cmd => cmd.name() === 'audit')!;
    const help = command.helpInformation();
    for (const flag of ['--org', '--actor', '--actor-id', '--actor-name', '--actor-type', '--action', '--target', '--target-id', '--target-name', '--target-type', '--sort', '--order', '--cursor', '--json']) {
      expect(help).toContain(flag);
    }
  });
  it('rejects bad sorting and pagination before authenticating', () => {
    for (const options of [{ sort: 'random' }, { order: 'random' }, { limit: '0' }, { limit: '201' }]) {
      expect(() => auditSearchOptions(options)).toThrow();
    }
    expect(auditSearchOptions({ target_name: 'Production', sort: 'actor_name', order: 'asc' })).toMatchObject({ target_name: 'Production', sort: 'actor_name', order: 'asc' });
  });
  it('encodes all filters and keeps every page scoped to the same org', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ entries: [], next_cursor: null })));
    const tokenProvider = jest.fn(async () => ({ access_token: 'private-token' } as ServiceToken));
    const query = createAuditClient('org/a', tokenProvider, 'https://service.test', fetchFn as typeof fetch);
    await query({ actor: 'a&b', target_name: 'production=1', sort: 'target_name', order: 'asc' });
    await query({ cursor: 'cursor-1' });
    const [url, options] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/orgs/org%2Fa/audit');
    expect(new URL(url).searchParams.get('actor')).toBe('a&b');
    expect(new URL(url).searchParams.get('target_name')).toBe('production=1');
    expect(options.headers).toEqual({ Authorization: 'Bearer private-token' });
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain('/orgs/org%2Fa/audit?cursor=cursor-1');
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });
  it('does not search without a session and surfaces server admin denial', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ error: 'Audit log is admin-only' }), { status: 403 }));
    await expect(createAuditClient('org-a', async () => null, 'https://service.test', fetchFn as typeof fetch)({})).rejects.toThrow('Sign in');
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(createAuditClient('org-a', async () => ({ access_token: 'token' } as ServiceToken), 'https://service.test', fetchFn as typeof fetch)({})).rejects.toThrow('admin-only');
  });
});
