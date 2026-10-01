/**
 * Full-screen centered QR view for `capy transport` and `capy pair`
 * (CAP-692 follow-up) — shared by both commands so they behave identically.
 *
 * Only used in a real interactive TTY (both stdin AND stdout, not `--json`,
 * not `NO_COLOR` — see {@link isFullScreenQrEligible}, the same bar
 * `maskedLinkPrompt.ts`'s `isInteractiveLinkPrompt` sets for the plain
 * masked-link prompt, plus the `NO_COLOR` check this fancier view adds on
 * top). Everywhere else, callers keep today's inline behaviour unchanged —
 * this module is never imported into that path at all.
 *
 * Sequence: the caller prints its own intro copy inline FIRST (so it stays
 * in scrollback), then calls {@link startFullScreenQrView}, which enters
 * the terminal's alternate screen (`\x1b[?1049h`), hides the cursor, and
 * draws the QR centered both ways with the masked link + key hints +
 * expiry centered directly under it (via `qrScreenLayout.ts`). `c`/`r`/`q`
 * reuse the exact same reducer `maskedLinkPrompt.ts` uses
 * (`attachMaskedLinkKeyListener`/`handleMaskedLinkKey`) — no duplicated
 * state machine. `r` (reveal) redraws with the full link wrapped to the
 * terminal width underneath (pushing layout, which is fine); `c` (copy)
 * just appends a confirmation line, same as the non-full-screen prompt.
 * Resize (`SIGWINCH` / stdout `'resize'`) redraws at the new size, same
 * `revealed` state.
 *
 * On q/Enter/Esc/Ctrl-C, on `stop()`, or on an error during the initial
 * draw, ALWAYS restores (`\x1b[?25h` show cursor, `\x1b[?1049l` leave the
 * alternate screen) before anything else — via try/finally plus a
 * `process.once('exit', ...)` safety net — then the caller prints the
 * masked link + expiry inline as it does today, so scrollback still has
 * them. The terminal is never left stuck in the alternate screen.
 */
import { EventEmitter, once } from 'node:events';
import {
  handleMaskedLinkKey,
  attachMaskedLinkKeyListener,
  HINT_LINE,
  COPIED_LINE,
  COPY_FAILED_LINE,
  type KeyStdin,
  type WritableOut,
  type MaskedLinkAction,
} from './maskedLinkPrompt';
import { oscHyperlink } from './osc8';
import { copyToClipboard } from './clipboard';
import { layoutQrScreen, visibleWidth, type TerminalSize } from './qrScreenLayout';
import type { RenderedTerminalQr } from './terminalQr';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const CLEAR_AND_HOME = '\x1b[2J\x1b[H';

export interface FullScreenQrOptions {
  /** The real, sensitive URL — the QR payload, the OSC 8 click target, and what `r` reveals. */
  readonly fullUrl: string;
  /** The masked text shown on the link line. */
  readonly maskedUrl: string;
  /** Printed before the masked link, e.g. `"Open on your other device:"`. */
  readonly label: string;
  /** The already-rendered half-block QR (see `terminalQr.ts`). */
  readonly qr: RenderedTerminalQr;
  /** Copy shown above the QR inside the full-screen view (word-wrapped to the terminal width). The alternate screen hides anything printed before it, so callers pass their intro here as well. */
  readonly headerLines?: readonly string[];
  /** Extra lines centered under the key hint, e.g. `["Code: ABCD-EFGH"]` or `["Expires 2026-…"]`. Printed verbatim — callers own their own COPY-FLAGs. */
  readonly extraFooterLines?: readonly string[];
  readonly stdin?: KeyStdin;
  readonly stdout?: WritableOut;
  readonly copy?: (text: string) => Promise<boolean>;
  /** Defaults to real `process.stdout.columns`/`.rows` (80x24 fallback). Injectable so tests never need a real TTY-sized terminal. */
  readonly getSize?: () => TerminalSize;
  /** Subscribes `cb` to a resize; returns an unsubscribe. Defaults to real `SIGWINCH` + stdout `'resize'`. Injectable for tests. */
  readonly onResize?: (cb: () => void) => () => void;
}

export interface FullScreenQrHandle {
  /** Resolves once the view closes (q/Enter/Esc, or `stop()`). */
  readonly done: Promise<void>;
  /** Closes the view (same effect as the user pressing `q`): restores the terminal and resolves `done`. Idempotent. */
  readonly stop: () => void;
}

/**
 * Whether the full-screen view should run at all: both ends a real TTY
 * (same bar `isInteractiveLinkPrompt` uses), never under `--json`, and
 * never with a `NO_COLOR`-style opt-out set (https://no-color.org) — this
 * view is a much bigger terminal decoration than the plain masked-link
 * prompt, so it honors that convention even though the plain prompt
 * doesn't need to.
 */
export function isFullScreenQrEligible(
  json: boolean,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
  noColor: boolean = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length > 0,
): boolean {
  if (json) return false;
  if (noColor) return false;
  return stdin.isTTY === true && stdout.isTTY === true;
}

function defaultGetSize(): TerminalSize {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

// Only stdout's 'resize': Node emits it from its own SIGWINCH handler, so
// also subscribing to SIGWINCH ran every resize twice (and, because each run
// starts a new generation, doubled the live generations on every resize).
function defaultOnResize(cb: () => void): () => void {
  process.stdout.on('resize', cb);
  return () => {
    process.stdout.removeListener('resize', cb);
  };
}

/** Word-wraps `line` to `width` visible columns (ANSI/OSC escapes don't count). A single word longer than `width` is left whole. */
function wordWrap(line: string, width: number): readonly string[] {
  const words = line.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  return words.reduce<readonly string[]>((lines, word) => {
    const last = lines[lines.length - 1];
    if (last === undefined) return [word];
    return visibleWidth(`${last} ${word}`) <= width ? [...lines.slice(0, -1), `${last} ${word}`] : [...lines, word];
  }, []);
}

function wrapHeader(lines: readonly string[], cols: number): readonly string[] {
  const width = Math.max(20, Math.min(cols - 4, 76));
  return lines.flatMap((l) => wordWrap(l, width));
}

function wrapToWidth(text: string, width: number): readonly string[] {
  const w = Math.max(1, width);
  return Array.from({ length: Math.ceil(text.length / w) }, (_, i) => text.slice(i * w, (i + 1) * w));
}

interface ScreenState {
  readonly revealed: boolean;
}

function buildFooterLines(opts: FullScreenQrOptions, state: ScreenState, size: TerminalSize): readonly string[] {
  const maskedLine = `${opts.label} ${oscHyperlink(opts.fullUrl, opts.maskedUrl)}`;
  const base: readonly string[] = [maskedLine, HINT_LINE, ...(opts.extraFooterLines ?? [])];
  if (!state.revealed) return base;
  return [...base, '', ...wrapToWidth(opts.fullUrl, size.cols)];
}

/**
 * Opens the full-screen view. Entering the alternate screen and the first
 * draw are wrapped in try/finally so a failure anywhere in that sequence
 * still restores the terminal before the error propagates.
 */
export function startFullScreenQrView(opts: FullScreenQrOptions): FullScreenQrHandle {
  const stdin = opts.stdin ?? (process.stdin as unknown as KeyStdin);
  const out = opts.stdout ?? process.stdout;
  const copy = opts.copy ?? copyToClipboard;
  const getSize = opts.getSize ?? defaultGetSize;
  const onResize = opts.onResize ?? defaultOnResize;

  const doneEmitter = new EventEmitter();
  // Bridges the external handle's `stop()` into whichever "generation" of
  // listeners (one per draw — a fresh one is created on every reveal/resize
  // rather than mutating state in place) is currently live. Node's own
  // EventEmitter is the one piece of mutable state here, same carve-out
  // `maskedLinkPrompt.ts` already relies on for `done`.
  const controlEmitter = new EventEmitter();

  const restore = (): void => {
    out.write(SHOW_CURSOR);
    out.write(LEAVE_ALT_SCREEN);
  };

  const onProcessExit = (): void => restore();
  process.once('exit', onProcessExit);

  const finish = (): void => {
    process.removeListener('exit', onProcessExit);
    restore();
    doneEmitter.emit('done');
  };

  function draw(state: ScreenState): void {
    const size = getSize();
    const qrLines = opts.qr.text.split('\n').filter((l) => l.length > 0);
    const footer = opts.qr.hint ? [opts.qr.hint, ...buildFooterLines(opts, state, size)] : buildFooterLines(opts, state, size);
    const header = opts.headerLines && opts.headerLines.length > 0 ? [...wrapHeader(opts.headerLines, size.cols), ''] : [];
    const layout = layoutQrScreen(size, [...header, ...qrLines], footer);
    // Never write more rows than the screen has: extra rows scroll the
    // alternate screen and smear the next redraw.
    const visible = layout.fits ? layout.lines : layout.lines.slice(0, Math.max(1, size.rows));
    out.write(CLEAR_AND_HOME);
    out.write(visible.join('\n'));
  }

  /** One "generation": draws at `state`, attaches its own key + resize listeners, and tears itself down (removing both, plus its `stop` listener) before any transition — reveal, resize, or close. */
  function run(state: ScreenState): void {
    draw(state);

    // Ends this generation exactly once; any late callback from it (a
    // resize or key event already queued) is ignored.
    const generation = new AbortController();

    const teardownGen = (): void => {
      if (generation.signal.aborted) return;
      generation.abort();
      keyListener.stop();
      unsubResize();
      controlEmitter.removeListener('stop', onStop);
    };

    const onStop = (): void => {
      teardownGen();
      finish();
    };

    const handleAction = (action: MaskedLinkAction): void => {
      if (generation.signal.aborted) return;
      if (action.kind === 'copy') {
        // Fire-and-forget, same as the non-full-screen prompt — never
        // awaited, never redraws (just appends a line below).
        void copy(opts.fullUrl).then((ok) => {
          out.write(`\n${ok ? COPIED_LINE : COPY_FAILED_LINE}`);
        });
        return;
      }
      if (action.kind === 'reveal') {
        teardownGen();
        run({ ...state, revealed: true });
        return;
      }
      if (action.kind === 'done') {
        teardownGen();
        finish();
        return;
      }
      if (action.kind === 'exit') {
        teardownGen();
        restore();
        process.exit(130);
      }
    };

    const keyListener = attachMaskedLinkKeyListener(stdin, handleAction);
    const unsubResize = onResize(() => {
      if (generation.signal.aborted) return;
      teardownGen();
      run(state);
    });
    controlEmitter.once('stop', onStop);
  }

  try {
    out.write(HIDE_CURSOR);
    out.write(ENTER_ALT_SCREEN);
    run({ revealed: false });
  } catch (err) {
    restore();
    throw err;
  }

  return {
    done: once(doneEmitter, 'done').then(() => undefined),
    stop: () => controlEmitter.emit('stop'),
  };
}

// Re-exported so call sites that already imported the pure reducer from
// `maskedLinkPrompt.ts` don't need a second import for the same function.
export { handleMaskedLinkKey };

/**
 * What stays in scrollback once the full-screen view closes — the same end
 * state the non-full-screen masked-link prompt leaves behind (the masked
 * hyperlink line, any extra lines the caller wants under it, then a blank
 * line), printed plainly (no key hint — there is nothing left to press).
 * Shared by `transportCommand.ts`/`pairCommand.ts` so both print the exact
 * same shape after leaving the alternate screen.
 */
export function printMaskedLinkFooter(
  out: WritableOut,
  opts: { fullUrl: string; maskedUrl: string; label: string; extraLines?: readonly string[] },
): void {
  const lines = [
    `  ${opts.label} ${oscHyperlink(opts.fullUrl, opts.maskedUrl)}`,
    ...(opts.extraLines ?? []).map((l) => `  ${l}`),
    '',
  ];
  out.write(`${lines.join('\n')}\n`);
}
