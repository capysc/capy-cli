// Thin imperative shell for the `capy secrets` TUI (CAP-675). Owns every
// side effect the screen needs — raw stdin, the alt-screen ANSI dance, and
// dispatching the pure reducer's `fetchValue` effect to the injected
// decryptor — and nothing else. All actual behavior (what a keypress does,
// what a row/popup renders as) lives in the pure `secretsScreen.ts`; this
// file never computes any of it, it only calls in and draws the result.
//
// The one deliberate exception to the "no mutable bindings" house rule: a
// Node stdin listener is an inherently stateful, callback-driven API (like
// any other host runtime facility this driver has to hold), and bridging it
// to a sequence of immutable states needs exactly one cell that always holds
// "the current state" so a keypress and a late-arriving fetch result can
// both feed into it. `state` below is that cell — every assignment REPLACES
// it wholesale with a brand-new object from `handleKey`/`applyValueResult`;
// nothing ever mutates a field of the value it already holds.

import {
  SecretsScreenState,
  SECRETS_SCREEN_ANSI,
  initialSecretsScreenState,
  handleKey,
  applyValueResult,
  resolveSecretValue,
  render,
  LocationDecryptor,
} from './secretsScreen';
import type { SecretIndexRow } from '../service/serviceClient';

const { HIDE_CURSOR, SHOW_CURSOR, MOVE_HOME, CLEAR_SCREEN, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } = SECRETS_SCREEN_ANSI;

/**
 * Runs the interactive screen to completion (until the user quits). Always
 * restores the terminal — cursor shown, alt screen exited, raw mode off —
 * even if a fetch/decrypt or a render throws, via try/finally.
 */
export async function runSecretsScreen(rows: readonly SecretIndexRow[], decryptAt: LocationDecryptor): Promise<void> {
  let state: SecretsScreenState = initialSecretsScreenState(rows);

  let cleanedUp = false;
  let onData: ((data: Buffer) => void) | null = null;
  let onResize: (() => void) | null = null;

  const draw = () => {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    process.stdout.write(CLEAR_SCREEN + MOVE_HOME + render(state, width, height));
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (onData) process.stdin.removeListener('data', onData);
    if (onResize) process.removeListener('SIGWINCH', onResize);
  };

  try {
    await new Promise<void>((resolve) => {
      // A value fetch that resolves after the popup has moved on is dropped
      // by `applyValueResult`'s (name, value_hash) guard — so firing it and
      // forgetting it here (no cancellation) is safe.
      const runFetch = (row: SecretIndexRow) => {
        void resolveSecretValue(row, decryptAt).then((result) => {
          state = applyValueResult(state, row, result);
          draw();
        });
      };

      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();

      draw();

      onData = (data: Buffer) => {
        const { state: nextState, effect } = handleKey(state, data.toString());
        state = nextState;
        if (effect) runFetch(effect.row);
        if (state.quit) {
          resolve();
          return;
        }
        draw();
      };
      process.stdin.on('data', onData);

      onResize = () => draw();
      process.on('SIGWINCH', onResize);

      const exit = () => resolve();
      process.once('SIGINT', exit);
      process.once('SIGTERM', exit);
    });
  } finally {
    cleanup();
  }
}
