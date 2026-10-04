/**
 * An append-only log of the saves made during a `capy edit` session.
 *
 * The screen's `saveLocalEdits` callback runs once per save and has no way to
 * hand state back through its return value, so something outside it has to
 * collect the saves. Rather than a cell that is reassigned on every save, each
 * save is announced on an event channel and a single consumer folds the
 * announcements into an array it threads through as an argument — nothing is
 * ever reassigned or mutated.
 */
import { EventEmitter, on } from 'node:events';
import type { EditSaveRecord } from '../deploy/keepGate';

const SAVE_EVENT = 'save';

type Step = { readonly done: true } | { readonly done: false; readonly record: EditSaveRecord };

/** The next save, or `done` once the log was closed. */
async function nextSave(it: AsyncIterator<unknown[]>): Promise<Step> {
  try {
    const next = await it.next();
    return next.done ? { done: true } : { done: false, record: next.value[0] as EditSaveRecord };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') return { done: true };
    throw err;
  }
}

async function collect(it: AsyncIterator<unknown[]>, saved: readonly EditSaveRecord[]): Promise<readonly EditSaveRecord[]> {
  const step = await nextSave(it);
  return step.done ? saved : collect(it, [...saved, step.record]);
}

export interface SessionSaveLog {
  /** Appends one save. */
  readonly record: (save: EditSaveRecord) => void;
  /** Closes the log and returns every save recorded, in order. */
  readonly finish: () => Promise<readonly EditSaveRecord[]>;
}

export function startSaveLog(): SessionSaveLog {
  const bus = new EventEmitter();
  const closer = new AbortController();
  const collected = collect(on(bus, SAVE_EVENT, { signal: closer.signal })[Symbol.asyncIterator](), []);
  return {
    record: (save) => {
      bus.emit(SAVE_EVENT, save);
    },
    finish: () => {
      closer.abort();
      return collected;
    },
  };
}
