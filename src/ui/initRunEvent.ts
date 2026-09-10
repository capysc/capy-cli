/** CAP-652's one hosted entry and authoritative terminal projection. */
import {
  canonicalClaimCode,
  isInitRunEntryUrl,
  isInitRunId,
  parseInitRunTerminalReceipt,
  type InitRunTerminalReceipt,
} from '../auth/initRunContract';
import type { InitRunBootstrapHandoff } from '../auth/initRunBootstrap';
import { HANDOFF_EVENT_MARKER } from './handoffEvent';

export interface InitRunHandoffEvent {
  readonly v: 1;
  readonly event: 'capy:init-run-handoff';
  readonly flow: 'init';
  readonly runId: string;
  readonly url: string;
  readonly claimCode: string;
  readonly expiresAt: string;
  readonly location: 'hosted';
  readonly ts: string;
}

export interface InitRunTerminalEvent {
  readonly v: 1;
  readonly event: 'capy:init-run-terminal';
  readonly flow: 'init';
  readonly runId: string | null;
  readonly receiptId: string | null;
  readonly status: InitRunTerminalReceipt['status'] | 'indeterminate';
  readonly code: string;
  readonly effectState: 'not_started' | 'not_applied' | 'verified_applied' | 'indeterminate';
  readonly repositoryVerified: boolean;
  readonly custodyVerified: boolean;
  readonly ts: string;
}

export type InitRunEvent = InitRunHandoffEvent | InitRunTerminalEvent;
export type InitRunEventState = Readonly<
  | { phase: 'new' }
  | { phase: 'created'; runId: string }
  | { phase: 'handed-off'; runId: string }
  | { phase: 'terminal'; runId: string | null }
>;

const fail = (): never => { throw new Error('INIT_RUN_EVENT_INVALID'); };
const isoDate = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exactKeys = (row: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
const coded = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);

/** Closed schemas reject accidental private fields and contradictory outcomes. */
export function parseInitRunEvent(value: unknown): InitRunEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>;
  if (row.v !== 1 || row.flow !== 'init' || !isoDate(row.ts)) return null;
  if (row.event === 'capy:init-run-handoff') {
    if (!exactKeys(row, ['v', 'event', 'flow', 'runId', 'url', 'claimCode', 'expiresAt', 'location', 'ts'])
      || !isInitRunId(row.runId) || typeof row.url !== 'string' || !isInitRunEntryUrl(row.url, row.runId)
      || typeof row.claimCode !== 'string' || canonicalClaimCode(row.claimCode) === null
      || !/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(row.claimCode)
      || !isoDate(row.expiresAt) || Date.parse(row.expiresAt) <= Date.parse(row.ts)
      || row.location !== 'hosted') return null;
    return row as unknown as InitRunHandoffEvent;
  }
  if (row.event !== 'capy:init-run-terminal'
    || !exactKeys(row, ['v', 'event', 'flow', 'runId', 'receiptId', 'status', 'code', 'effectState', 'repositoryVerified', 'custodyVerified', 'ts'])
    || (row.runId !== null && !isInitRunId(row.runId))
    || (row.receiptId !== null && !isInitRunId(row.receiptId))
    || typeof row.repositoryVerified !== 'boolean' || typeof row.custodyVerified !== 'boolean' || !coded(row.code)
    || !['succeeded', 'cancelled', 'failed', 'expired', 'indeterminate'].includes(String(row.status))
    || !['not_started', 'not_applied', 'verified_applied', 'indeterminate'].includes(String(row.effectState))) return null;
  if (row.runId === null) {
    return row.receiptId === null && row.status === 'failed' && row.effectState === 'not_started'
      && !row.repositoryVerified && !row.custodyVerified && row.code !== 'INIT_DONE'
      ? row as unknown as InitRunTerminalEvent : null;
  }
  if (row.status === 'succeeded') {
    return row.receiptId !== null && row.code === 'INIT_DONE' && row.effectState === 'verified_applied'
      && row.repositoryVerified ? row as unknown as InitRunTerminalEvent : null;
  }
  if (row.code === 'INIT_DONE' || row.effectState === 'not_started') return null;
  if (row.status === 'indeterminate') {
    return row.receiptId === null && row.code === 'INIT_FINAL_OUTCOME_INDETERMINATE'
      && row.effectState === 'indeterminate' ? row as unknown as InitRunTerminalEvent : null;
  }
  if (row.receiptId === null && (row.effectState !== 'not_applied' || row.repositoryVerified || row.custodyVerified)) return null;
  return row as unknown as InitRunTerminalEvent;
}

export function initRunHandoffEvent(handoff: InitRunBootstrapHandoff, ts: string = new Date().toISOString()): InitRunHandoffEvent {
  const event = {
    v: 1, event: 'capy:init-run-handoff', flow: 'init', runId: handoff.runId, url: handoff.entryUrl,
    claimCode: handoff.claimCode, expiresAt: handoff.expiresAt, location: 'hosted', ts,
  } as const;
  return parseInitRunEvent(event) ? event : fail();
}

export function initRunReceiptEvent(receipt: InitRunTerminalReceipt, ts: string = new Date().toISOString()): InitRunTerminalEvent {
  if (!parseInitRunTerminalReceipt(receipt)) return fail();
  const event = {
    v: 1, event: 'capy:init-run-terminal', flow: 'init', runId: receipt.run_id, receiptId: receipt.receipt_id,
    status: receipt.status, code: receipt.code ?? 'INIT_DONE',
    effectState: receipt.effects === 'complete' ? 'verified_applied'
      : receipt.effects === 'none' ? 'not_applied' : 'indeterminate',
    repositoryVerified: receipt.repository_verified, custodyVerified: receipt.custody_verified, ts,
  } as const;
  return parseInitRunEvent(event) ? event : fail();
}

export function initRunUnconfirmedEvent(input: Readonly<
  | { kind: 'pre-run'; code: string }
  | { kind: 'no-effects'; runId: string; status: 'failed' | 'cancelled' | 'expired'; code: string }
  | { kind: 'indeterminate'; runId: string; repositoryVerified: boolean; custodyVerified: boolean }
>, ts: string = new Date().toISOString()): InitRunTerminalEvent {
  const event = {
    v: 1, event: 'capy:init-run-terminal', flow: 'init',
    runId: input.kind === 'pre-run' ? null : input.runId, receiptId: null,
    status: input.kind === 'indeterminate' ? 'indeterminate' : input.kind === 'pre-run' ? 'failed' : input.status,
    code: input.kind === 'indeterminate' ? 'INIT_FINAL_OUTCOME_INDETERMINATE' : input.code,
    effectState: input.kind === 'indeterminate' ? 'indeterminate' : input.kind === 'pre-run' ? 'not_started' : 'not_applied',
    repositoryVerified: input.kind === 'indeterminate' && input.repositoryVerified,
    custodyVerified: input.kind === 'indeterminate' && input.custodyVerified, ts,
  } as const;
  return parseInitRunEvent(event) ? event : fail();
}

/** Preserve a created identity even when preparation fails before its handoff. */
export function recordInitRunCreated(state: InitRunEventState, runId: string): InitRunEventState {
  if (state.phase !== 'new' || !isInitRunId(runId)) return fail();
  return { phase: 'created', runId };
}

/** The caller threads the returned state. A repeated or foreign event fails before output. */
export function emitInitRunEvent(
  state: InitRunEventState,
  event: InitRunEvent,
  output: Readonly<{ isTTY?: boolean; write: (line: string) => unknown }> = process.stdout,
): InitRunEventState {
  if (!parseInitRunEvent(event) || state.phase === 'terminal') return fail();
  if (event.event === 'capy:init-run-handoff') {
    if (state.phase === 'handed-off' || (state.phase === 'created' && state.runId !== event.runId)) return fail();
    if (!output.isTTY) output.write(`${HANDOFF_EVENT_MARKER}${JSON.stringify(event)}\n`);
    return { phase: 'handed-off', runId: event.runId };
  }
  if ((state.phase === 'new' && event.runId !== null)
    || (state.phase !== 'new' && state.runId !== event.runId)
    || (state.phase === 'created' && event.status === 'succeeded')) return fail();
  if (!output.isTTY) output.write(`${HANDOFF_EVENT_MARKER}${JSON.stringify(event)}\n`);
  return { phase: 'terminal', runId: event.runId };
}
