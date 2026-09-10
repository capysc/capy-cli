import { expect, test } from 'bun:test';
import { emitInitRunEvent, initRunHandoffEvent, initRunReceiptEvent, initRunUnconfirmedEvent, parseInitRunEvent, recordInitRunCreated } from '../../src/ui/initRunEvent';
import type { InitRunTerminalReceipt } from '../../src/auth/initRunContract';

const RUN = '11111111-1111-4111-8111-111111111111';
const TS = '2026-09-10T04:50:00.000Z';
const HANDOFF = initRunHandoffEvent({
  runId: RUN, entryUrl: `https://keep.dev.example/flow/init-wizard?run=${RUN}`,
  claimCode: '7KM2-W9QD-R4TX', expiresAt: '2026-09-10T05:00:00.000Z',
}, TS);
const RECEIPT: InitRunTerminalReceipt = {
  v: 1, run_id: RUN, receipt_id: '22222222-2222-4222-8222-222222222222', status: 'succeeded', code: null,
  repository_verified: true, custody_verified: true, effects: 'complete', completed_at: TS,
};

test('matches the approved event projection and does not spread private bootstrap or receipt fields', () => {
  const extra = { ...HANDOFF, runSecret: 'private' };
  expect(parseInitRunEvent(extra)).toBeNull();
  expect(parseInitRunEvent({ ...HANDOFF, claimCode: HANDOFF.claimCode.toLowerCase() })).toBeNull();
  expect(parseInitRunEvent({ ...HANDOFF, url: `${HANDOFF.url}&claim=${HANDOFF.claimCode}` })).toBeNull();
  expect(parseInitRunEvent({ ...HANDOFF, expiresAt: TS })).toBeNull();
  expect(parseInitRunEvent(HANDOFF)).toEqual(HANDOFF);
  const terminal = initRunReceiptEvent(RECEIPT, TS);
  expect(terminal).toEqual({
    v: 1, event: 'capy:init-run-terminal', flow: 'init', runId: RUN,
    receiptId: RECEIPT.receipt_id, status: 'succeeded', code: 'INIT_DONE', effectState: 'verified_applied',
    repositoryVerified: true, custodyVerified: true, ts: TS,
  });
  expect(Object.keys(terminal)).not.toContain('completed_at');
});

test('threads one handoff and one matching terminal, rejecting repeats before writing', () => {
  const first = Promise.withResolvers<string>();
  const handedOff = emitInitRunEvent({ phase: 'new' }, HANDOFF, { write: first.resolve });
  const final = Promise.withResolvers<string>();
  const terminal = initRunReceiptEvent(RECEIPT, TS);
  const finished = emitInitRunEvent(handedOff, terminal, { write: final.resolve });
  expect(handedOff).toEqual({ phase: 'handed-off', runId: RUN });
  expect(finished).toEqual({ phase: 'terminal', runId: RUN });
  expect(first.promise).resolves.toBe(`CAPY_EVENT_V1 ${JSON.stringify(HANDOFF)}\n`);
  expect(final.promise).resolves.toBe(`CAPY_EVENT_V1 ${JSON.stringify(terminal)}\n`);
  const forbidden = { write: (): never => { throw new Error('SHOULD_NOT_WRITE'); } };
  expect(() => emitInitRunEvent(handedOff, HANDOFF, forbidden)).toThrow('INIT_RUN_EVENT_INVALID');
  expect(() => emitInitRunEvent(finished, terminal, forbidden)).toThrow('INIT_RUN_EVENT_INVALID');
  expect(() => emitInitRunEvent(handedOff, { ...terminal, runId: RECEIPT.receipt_id }, forbidden)).toThrow('INIT_RUN_EVENT_INVALID');
  expect(() => emitInitRunEvent({ phase: 'new' }, terminal, forbidden)).toThrow('INIT_RUN_EVENT_INVALID');
});

test('TTY emits neither event but retains immutable transition enforcement', () => {
  const tty = { isTTY: true, write: (): never => { throw new Error('TTY_OUTPUT_FORBIDDEN'); } };
  const first = emitInitRunEvent({ phase: 'new' }, HANDOFF, tty);
  expect(emitInitRunEvent(first, initRunReceiptEvent(RECEIPT, TS), tty).phase).toBe('terminal');
});

test('represents pre-run failure, known no-effect cancellation, and lost authority without inferring rollback', () => {
  const before = initRunUnconfirmedEvent({ kind: 'pre-run', code: 'INIT_RUN_CREATE_FAILED' }, TS);
  expect(before).toMatchObject({ runId: null, receiptId: null, status: 'failed', effectState: 'not_started' });
  expect(emitInitRunEvent({ phase: 'new' }, before, { isTTY: true, write: () => undefined }).phase).toBe('terminal');
  expect(initRunUnconfirmedEvent({ kind: 'no-effects', runId: RUN, status: 'cancelled', code: 'INIT_RUN_CANCELLED' }, TS))
    .toMatchObject({ runId: RUN, receiptId: null, status: 'cancelled', effectState: 'not_applied' });
  const ambiguous = initRunUnconfirmedEvent({ kind: 'indeterminate', runId: RUN, repositoryVerified: true, custodyVerified: false }, TS);
  expect(ambiguous).toMatchObject({ receiptId: null, status: 'indeterminate', code: 'INIT_FINAL_OUTCOME_INDETERMINATE',
    effectState: 'indeterminate', repositoryVerified: true, custodyVerified: false });
  expect(parseInitRunEvent({ ...ambiguous, status: 'succeeded', code: 'INIT_DONE' })).toBeNull();
  expect(parseInitRunEvent({ ...before, repositoryVerified: true })).toBeNull();
});

test('preserves original failure codes and keeps repository and custody verification separate', () => {
  const failed = initRunReceiptEvent({ ...RECEIPT, status: 'failed', code: 'ENCRYPT_PUSH_FAILED',
    repository_verified: false, custody_verified: false, effects: 'indeterminate' }, TS);
  expect(failed.code).toBe('ENCRYPT_PUSH_FAILED');
  expect(failed.effectState).toBe('indeterminate');
  expect(initRunReceiptEvent({ ...RECEIPT, custody_verified: false }, TS).custodyVerified).toBe(false);
  expect(parseInitRunEvent({ ...failed, code: 'INIT_DONE' })).toBeNull();
  for (const code of ['A', 'A'.repeat(128)]) {
    expect(initRunReceiptEvent({ ...RECEIPT, status: 'failed', code,
      repository_verified: false, effects: 'indeterminate' }, TS).code).toBe(code);
  }
  expect(parseInitRunEvent({ ...failed, code: 'A'.repeat(129) })).toBeNull();
});

test('retains a known run when failure precedes handoff without inventing a handoff', () => {
  const created = recordInitRunCreated({ phase: 'new' }, RUN);
  const failure = initRunUnconfirmedEvent({ kind: 'no-effects', runId: RUN, status: 'failed', code: 'INIT_RUN_CONFIGURATION' }, TS);
  const tty = { isTTY: true, write: (): never => { throw new Error('NO_HANDOFF_EXPECTED'); } };
  expect(emitInitRunEvent(created, failure, tty)).toEqual({ phase: 'terminal', runId: RUN });
  expect(emitInitRunEvent(created, HANDOFF, tty)).toEqual({ phase: 'handed-off', runId: RUN });
  expect(() => emitInitRunEvent(created, initRunReceiptEvent(RECEIPT, TS), tty)).toThrow('INIT_RUN_EVENT_INVALID');
  expect(() => emitInitRunEvent(created, { ...HANDOFF, runId: RECEIPT.receipt_id }, tty)).toThrow('INIT_RUN_EVENT_INVALID');
  expect(() => recordInitRunCreated(created, RUN)).toThrow('INIT_RUN_EVENT_INVALID');
});
