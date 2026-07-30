// The first run — `capy` in a directory with no keep.lock — served as the
// compiled `init-wizard` screen.
//
// WHAT WAS WRONG. The six prompts of `initializeProject` had a `--web` path
// already, and it was six unrelated pages: an org list, a project list, two
// bare text boxes, another list, and a yes/no. Each one opened its own server,
// its own tab and its own URL, and none of them could say what the other five
// were, so a person answering "development" had no way to know a consent gate
// that rewrites their .env was two questions away. The route existed only in
// the order the CLI happened to ask.
//
// This serves ONE window for the whole run. `initWizardPlan` computes all ten
// stops before the first page is rendered — including the ones this run will
// skip and the ones whose fork is not settled yet — and every step redraws the
// same rail with the answers folded in. Advancing is a page RELOAD, which is
// what `standalone` means: a compiled screen is a whole document, and the
// browser fetches the next step rather than being handed its markup.
//
// SECRET MATERIAL. Variable NAMES and counts only. The values in that .env are
// still plaintext on disk at this point and the last stop's entire question is
// whether they may stop being — putting even a snippet of one on the page
// would be showing more than the terminal does to ask it. The recovery phrase
// belongs to the same flow and never appears here at all: `orgCreation.ts`
// shows and confirms it on its own surface, and the `recovery` stop is drawn
// `manual` to say that this page is not where that happens.
import { runBrowserWizard, type WizardDecision } from './browserWizard';
import { renderScreen } from './screens/serve';
import { branchNameProblem } from './branchScreens';
import { initWizardPlan, type InitWizardInput } from '../core/initWizardPlan';
import type {
  InitLocalEnv,
  InitOrg,
  InitProject,
  InitStep,
  InitTarget,
  InitWizardData,
} from './screens/contract';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to names the CLI also PRINTS — an org name inside a bolded prompt, a
 * project name out of `getDefaultProjectName` — because a payload is not a
 * terminal and an escape renders as a literal `[1m` in the browser.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The sentinel the org list uses for "create a new one". Never leaves the CLI. */
export const CREATE_NEW_ORG = '__create_new__';
/** The sentinel the project list uses for "start a new one". Never leaves the CLI. */
export const CREATE_NEW_PROJECT = '__create_new_project__';

/** Everything one render of the wizard needs: which step, and the run so far. */
export interface InitWizardView {
  step: InitStep;
  /** What has been answered and discovered. The rail is derived from this. */
  input: InitWizardInput;
  orgs?: InitOrg[];
  projects?: InitProject[];
  projectsUnavailable?: boolean;
  localEnv?: InitLocalEnv;
  target?: InitTarget;
  /** Prefill for a text step — the directory-derived default project name. */
  value?: string;
  /** Why the previous answer was refused, in the CLI's own words. */
  rejected?: string;
}

/**
 * How each stop is answered without a browser.
 *
 * The root `capy` command has no flags for any of this and no `--non-tty`
 * either, so every one of these prompts hangs forever on a closed stdin. The
 * declared route is what makes the gap expressible rather than mysterious, and
 * `redeem` is a refusal on purpose: an invite code is a bearer credential, and
 * a flag would leave it in shell history and `ps` output whoever typed it.
 */
const NON_TTY: Record<InitStep, { command: string; why: string }> = {
  auth: {
    command: 'capy',
    why: 'Signing in opens a browser at capy.sc; there is no flag that replaces it.',
  },
  organization: {
    command: 'capy org',
    why: 'Which organization a directory belongs to decides who can read its secrets, so it is never picked for you.',
  },
  'organization-name': {
    command: 'capy org',
    why: 'Creating an organization mints a master key and a recovery phrase, which cannot be done unattended.',
  },
  redeem: {
    command: 'capy redeem <code>',
    why: 'An invite code is a bearer credential. Passing it as a flag would leave it in shell history and in ps output.',
  },
  project: {
    command: 'capy',
    why: 'There is no flag for this: the root command asks, and bootstrapping the wrong project overwrites the .env in this directory.',
  },
  'project-name': {
    command: 'capy',
    why: 'The project name defaults to this directory\'s name, but creating a project is not something a run does without being asked.',
  },
  branch: {
    command: 'capy',
    why: 'The first branch is what every later pin is written against, so it is not guessed.',
  },
  'branch-name': {
    command: 'capy',
    why: 'The first branch is what every later pin is written against, so it is not guessed.',
  },
  encrypt: {
    command: 'capy push',
    why: 'Encrypting rewrites the .env in this directory as ciphertext. Nothing does that without being asked.',
  },
};

export function buildInitWizardData(v: InitWizardView, nonce: string): InitWizardData {
  const data: InitWizardData = {
    nonce,
    step: v.step,
    stops: initWizardPlan(v.input),
    nonTty: NON_TTY[v.step],
  };

  if (v.orgs) data.orgs = v.orgs.map((o) => ({ ...o, name: stripAnsi(o.name) }));
  if (v.projects) data.projects = v.projects.map((p) => ({ ...p, name: stripAnsi(p.name) }));
  if (v.projectsUnavailable) data.projectsUnavailable = true;
  if (v.localEnv) {
    // Names, and a count. Never a value, and never a snippet of one: this is
    // the payload of the page that asks whether these may be encrypted at all.
    data.localEnv = { count: v.localEnv.count, names: v.localEnv.names.map(stripAnsi) };
  }
  if (v.target) {
    data.target = {
      projectName: stripAnsi(v.target.projectName),
      orgName: stripAnsi(v.target.orgName),
      branch: stripAnsi(v.target.branch),
    };
  }
  if (v.value !== undefined) data.value = stripAnsi(v.value);
  if (v.rejected !== undefined) data.rejected = v.rejected;
  return data;
}

/**
 * The CLI's own project-name validator, in the CLI's own words.
 *
 * Both sentences are `initializeProject`'s, copied so the browser refuses a
 * name for the same reason and with the same sentence the terminal does. The
 * screen holds its button on both, so either arriving over the wire means the
 * submit did not come from the screen.
 */
export function projectNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Project name cannot be empty';
  if (!/^[a-zA-Z0-9-_]+$/.test(trimmed)) {
    return 'Project name can only contain letters, numbers, hyphens, and underscores';
  }
  return undefined;
}

/** A step's verdict: refuse inline, or take the answer. */
type Verdict<T> = { error: string } | { value: T };

export interface InitWizardOptions {
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * One browser window, held open across the whole first run.
 *
 * The CLI asks its questions in the order it always has — this is a channel,
 * not a rewrite of the flow. `ask` renders the step and waits; the answer's
 * POST is then HELD OPEN while the CLI does the work that step unlocked
 * (refreshing a token, creating the project, creating the branch), and is
 * released with the next screen when the CLI asks its next question. That is
 * what makes the page truthful: it says "Working…" exactly while work is
 * happening, and the step it reloads into is one the CLI has actually reached.
 *
 * A closed window answers nothing. Every `ask` resolves to `null` on cancel,
 * and each call site decides what that means — for the consent gate it means
 * NO, which is the same thing `confirmEncrypt = chosen === 'yes'` already
 * meant. Nothing here ever turns silence into agreement.
 */
export class InitWizardSession {
  private nonce = '';
  private wizard: Promise<unknown> | null = null;
  private pending: {
    view: InitWizardView;
    decide: (payload: Record<string, unknown>) => Verdict<unknown>;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
  } | null = null;
  /** Releases the POST the reducer is holding open, once there is a next step. */
  private handoff: ((d: WizardDecision) => void) | null = null;
  private input: InitWizardInput = {};
  private ended = false;

  constructor(private opts: InitWizardOptions = {}) {}

  /** Fold a fact or an answer into the run, so the rail redraws from one place. */
  record(patch: Partial<InitWizardInput>): void {
    this.input = { ...this.input, ...patch };
  }

  private render(view: InitWizardView): string {
    return renderScreen('init-wizard', buildInitWizardData({ ...view, input: this.input }, this.nonce));
  }

  private async ask<T>(
    view: Omit<InitWizardView, 'input'>,
    decide: (payload: Record<string, unknown>) => Verdict<T>,
  ): Promise<T | null> {
    if (this.ended) throw new Error('The setup window has already closed.');
    const full: InitWizardView = { ...view, input: this.input };

    const answer = new Promise<T | null>((resolve, reject) => {
      this.pending = {
        view: full,
        decide: decide as (p: Record<string, unknown>) => Verdict<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
    });

    if (!this.wizard) {
      this.wizard = runBrowserWizard(
        {
          title: 'Set up this directory',
          // Rendered per-request so the nonce the page echoes is the one this
          // server minted. `standalone` because a compiled screen is a whole
          // document and cannot be dropped into the wizard shell.
          firstScreen: { html: '', standalone: true },
          open: this.opts.open ?? true,
          onListen: this.opts.onListen,
          timeoutMs: this.opts.timeoutMs,
          doneMessage: 'Set up — back to your terminal.',
          renderFirst: (n) => {
            this.nonce = n;
            return this.render(this.pending!.view);
          },
        },
        async (_step, payload) => this.onSubmit(payload),
      );
      // A window that times out, or a Ctrl+C, must not leave the CLI waiting on
      // an answer that can no longer arrive.
      this.wizard.catch((err) => {
        this.ended = true;
        const p = this.pending;
        this.pending = null;
        p?.reject(err);
      });
    } else {
      // The reducer is holding the previous answer's POST open. Releasing it
      // with this step is what makes the browser reload into it.
      this.release({ screen: { html: this.render(full), standalone: true } });
    }

    return answer;
  }

  private release(decision: WizardDecision): void {
    const h = this.handoff;
    this.handoff = null;
    h?.(decision);
  }

  private onSubmit(payload: Record<string, unknown>): Promise<WizardDecision> | WizardDecision {
    const p = this.pending;
    if (!p) {
      // Nothing is outstanding, so no step asked this. Refusing keeps a stray
      // submit from answering a question the CLI never put.
      return { error: 'There is nothing left to answer on this run.' };
    }

    if (payload.__action === 'cancel') {
      this.pending = null;
      this.ended = true;
      p.resolve(null);
      return { done: true, result: { cancelled: true } };
    }

    const verdict = p.decide(payload);
    // An inline refusal keeps the user on the step with the reason on screen,
    // rather than applying a guess: an answer the screen could not have
    // produced did not come from the screen.
    if ('error' in verdict) return verdict;

    this.pending = null;
    p.resolve(verdict.value);
    // Hold this POST until the CLI reaches its next question — or finishes.
    return new Promise<WizardDecision>((resolve) => {
      this.handoff = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // the six questions, in the order `initializeProject` asks them
  // -------------------------------------------------------------------------

  /** `Select organization for project:` — or the "create new" row. */
  async askOrganization(orgs: InitOrg[]): Promise<string | 'create' | null> {
    return this.ask<string | 'create'>({ step: 'organization', orgs }, (payload) => {
      if (payload.createOrganization === true) {
        // The name is not known yet — `capy` asks for it in the org-creation
        // flow that follows — so the fork is recorded and the name is not.
        this.record({ organization: { kind: 'new' } });
        return { value: 'create' as const };
      }
      const id = typeof payload.organizationId === 'string' ? payload.organizationId : '';
      // The page offers only what this session can reach, so anything else is a
      // malformed submit — and picking the wrong organization decides which key
      // this directory's secrets get encrypted to.
      const org = orgs.find((o) => o.id === id);
      if (!org) return { error: 'That organization is not one this session can reach.' };
      this.record({ organization: { kind: 'existing', name: org.name } });
      return { value: id };
    });
  }

  /** `Which project do you want to use?` — or the "New project" row. */
  async askProject(projects: InitProject[]): Promise<string | 'new' | null> {
    return this.ask<string | 'new'>({ step: 'project', projects }, (payload) => {
      if (payload.newProject === true) {
        this.record({ project: { kind: 'new' } });
        return { value: 'new' as const };
      }
      const id = typeof payload.projectId === 'string' ? payload.projectId : '';
      const project = projects.find((p) => p.id === id);
      if (!project) return { error: 'That project is not in this organization.' };
      this.record({ project: { kind: 'existing', name: project.name } });
      return { value: id };
    });
  }

  /** `Project name (default: "…")` — the CLI's own validator, verbatim. */
  async askProjectName(defaultName: string): Promise<string | null> {
    return this.ask<string>({ step: 'project-name', value: defaultName }, (payload) => {
      const name = typeof payload.projectName === 'string' ? payload.projectName.trim() : '';
      const problem = projectNameProblem(name);
      if (problem) return { error: problem };
      this.record({ project: { kind: 'new', name } });
      return { value: name };
    });
  }

  /** `What branch should this project start with?` */
  async askBranchChoice(): Promise<'development' | 'other' | null> {
    return this.ask<'development' | 'other'>({ step: 'branch' }, (payload) => {
      const choice = payload.branchChoice;
      if (choice !== 'development' && choice !== 'other') {
        return { error: 'That is not a branch this step offers.' };
      }
      this.record({ branchChoice: choice });
      return { value: choice };
    });
  }

  /** `Branch name:` — validated the way `capy checkout -b` validates one. */
  async askBranchName(): Promise<string | null> {
    return this.ask<string>({ step: 'branch-name' }, (payload) => {
      const name = typeof payload.branchName === 'string' ? payload.branchName.trim() : '';
      const problem = branchNameProblem(name, []);
      if (problem) return { error: problem };
      this.record({ branchName: name });
      return { value: name };
    });
  }

  /**
   * The consent gate: `Encrypt these N secrets and push to <project> (<org>)
   * on <branch>?`
   *
   * Answers `false` for a closed window, because that is what the terminal
   * already does — `confirmEncrypt = chosen === 'yes'` — and because after
   * this step the .env in the directory is ciphertext. Nothing about leaving
   * may look like agreement to that.
   */
  async askEncrypt(localEnv: InitLocalEnv, target: InitTarget): Promise<boolean> {
    const answer = await this.ask<boolean>({ step: 'encrypt', localEnv, target }, (payload) => {
      if (typeof payload.encrypt !== 'boolean') {
        return { error: 'That is not an answer the encrypt step can produce.' };
      }
      this.record({ encrypt: payload.encrypt });
      return { value: payload.encrypt };
    });
    return answer === true;
  }

  /** Nothing more will be asked: release the browser and let the CLI finish. */
  async finish(): Promise<void> {
    if (!this.wizard) return;
    this.ended = true;
    this.release({ done: true, result: { cancelled: false } });
    await this.wizard.catch(() => undefined);
  }

  /**
   * The run failed between two questions.
   *
   * Releases the POST the browser is waiting on so the page stops claiming to
   * be working on something that has already stopped. The error itself is the
   * terminal's to report — this only closes the window.
   */
  async abort(): Promise<void> {
    if (!this.wizard) return;
    this.ended = true;
    this.release({ done: true, result: { cancelled: true } });
    await this.wizard.catch(() => undefined);
  }
}
