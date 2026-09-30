/**
 * OSC 8 terminal hyperlinks (CAP-684 follow-up: masked transport/pair
 * links). Lets a terminal that understands the sequence (iTerm2,
 * Terminal.app, most modern emulators, per
 * https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) render
 * `text` as a clickable link to `url` without ever printing `url` itself. A
 * terminal that doesn't understand OSC 8 just shows `text` — the escape
 * bytes are silently ignored, never garbage on screen.
 *
 * No existing helper for this in the repo (checked: no other `\x1b]8`/OSC 8
 * usage anywhere under `src/`) — this is the first.
 */
const OSC8 = '\x1b]8;;';
const ST = '\x1b\\';

/**
 * Wraps `text` as an OSC 8 hyperlink whose click target is `url`. Pure
 * string building, no I/O — callers `console.log`/`write` the result.
 */
export function oscHyperlink(url: string, text: string): string {
  return `${OSC8}${url}${ST}${text}${OSC8}${ST}`;
}
