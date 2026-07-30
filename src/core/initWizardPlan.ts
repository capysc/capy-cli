/**
 * The route `capy` travels on its first run in a directory, computed before
 * anything opens.
 *
 * ONE function, for the reason `branchCreatePlan` gives: the rail a person
 * reads and the array a headless caller would parse have to be the same
 * object, and two builders stop being the same object at the first divergence.
 *
 * The route is TEN stops and the CLI asks at most six questions on it. That
 * gap is the point. `initializeProject` is six `inquirer` prompts in a row with
 * nothing saying how many are left, which side of a fork this run is on, or
 * that the recovery phrase about to scroll past is the only copy that will
 * ever exist. A stop this run will not visit is drawn `skipped` rather than
 * dropped, and a stop whose fork is not settled yet is `blank` — the CLI's own
 * ◌ — because "we do not know yet" and "this will not happen" are different
 * answers and a rail that renders them the same is lying about one of them.
 *
 * Four stops are not questions the CLI asks:
 *
 *   auth      settled before the wizard opens — `capy` authenticates first and
 *             the browser only opens once there is a session
 *   recovery  the 24 words are shown and confirmed by `orgCreation.ts`, on its
 *             own surface, so the stop is `manual`: it happens, and it does
 *             not happen here
 *   redeem    a key this device does not hold. The CLI refuses with `capy
 *             redeem <code>`; the stop exists so the refusal lands on a station
 *             that was drawn from the start
 *   encrypt   skipped when there is no .env to encrypt, which is a fact the
 *             directory already knows before a browser opens
 */
import type { InitWizardStop } from '../ui/screens/contract';

/** Which side of the organization fork this run took. */
export type InitChoice = { kind: 'existing'; name: string } | { kind: 'new'; name?: string };

/**
 * What the run has answered or discovered so far.
 *
 * Every field is optional and `undefined` means "not known yet" rather than
 * "no" — the distinction the `blank` state exists to draw. The plan is
 * recomputed from this after every answer, so no caller ever decides a stop's
 * state itself.
 */
export interface InitWizardInput {
  /** Who the run authenticated as. Shown on the `auth` stop, which is done. */
  signedInAs?: string;
  /** Organizations this session can reach. 0 means the CLI never asks. */
  orgCount?: number;
  organization?: InitChoice;
  /** The 24 words have been printed in the terminal. */
  recoveryShown?: boolean;
  /** Whether this device holds the organization's key. Checked after the org stop. */
  hasOrgKey?: boolean;
  /** Projects listed in the chosen org. Undefined until the lookup runs. */
  projectCount?: number;
  /**
   * The project lookup failed. The CLI swallows that error and proceeds as if
   * the org had none, so the stop is skipped either way — but for a different
   * reason, and the payload says which.
   */
  projectsUnavailable?: boolean;
  project?: InitChoice;
  branchChoice?: 'development' | 'other';
  branchName?: string;
  /** Variables in the .env sitting in this directory. Undefined until read. */
  localEnvCount?: number;
  /** The answer to the encrypt-and-push consent gate. */
  encrypt?: boolean;
}

/** A stop before the cursor pass: `state` is decided in one place, below. */
type Draft = Omit<InitWizardStop, 'state'> & { state?: InitWizardStop['state'] };

/** Creating a new project — either chosen, or the only thing this org offers. */
function creatingProject(i: InitWizardInput): boolean | undefined {
  if (i.project) return i.project.kind === 'new';
  if (i.projectsUnavailable) return true;
  if (i.projectCount === 0) return true;
  if (i.projectCount === undefined) return undefined;
  return undefined;
}

export function initWizardPlan(i: InitWizardInput): InitWizardStop[] {
  const newOrg = i.organization?.kind === 'new';
  const existingOrg = i.organization?.kind === 'existing';
  const newProject = creatingProject(i);
  const existingProject = i.project?.kind === 'existing';

  const drafts: Draft[] = [
    {
      id: 'auth',
      label: 'Sign in',
      // Already true by the time anything is served: `capy` authenticates
      // before it asks its first question, and the browser opens after that.
      state: 'done',
      detail: 'capy.sc, in your browser',
      answer: i.signedInAs,
    },
    {
      id: 'organization',
      label: 'Organization',
      // An account with no organization is never asked which one to use; the
      // CLI says "No organization found. Let's create one." and creates it.
      state: i.orgCount === 0 ? 'skipped' : i.organization ? 'done' : undefined,
      detail: 'which organization this project belongs to',
      answer: i.organization?.kind === 'existing' ? i.organization.name : i.organization ? 'a new organization' : undefined,
    },
    {
      id: 'organization-name',
      label: 'Organization name',
      state: existingOrg ? 'skipped' : newOrg ? (i.organization?.name ? 'done' : undefined) : undefined,
      blank: i.organization === undefined,
      detail: 'name the organization this project will belong to',
      answer: newOrg ? i.organization?.name : undefined,
    },
    {
      id: 'recovery',
      label: 'Recovery phrase',
      state: existingOrg ? 'skipped' : newOrg ? (i.recoveryShown ? 'done' : undefined) : undefined,
      blank: i.organization === undefined,
      // The words are shown and confirmed somewhere else entirely — their own
      // page under `--web`, the terminal without it — and never reach this
      // payload. The dotted track is the honest drawing of that: the stop
      // happens, and it does not happen here.
      manual: true,
      detail: '24 words, shown once and never again',
    },
    {
      id: 'redeem',
      label: 'Redeem a code',
      // Most sign-ins hold the key already and never see this. It is on the
      // route so a run that does NOT hold it is refused at a station that was
      // drawn from the start, rather than mid-flow at a stop nobody declared.
      state: i.hasOrgKey === true ? 'skipped' : undefined,
      blank: i.hasOrgKey === undefined,
      manual: true,
      detail: 'receive this organization\'s key on this device',
    },
    {
      id: 'project',
      label: 'Project',
      // No projects to choose between (or the lookup failed): the CLI goes
      // straight to naming a new one.
      state:
        i.project ? 'done'
          : i.projectsUnavailable || i.projectCount === 0 ? 'skipped'
            : undefined,
      blank: i.projectCount === undefined && i.project === undefined,
      detail: 'a project this organization already has, or a new one',
      answer: i.project?.kind === 'existing' ? i.project.name : i.project ? 'New project' : undefined,
    },
    {
      id: 'project-name',
      label: 'Project name',
      state: newProject === false ? 'skipped' : newProject ? (i.project?.name ? 'done' : undefined) : undefined,
      blank: newProject === undefined,
      detail: 'name the project this directory becomes',
      answer: i.project?.kind === 'new' ? i.project.name : undefined,
    },
    {
      id: 'branch',
      label: 'First branch',
      // Bootstrapping an existing project pulls its development branch and
      // returns; there is no first branch to choose.
      state: existingProject ? 'skipped' : i.branchChoice ? 'done' : undefined,
      blank: newProject === undefined,
      detail: 'the branch this project starts on',
      answer: i.branchChoice === 'development' ? 'development' : i.branchChoice ? 'another branch' : undefined,
    },
    {
      id: 'branch-name',
      label: 'Branch name',
      state:
        existingProject ? 'skipped'
          : i.branchChoice === 'development' ? 'skipped'
            : i.branchChoice === 'other' ? (i.branchName ? 'done' : undefined)
              : undefined,
      blank: i.branchChoice === undefined,
      detail: 'name the branch this project starts on',
      answer: i.branchName,
    },
    {
      id: 'encrypt',
      label: 'Encrypt and push',
      state:
        existingProject ? 'skipped'
          : i.localEnvCount === 0 ? 'skipped'
            : i.encrypt !== undefined ? 'done'
              : undefined,
      blank: i.localEnvCount === undefined,
      detail: 'rewrite .env as ciphertext and store it',
      answer: i.encrypt === undefined ? undefined : i.encrypt ? 'yes' : 'no',
    },
  ];

  // One cursor pass, in one place: the first stop that is neither settled nor
  // skipped is where the traveller stands, and everything after it is ahead.
  let standing = false;
  return drafts.map((d) => {
    const { blank, ...rest } = d;
    let state = d.state;
    if (!state) {
      state = standing ? 'upcoming' : 'current';
      standing = true;
    }
    const stop: InitWizardStop = { ...rest, state };
    // A settled stop is not blank, whatever the fork looked like on the way in.
    if (blank && state !== 'done' && state !== 'skipped') stop.blank = true;
    return stop;
  });
}

/**
 * The stops this run still has to ask about.
 *
 * A headless caller uses this the way `unansweredStops` is used for branch
 * creation: anything left here is something no flag answered, and the root
 * `capy` command has no flags for any of them — so a run with nowhere to ask
 * must refuse rather than pick a default. Derived from the plan rather than
 * recomputed, so the two can never disagree about what is outstanding.
 */
export function unansweredInitStops(stops: InitWizardStop[]): string[] {
  return stops.filter((s) => s.state === 'current' || s.state === 'upcoming').map((s) => s.id);
}
