import { describe, expect, it, jest } from 'bun:test';
import { EventEmitter } from 'node:events';
import { auditKey, auditText, initialAuditState, renderAuditScreen, runAuditTui } from '../../src/ui/auditTui';
import type { AuditState } from '../../src/ui/auditTui';
import { AUDIT_FILTERS, AUDIT_SORTS, type AuditEvent } from '../../src/service/auditClient';

const event: AuditEvent = {
  id: 'event-1', occurredAt: '2026-09-30T12:00:00Z', actorId: 'alice', actorName: 'Alice', actorType: 'user',
  action: 'secret.read', targetType: 'project', targetId: 'p-1', targetName: 'Production', metadata: { version: 1 }, ipAddress: null, userAgent: null,
};
const ready: AuditState = { ...initialAuditState({ actor: 'alice' }), loading: false, page: { entries: [event], next_cursor: 'page-2' } };
const press = (state: AuditState, name: string, text = '') => auditKey(state, text, { name });

describe('audit TUI', () => {
  it.each(AUDIT_FILTERS)('submits %s as a server search and discards cursors', field => {
    const editing = press({ ...ready, search: { ...ready.search, cursor: 'old' }, field: AUDIT_FILTERS.indexOf(field) }, '/', '/');
    const next = press({ ...editing, draft: 'Production' }, 'return');
    expect(next.search).toEqual({ actor: 'alice', [field]: 'Production', cursor: undefined });
    expect(next.loading).toBe(true);
    expect(next.page.entries).toEqual([]);
    expect(next.request).toBe(1);
    expect(next.history).toEqual([]);
  });
  it.each(AUDIT_SORTS)('sorts by %s without retaining a stale cursor', sort => {
    const next = press({ ...ready, mode: 'sort', sort: AUDIT_SORTS.indexOf(sort), order: 'asc' }, 'return');
    expect(next.search).toEqual({ actor: 'alice', sort, order: 'asc', cursor: undefined });
    expect(next.request).toBe(1);
  });
  it('pages forward and backward without losing filters', () => {
    const next = press(ready, 'n', 'n');
    expect(next.search).toEqual({ actor: 'alice', cursor: 'page-2' });
    expect(press({ ...next, loading: false }, 'p', 'p').search).toEqual(ready.search);
  });
  it('edits inline, cycles fields, cancels drafts, and clears filters', () => {
    const editing = press(ready, '/', '/');
    expect(press(editing, 'q', 'q').draft).toBe('aliceq');
    expect(press(editing, 'tab').field).toBe(1);
    expect(press(editing, 'escape').search).toEqual(ready.search);
    expect(press(ready, 'c', 'c').search.actor).toBeUndefined();
    expect(auditKey(editing, '', { name: 'u', ctrl: true }).draft).toBe('');
  });
  it('treats bracketed paste as text and never executes pasted shortcuts', () => {
    const start = auditKey(ready, '', { sequence: '\x1b[200~' });
    expect(press(start, 'q', 'q').quit).toBe(false);
    const editing = { ...start, mode: 'search' as const, draft: '' };
    expect(press(editing, 'return', '\n').request).toBe(0);
    expect(press(editing, 'q', 'q').draft).toBe('q');
    expect(auditKey(editing, '', { sequence: '\x1b[201~' }).pasting).toBe(false);
  });
  it('renders an edit-style table, selection, inline search and scrollable details', () => {
    const screen = renderAuditScreen('Org', ready, 100, 24);
    expect(screen).toContain('capy audit');
    expect(screen).toContain('ACTOR');
    expect(screen).toContain('\x1b[7m▶ Alice');
    expect(screen).toContain('project: Production');
    expect(renderAuditScreen('Org', press(ready, '/', '/'))).toContain('Search\x1b[0m actor:');
    const details = press(ready, 'return');
    expect(renderAuditScreen('Org', details)).toContain('actorId: alice');
    expect(renderAuditScreen('Org', { ...details, detailOffset: 100 })).toContain('userAgent:');
    expect(auditText('\x1b[2Jbad\nvalue\x9b')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    for (const columns of [40, 80, 120]) {
      const lines = renderAuditScreen('Org', ready, columns, 24).replace(/\x1b\[[0-9;]*m|\x1b\[K/g, '').split('\n');
      expect(lines.length).toBeLessThan(24);
      expect(lines.every(line => line.length <= columns)).toBe(true);
    }
  });
  it('queries on submitted search and restores terminal on exit', async () => {
    const close = jest.fn();
    const query = jest.fn(async () => ({ entries: [event], next_cursor: null }));
    const channel = new EventEmitter();
    const write = jest.fn((text: string) => {
      if (text.includes('▶ Alice')) channel.emit('input', { type: 'quit' });
    });
    await runAuditTui('Org', query, {}, {
      size: () => ({ columns: 100, rows: 24 }), write,
      open: send => {
        channel.on('input', send);
        for (const input of [
          { type: 'key', text: '/', key: {} },
          { type: 'key', text: 'alice', key: {} },
          { type: 'key', text: '', key: { name: 'return' } },
        ] as const) send(input);
        return close;
      },
    });
    expect(query.mock.calls.map(call => call[0])).toEqual([{}, { actor: 'alice', cursor: undefined }]);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('permits quitting while a query is pending', async () => {
    const close = jest.fn();
    const query = jest.fn(() => new Promise<never>(() => {}));
    await runAuditTui('Org', query, {}, {
      size: () => ({ columns: 80, rows: 24 }), write: jest.fn(),
      open: send => { send({ type: 'quit' }); return close; },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('never displays an older response after a newer search finishes', async () => {
    const channel = new EventEmitter();
    const write = jest.fn();
    const query = async (search: Readonly<{ actor?: string }>) => {
      if (!search.actor) await new Promise(resolve => setTimeout(resolve, 10));
      return { entries: [{ ...event, actorName: search.actor ? 'Current' : 'Stale' }], next_cursor: null };
    };
    await runAuditTui('Org', query, {}, {
      size: () => ({ columns: 80, rows: 24 }), write,
      open: send => {
        channel.on('input', send);
        for (const input of [
          { type: 'key', text: '/', key: {} },
          { type: 'key', text: 'alice', key: {} },
          { type: 'key', text: '', key: { name: 'return' } },
        ] as const) send(input);
        const timeout = setTimeout(() => send({ type: 'quit' }), 30);
        return () => { clearTimeout(timeout); channel.off('input', send); };
      },
    });
    expect(write.mock.calls.some(call => call[0].includes('Current'))).toBe(true);
    expect(write.mock.calls.every(call => !call[0].includes('Stale'))).toBe(true);
  });
  it('cleans up and refuses to show records when authorization fails', async () => {
    const close = jest.fn();
    const write = jest.fn();
    await expect(runAuditTui('Org', async () => { throw new Error('admin-only'); }, {}, {
      size: () => ({ columns: 80, rows: 24 }), write, open: () => close,
    })).rejects.toThrow('admin-only');
    expect(close).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.every(call => !call[0].includes('Alice'))).toBe(true);
  });
});
