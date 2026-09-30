import inquirer from 'inquirer';
import { AUDIT_FILTERS, AUDIT_SORTS, AuditEvent, AuditPage, AuditSearch } from '../service/auditClient';

/** Audit fields are untrusted: never let stored escape sequences control the terminal. */
export const auditText = (value: unknown): string => String(value ?? '—')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

const cell = (value: unknown, width: number) => {
  const text = auditText(value);
  return (text.length > width ? `${text.slice(0, width - 1)}…` : text).padEnd(width);
};

export function renderAuditPage(org: string, page: AuditPage, search: AuditSearch, width = process.stdout.columns ?? 110): string {
  const filters = AUDIT_FILTERS.filter(key => search[key]).map(key => `${key}=${auditText(search[key])}`).join(' · ');
  const compact = width < 100;
  const headings = compact ? 'Time / Actor / Action / Target'
    : `${cell('Time', 24)} ${cell('Actor', 24)} ${cell('Action', 24)} ${cell('Target', 32)}`;
  const rows = page.entries.map(event => compact
    ? `${auditText(event.occurredAt)}  ${auditText(event.action)}\n  ${auditText(event.actorName ?? event.actorId)} → ${auditText(event.targetType)}: ${auditText(event.targetName ?? event.targetId)}`
    : `${cell(event.occurredAt, 24)} ${cell(event.actorName ?? event.actorId, 24)} ${cell(event.action, 24)} ${cell(`${event.targetType}: ${event.targetName ?? event.targetId}`, 32)}`);
  return [
    `\nAudit log · ${auditText(org)}`,
    `Sort: ${search.sort ?? 'occurred_at'} ${search.order ?? 'desc'}${filters ? ` · ${filters}` : ''}`,
    '', headings, '─'.repeat(Math.min(Math.max(width - 1, 20), 107)),
    ...(rows.length ? rows : ['No matching audit events.']),
    '', `${page.entries.length} events${page.next_cursor ? ' · more available' : ''}`,
  ].join('\n');
}

export interface AuditTuiIO {
  readonly write: (text: string) => void;
  readonly choose: (message: string, choices: readonly Readonly<{ name: string; value: string }>[]) => Promise<string>;
  readonly input: (message: string, value: string) => Promise<string>;
}
const terminalIO: AuditTuiIO = {
  write: text => console.log(text),
  choose: async (message, choices) => {
    const answer = await inquirer.prompt<{ value: string }>([{ type: 'list', name: 'value', message, choices: [...choices] }]);
    return answer.value;
  },
  input: async (message, value) => {
    const answer = await inquirer.prompt<{ value: string }>([{
      type: 'input', name: 'value', message, default: value,
      validate: (text: string) => text.length <= 256 || 'Use at most 256 characters.',
    }]);
    return answer.value;
  },
};

function showEvent(event: AuditEvent, io: AuditTuiIO): void {
  io.write(Object.entries(event).map(([key, value]) =>
    `${key}: ${auditText(typeof value === 'object' && value !== null ? JSON.stringify(value) : value)}`).join('\n'));
}

/** Each navigation/search submits a new database query; no page-local filtering. */
export async function runAuditTui(
  org: string,
  query: (search: AuditSearch) => Promise<AuditPage>,
  search: AuditSearch = {},
  io: AuditTuiIO = terminalIO,
  history: readonly AuditSearch[] = [],
): Promise<void> {
  const page = await query(search);
  io.write(renderAuditPage(org, page, search));
  const action = await io.choose('Audit log', [
    { name: 'Search / change filters', value: 'search' },
    { name: 'Sort', value: 'sort' },
    ...(page.entries.length ? [{ name: 'Inspect event (all attributes)', value: 'inspect' }] : []),
    ...(page.next_cursor ? [{ name: 'Next page', value: 'next' }] : []),
    ...(history.length ? [{ name: 'Previous page', value: 'previous' }] : []),
    { name: 'Refresh', value: 'refresh' },
    { name: 'Clear filters', value: 'clear' },
    { name: 'Quit', value: 'quit' },
  ]);
  if (action === 'quit') return;
  if (action === 'search') {
    const field = await io.choose('Search field (contains, case-insensitive)', AUDIT_FILTERS.map(value => ({ name: value.replace(/_/g, ' '), value })));
    const value = await io.input('Search text (empty removes this filter)', search[field as typeof AUDIT_FILTERS[number]] ?? '');
    return runAuditTui(org, query, { ...search, [field]: value.trim() || undefined, cursor: undefined }, io);
  }
  if (action === 'sort') {
    const sort = await io.choose('Sort by', AUDIT_SORTS.map(value => ({ name: value.replace(/_/g, ' '), value })));
    const order = await io.choose('Order', [{ name: 'Descending / newest first', value: 'desc' }, { name: 'Ascending / oldest first', value: 'asc' }]);
    return runAuditTui(org, query, { ...search, sort: sort as AuditSearch['sort'], order: order as AuditSearch['order'], cursor: undefined }, io);
  }
  if (action === 'inspect') {
    const id = await io.choose('Event', page.entries.map(event => ({ name: auditText(`${event.occurredAt} ${event.action} ${event.id}`), value: event.id })));
    const event = page.entries.find(entry => entry.id === id);
    if (event) showEvent(event, io);
    await io.input('Press Enter to return', '');
    return runAuditTui(org, query, search, io, history);
  }
  if (action === 'next' && page.next_cursor) return runAuditTui(org, query, { ...search, cursor: page.next_cursor }, io, [...history, search]);
  if (action === 'previous' && history.length) return runAuditTui(org, query, history[history.length - 1], io, history.slice(0, -1));
  if (action === 'clear') return runAuditTui(org, query, { sort: search.sort, order: search.order, limit: search.limit }, io);
  return runAuditTui(org, query, { ...search, cursor: undefined }, io);
}
