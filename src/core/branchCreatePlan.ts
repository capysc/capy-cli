/**
 * The route `capy checkout -b <name>` will travel, computed before anything
 * runs, and printed by `capy checkout -b <name> --json`.
 *
 * ONE function, so the array a headless caller parses is built in one place.
 *
 * The precedence is §8.2's, and it is the reason a stop can arrive already
 * answered: an explicit flag settles a stop before the run starts, existing
 * state settles the next ones, and a headless run with a blank remaining
 * refuses rather than guessing. A flag-answered stop is `done` carrying the
 * flag that supplied it — never `skipped`, because the plan resolved it rather
 * than dropping it.
 */
import type { BranchCreateStop } from '../ui/screens/contract';

export interface BranchCreateInput {
  /** Name from argv, if the caller supplied one. */
  branchName?: string;
  /** Settled by `--protected` / `--no-protected`; undefined means unanswered. */
  isProtected?: boolean;
}

/**
 * Which flag settled protection, for the marker on the rail.
 *
 * The literal text the caller typed, so the answer to "why was I never asked?"
 * is the thing they can find in their own shell history.
 */
const protectionFlag = (isProtected: boolean): string => (isProtected ? '--protected' : '--no-protected');

export function branchCreatePlan(input: BranchCreateInput): BranchCreateStop[] {
  const named = typeof input.branchName === 'string' && input.branchName.trim() !== '';
  const protectionAnswered = input.isProtected !== undefined;

  const name: BranchCreateStop = named
    ? {
        id: 'name',
        label: 'Name',
        state: 'done',
        detail: 'what to call it',
        answer: input.branchName!.trim(),
        // The name is positional rather than a flag, so there is no `--x` to
        // quote. Naming the argument is still the honest answer to "where did
        // this come from" — it did not come from a question.
        flag: 'argument',
      }
    : { id: 'name', label: 'Name', state: 'current', detail: 'what to call it' };

  const protection: BranchCreateStop = protectionAnswered
    ? {
        id: 'protection',
        label: 'Protection',
        state: 'done',
        detail: 'invite-only, or open to the project',
        answer: input.isProtected ? 'protected' : 'open',
        flag: protectionFlag(input.isProtected!),
      }
    : {
        id: 'protection',
        label: 'Protection',
        // Only the first unanswered stop is where the traveller stands.
        state: named ? 'current' : 'upcoming',
        detail: 'invite-only, or open to the project',
      };

  return [
    name,
    protection,
    {
      id: 'create',
      label: 'Create',
      state: 'upcoming',
      detail: 'register it and switch this directory to it',
    },
  ];
}

/**
 * The stops this run still has to ask about.
 *
 * A headless caller uses this to know whether it can proceed: anything left
 * here is something no flag answered, so a run with nowhere to ask must refuse
 * with exit 3 rather than pick a default. Derived from the plan rather than
 * recomputed, so the two can never disagree about what is outstanding.
 */
export function unansweredStops(stops: BranchCreateStop[]): string[] {
  return stops.filter((s) => s.state !== 'done' && s.id !== 'create').map((s) => s.id);
}
