import { describe, expect, it, jest } from 'bun:test';
import { auditText, renderAuditPage, runAuditTui } from '../../src/ui/auditTui';
import type { AuditEvent } from '../../src/service/auditClient';

const event: AuditEvent = {
  id: 'event-1', occurredAt: '2026-09-30T12:00:00Z', actorId: 'alice', actorName: 'Alice', actorType: 'user',
  action: 'secret.read', targetType: 'project', targetId: 'p-1', targetName: 'Production', metadata: { version: 1 }, ipAddress: null, userAgent: null,
};

describe('audit TUI', () => {
  it('issues database searches when filters or sort change and discards stale cursors', async () => {
    const query = jest.fn(async () => ({ entries: [event], next_cursor: 'page-2' }));
    const choose = jest.fn().mockResolvedValueOnce('search').mockResolvedValueOnce('target_name')
      .mockResolvedValueOnce('sort').mockResolvedValueOnce('actor_name').mockResolvedValueOnce('asc').mockResolvedValueOnce('quit');
    await runAuditTui('Org', query, { cursor: 'old', actor: 'alice' }, {
      write: jest.fn(), choose, input: jest.fn(async () => 'Production'),
    });
    expect(query.mock.calls[1]?.[0]).toEqual({ cursor: undefined, actor: 'alice', target_name: 'Production' });
    expect(query.mock.calls[2]?.[0]).toEqual({ cursor: undefined, actor: 'alice', target_name: 'Production', sort: 'actor_name', order: 'asc' });
  });
  it('pages forward and backward without losing filters', async () => {
    const query = jest.fn(async () => ({ entries: [event], next_cursor: 'page-2' }));
    await runAuditTui('Org', query, { actor: 'alice' }, {
      write: jest.fn(), input: jest.fn(),
      choose: jest.fn().mockResolvedValueOnce('next').mockResolvedValueOnce('previous').mockResolvedValueOnce('quit'),
    });
    expect(query.mock.calls.map(call => call[0])).toEqual([{ actor: 'alice' }, { actor: 'alice', cursor: 'page-2' }, { actor: 'alice' }]);
  });
  it('offers search on an empty result and clears all filters', async () => {
    const query = jest.fn(async () => ({ entries: [], next_cursor: null }));
    const write = jest.fn();
    await runAuditTui('Org', query, { actor: 'missing', target_type: 'project' }, {
      write, input: jest.fn(), choose: jest.fn().mockResolvedValueOnce('clear').mockResolvedValueOnce('quit'),
    });
    expect(query.mock.calls[1]?.[0]).toEqual({ sort: undefined, order: undefined, limit: undefined });
    expect(write.mock.calls[0]?.[0]).toContain('No matching audit events');
  });
  it('refuses to show records when a new query is denied', async () => {
    const write = jest.fn();
    await expect(runAuditTui('Org', jest.fn(async () => { throw new Error('admin-only'); }), {}, {
      write, input: jest.fn(), choose: jest.fn(),
    })).rejects.toThrow('admin-only');
    expect(write).not.toHaveBeenCalled();
  });
  it('shows stored attributes and neutralizes terminal controls', () => {
    expect(renderAuditPage('Org', { entries: [event], next_cursor: null }, {})).toContain('project: Production');
    expect(auditText('\x1b[2Jbad\nvalue\x9b')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});
