// Thin imperative shell for the `capy projects` type-to-search TUI. Owns
// every side effect the screen needs — raw stdin, the alt-screen ANSI
// dance, resize/signal handling — and nothing else. All actual behavior
// (what a keypress does, what a row/inspect view renders as) lives in the
// pure `projectsScreen.ts`; this file never computes any of it, it only
// calls in and draws the result. Modeled directly on
// `secretsScreenDriver.ts`'s event-bus/async-iterator loop, with one
// simplification: `projectsScreen.ts`'s reducer never produces an effect
// (nothing here is ever fetched — see that module's doc), so there is no
// `value`-kind action to thread through.
//
// Every binding in this file is declared const; nothing is ever reassigned.
//
// stdin/stdout and the resize/signal subscriptions are injectable (defaults
// to the real `process.stdin`/`process.stdout`/`SIGWINCH`/`SIGINT`/
// `SIGTERM`), the same pattern `maskedLinkPrompt.ts`'s `KeyStdin`/
// `WritableOut` and `fullScreenQr.ts`'s `getSize`/`onResize` already use —
// so this driver is testable with a fake TTY stream instead of a real
// terminal.

import { EventEmitter, on } from 'node:events';
import { ProjectsScreenState, PROJECTS_SCREEN_ANSI, initialProjectsScreenState, handleKey, render, tokenizeKeys } from './projectsScreen';
import type { ProjectSummary } from '../commands/projectsCommand';
import type { KeyStdin, WritableOut } from './maskedLinkPrompt';

const { HIDE_CURSOR, SHOW_CURSOR, MOVE_HOME, CLEAR_SCREEN, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } = PROJECTS_SCREEN_ANSI;

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface RunProjectsScreenOptions {
  readonly stdin?: KeyStdin;
  readonly stdout?: WritableOut;
  /** Defaults to real `process.stdout.columns`/`.rows` (80x24 fallback). Injectable so tests never need a real TTY-sized terminal. */
  readonly getSize?: () => TerminalSize;
  /** Subscribes `cb` to a terminal resize; returns an unsubscribe. Defaults to real `SIGWINCH`. Injectable for tests. */
  readonly onResize?: (cb: () => void) => () => void;
  /** Subscribes `cb` to a termination signal; returns an unsubscribe. Defaults to real `SIGINT`/`SIGTERM`. Injectable for tests. */
  readonly onSignal?: (cb: () => void) => () => void;
}

type DriverAction = { readonly kind: 'key'; readonly key: string } | { readonly kind: 'resize' } | { readonly kind: 'quit' };

function defaultGetSize(): TerminalSize {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function defaultOnResize(cb: () => void): () => void {
  process.on('SIGWINCH', cb);
  return () => {
    process.removeListener('SIGWINCH', cb);
  };
}

function defaultOnSignal(cb: () => void): () => void {
  process.once('SIGINT', cb);
  process.once('SIGTERM', cb);
  return () => {
    process.removeListener('SIGINT', cb);
    process.removeListener('SIGTERM', cb);
  };
}

function draw(state: ProjectsScreenState, stdout: WritableOut, getSize: () => TerminalSize): void {
  const { cols, rows } = getSize();
  stdout.write(CLEAR_SCREEN + MOVE_HOME + render(state, cols, rows));
}

/** Consumes one `DriverAction` per recursive call and returns once `state` says to quit. */
async function loop(
  state: ProjectsScreenState,
  actions: AsyncIterator<[DriverAction]>,
  stdout: WritableOut,
  getSize: () => TerminalSize,
): Promise<void> {
  if (state.quit) return;
  draw(state, stdout, getSize);

  const { value } = await actions.next();
  const [action] = value;

  if (action.kind === 'quit') return loop({ ...state, quit: true }, actions, stdout, getSize);
  if (action.kind === 'resize') return loop(state, actions, stdout, getSize);

  return loop(handleKey(state, action.key), actions, stdout, getSize);
}

/**
 * Runs the interactive screen to completion (until the user quits). Always
 * restores the terminal — cursor shown, alt screen exited, raw mode off —
 * even if a render throws, via try/finally.
 */
export async function runProjectsScreen(projects: readonly ProjectSummary[], opts: RunProjectsScreenOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? (process.stdin as unknown as KeyStdin);
  const stdout = opts.stdout ?? process.stdout;
  const getSize = opts.getSize ?? defaultGetSize;
  const onResize = opts.onResize ?? defaultOnResize;
  const onSignal = opts.onSignal ?? defaultOnSignal;

  const bus = new EventEmitter();
  // A single `data` chunk can carry more than one keypress (a paste, fast
  // typing, or piped/scripted input) — `tokenizeKeys` splits it into
  // individual tokens first, and each becomes its own action, so all of
  // them reach the reducer in order instead of the chunk being handled (or
  // silently dropped) as if it were one key.
  const onData = (chunk: string): void => {
    for (const key of tokenizeKeys(chunk.toString())) bus.emit('action', { kind: 'key', key });
  };
  const handleResizeEvent = (): boolean => bus.emit('action', { kind: 'resize' });
  const handleSignalEvent = (): boolean => bus.emit('action', { kind: 'quit' });
  const actions = on(bus, 'action') as AsyncIterator<[DriverAction]>;

  stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  const stopResize = onResize(handleResizeEvent);
  const stopSignal = onSignal(handleSignalEvent);

  try {
    await loop(initialProjectsScreenState(projects), actions, stdout, getSize);
  } finally {
    stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener('data', onData);
    stopResize();
    stopSignal();
    const closable = actions as AsyncIterator<[DriverAction]> & { return?: (v?: unknown) => Promise<unknown> };
    if (typeof closable.return === 'function') await closable.return();
  }
}
