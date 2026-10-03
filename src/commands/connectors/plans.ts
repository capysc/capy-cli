/**
 * The route `capy rotate` travels, computed before it runs.
 *
 * The stops are built here and the terminal's diagram (`renderRotationPlan`)
 * renders what this returns. An explicit flag settles a stop before the run
 * starts; a flag-answered stop is `done` carrying the flag that supplied it —
 * never `skipped`, because the plan resolved it rather than dropping it.
 *
 * The plan carries no key material: names, modes, account ids and counts.
 */
import type {
  RotatePlanStop,
  RotateStep,
  StopState,
} from '../../ui/screens/contract';

/** `stripe` → `Stripe`. The CLI's own `cap`, shared so both plans agree. */
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Where a stop stands, given whether it has an answer and where the run is.
 *
 * Only the stop the run is standing on is `current`: a rail with two of them
 * is a rail that cannot say where you are, which is the one thing it exists
 * for.
 */
function stateFor(id: string, answered: boolean, standing: string | null | undefined): StopState {
  if (answered) return 'done';
  return standing === id ? 'current' : 'upcoming';
}

// ---------------------------------------------------------------------------
// capy rotate
// ---------------------------------------------------------------------------

export interface RotationPlanInput {
  /** The branch the rotation reads from and pushes to. */
  branch: string;
  /** `--all`: every already-managed key on this branch. */
  all?: boolean;
  /** The variable, once settled. Absent while the picker is still open. */
  varName?: string;
  /** How many credentials this run covers, once the targets are known. */
  targetCount?: number;
  /** Every provider in this run, for the Rotate stop's detail. */
  providers?: string[];
  /** The providers among them that hand off to a manual sign-in. */
  authProviders?: string[];
  /**
   * The variable has no connector yet, so the run diverts through `capy
   * connect` and the integration stop is a real question. False means the
   * credential is already managed and that stop is never visited.
   */
  needsIntegration?: boolean;
  /** The integration a promote run picked. */
  integration?: string;
  /** `--provider` supplied it. */
  integrationFromFlag?: boolean;
  /** `--no-push`: the new key stops at .env on this machine. */
  noPush?: boolean;
  /** How the resolved deploy target ships, in the CLI's own words. */
  deployDetail?: string;
  /** Where the run is standing. */
  standing?: RotateStep | null;
}

/**
 * The stops `capy rotate` travels.
 *
 * `renderRotationPlan` printed four of these and left two implicit: the
 * variable and the integration are answered by the user and then missing from
 * the picture of what they are agreeing to. Both are stops here, so the
 * diagram covers the whole journey rather than its second half.
 */
export function rotationPlan(input: RotationPlanInput): RotatePlanStop[] {
  const stops: RotatePlanStop[] = [];
  const providers = input.providers ?? [];
  const authProviders = input.authProviders ?? [];
  const count = input.targetCount ?? 1;

  stops.push({
    id: 'variable',
    label: 'Variable',
    state: stateFor('variable', input.all === true || input.varName !== undefined, input.standing),
    detail: input.all
      ? 'every managed credential on this branch'
      : 'which credential to fetch a fresh copy of',
    ...(input.all
      ? { answer: `all ${count}`, flag: '--all' }
      : input.varName !== undefined
        ? { answer: input.varName }
        : {}),
  });

  stops.push({
    id: 'integration',
    label: 'Integration',
    // A credential that already has a connector never diverts through connect,
    // and the rail says so rather than dropping the stop.
    state:
      input.needsIntegration === false
        ? 'skipped'
        : stateFor('integration', input.integration !== undefined, input.standing),
    detail: 'which provider issues this credential',
    ...(input.integration !== undefined ? { answer: input.integration } : {}),
    ...(input.integrationFromFlag ? { flag: '--provider' } : {}),
  });

  if (authProviders.length > 0) {
    stops.push({
      id: 'auth',
      label: 'Auth',
      // Verbatim from the CLI: two wordings for one stop is a bug in the
      // product, and this string has been in the terminal diagram all along.
      detail: `authenticate with ${authProviders.map(cap).join(', ')} (requires manual user auth)`,
      manual: true,
      state: stateFor('auth', false, input.standing),
    });
  }

  // The CLI's own two sentences, verbatim — with one addition it could not
  // make before: until a variable is picked there is no connector to name, and
  // "fetch a fresh key from " with nothing after it is worse than saying so.
  const from = providers.length > 0 ? providers.map(cap).join(', ') : 'the integration that issued it';
  stops.push({
    id: 'rotate',
    label: 'Rotate',
    state: 'upcoming',
    detail:
      count === 1
        ? `fetch a fresh key from ${from}`
        : `fetch fresh keys for ${count} credentials from ${from}`,
  });

  stops.push({
    id: 'push',
    label: 'Push',
    // `--no-push` still rotates: the old key dies at the provider either way.
    // The stop it skips is the sharing, and a struck-through station says that
    // better than the terminal's silence does.
    state: input.noPush ? 'skipped' : 'upcoming',
    detail: `encrypt + push to Capy (branch: ${input.branch})`,
  });

  stops.push(
    input.noPush
      ? {
          id: 'deploy',
          label: 'Deploy',
          state: 'skipped',
          detail: 'nothing was pushed, so there is nothing to roll out',
        }
      : input.deployDetail
        ? { id: 'deploy', label: 'Deploy', state: 'upcoming', detail: input.deployDetail }
        : {
            id: 'deploy',
            label: 'Deploy',
            state: 'upcoming',
            blank: true,
            detail: 'set up a deploy target — opens a rollout PR (CI deploys on merge)',
          },
  );

  return stops;
}
