/**
 * Shared inquirer prompt styling for the Capy CLI.
 *
 * Default inquirer renders helper keys as `<space>`, `<a>` etc. — looks like
 * XML-tag soup and clashes with the rest of the CLI's styling. This module
 * centralizes the override so every checkbox/list prompt in capy reads the
 * same way: dim gray surround, bold-white key names, no angle brackets.
 *
 * Also exports a theme that left-pads the cursor by one space so the
 * selection indicators (◉ ◯ ❯) sit at a consistent indent matching the
 * rest of capy's output (which typically begins at column 2).
 */

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`; // bold white

/**
 * Drop-in replacement for the default inquirer checkbox `instructions` line.
 * Pass to the checkbox prompt as `instructions: CHECKBOX_INSTRUCTIONS`.
 *
 * Leading + trailing newlines visually separate the help line from the
 * choices and the message. No surrounding parentheses — the keys read like
 * a sentence in their own right.
 */
export const CHECKBOX_INSTRUCTIONS =
  '\n' +
  DIM('Press ') +
  KEY('space') +
  DIM(' to select, ') +
  KEY('a') +
  DIM(' to toggle all, ') +
  KEY('i') +
  DIM(' to invert, ') +
  KEY('enter') +
  DIM(' to proceed') +
  '\n';

/**
 * Theme override for `inquirer.prompt({ type: 'checkbox', ... })`. Left-pads
 * the cursor with a single space so the selection indicator (◉ ◯) lines up
 * with the rest of the CLI's column-2 indent.
 */
export const CHECKBOX_THEME = {
  icon: {
    cursor: ' ❯',
  },
};

/**
 * Theme override for `inquirer.prompt({ type: 'list', ... })`. Same indent
 * tweak as CHECKBOX_THEME so list pickers and checkbox pickers feel like
 * one family.
 */
export const LIST_THEME = {
  icon: {
    cursor: ' ❯',
  },
};
