/**
 * Interactivity detection for prompt sites.
 *
 * A command is "interactive" only when we have a real TTY on stdin AND the
 * caller didn't explicitly opt out with --non-tty. Agents and CI either pass
 * --non-tty or run with a piped/closed stdin; both must resolve every choice
 * from flags or fail fast — never render a picker that EOFs to a silent cancel.
 */
export function isInteractive(nonTty?: boolean): boolean {
  if (nonTty) return false;
  return process.stdin.isTTY === true;
}

/**
 * Exit code reserved for "this needs interactive input we can't gather".
 * Distinct from generic failure (1) so an agent/CI can branch on it and know
 * the next move is a flag or a human, not a retry.
 */
export const EXIT_NEEDS_INPUT = 3;

/**
 * Refuse to proceed because a required choice can't be made non-interactively.
 * Prints a one-line, machine-greppable reason plus the concrete flag/command
 * that would unblock it, then exits EXIT_NEEDS_INPUT.
 */
export function refuseNonInteractive(reason: string, hint: string): never {
  console.error(`\n  non-interactive: ${reason}`);
  console.error(`  ${hint}\n`);
  process.exit(EXIT_NEEDS_INPUT);
}
