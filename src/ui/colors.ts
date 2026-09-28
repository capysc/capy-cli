/**
 * Shared ANSI color constants for the Capy CLI's raw-terminal output.
 *
 * `ACCENT` is the CLI's one house accent color — the teal used to mark
 * "the current thing" (`← current` next to the active org in
 * `capy org`/`capy`'s org picker) and, as of CAP-678, the secrets screen's
 * search query text and match-reason tags. One constant so every call site
 * agrees on the exact color without copy-pasting the escape sequence (and
 * so a future re-tint is a one-line change, not a grep-and-replace).
 */
export const ACCENT = '\x1b[38;5;43m';
