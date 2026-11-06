/**
 * The `capy edit` screen's pure core (src/ui/editScreen.ts), after bare `capy` has already settled every difference
 * (src/sync/gate.ts): the screen starts in sync and has no way to resolve anything itself.
 *   - a commit carries the edits typed and the server read the rows came from (its `base_keep_hash`), nothing else;
 *   - Capy having moved since that read (`SECRETS_STALE_BASE`) closes the screen with nothing uploaded and the edits kept,
 *     so the command can run bare `capy` and reopen it with the edits still typed (`withPendingEdits`);
 *   - a row both sides changed still READS `conflict`, but no key on this screen resolves it.
 */
import { describe, test, expect } from 'bun:test';
import {
  classifiedRow,
  initialModel,
  reduce,
  render,
  saveOutcome,
  withPendingEdits,
  type EditContext,
  type EditModel,
  type EditRow,
  type EditState,
} from '../../src/ui/editScreen';
import { hashValue } from '../../src/sync/compareSecrets';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const mode = { localMode: false, remoteAvailable: true };

const row = (key: string, local: string | undefined, remote: string | undefined, pinned: string | undefined): EditRow =>
  classifiedRow({ key, localValue: local, remoteValue: remote, status: 'unknown', updatedLabel: '—', pinnedHash: pinned === undefined ? null : hashValue(pinned) }, mode);

const state = (rows: readonly EditRow[]): EditState => ({ projectName: 'demo', branch: 'development', rows, remoteAvailable: true });

const press = (model: EditModel, ...keys: readonly string[]): EditModel => keys.reduce((m, k) => reduce(m, { kind: 'data', data: k }).model, model);
const ENTER = '\r';

/** The model after editing row `index`'s value to `value` (e, type, Enter). */
const edited = (model: EditModel, value: string): EditModel => press(model, 'e', ...value.split(''), ENTER);

describe('statuses (display only)', () => {
  test('in sync, local, remote and conflict read as they always did', () => {
    expect(row('A', 'a', 'a', 'a').status).toBe('in sync');
    expect(row('B', 'b2', 'b', 'b').status).toBe('local');
    expect(row('C', 'c', 'c2', 'c').status).toBe('remote');
    expect(row('D', 'd-aaa', 'd-bbb', 'd').status).toBe('conflict');
  });

  test('no key resolves a conflict row: m and t do nothing, the row stays a conflict, and nothing is dirty', () => {
    const model = initialModel(state([row('D', 'd-aaa', 'd-bbb', 'd')]));
    const after = press(model, 'm', 't', 'M', 'T');
    expect(after.state.rows[0].status).toBe('conflict');
    expect(after.pending).toEqual({});
    // Nothing to commit: `c` asks for no save.
    expect(reduce(after, { kind: 'data', data: 'c' }).effect).toBeUndefined();
  });

  test('the footer offers no mine/theirs on a conflict row', () => {
    const frame = render(initialModel(state([row('D', 'd-aaa', 'd-bbb', 'd')])), 100, 30).text;
    expect(frame).not.toMatch(/mine|theirs/);
  });
});

describe('committing', () => {
  const seen = { keep: undefined, entries: {} } as const;

  test('c: the commit is the edits typed and the server read the rows came from; nothing else', () => {
    const model = edited(initialModel({ ...state([row('A', 'a', 'a', 'a'), row('B', 'b', 'b', 'b')]), seen }), 'a2');
    const outcome = reduce(model, { kind: 'data', data: 'c' });
    expect(outcome.effect).toEqual({ type: 'save', request: { set: { A: 'a2' }, seen } });
  });

  test('a save that landed refreshes the rows and clears the edits', () => {
    const model = edited(initialModel(state([row('A', 'a', 'a', 'a')])), 'a2');
    const requested = reduce(model, { kind: 'data', data: 'c' });
    const landed = reduce(requested.model, { kind: 'saved', result: { kind: 'saved', changedAt: { A: '2026-10-15T00:00:00.000Z' }, loaded: undefined } });
    expect(landed.done).toBeUndefined();
    expect(landed.model.pending).toEqual({});
    expect(landed.model.state.rows[0].status).toBe('in sync');
  });

  test('Capy moved since the screen read it: the screen is over, stale, with the edits kept and nothing claimed saved', () => {
    const model = edited(initialModel(state([row('A', 'a', 'a', 'a')])), 'a2');
    const requested = reduce(model, { kind: 'data', data: 'c' });
    const stale = reduce(requested.model, { kind: 'saved', result: { kind: 'stale' } });
    expect(stale.done).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.model.pending).toEqual({ A: 'a2' });
  });

  test('any other failure keeps the screen open with the edits and says so', () => {
    const model = edited(initialModel(state([row('A', 'a', 'a', 'a')])), 'a2');
    const requested = reduce(model, { kind: 'data', data: 'c' });
    const failed = reduce(requested.model, { kind: 'saved', result: { kind: 'failed', message: 'down' } });
    expect(failed.done).toBeUndefined();
    expect(failed.model.pending).toEqual({ A: 'a2' });
    expect(failed.model.status?.isError).toBe(true);
  });
});

describe('saveOutcome', () => {
  const request = { set: { A: 'a2' }, seen: undefined };

  test('SECRETS_STALE_BASE is stale (decided by the code); anything else is failed; a landed save carries changed_at', async () => {
    const ctx = (save: () => Promise<Record<string, string>>): EditContext => ({ saveLocalEdits: save });
    expect(await saveOutcome(ctx(async () => Promise.reject(new CapyError('stale', ERROR_CODES.SECRETS_STALE_BASE))), request)).toEqual({ kind: 'stale' });
    expect(await saveOutcome(ctx(async () => Promise.reject(new CapyError('no', ERROR_CODES.NETWORK_ERROR))), request)).toMatchObject({ kind: 'failed' });
    expect(await saveOutcome(ctx(async () => ({ A: '2026-10-15T00:00:00.000Z' })), request)).toMatchObject({ kind: 'saved', changedAt: { A: '2026-10-15T00:00:00.000Z' } });
  });
});

describe('reopening after bare capy (withPendingEdits)', () => {
  test('the typed values come back as uncommitted edits, a name no row has gets one, and a clean state is returned as it is', () => {
    const base = state([row('A', 'a', 'a', 'a'), row('B', 'b', 'b', 'b')]);
    const reopened = withPendingEdits(base, { A: 'a2', NEW: 'n1' });
    expect(reopened.rows.map((r) => [r.key, r.localValue, r.status])).toEqual([
      ['A', 'a2', 'local'],
      ['B', 'b', 'in sync'],
      ['NEW', 'n1', 'local'],
    ]);
    const model = initialModel(reopened);
    expect(model.pending).toEqual({ A: 'a2', NEW: 'n1' });
    // ... and it can be committed straight away.
    expect(reduce(model, { kind: 'data', data: 'c' }).effect).toMatchObject({ type: 'save', request: { set: { A: 'a2', NEW: 'n1' } } });
    expect(withPendingEdits(base, {})).toBe(base);
  });

  test('a row Capy changed in the meantime reads remote/conflict against the reopened read, as any row does', () => {
    const reopened = withPendingEdits(state([row('A', 'a', 'a-newer', 'a')]), { A: 'a2' });
    expect(reopened.rows[0].status).toBe('conflict');
  });
});

