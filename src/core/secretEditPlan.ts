/**
 * The route `capy edit` travels, computed before anything opens.
 *
 * ONE function, for `branchCreatePlan`'s reason: the rail a person reads and
 * the array a headless caller parses have to be the same object, and two
 * builders — one for the page, one for `--json` — make that a promise nobody
 * can keep past the first divergence.
 *
 * There is a second reason here. This route is drawn by TWO screens:
 * `secret-table` shows it on the variable list and again on the review stop,
 * and `secret-commit-review` shows it from the other half of the same journey.
 * A station cannot be called two things, and until now it was — both screens
 * carried their own lookup table of labels. They get their stations from here.
 *
 * The terminal has no route at all. `c` commits and pushes on one keystroke,
 * `q` prompts, and neither says a review exists until you are standing in it.
 */
import type { SecretTableStop } from '../ui/screens/contract';

/** Where the run is standing. `result` covers both endings — done and discarded. */
export type SecretEditStopId = 'edit' | 'review' | 'write' | 'result';

export interface SecretEditInput {
  /** Variables on the table this run. Named on the first stop. */
  variableCount: number;
  /** Uncommitted edits so far. Becomes the first stop's answer once it is behind. */
  changeCount: number;
  /**
   * A local-only profile has no server, so the write stop is a local commit
   * and names no destination it could push to.
   */
  localMode: boolean;
  /** Where a commit lands, as `project/branch`. Unused in local mode. */
  destination: string;
  /** Which stop the run is standing on. */
  at: SecretEditStopId;
  /**
   * The run reached `result` without writing anything — the edits were
   * discarded. The write stop is then `skipped` rather than `done`: it is a
   * station this run decided not to visit, not one it passed through.
   */
  discarded?: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How a stop reads relative to where the traveller is standing.
 *
 * Only the first unanswered station is `current`; everything before it is
 * behind and everything after is ahead. Derived from one cursor rather than
 * set per stop, so a route cannot be built with two "you are here" markers.
 */
function stateFor(id: SecretEditStopId, at: SecretEditStopId): 'done' | 'current' | 'upcoming' {
  const order: SecretEditStopId[] = ['edit', 'review', 'write', 'result'];
  const here = order.indexOf(at);
  const mine = order.indexOf(id);
  if (mine < here) return 'done';
  if (mine === here) return 'current';
  return 'upcoming';
}

export function secretEditPlan(input: SecretEditInput): SecretTableStop[] {
  const editState = stateFor('edit', input.at);
  const writeState = stateFor('write', input.at);
  const resultState = stateFor('result', input.at);

  const edit: SecretTableStop =
    editState === 'done'
      ? {
          id: 'edit',
          label: 'Edit values',
          state: 'done',
          // What was decided here, not what was on offer. A finished stop that
          // still says "9 variables" describes the page rather than the answer.
          answer: plural(input.changeCount, 'change', 'changes'),
        }
      : {
          id: 'edit',
          label: 'Edit values',
          state: editState,
          detail: plural(input.variableCount, 'variable', 'variables'),
        };

  return [
    edit,
    {
      id: 'review',
      label: 'Review changes',
      state: stateFor('review', input.at),
      detail: 'everything this write touches',
    },
    {
      id: 'write',
      // Local mode pushes nothing, so naming Keep here would promise a
      // destination that does not exist for this profile.
      label: input.localMode ? 'Commit locally' : 'Encrypt and push to Keep',
      // A discarded run never visits this station. Saying so is the point of
      // drawing the whole route rather than only the part that happened.
      state: input.discarded && writeState !== 'upcoming' ? 'skipped' : writeState,
      detail: input.localMode ? 'to this machine only' : input.destination,
      // The detail is a branch path — machine state, so it is set in mono. Local
      // mode's detail is a sentence and must not be.
      ...(input.localMode ? {} : { detailMono: true }),
    },
    {
      id: 'result',
      label: 'Result',
      state: resultState,
      // The endings ARE the result, so a stop standing on one has nothing left
      // to describe: "what this run changed" is on the page underneath it.
      ...(resultState === 'current' ? {} : { detail: 'what this run changed' }),
    },
  ];
}
