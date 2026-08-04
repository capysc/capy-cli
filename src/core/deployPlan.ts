/**
 * The route `capy deploy` travels, computed before anything opens.
 *
 * ONE function, because three screens draw this rail — `deploy-destination`,
 * `deploy-target-setup`, `deploy-plan-confirm` — and until now each of them
 * carried its own copy of the station list in a lookup table inside its
 * `Screen.svelte`. Three copies of one route is three chances for the rail to
 * say something different depending on which page you happen to be standing
 * on, and none of the three was the CLI's: the command that decides how many
 * questions there are had no say in the diagram claiming to describe it.
 *
 * So the plan is built here, and both the browser payload and `--json` render
 * what this returns. The screens draw it and may say where the traveller is
 * STANDING; they may not add a station, drop one, or reword a detail.
 *
 * Why the whole route, including the parts a run will not travel: the terminal
 * asks its deploy questions as a run of `inquirer` prompts with nothing
 * between them, and how many there are depends on the platform. Pick Vercel
 * and a mode question appears; pick Heroku and it silently does not, so the
 * flow just gets shorter and nobody is told why. A stop this run cannot reach
 * is `skipped` here rather than absent, which is the difference between "there
 * was never a question" and "you were never asked".
 */
import type { DeployPlanConfirmStop } from '../ui/screens/contract';

/** The ten stations, in order. `capy deploy` has no other route. */
export type DeployStopId =
  | 'platform'
  | 'mode'
  | 'signin'
  | 'branch'
  | 'settings'
  | 'variables'
  | 'delivery'
  | 'name'
  | 'review'
  | 'deploy';

/**
 * The route itself: id, label and the one-line detail beside it.
 *
 * `manual` marks a station the user performs by hand — `signin` is a vendor
 * login in a terminal Capy does not drive, so the track either side of it is
 * drawn broken and the stop is badged "you do this". It is a fact about the
 * flow, so it lives with the flow rather than being inferred by whichever page
 * happens to be rendering.
 */
const ROUTE: ReadonlyArray<{
  id: DeployStopId;
  label: string;
  detail: string;
  manual?: boolean;
}> = [
  { id: 'platform', label: 'Platform', detail: 'where this project deploys' },
  { id: 'mode', label: 'How to deploy', detail: 'a connector, or a deploy token' },
  { id: 'signin', label: 'Sign in', detail: 'in a terminal you control', manual: true },
  { id: 'branch', label: 'Branch', detail: 'whose secrets ship' },
  { id: 'settings', label: 'Settings', detail: 'what this platform needs' },
  { id: 'variables', label: 'Variables', detail: 'by name, never by value' },
  { id: 'delivery', label: 'Delivery', detail: 'a pull request, or straight out' },
  { id: 'name', label: 'Save as', detail: 'what to call this target' },
  { id: 'review', label: 'Review', detail: 'the plan, and preflight' },
  { id: 'deploy', label: 'Deploy', detail: 'secrets pushed, code shipped' },
];

export interface DeployPlanInput {
  /**
   * The station this run is standing on. Null when nothing is being asked —
   * a headless run describing the route it would travel.
   */
  at?: DeployStopId | null;
  /** Stops already settled, and what settled them. Rendered on the rail. */
  answers?: Partial<Record<DeployStopId, string>>;
  /**
   * Stops this run will never visit.
   *
   * `mode` when the chosen platform has no connector — the terminal skips that
   * question without saying so, and this is where it says so.
   */
  skipped?: readonly DeployStopId[];
  /**
   * `--dry-run`. The terminus is unreachable by construction: nothing is
   * decrypted and nothing is pushed. It is drawn ◌ — a station the plan has an
   * unfilled answer at — rather than ○, a stop still ahead of you. The command
   * knows which it is when it computes the route, so it says so here instead
   * of leaving a page to infer a glyph nobody planned.
   */
  dryRun?: boolean;
}

/**
 * The route, with a state on every station.
 *
 * Widest of the three stop types, so one array feeds all three screens: the
 * two narrower ones simply ignore `blank`.
 */
export function deployPlan(input: DeployPlanInput = {}): DeployPlanConfirmStop[] {
  const answers = input.answers ?? {};
  const skipped = new Set(input.skipped ?? []);

  return ROUTE.map((stop) => {
    const answer = answers[stop.id];
    const state: DeployPlanConfirmStop['state'] = skipped.has(stop.id)
      ? 'skipped'
      : answer !== undefined
        ? 'done'
        : stop.id === input.at
          ? 'current'
          : 'upcoming';

    return {
      id: stop.id,
      label: stop.label,
      state,
      detail: stop.detail,
      ...(answer !== undefined ? { answer } : {}),
      ...(stop.manual ? { manual: true } : {}),
      // Only the terminus can be blank, and only because a dry run stops one
      // station short of it on purpose.
      ...(stop.id === 'deploy' && input.dryRun ? { blank: true } : {}),
    };
  });
}

/**
 * The stops this run still has to ask about.
 *
 * A headless caller uses this to know whether it can proceed: anything left
 * here is a question no flag answered, so a run with nowhere to ask must
 * refuse rather than pick a default. `deploy` is excluded because it is the
 * terminus — it is the thing the answers are FOR, not a question.
 *
 * Derived from the plan rather than recomputed, so the two can never disagree
 * about what is outstanding.
 *
 * Called by `describeDeployRoute` in deployCommand.ts, which is what
 * `capy deploy --json` emits — the same array the three browser screens draw.
 * That is the whole claim: the rail a person reads and the array an agent
 * parses come out of one builder. (argv wiring for the flag lives in
 * src/index.ts, which the coordinator owns, exactly as `--web` does.)
 */
export function unansweredDeployStops(stops: DeployPlanConfirmStop[]): string[] {
  return stops
    .filter((s) => s.state !== 'done' && s.state !== 'skipped' && s.id !== 'deploy')
    .map((s) => s.id);
}

/**
 * What the manual sign-in stop was, per adapter.
 *
 * `signin` is the one station Capy does not perform: the vendor CLI holds its
 * own session and the user establishes it in their own terminal. Preflight is
 * where Capy finds out whether that happened, so the stop stays `upcoming`
 * until preflight passes and then carries the command that made it true.
 */
export const SIGNIN_COMMAND: Readonly<Record<string, string>> = {
  'cf-worker': 'wrangler login',
  'cf-pages': 'wrangler login',
  vercel: 'vercel link',
  'aws-ssm': 'aws configure',
  'gh-actions': 'gh auth login',
};
