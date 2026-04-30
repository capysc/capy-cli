/**
 * Shared inquirer prompt styling for the Capy CLI.
 *
 * The default checkbox instructions render keys as `<space>`, `<a>` etc. —
 * looks like XML-tag soup and clashes with the rest of the CLI's styling.
 * This module centralizes the override so every checkbox in capy reads the
 * same way: dim gray surround, bold-white key names, no angle brackets.
 */

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`; // bold white

/**
 * Drop-in replacement for the default inquirer checkbox `instructions` line.
 * Pass to the checkbox prompt as `instructions: CHECKBOX_INSTRUCTIONS`.
 */
export const CHECKBOX_INSTRUCTIONS =
  DIM('(Press ') +
  KEY('space') +
  DIM(' to select, ') +
  KEY('a') +
  DIM(' to toggle all, ') +
  KEY('i') +
  DIM(' to invert, ') +
  KEY('enter') +
  DIM(' to proceed)');
