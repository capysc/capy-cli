/**
 * The `--org` typed on this run's command (spec 3l), recorded by the entry point before the command runs. A module of
 * its own so the entry point does not load the sign-in code to record it. Only `resolveOrgContext` reads it, and only
 * to pick among the organizations the account belongs to.
 */
let typed: string | undefined;

export function setRequestedOrg(org: string | undefined): void {
  typed = org?.trim() || undefined;
}

export function requestedOrg(): string | undefined {
  return typed;
}

/** What the running command accepts, for a rerun that adds `--org`: whether it takes `--org`, `--json` and `--non-tty`. */
export interface CommandShape {
  readonly org: boolean;
  readonly json: boolean;
  readonly nonTty: boolean;
}

let shape: CommandShape = { org: false, json: false, nonTty: false };

export function setCommandShape(next: CommandShape): void {
  shape = next;
}

export function commandShape(): CommandShape {
  return shape;
}
