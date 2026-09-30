import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { AUDIT_FILTERS, AUDIT_SORTS, AuditPage, AuditSearch } from '../service/auditClient';
import { clipTerminalText, terminalWidth, wrapTerminalText } from './terminalColumns';

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const INVERSE = '\x1b[7m';
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h';
const EXIT = '\x1b[?2004l\x1b[?25h\x1b[?1049l';

/** Audit fields are untrusted: never let stored escape sequences control the terminal. */
export const auditText = (value: unknown): string => String(value ?? '—')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

const cell = (value: unknown, width: number): string => {
  const text = auditText(value);
  const clipped = terminalWidth(text) > width ? `${clipTerminalText(text, Math.max(0, width - 1))}…` : text;
  return clipped + ' '.repeat(Math.max(0, width - terminalWidth(clipped)));
};
const label = (value: string): string => value.replace(/_/g, ' ');

export interface AuditState {
  readonly search: AuditSearch;
  readonly page: AuditPage;
  readonly history: readonly AuditSearch[];
  readonly selected: number;
  readonly mode: 'table' | 'search' | 'sort' | 'details';
  readonly field: number;
  readonly draft: string;
  readonly sort: number;
  readonly order: 'asc' | 'desc';
  readonly detailOffset: number;
  readonly request: number;
  readonly loading: boolean;
  readonly pasting: boolean;
  readonly quit: boolean;
}

export const initialAuditState = (search: AuditSearch): AuditState => ({
  search, page: { entries: [], next_cursor: null }, history: [], selected: 0,
  mode: 'table', field: 0, draft: '', sort: AUDIT_SORTS.indexOf(search.sort ?? 'occurred_at'),
  order: search.order ?? 'desc', detailOffset: 0, request: 0, loading: true, pasting: false, quit: false,
});

const load = (state: AuditState, search: AuditSearch, history: readonly AuditSearch[] = []): AuditState => ({
  ...state, search, history, selected: 0, mode: 'table', loading: true,
  page: { entries: [], next_cursor: null }, request: state.request + 1,
});

export interface AuditKey {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

/** Keyboard transitions are immutable; only a new request number triggers database work. */
export function auditKey(state: AuditState, text: string, key: AuditKey): AuditState {
  if (key.sequence === '\x1b[200~') return { ...state, pasting: true };
  if (key.sequence === '\x1b[201~') return { ...state, pasting: false };
  if (state.pasting) return state.mode === 'search'
    ? { ...state, draft: (state.draft + auditText(text)).slice(0, 256) } : state;
  if (key.ctrl && key.name === 'c') return { ...state, quit: true };
  if (key.name === 'escape') return { ...state, mode: 'table' };
  if (state.mode === 'search') {
    if (key.name === 'tab') {
      const field = (state.field + (key.shift ? AUDIT_FILTERS.length - 1 : 1)) % AUDIT_FILTERS.length;
      return { ...state, field, draft: state.search[AUDIT_FILTERS[field]] ?? '' };
    }
    if (key.name === 'return') return load(state, {
      ...state.search, [AUDIT_FILTERS[state.field]]: state.draft.trim() || undefined, cursor: undefined,
    });
    if (key.name === 'backspace') return { ...state, draft: Array.from(state.draft).slice(0, -1).join('') };
    if (key.ctrl && key.name === 'u') return { ...state, draft: '' };
    if (!key.ctrl && text && !/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
      return { ...state, draft: (state.draft + auditText(text)).slice(0, 256) };
    }
    return state;
  }
  if (text === 'q') return { ...state, quit: true };
  if (state.mode === 'sort') {
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
      return { ...state, sort: (state.sort + (key.name === 'left' ? AUDIT_SORTS.length - 1 : 1)) % AUDIT_SORTS.length };
    }
    if (key.name === 'up' || key.name === 'down') return { ...state, order: state.order === 'asc' ? 'desc' : 'asc' };
    if (key.name === 'return') return load(state, { ...state.search, sort: AUDIT_SORTS[state.sort], order: state.order, cursor: undefined });
    return state;
  }
  if (state.mode === 'details') {
    if (key.name === 'return' || text === ' ') return { ...state, mode: 'table' };
    if (key.name === 'up') return { ...state, detailOffset: Math.max(0, state.detailOffset - 1) };
    if (key.name === 'down') return { ...state, detailOffset: state.detailOffset + 1 };
    return state;
  }
  if (text === '/') return { ...state, mode: 'search', draft: state.search[AUDIT_FILTERS[state.field]] ?? '' };
  if (text === 's') return { ...state, mode: 'sort', sort: AUDIT_SORTS.indexOf(state.search.sort ?? 'occurred_at'), order: state.search.order ?? 'desc' };
  if (text === 'c') return load(state, { sort: state.search.sort, order: state.search.order, limit: state.search.limit });
  if (text === 'r') return load(state, state.search, state.history);
  if (state.loading) return state;
  if (key.name === 'up') return { ...state, selected: Math.max(0, state.selected - 1) };
  if (key.name === 'down') return { ...state, selected: Math.min(Math.max(0, state.page.entries.length - 1), state.selected + 1) };
  if ((key.name === 'return' || text === ' ') && state.page.entries.length) return { ...state, mode: 'details', detailOffset: 0 };
  if (text === 'n' && state.page.next_cursor) return load(state, { ...state.search, cursor: state.page.next_cursor }, [...state.history, state.search]);
  if (text === 'p' && state.history.length) return load(state, state.history[state.history.length - 1], state.history.slice(0, -1));
  return state;
}

/** Matches edit's two-column margin, summary cells, table selection and inline inspector. */
export function renderAuditScreen(org: string, state: AuditState, columns = 80, rows = 24): string {
  const width = Math.max(12, columns - 4);
  const filters = AUDIT_FILTERS.filter(key => state.search[key]).map(key => `${label(key)}=${auditText(state.search[key])}`).join(' · ');
  const summaries = [`${state.page.entries.length} events`, `page ${state.history.length + 1}`, `${state.search.sort ?? 'occurred_at'} ${state.search.order ?? 'desc'}`];
  const summaryWidth = Math.floor(width / 3);
  const draftWidth = Math.max(1, width - 10 - label(AUDIT_FILTERS[state.field]).length);
  const visibleDraft = clipTerminalText(auditText(state.draft), draftWidth, true);
  const searchLine = state.mode === 'search'
    ? `${BOLD}Search${RESET} ${label(AUDIT_FILTERS[state.field])}: ${visibleDraft}${INVERSE} ${RESET}${' '.repeat(draftWidth - terminalWidth(visibleDraft))}`
    : `${DIM}${cell(`Search: ${filters || 'all events'}`, width)}${RESET}`;
  const heading = state.mode === 'sort'
    ? `${BOLD}Sort${RESET} ${label(AUDIT_SORTS[state.sort])} ${state.order}` : `${BOLD}Audit events${RESET}`;
  const widths = [Math.floor(width * .24), Math.floor(width * .24), Math.floor(width * .28) - 2, width - Math.floor(width * .24) * 2 - Math.floor(width * .28) - 4];
  const tableRow = (values: readonly unknown[]): string => values.map((value, index) => cell(value, Math.max(1, widths[index]))).join('  ');
  const selectedEvent = state.page.entries[state.selected];
  const bodyHeight = Math.max(1, rows - 12);
  const offset = Math.max(0, state.selected - bodyHeight + 1);
  const detailLines = selectedEvent ? Object.entries(selectedEvent).flatMap(([key, value]) => wrapTerminalText(
    `${key}: ${auditText(typeof value === 'object' && value !== null ? JSON.stringify(value) : value)}`, Math.max(1, width - 5),
  ).map(line => `     ${line}`)) : [];
  const row = (index: number): string => {
    const event = state.page.entries[index];
    const content = tableRow([`${index === state.selected ? '▶' : ' '} ${event.actorName ?? event.actorId}`, event.action, `${event.targetType}: ${event.targetName ?? event.targetId}`, event.occurredAt]);
    return index === state.selected ? `${INVERSE}${content}${RESET}` : content;
  };
  const body = state.loading ? [`${DIM}Searching…${RESET}`]
    : !state.page.entries.length ? ['No matching audit events.']
    : state.mode === 'details' ? [
      row(state.selected), `  ${DIM}╶${'─'.repeat(Math.max(0, width - 4))}╴${RESET}`,
      ...detailLines.slice(Math.min(state.detailOffset, Math.max(0, detailLines.length - Math.max(1, bodyHeight - 2))),
        Math.min(state.detailOffset, Math.max(0, detailLines.length - Math.max(1, bodyHeight - 2))) + Math.max(1, bodyHeight - 2)),
    ].slice(0, bodyHeight)
      : state.page.entries.slice(offset, offset + bodyHeight).map((_, index) => row(offset + index));
  const hints = state.mode === 'search' ? 'Tab field · Enter search · Ctrl-U clear text · Esc cancel'
    : state.mode === 'sort' ? '←→ field · ↑↓ direction · Enter apply · Esc cancel'
      : state.mode === 'details' ? '↑↓ scroll details · Esc close · q quit'
        : '↑↓ navigate · Enter inspect · / search · s sort · q quit';
  return [
    `${BOLD}capy audit${RESET}: ${cell(org, Math.max(1, width - 12))}`, '',
    summaries.map(value => cell(value, summaryWidth)).join(''),
    `${DIM}${['on this page', 'n next / p previous', 's sort'].map(value => cell(value, summaryWidth)).join('')}${RESET}`, '',
    searchLine, heading, `${DIM}${tableRow(['ACTOR', 'ACTION', 'TARGET', 'OCCURRED'])}${RESET}`,
    ...body, ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ''), '',
    `${DIM}${cell(hints, width)}${RESET}`,
    `${DIM}${cell(state.mode === 'table' ? 'n next · p previous · r refresh · c clear filters' : 'Search runs on the server; Enter applies changes.', width)}${RESET}`,
  ].slice(0, Math.max(1, rows - 1)).map(line => `  ${line}\x1b[K`).join('\n');
}

export type AuditInput = Readonly<{ type: 'key'; text: string; key: AuditKey }> | Readonly<{ type: 'resize' | 'quit' }>;
export interface AuditTerminal {
  readonly open: (send: (input: AuditInput) => void) => () => void;
  readonly write: (text: string) => void;
  readonly size: () => Readonly<{ columns: number; rows: number }>;
}
const terminal: AuditTerminal = {
  open: send => {
    const wasRaw = process.stdin.isRaw;
    const onKey = (text: string | undefined, key: AuditKey) => send({ type: 'key', text: text ?? '', key });
    const onResize = () => send({ type: 'resize' });
    const onQuit = () => send({ type: 'quit' });
    emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', onKey);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.on('resize', onResize);
    process.on('SIGINT', onQuit);
    process.on('SIGTERM', onQuit);
    process.stdin.on('end', onQuit);
    process.stdout.write(ENTER);
    return () => {
      process.stdin.off('keypress', onKey);
      process.stdout.off('resize', onResize);
      process.off('SIGINT', onQuit);
      process.off('SIGTERM', onQuit);
      process.stdin.off('end', onQuit);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.write(EXIT);
    };
  },
  write: text => { process.stdout.write(text); },
  size: () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
};

type Message = AuditInput | Readonly<{ type: 'page'; request: number; page: AuditPage }>
  | Readonly<{ type: 'error'; request: number; error: unknown }>;

/** Async responses carry request identities so stale searches cannot replace newer results. */
export async function runAuditTui(
  org: string, query: (search: AuditSearch, signal?: AbortSignal) => Promise<AuditPage>, search: AuditSearch = {}, io: AuditTerminal = terminal,
): Promise<void> {
  const messages = new PassThrough({ objectMode: true });
  const controller = new AbortController();
  const send = (message: Message): void => { if (!messages.destroyed) messages.write(message); };
  const request = (state: AuditState): void => {
    void Promise.resolve().then(() => query(state.search, controller.signal)).then(
      page => send({ type: 'page', request: state.request, page }),
      error => send({ type: 'error', request: state.request, error }),
    );
  };
  const draw = (state: AuditState): void => {
    const size = io.size();
    io.write('\x1b[2J\x1b[H' + renderAuditScreen(org, state, size.columns, size.rows));
  };
  const iterator = messages[Symbol.asyncIterator]();
  const loop = async (state: AuditState): Promise<void> => {
    const item = await iterator.next();
    if (item.done) return;
    const message = item.value as Message;
    if (message.type === 'quit') return;
    if (message.type === 'error') {
      if (message.request === state.request) throw message.error;
      return loop(state);
    }
    const next = message.type === 'key' ? auditKey(state, message.text, message.key)
      : message.type === 'page' && message.request === state.request ? { ...state, page: message.page, loading: false } : state;
    if (next.quit) return;
    draw(next);
    if (next.request !== state.request) request(next);
    return loop(next);
  };
  const close = io.open(send);
  try {
    const initial = initialAuditState(search);
    draw(initial);
    request(initial);
    await loop(initial);
  } finally {
    messages.destroy();
    controller.abort();
    close();
  }
}
