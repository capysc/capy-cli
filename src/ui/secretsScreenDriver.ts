// Thin imperative shell for the `capy secrets` TUI (CAP-675). Owns every
// side effect the screen needs — raw stdin, the alt-screen ANSI dance, and
// dispatching the pure reducer's `fetchValue` effect to the injected
// decryptor — and nothing else. All actual behavior (what a keypress does,
// what a row/popup renders as) lives in the pure `secretsScreen.ts`; this
// file never computes any of it, it only calls in and draws the result.
//
// Every binding in this file is declared const; nothing is ever reassigned.
// A raw-mode stdin is an inherently callback-driven Node API — keypresses,
// terminal resizes, SIGINT/SIGTERM, and a value fetch resolving are four
// independent, asynchronously-arriving event sources that all have to feed
// into ONE sequential stream of immutable states. Rather than holding a
// mutable "current state" cell, every source re-emits onto a single local
// `EventEmitter` as one `DriverAction`; `node:events`' `on()` turns that
// into one async-iterable sequence (its own internal bookkeeping is the
// runtime's, not this module's), and `loop()` below consumes it with
// recursion — `state` is a plain function parameter, replaced by a
// brand-new value on every recursive call, never mutated in place.

import { EventEmitter, on } from 'node:events';
import {
  SecretsScreenState,
  SECRETS_SCREEN_ANSI,
  initialSecretsScreenState,
  handleKey,
  applyValueResult,
  resolveSecretValue,
  render,
  tokenizeKeys,
  LocationDecryptor,
  ValueState,
} from './secretsScreen';
import type { SecretIndexRow } from '../service/serviceClient';

const { HIDE_CURSOR, SHOW_CURSOR, MOVE_HOME, CLEAR_SCREEN, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } = SECRETS_SCREEN_ANSI;

type DriverAction =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'resize' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'value'; readonly row: SecretIndexRow; readonly result: ValueState };

function draw(state: SecretsScreenState): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  process.stdout.write(CLEAR_SCREEN + MOVE_HOME + render(state, width, height));
}

/**
 * Consumes one `DriverAction` per recursive call and returns once `state`
 * says to quit. `bus` is where a fetch this call kicks off re-emits its
 * result, so it can rejoin the SAME sequential stream `actions` is already
 * reading from — never a second, competing "current state" of its own.
 */
async function loop(
  state: SecretsScreenState,
  actions: AsyncIterator<[DriverAction]>,
  decryptAt: LocationDecryptor,
  bus: EventEmitter,
): Promise<void> {
  if (state.quit) return;
  draw(state);

  const { value } = await actions.next();
  const [action] = value;

  if (action.kind === 'quit') return loop({ ...state, quit: true }, actions, decryptAt, bus);
  if (action.kind === 'resize') return loop(state, actions, decryptAt, bus);
  if (action.kind === 'value') return loop(applyValueResult(state, action.row, action.result), actions, decryptAt, bus);

  const { state: nextState, effect } = handleKey(state, action.key);
  if (effect) {
    // Fired and forgotten: a result that arrives after the popup has moved
    // on is dropped by `applyValueResult`'s (name, value_hash) guard, so
    // there's nothing to cancel here.
    void resolveSecretValue(effect.row, decryptAt).then((result) => {
      bus.emit('action', { kind: 'value', row: effect.row, result });
    });
  }
  return loop(nextState, actions, decryptAt, bus);
}

/**
 * Runs the interactive screen to completion (until the user quits). Always
 * restores the terminal — cursor shown, alt screen exited, raw mode off —
 * even if a fetch/decrypt or a render throws, via try/finally.
 */
export async function runSecretsScreen(rows: readonly SecretIndexRow[], decryptAt: LocationDecryptor): Promise<void> {
  const bus = new EventEmitter();
  // A single `data` chunk can carry more than one keypress (a paste, fast
  // typing, or piped/scripted input) — `tokenizeKeys` splits it into
  // individual tokens first, and each becomes its own action, so all of
  // them reach the reducer in order instead of the chunk being handled (or
  // silently dropped) as if it were one key.
  const onData = (data: Buffer): void => {
    for (const key of tokenizeKeys(data.toString())) bus.emit('action', { kind: 'key', key });
  };
  const onResize = (): boolean => bus.emit('action', { kind: 'resize' });
  const onSignal = (): boolean => bus.emit('action', { kind: 'quit' });
  const actions = on(bus, 'action') as AsyncIterator<[DriverAction]>;

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.on('SIGWINCH', onResize);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await loop(initialSecretsScreenState(rows), actions, decryptAt, bus);
  } finally {
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeListener('data', onData);
    process.removeListener('SIGWINCH', onResize);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    const closable = actions as AsyncIterator<[DriverAction]> & { return?: (v?: unknown) => Promise<unknown> };
    if (typeof closable.return === 'function') await closable.return();
  }
}
