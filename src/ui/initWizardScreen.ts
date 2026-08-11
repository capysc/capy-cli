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
//
// TWO ENDINGS, AND A THIRD THAT IS NOT "DONE". A submit and a cancel are the
// browser's own endings and the screen draws them from the button that was
// pressed. A run that STOPS — no key on this device, a push that failed after
// consent — is neither, and it may not be reported with `{ done }`: the page
// would draw the ending the button implied, which is a green check over a
// failure. Those land on a final page instead: `blocked` for a stop the run
// cannot get past, `encryptFailure` for the one failure that happens after the
// last question and changes what is on disk.
import { runBrowserWizard, type WizardDecision } from './browserWizard';
import { renderScreen } from './screens/serve';
import { initWizardPlan, type InitWizardInput } from '../core/initWizardPlan';
import { CapyError, ERROR_CODES } from '../types';
import type {
  Blocked,
  InitEncryptFailure,
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
  /** The run cannot go past this stop. Replaces the question with the reason. */
  blocked?: Blocked;
  /** Identifiers the block is about — the variables under a foreign key. */
  blockedNames?: string[];
  /** Labelled singletons the block is about — the organization, the branch. */
  blockedFacts?: { label: string; value: string }[];
  /** Consent was given and the push failed. What it had done by then. */
  encryptFailure?: InitEncryptFailure;
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
  if (v.blocked) {
    // `detail` is prose the CLI also prints, and printing is where the bold
    // comes from. An escape that renders as `[1m` in a browser turns the one
    // sentence explaining why a run stopped into gibberish.
    data.blocked = {
      ...v.blocked,
      title: stripAnsi(v.blocked.title),
      detail: stripAnsi(v.blocked.detail),
      ...(v.blocked.remedy === undefined ? {} : { remedy: stripAnsi(v.blocked.remedy) }),
    };
  }
  if (v.blockedNames?.length) data.blockedNames = v.blockedNames.map(stripAnsi);
  if (v.blockedFacts?.length) {
    data.blockedFacts = v.blockedFacts.map((f) => ({ label: f.label, value: stripAnsi(f.value) }));
  }
  if (v.encryptFailure) {
    data.encryptFailure = { ...v.encryptFailure, reason: stripAnsi(v.encryptFailure.reason) };
  }
  return data;
}

/**
 * A stop the run could not get past, built from the error that stopped it.
 *
 * `code` is the CLI's own stable code and is the only thing anything may
 * branch on. The message is carried as `detail` for a person to read and is
 * never parsed — which is also why no remedy is invented here: several of
 * these errors print a `capy redeem <code>` inside their prose, and digging it
 * back out of a sentence is exactly the thing that breaks the next time the
 * sentence is reworded. A call site that knows the remedy states it in fields
 * with `willBlock` before it throws.
 */
export function blockedFromError(err: unknown): Blocked {
  return {
    code: err instanceof CapyError ? err.code : 'UNKNOWN',
    title: 'This run stopped before it finished.',
    detail:
      err instanceof Error && err.message
        ? err.message
        : 'The CLI stopped without saying why. Its terminal output has the details.',
    // Re-running the first run is the way out of every generic failure here:
    // nothing this flow does before the last stop writes anything.
    remedy: 'capy',
  };
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
  /**
   * How long ONE outstanding question may go unanswered. Not a budget for the
   * run: the clock stops while the CLI is working between two stops, which is
   * where creating an organization and writing down 24 words happen.
   */
  timeoutMs?: number;
  /** How long a final page (blocked, or a failed push) waits to be collected. */
  finalGraceMs?: number;
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
  /** True once the wizard promise has settled, however it settled. */
  private settled = false;
  /** The stop the browser is on. What a blocked page redraws itself as. */
  private step: InitStep = 'organization';
  /** Declared by the call site that is about to throw. See `willBlock`. */
  private block: { step: InitStep; view: Omit<InitWizardView, 'input' | 'step'> } | null = null;
  /** What the consent gate was asked ABOUT, for the page a failure redraws. */
  private encryptView: { localEnv: InitLocalEnv; target: InitTarget } | null = null;

  constructor(private opts: InitWizardOptions = {}) {}

  /** Fold a fact or an answer into the run, so the rail redraws from one place. */
  record(patch: Partial<InitWizardInput>): void {
    this.input = { ...this.input, ...patch };
  }

  /**
   * State, in fields, why the run is about to stop.
   *
   * Called immediately before the `throw`, by the one caller that knows what
   * the condition IS: which stop it belongs to, the code behind it, and the
   * command that clears it. Without this the browser gets `abort`'s generic
   * page, which can carry the error's code and its sentence and cannot invent
   * a remedy out of prose — see `blockedFromError`.
   */
  willBlock(
    step: InitStep,
    blocked: Blocked,
    extra: { names?: string[]; facts?: { label: string; value: string }[] } = {},
  ): void {
    this.block = {
      step,
      view: { blocked, blockedNames: extra.names, blockedFacts: extra.facts },
    };
  }

  private render(view: InitWizardView): string {
    return renderScreen('init-wizard', buildInitWizardData({ ...view, input: this.input }, this.nonce));
  }

  private async ask<T>(
    view: Omit<InitWizardView, 'input'>,
    decide: (payload: Record<string, unknown>) => Verdict<T>,
  ): Promise<T | null> {
    if (this.ended) {
      // A code, not a bare Error: this reaches the same handler every other
      // failure does, and "the window closed" is a thing callers may want to
      // tell apart from a service that refused them.
      throw new CapyError('The setup window has already closed.', ERROR_CODES.SERVICE_ERROR);
    }
    this.step = view.step;
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
          flow: 'init',
          // Rendered per-request so the nonce the page echoes is the one this
          // server minted. `standalone` because a compiled screen is a whole
          // document and cannot be dropped into the wizard shell.
          firstScreen: { html: '', standalone: true },
          open: this.opts.open ?? true,
          onListen: this.opts.onListen,
          timeoutMs: this.opts.timeoutMs,
          finalGraceMs: this.opts.finalGraceMs,
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
      // Whether the window is still there decides whether an ending has
      // anywhere to be delivered — see `end`.
      void this.wizard.then(
        () => (this.settled = true),
        () => (this.settled = true),
      );
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

  /**
   * `Branch name:` — the CLI's own validator, in the CLI's own words.
   *
   * `input.trim().length > 0`, which is all the terminal prompt this replaces
   * checks. It used to borrow `capy checkout`'s stricter validator, which also
   * refuses whitespace and a leading hyphen — and a channel that accepts a
   * different set of names than the terminal is not a rendering change, it is
   * a change of what the product does. (The screen holds its own button on a
   * name with a space. That is a rendering difference and stays one: it is the
   * page being more careful, not this flow being pickier.)
   */
  async askBranchName(): Promise<string | null> {
    return this.ask<string>({ step: 'branch-name' }, (payload) => {
      const name = typeof payload.branchName === 'string' ? payload.branchName.trim() : '';
      if (name.length === 0) return { error: 'Branch name cannot be empty' };
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
    // Kept for the failure page, which redraws this step: its checklist says
    // how many secrets reached Keep, and a page rebuilt without the count
    // would report a successful push of zero of them.
    this.encryptView = { localEnv, target };
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
    if (this.ended) {
      // Already over — cancelled, blocked, or a window that closed. `finish`
      // runs on the way out of every successful path, and a run that ended
      // badly still comes back through here.
      await this.wizard.catch(() => undefined);
      return;
    }
    this.ended = true;
    this.release({ done: true, result: { cancelled: false } });
    await this.wizard.catch(() => undefined);
  }

  /**
   * The run stopped between two questions.
   *
   * The page is holding a submit at this moment, and the compiled screen draws
   * its ending from the control that was pressed — so `{ done }` here would
   * print "Done. You can close this tab." over a run that just died. It gets
   * the reason instead: the same rail, with the question replaced by what
   * stopped it, the code behind it, and (when a call site declared one with
   * `willBlock`) the command that clears it.
   *
   * The error is still the terminal's to report. This decides only what the
   * browser is left looking at.
   */
  async abort(err?: unknown): Promise<void> {
    if (!this.wizard) return;
    const declared = this.block;
    await this.end(
      declared?.step ?? this.step,
      declared?.view ?? { blocked: blockedFromError(err) },
    );
  }

  /**
   * Consent was given, and the push that followed failed.
   *
   * The one failure that happens AFTER the last question, which is why it is
   * not an `abort`: by this point the answer was yes, some of it may have
   * happened, and what is on disk right now is the only thing worth saying.
   * The CLI states that in fields — `pushed`, `backupWritten`, `envRewritten`,
   * and the code — and the screen draws them as the checklist it already has.
   *
   * The consent stop goes back to being the stop this run is STANDING at: it
   * was answered and it did not complete, and a rail that ticks it off would
   * be claiming the thing that failed is done.
   */
  async reportEncryptFailure(failure: InitEncryptFailure): Promise<void> {
    if (!this.wizard) return;
    this.record({ encrypt: undefined });
    await this.end('encrypt', { ...(this.encryptView ?? {}), encryptFailure: failure });
  }

  /**
   * Serve one last page and stop.
   *
   * A held POST is what an ending is delivered THROUGH: the page reloads out
   * of it. With nothing held there is nowhere to put one, and there is nothing
   * to say either — the flow settled on its own (cancelled, timed out, Ctrl+C)
   * and the page drew that itself, or no question was ever asked. The CLI is
   * on its way out with an error to print, so that case returns rather than
   * waiting on a window that has already answered.
   */
  private async end(step: InitStep, view: Omit<InitWizardView, 'input' | 'step'>): Promise<void> {
    const wizard = this.wizard;
    if (!wizard) return;
    const holding = this.handoff !== null;
    this.ended = true;
    this.pending = null;
    if (!holding) {
      if (this.settled) await wizard.catch(() => undefined);
      return;
    }
    this.release({
      screen: { html: this.render({ ...view, step, input: this.input }), standalone: true, final: true },
      result: { cancelled: true },
    });
    await wizard.catch(() => undefined);
  }
}
