// `capy checkout`, served as compiled screens.
//
// Two questions this command asks and had no browser answer for:
//
//   1. `capy checkout -b <name>` asks, in the terminal, `Make "<name>" a
//      protected branch? (invite-only)` — a confirm defaulting to No, with the
//      whole consequence of "yes" compressed into two dim words. Under `--web`
//      it is the `branch-create` screen's protection step, which states what
//      invite-only costs beside the choice and lists what this directory is
//      about to copy onto the new branch.
//   2. `capy checkout <name>` on a name that does not exist prints the branch
//      list and exits 1. It is a listing the user cannot answer: the branch
//      they meant is on the screen and the only way to reach it is to retype
//      the command. Under `--web` that dead end becomes the `branch-list`
//      screen, and picking a row continues the same checkout.
//
// The route is `branchCreatePlan`'s, not this file's, and not the screen's.
// One builder feeds both `--json` and the payload, which is the only way the
// rail a person reads and the array an agent parses can be claimed to be the
// same array. `tests/core/branchCreatePlan.test.ts` pins that claim.
//
// Renders no secret values. `checkout` decrypts .env in-process to seed a new
// branch, and that plaintext must never reach a payload: the seed preview is
// variable NAMES and a count, deliberately.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import { formatRelativeTime } from './relativeTime';
import { branchCreatePlan, unansweredStops } from '../core/branchCreatePlan';
import type {
  BranchCreateData,
  BranchCreateExisting,
  BranchListData,
  BranchRow,
} from './screens/contract';
import type { Branch } from '../types/index';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to strings the CLI also PRINTS — the age line it formats, the
 * project name it puts in headers — because a payload is not a terminal and
 * an escape would render as a literal `[90m` in the browser.
 *
 * Deliberately NOT applied to a branch name. A name is the identifier the
 * answer comes back as and the one this command then checks out, so it has to
 * round-trip byte for byte; rewriting it here would mean the browser could
 * only ever ask for a branch that does not exist. Names are compared against
 * the list the server sent instead, which no rewriting can defeat.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// branch-create
// ---------------------------------------------------------------------------

export interface WebBranchCreateParams {
  projectName: string;
  /** Name from `capy checkout -b <name>`. */
  branchName: string;
  /** Settled by `--protected` / `--no-protected`; undefined means ask. */
  isProtected?: boolean;
  /** Branches that already exist, so a collision is caught before the POST. */
  existingBranches: BranchCreateExisting[];
  /**
   * The branch this directory is on now: where `-b` copies .env from. Null
   * when Capy could not tell which branch this directory is on.
   */
  seedFrom: string | null;
  /** Variable NAMES that would be copied across. Never values. */
  seedVarNames: string[];
  /** The .env could not be decrypted, so the new branch starts empty. */
  seedUnreadable?: boolean;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** What the browser decided. `cancelled` means nothing may be created. */
export interface WebBranchCreateResult {
  name: string;
  isProtected: boolean;
  cancelled: boolean;
}

/**
 * How each question is answered without a browser.
 *
 * Written from the CLI's argv as it is today. `--no-protected` exists and
 * commander binds it to `false`, so an unprotected branch IS reachable
 * headlessly — the fixture under packages/fixtures still says it is not,
 * which was true before that flag landed.
 */
function nonTtyEscapes(name: string): BranchCreateData['nonTty'] {
  const shown = name || '<name>';
  return {
    name: {
      command: `capy checkout -b ${shown}`,
      why: 'The name is a positional argument. Without one there is nothing to create, so the step cannot fall back to a default.',
    },
    protection: {
      command: `capy checkout -b ${shown} --no-protected`,
      why: 'Protection is not guessed: --protected makes the branch invite-only, --no-protected leaves it open to the project. An untouched flag is unanswered rather than false, so a run with nowhere to ask refuses instead of picking one.',
    },
  };
}

/**
 * Which question this run is standing on, or null when nothing is left to ask.
 *
 * Derived from the plan rather than from a view field the caller sets, so the
 * screen that gets served and the rail drawn beside it cannot disagree about
 * where the traveller is.
 */
function currentView(p: { branchName: string; isProtected?: boolean }): 'name' | 'protection' | null {
  const [next] = unansweredStops(branchCreatePlan({ branchName: p.branchName, isProtected: p.isProtected }));
  if (next === 'name') return 'name';
  if (next === 'protection') return 'protection';
  return null;
}

export function buildBranchCreateData(p: WebBranchCreateParams, nonce: string): BranchCreateData {
  const stops = branchCreatePlan({ branchName: p.branchName, isProtected: p.isProtected });
  const name = p.branchName.trim();

  return {
    nonce,
    projectName: stripAnsi(p.projectName),
    stops,
    existingBranches: p.existingBranches,
    // "Empty when the CLI has none" — and a name that is only whitespace is
    // none, which is the same judgement `branchCreatePlan` makes one line up.
    name,
    isProtected: p.isProtected,
    seedFrom: p.seedFrom,
    seedVarNames: p.seedVarNames,
    seedUnreadable: p.seedUnreadable,
    // `currentView` returning null means there is nothing to serve; the caller
    // never opens a browser in that case. Falling back to the name step keeps
    // the type total without inventing a fourth view.
    view: currentView({ branchName: p.branchName, isProtected: p.isProtected }) ?? 'name',
    nonTty: nonTtyEscapes(name),
  };
}

/**
 * The four ways a name is not a name.
 *
 * Only the first has CLI copy (the init prompt's validator); the rest are the
 * screen's, reproduced verbatim so a refusal the CLI makes and the error the
 * field shows are one sentence rather than two about one condition.
 *
 * The screen holds its button on every one of these, so any of them arriving
 * over the wire means the submit did not come from the screen — refuse it
 * rather than post a name nobody typed to `POST /projects/{id}/branches`.
 */
export function branchNameProblem(name: string, existing: BranchCreateExisting[]): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Branch name cannot be empty';
  if (/\s/.test(trimmed)) return 'Branch names cannot contain spaces or line breaks';
  if (trimmed.startsWith('-')) return 'Branch names cannot start with a hyphen';
  const clash = existing.find((b) => b.name === trimmed);
  if (clash) {
    return clash.isProtected
      ? `${clash.name} already exists in this project, as a protected branch`
      : `${clash.name} already exists in this project`;
  }
  return undefined;
}

export async function createBranchInBrowser(p: WebBranchCreateParams): Promise<WebBranchCreateResult> {
  // The nonce is minted inside `runBrowserWizard` and reaches a caller only
  // through `renderFirst`. A second standalone step has to be rendered with
  // that same token, so it is captured on the way past rather than each flow
  // minting its own — which would put the security token of every browser path
  // in the hands of each path instead of in one place.
  let nonce = '';

  // What this run has answered so far. Seeded from argv, then folded forward
  // as each step comes back, so the plan is recomputed from one place and the
  // rail redraws itself without this file deciding what a stop's state is.
  let answered = { branchName: p.branchName, isProtected: p.isProtected };
  const render = (): string =>
    renderScreen('branch-create', buildBranchCreateData({ ...p, ...answered }, nonce));

  const out = await runBrowserWizard(
    {
      title: `New branch — ${p.projectName}`,
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Answered — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return {
          done: true,
          result: { name: answered.branchName, isProtected: false, cancelled: true },
        };
      }

      const view = currentView(answered);

      if (view === 'name') {
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        const problem = branchNameProblem(name, p.existingBranches);
        if (problem) return { error: problem };
        answered = { ...answered, branchName: name };
      } else if (view === 'protection') {
        // The screen sends a boolean or nothing. Anything else is a malformed
        // submit, and guessing would decide who can reach this branch — the
        // one security setting this flow exists to set.
        if (typeof payload.isProtected !== 'boolean') {
          return { error: 'That is not an answer the protection step can produce.' };
        }
        answered = { ...answered, isProtected: payload.isProtected };
      } else {
        // Nothing was outstanding, so no screen asked this. Refusing keeps a
        // stray submit from creating a branch nobody was asked about.
        return { error: 'There is nothing left to answer on this run.' };
      }

      const next = currentView(answered);
      if (next === null) {
        return {
          done: true,
          result: {
            name: answered.branchName,
            isProtected: answered.isProtected === true,
            cancelled: false,
          },
        };
      }
      // A whole document cannot be spliced into the open page, so it is handed
      // back as `standalone` and the browser reloads to receive it.
      return { screen: { html: render(), standalone: true } };
    },
  );
  return out as WebBranchCreateResult;
}

// ---------------------------------------------------------------------------
// branch-list
// ---------------------------------------------------------------------------

export interface WebBranchListParams {
  projectName: string;
  /** Null when the CLI could not derive one — then no row is marked current. */
  activeBranch: string | null;
  /** The server's list, verbatim. Protection is read off `is_protected`. */
  branches: Branch[];
  /** Variables held per branch, where keep.lock has counted them. */
  variableCounts?: Record<string, number>;
  /** Whether this run may delete branches at all. `capy checkout` may not. */
  canDelete: boolean;
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
  /** Test hook only: fixes `now` so the age column is deterministic. */
  now?: Date;
}

/** What the browser picked. `cancelled` means the run must not switch. */
export interface WebBranchListResult {
  branch: string;
  cancelled: boolean;
}

export function buildBranchListData(p: WebBranchListParams, nonce: string): BranchListData {
  const branches: BranchRow[] = p.branches.map((b) => ({
    id: b.id,
    name: b.name,
    // Off `is_protected`, never off the name. `branchResolver` holds itself to
    // that — a branch called `production` is not protected and a protected
    // branch called `spike` is — and a screen that guessed from the name would
    // be the one place the product disagreed with itself about who can read a
    // secret.
    isProtected: b.is_protected,
    isCurrent: b.name === p.activeBranch,
    variableCount: p.variableCounts?.[b.name],
    age: b.created_at ? stripAnsi(`created ${formatRelativeTime(b.created_at, p.now)}`) : undefined,
    // The server's branch list carries no per-caller grant, so for a protected
    // branch this is genuinely unknown here. `true` is the honest unknown: it
    // offers exactly what the terminal picker offers, and the 403 the checkout
    // already handles says the accurate thing afterwards. `false` would read
    // as knowledge the CLI does not have, and would lock a member who DOES
    // hold a grant out of a branch the terminal would let them switch to.
    canSwitch: true,
  }));

  return {
    nonce,
    projectName: stripAnsi(p.projectName),
    activeBranch: p.activeBranch,
    branches,
    canDelete: p.canDelete,
    // Omitted rather than zeroed: `checkout` refuses to run at all with a dirty
    // working tree, so by the time this screen is served there is no drift to
    // count, and `0` would be a claim this code did not make.
    nonTty: {
      command: 'capy checkout <branch>',
      why: 'Switching branches changes which secrets land in .env, so it is never chosen for you.',
    },
  };
}

/**
 * Serve the branch list and wait for a row.
 *
 * The submitted name is resolved against the list the server sent, not
 * trusted: `switch` is followed by a real checkout of whatever comes back, and
 * a name the screen could not have offered did not come from the screen.
 */
export async function chooseBranchInBrowser(p: WebBranchListParams): Promise<WebBranchListResult> {
  const out = await runBrowserWizard(
    {
      title: `Branches — ${p.projectName}`,
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Picked — back to your terminal.',
      renderFirst: (nonce) => renderScreen('branch-list', buildBranchListData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { branch: '', cancelled: true } };
      }
      if (payload.__action === 'delete') {
        // The screen only draws its delete control when `canDelete` is set, and
        // a checkout never sets it. Deleting somebody's secrets off the back of
        // a submit the screen could not have produced is the failure this
        // refusal exists to prevent.
        return { error: 'Deleting a branch is not part of capy checkout. Use capy branch -D <name>.' };
      }
      if (payload.__action !== 'switch') {
        return { error: 'That is not an action this screen offers.' };
      }

      const name = typeof payload.branch === 'string' ? payload.branch : '';
      const row = p.branches.find((b) => b.name === name);
      if (!row) return { error: 'That branch is not in this project.' };
      if (row.name === p.activeBranch) {
        // The screen holds its button on the current row, so this can only
        // arrive from something that is not the screen.
        return { error: 'This directory is already on that branch.' };
      }

      return { done: true, result: { branch: row.name, cancelled: false } };
    },
  );
  return out as WebBranchListResult;
}
