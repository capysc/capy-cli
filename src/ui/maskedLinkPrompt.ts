/**
 * Masked link display for `capy transport` and `capy pair` (CAP-684
 * follow-up). Both commands print a Keep link carrying sensitive material
 * (transport: the encrypted-key-material fragment; pair: the device code
 * query string) — this module is what keeps that material off the visible
 * line while still making the link usable:
 *
 *   - {@link maskLink} hides the sensitive tail for DISPLAY only (origin +
 *     path stay visible, the fragment/query is replaced with `…`).
 *   - {@link startMaskedLinkPrompt} prints the masked text as an OSC 8
 *     hyperlink (`osc8.ts`) whose CLICK TARGET is still the full URL, plus a
 *     `c`/`r`/`q` key hint, then listens for those keys on `stdin` without
 *     blocking the event loop — `capy pair` needs this to keep polling the
 *     device token while the prompt is live (`pollDeviceToken` and this
 *     listener run concurrently; `stop()` tears the listener down once the
 *     poll settles, whether or not the user ever pressed a key).
 *   - {@link handleMaskedLinkKey} is the pure keypress→action reducer, kept
 *     separate from the stdin plumbing so it's testable with no stdin at
 *     all (same split `secretsScreen.ts`/`secretsScreenDriver.ts` uses).
 *
 * The full URL is NEVER written to `stdout`/`stderr` by this module except
 * in direct response to an explicit `r` keypress — everything else here
 * only ever sees/prints the masked text (or hands the full URL to the
 * injected `copy` function, never to a log).
 */
import { EventEmitter, once } from 'node:events';
import { oscHyperlink } from './osc8';
import { copyToClipboard } from './clipboard';

export type MaskedLinkKind = 'fragment' | 'query';

/**
 * Masks the sensitive tail of `url` for display: keeps `origin + pathname`
 * (identifies which Keep instance — safe to show), replaces the fragment
 * (transport's `#<id>.<iv>.<ct>`) or query string (pair's `?code=...`) with
 * a single `…`. Pure and total — never throws on a well-formed URL string;
 * an absent fragment/query is left off rather than appending a bare `…`.
 */
export function maskLink(url: string, kind: MaskedLinkKind): string {
  const parsed = new URL(url);
  const base = `${parsed.origin}${parsed.pathname}`;
  if (kind === 'fragment') return parsed.hash ? `${base}#…` : base;
  return parsed.search ? `${base}?…` : base;
}

export type MaskedLinkAction =
  | { readonly kind: 'copy' }
  | { readonly kind: 'reveal' }
  | { readonly kind: 'done' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'ignore' };

/**
 * Pure keypress → action mapping (cardinal Rule 5: keys off the raw byte,
 * never off any human-readable prose). `c` copy, `r` reveal, `q`/Enter/Esc
 * done, Ctrl-C exit; anything else is ignored so an accidental keystroke
 * (or a paste landing in the buffer) can't be misread as a command.
 */
export function handleMaskedLinkKey(key: string): MaskedLinkAction {
  const ch = key[0];
  const code = key.charCodeAt(0);
  if (code === 3 /* Ctrl-C */) return { kind: 'exit' };
  if (ch === 'c' || ch === 'C') return { kind: 'copy' };
  if (ch === 'r' || ch === 'R') return { kind: 'reveal' };
  if (ch === 'q' || ch === 'Q' || code === 13 /* \r */ || code === 10 /* \n */ || code === 27 /* Esc */) {
    return { kind: 'done' };
  }
  return { kind: 'ignore' };
}

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`;
/** COPY-FLAG */
const HINT_LINE = `${KEY('c')} ${DIM('copy')}   ${KEY('r')} ${DIM('reveal')}   ${KEY('q')} ${DIM('done')}`;
/** COPY-FLAG */
const COPIED_LINE = '✓ Copied to clipboard';
/** COPY-FLAG */
const COPY_FAILED_LINE = 'Could not access clipboard — press r to print the full link instead.';
/** COPY-FLAG */
const JSON_HINT_LINE = 'Run with --json to print the full link.';

/** The minimal stdin surface this module needs. Real `process.stdin` satisfies it; tests pass a fake `EventEmitter` instead. */
export interface KeyStdin {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: string): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  removeListener(event: 'data', listener: (chunk: string) => void): void;
}

export interface WritableOut {
  write(text: string): void;
}

export interface MaskedLinkPromptOptions {
  /** The real, sensitive URL — the clipboard's copy target and the OSC 8 hyperlink's click target. Only ever printed as plain text in direct response to `r`. */
  readonly fullUrl: string;
  /** The masked text shown, and what the OSC 8 hyperlink displays. */
  readonly maskedUrl: string;
  /** Printed before the link, e.g. `"Open on your other device:"`. */
  readonly label: string;
  readonly indent?: string;
  readonly stdin?: KeyStdin;
  readonly stdout?: WritableOut;
  readonly copy?: (text: string) => Promise<boolean>;
}

export interface MaskedLinkPromptHandle {
  /** Resolves once the user presses `q`/Enter/Esc. A caller running a concurrent async op (`capy pair`'s device-token poll) can ignore this entirely and just call `stop()` once its own op settles. */
  readonly done: Promise<void>;
  /** Removes the `data` listener and restores raw mode. Idempotent (safe to call whether or not `done` ever resolved, and safe to call more than once) — both `removeListener` on an already-removed listener and `setRawMode(false)` when already off are no-ops. */
  readonly stop: () => void;
}

/**
 * Prints `label` + a masked OSC 8 hyperlink (full `fullUrl` as the click
 * target, `maskedUrl` as the visible text) plus a one-line key hint, then
 * listens on `stdin` for `c`/`r`/`q`/Enter/Esc/Ctrl-C — entirely through
 * `stdin`'s own `data` EVENT, never a blocking read, so a concurrent async
 * operation (e.g. `pollDeviceToken`) keeps running while this listens.
 */
export function startMaskedLinkPrompt(opts: MaskedLinkPromptOptions): MaskedLinkPromptHandle {
  const stdin = opts.stdin ?? (process.stdin as unknown as KeyStdin);
  const out = opts.stdout ?? process.stdout;
  const copy = opts.copy ?? copyToClipboard;
  const indent = opts.indent ?? '  ';

  out.write(`${indent}${opts.label} ${oscHyperlink(opts.fullUrl, opts.maskedUrl)}\n`);
  out.write(`${indent}${HINT_LINE}\n`);

  const emitter = new EventEmitter();

  const cleanup = (): void => {
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener('data', onData);
  };

  function onData(chunk: string): void {
    const action = handleMaskedLinkKey(chunk);
    if (action.kind === 'copy') {
      // Fire-and-forget: never awaited here, so a slow/hanging clipboard
      // helper can never stall the listener (or, for `capy pair`, the
      // concurrent poll it must never block).
      void copy(opts.fullUrl).then((ok) => {
        out.write(`${indent}${ok ? COPIED_LINE : COPY_FAILED_LINE}\n`);
      });
      return;
    }
    if (action.kind === 'reveal') {
      out.write(`${indent}${opts.fullUrl}\n`);
      return;
    }
    if (action.kind === 'done') {
      cleanup();
      emitter.emit('done');
      return;
    }
    if (action.kind === 'exit') {
      cleanup();
      process.exit(130);
    }
  }

  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', onData);

  const done = once(emitter, 'done').then(() => undefined);
  return { done, stop: cleanup };
}

/** Whether both ends of the terminal are real TTYs — the bar for a clickable masked link + interactive key prompt, rather than a plain masked line with a `--json` hint. */
export function isInteractiveLinkPrompt(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * The shared non-`--json` link block `transportCommand.ts`/`pairCommand.ts`
 * each print: masked link (interactive OSC 8 + key prompt on a real TTY,
 * plain masked text + a `--json` hint otherwise). Callers still print their
 * own QR/expiry/code lines around this — only the link line + hint/prompt
 * live here, since those two commands differ on everything else.
 */
export function printMaskedLinkBlock(opts: { fullUrl: string; kind: MaskedLinkKind; label: string }): MaskedLinkPromptHandle | null {
  const masked = maskLink(opts.fullUrl, opts.kind);
  if (isInteractiveLinkPrompt()) {
    return startMaskedLinkPrompt({ fullUrl: opts.fullUrl, maskedUrl: masked, label: opts.label });
  }
  console.log(`  ${opts.label} ${masked}`); // COPY-FLAG (label text itself is caller-supplied, already flagged at each call site)
  console.log(`  ${JSON_HINT_LINE}`);
  return null;
}
