/**
 * The routes `capy connect` and `capy rotate` travel, computed before either
 * of them opens anything.
 *
 * ONE builder per command, because the whole claim behind the browser screens
 * is that the rail a person reads, the diagram the terminal prints and the
 * array a headless caller parses are the same object. `rotateCommand` already
 * had a route — `renderRotationPlan` is the diagram every screen's rail was
 * modelled on — but it built the stops inline, printed them and dropped them,
 * so the browser had nothing to draw and `--json` had nothing to emit. The
 * stops are built here now and all three surfaces render what these return.
 *
 * The precedence is §8.2's, and it is why a stop can arrive already answered:
 * an explicit flag settles a stop before the run starts, existing state
 * settles the next ones, the browser is asked about whatever is left. A
 * flag-answered stop is `done` carrying the flag that supplied it — never
 * `skipped`, because the plan resolved it rather than dropping it, and "Mode ·
 * live" with no marker is indistinguishable from a question the user answered
 * two seconds ago.
 *
 * Neither plan carries key material: names, modes, account ids and counts.
 */
import type {
  ConnectStep,
  ConnectStop,
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
// capy connect
// ---------------------------------------------------------------------------

export interface ConnectPlanInput {
  /** Registry name of the provider being connected, e.g. `stripe`. */
  provider: string;
  /** The branch the key is written to and pushed to. */
  branch: string;
  /**
   * Local binary the provider's `precheck` looks for, e.g. `stripe`. Omitted
   * for a connector that checks nothing — the stop then does not exist,
   * rather than existing and claiming a tool was found.
   */
  requiresTool?: string;
  /** The provider hands off to a sign-in the user completes by hand. */
  requiresAuth?: boolean;
  /**
   * Where the run is standing. `null` or omitted once every question is
   * behind it — which is what the result screen's rail wants.
   */
  standing?: ConnectStep | null;
  /** Settled by `--var`, or by the browser's variable step. */
  varName?: string;
  /** `--var` supplied it, so it was never asked. */
  varFromFlag?: boolean;
  mode?: 'test' | 'live';
  /** `--live` supplied it. There is no `--test`: test is the default. */
  modeFromFlag?: boolean;
  account?: string;
  /** `--account` supplied it. */
  accountFromFlag?: boolean;
  /**
   * A paired provider session was already on this machine, so the sign-in
   * stop is one this run does not travel. Undefined until the config is read.
   */
  alreadySignedIn?: boolean;
  /** The hand-off ran and came back, so the stop is behind the traveller. */
  signedIn?: boolean;
  /**
   * Whether the key this run is taking is near expiry, and so whether the
   * refresh offer happens at all. Undefined until the key has been read —
   * which is why the stop is `upcoming` rather than `skipped` before then.
   */
  refreshOffered?: boolean;
  /** The answer to the refresh offer, once it has been made. */
  refreshAccepted?: boolean;
  /** False under `--no-push`: the key lands in .env and goes no further. */
  push: boolean;
  /** `--no-push` was explicit rather than the default. */
  pushFromFlag?: boolean;
  /**
   * What became of the push, once the run is over.
   *
   * Absent while the route is still ahead of the traveller, which is every
   * screen that asks a question. It exists for the result page: a rail drawn
   * on a FINISHED run that still says `○ Push — encrypt and push to Capy`
   * beside a body reading "the push did not land" is the drift these plans
   * were built to remove, and it is worse than no rail at all because it is
   * the half of the page that looks authoritative.
   *
   * `landed` — the push went through.
   * `failed` — it ran and did not land; the run stopped here.
   * `not-reached` — the run ended before the push was attempted (a declined
   *   gate, a local write that failed), so the stop is still ahead of it.
   */
  pushOutcome?: 'landed' | 'failed' | 'not-reached';
}

/**
 * The stops `capy connect <provider>` travels, in the order it travels them.
 *
 * The order is `connect()`'s own — variable, mode, sign-in, account, refresh,
 * push — not the dependency order the screen's documentation describes. A rail
 * is a claim about the run in front of you, and a rail whose stops are ordered
 * one way while the questions arrive another would be describing a different
 * command.
 *
 * The overwrite guard is deliberately not a stop. It is not a step on the
 * route, it is the route being interrupted by something already in the way,
 * and drawing a station for it would imply the plan expected it.
 */
export function connectPlan(input: ConnectPlanInput): ConnectStop[] {
  const stops: ConnectStop[] = [];

  if (input.requiresTool) {
    // `precheck` exits before anything can be asked, so by the time any of
    // this is drawn the tool was found. A failed precheck arrives as
    // `blocked`, not as a question — but the stop stays on the rail, because
    // the route really did run through it.
    stops.push({
      id: 'cli',
      label: `${cap(input.provider)} CLI`,
      state: 'done',
      detail: `${input.requiresTool} on your PATH`,
      answer: 'found',
    });
  }

  stops.push({
    id: 'var',
    label: 'Variable',
    state: stateFor('var', input.varName !== undefined, input.standing),
    detail: 'which .env name holds the key',
    ...(input.varName !== undefined ? { answer: input.varName } : {}),
    ...(input.varFromFlag ? { flag: '--var' } : {}),
  });

  stops.push({
    id: 'mode',
    label: 'Mode',
    state: stateFor('mode', input.mode !== undefined, input.standing),
    detail: 'a test key cannot charge anyone; a live key can',
    ...(input.mode !== undefined ? { answer: input.mode } : {}),
    // Only `--live` exists. `--test` does not, so a test-mode run answered by
    // the absence of a flag has no flag to name, and naming one would tell the
    // reader to retype an argument the command would reject.
    ...(input.modeFromFlag ? { flag: '--live' } : {}),
  });

  if (input.requiresAuth) {
    stops.push({
      id: 'auth',
      label: 'Sign in',
      // A browser pairing the user completes by hand while the CLI polls.
      // Capy cannot do it, and the diagram should not imply it can.
      manual: true,
      state: input.alreadySignedIn
        ? 'skipped'
        : stateFor('auth', input.signedIn === true, input.standing),
      detail: `${input.provider} login opens in your browser`,
      ...(input.alreadySignedIn
        ? { answer: 'already paired' }
        : input.signedIn
          ? { answer: 'paired' }
          : {}),
    });
  }

  stops.push({
    id: 'account',
    label: 'Account',
    state: stateFor('account', input.account !== undefined, input.standing),
    detail: `which ${cap(input.provider)} account the key comes from`,
    ...(input.account !== undefined ? { answer: input.account } : {}),
    ...(input.accountFromFlag ? { flag: '--account' } : {}),
  });

  stops.push({
    id: 'refresh',
    label: 'Refresh key',
    manual: true,
    // A run whose key is not near expiry never visits this stop, and saying so
    // up front is the point of drawing the whole route: it says Capy is
    // watching the expiry, which is the reason `capy rotate` exists.
    state:
      input.refreshOffered === false
        ? 'skipped'
        : stateFor('refresh', input.refreshAccepted !== undefined, input.standing),
    detail: 'the key is nearly out — pair again for a fresh one',
    ...(input.refreshAccepted !== undefined
      ? { answer: input.refreshAccepted ? 'paired again' : 'kept the current key' }
      : {}),
  });

  stops.push({
    id: 'push',
    label: 'Push',
    // Never a question: `--no-push` settles it and nothing else asks. It is
    // the terminal stop of the route, which is why it is `upcoming` rather
    // than `current` even when everything before it is answered — until the
    // run is over and `pushOutcome` says what became of it.
    //
    // A failed push is drawn as the stop the traveller is STANDING on, which
    // is where the run stopped. There is no `failed` in `StopState` (the four
    // states are done, current, upcoming, skipped), and the other three would
    // each be a lie: `done` claims it worked, `upcoming` claims it has not
    // happened yet, `skipped` claims it was not needed. `blank` on top of it
    // is the CLI's own ◌ — the plan has a hole here — which is exactly the
    // fact. REPORTED, not patched: the screens' `StopState` has no way to say
    // "this stop was attempted and failed", and it should.
    state:
      input.pushOutcome === 'landed'
        ? 'done'
        : input.pushOutcome === 'failed'
          ? 'current'
          : 'upcoming',
    detail:
      input.pushOutcome === 'failed'
        ? `did not reach Capy (branch: ${input.branch})`
        : input.push
          ? `encrypt and push to Capy (branch: ${input.branch})`
          : 'write to .env on this machine only',
    ...(input.pushOutcome === 'failed' ? { blank: true } : {}),
    ...(input.pushOutcome === 'landed'
      ? { answer: `pushed to ${input.branch}` }
      : input.push
        ? {}
        : { answer: 'local only' }),
    ...(input.pushFromFlag ? { flag: '--no-push' } : {}),
  });

  return stops;
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
