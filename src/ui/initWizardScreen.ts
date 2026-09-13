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
import type { InitQuestion } from './initWizardQuestions';
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
  readonly step: InitStep;
  /** What has been answered and discovered. The rail is derived from this. */
  readonly input: Readonly<InitWizardInput>;
  readonly orgs?: readonly Readonly<InitOrg>[];
  readonly projects?: readonly Readonly<InitProject>[];
  readonly projectsUnavailable?: boolean;
  readonly localEnv?: Readonly<{ count: number; names: readonly string[] }>;
  readonly target?: Readonly<InitTarget>;
  /** Prefill for a text step — the directory-derived default project name. */
  readonly value?: string;
  /** Why the previous answer was refused, in the CLI's own words. */
  readonly rejected?: string;
  /** The run cannot go past this stop. Replaces the question with the reason. */
  readonly blocked?: Blocked;
  /** Identifiers the block is about — the variables under a foreign key. */
  readonly blockedNames?: readonly string[];
  /** Labelled singletons the block is about — the organization, the branch. */
  readonly blockedFacts?: readonly { readonly label: string; readonly value: string }[];
  /** Consent was given and the push failed. What it had done by then. */
  readonly encryptFailure?: InitEncryptFailure;
}

/**
 * How each stop is answered without a browser.
 *
 * The root `capy` command has no flags for any of this and no `--non-tty`
 * either, so every one of these prompts hangs forever on a closed stdin. The
 * declared route is what makes the gap expressible rather than mysterious, and
 * `redeem` is a refusal on purpose: an invite code is key material, and a
 * flag would leave it in shell history and `ps` output whoever typed it.
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
    why: 'An invite code is key material. Passing it as a flag would leave it in shell history and in ps output.',
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
  const base: InitWizardData = {
    nonce,
    step: v.step,
    stops: initWizardPlan({ ...v.input }),
    nonTty: NON_TTY[v.step],
  };
  return {
    ...base,
    ...(v.orgs === undefined ? {} : { orgs: v.orgs.map(org => ({ ...org, name: stripAnsi(org.name) })) }),
    ...(v.projects === undefined
      ? {}
      : { projects: v.projects.map(project => ({ ...project, name: stripAnsi(project.name) })) }),
    ...(v.projectsUnavailable ? { projectsUnavailable: true } : {}),
    ...(v.localEnv === undefined
      ? {}
      : {
          // Names, and a count. Never a value, and never a snippet of one:
          // this is the payload of the page that asks whether these may be
          // encrypted at all.
          localEnv: { count: v.localEnv.count, names: v.localEnv.names.map(stripAnsi) },
        }),
    ...(v.target === undefined
      ? {}
      : {
          target: {
            projectName: stripAnsi(v.target.projectName),
            orgName: stripAnsi(v.target.orgName),
            branch: stripAnsi(v.target.branch),
          },
        }),
    ...(v.value === undefined ? {} : { value: stripAnsi(v.value) }),
    ...(v.rejected === undefined ? {} : { rejected: v.rejected }),
    ...(v.blocked === undefined
      ? {}
      : {
          // `detail` is prose the CLI also prints, and printing is where the
          // bold comes from. An escape that renders as `[1m` in a browser
          // turns the one sentence explaining why a run stopped into
          // gibberish.
          blocked: {
            ...v.blocked,
            title: stripAnsi(v.blocked.title),
            detail: stripAnsi(v.blocked.detail),
            ...(v.blocked.remedy === undefined ? {} : { remedy: stripAnsi(v.blocked.remedy) }),
          },
        }),
    ...(v.blockedNames?.length ? { blockedNames: v.blockedNames.map(stripAnsi) } : {}),
    ...(v.blockedFacts?.length
      ? { blockedFacts: v.blockedFacts.map(fact => ({ label: fact.label, value: stripAnsi(fact.value) })) }
      : {}),
    ...(v.encryptFailure === undefined
      ? {}
      : { encryptFailure: { ...v.encryptFailure, reason: stripAnsi(v.encryptFailure.reason) } }),
  };
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
export { initProjectNameProblem as projectNameProblem } from './initWizardQuestions';

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
type InitWizardAnswer<T> = Readonly<{
  value: T | null;
  record: Readonly<Partial<InitWizardInput>>;
  terminal: boolean;
}>;
type InitDeferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}>;

type InitWizardTerminal = Readonly<{ kind: 'terminal'; decision: WizardDecision }>;
type InitWizardContinuation = InitWizardQuestionNode | InitWizardTerminal;
type InitWizardQuestionNode = Readonly<{
  index: number;
  question: InitQuestion<unknown>;
  view: InitWizardView;
  answer: InitDeferred<InitWizardAnswer<unknown>>;
  next: InitDeferred<InitWizardContinuation>;
}>;
type InitWizardChannel = Readonly<{
  wizard: Promise<unknown>;
  nonce: Promise<string>;
  failure: InitDeferred<unknown>;
}>;
type InitWizardBlock = Readonly<{
  step: InitStep;
  view: Omit<InitWizardView, 'input' | 'step'>;
}>;
type InitWizardState = Readonly<{
  input: InitWizardInput;
  channel?: InitWizardChannel;
  last?: InitWizardQuestionNode;
  block?: InitWizardBlock;
  terminal: boolean;
}>;

const initialState = (): InitWizardState => ({ input: {}, terminal: false });

const deferred = <T>(): InitDeferred<T> => Promise.withResolvers<T>();

const nodeFor = <T>(question: InitQuestion<T>, input: InitWizardInput, index: number): InitWizardQuestionNode => ({
  index,
  question: question as InitQuestion<unknown>,
  view: { ...question.view, input },
  answer: deferred<InitWizardAnswer<unknown>>(),
  next: deferred<InitWizardContinuation>(),
});

const renderNode = (node: InitWizardQuestionNode, nonce: string): string =>
  renderScreen('init-wizard', buildInitWizardData(node.view, nonce));

const followNode = async (
  node: InitWizardQuestionNode,
  payload: Record<string, unknown>,
  nonce: Promise<string>,
): Promise<WizardDecision> => {
  if (payload.__action === 'cancel') {
    node.answer.resolve({ value: null, record: {}, terminal: true });
    return { done: true, result: { cancelled: true } };
  }
  const verdict = node.question.decide(payload);
  if ('error' in verdict) return verdict;
  node.answer.resolve({ value: verdict.value, record: verdict.record, terminal: false });
  const continuation = await node.next.promise;
  if ('kind' in continuation) return continuation.decision;
  return {
    screen: { html: renderNode(continuation, await nonce), standalone: true },
  };
};

const nodeAt = async (node: InitWizardQuestionNode, index: number): Promise<InitWizardQuestionNode> => {
  if (node.index === index) return node;
  const continuation = await node.next.promise;
  if ('kind' in continuation) {
    throw new CapyError('The setup window has already closed.', ERROR_CODES.SERVICE_ERROR);
  }
  return nodeAt(continuation, index);
};

const startChannel = (first: InitWizardQuestionNode, options: InitWizardOptions): InitWizardChannel => {
  const nonce = deferred<string>();
  const failure = deferred<unknown>();
  const wizard = runBrowserWizard(
    {
      title: 'Set up this directory',
      flow: 'init',
      firstScreen: { html: '', standalone: true },
      open: options.open ?? true,
      onListen: options.onListen,
      timeoutMs: options.timeoutMs,
      finalGraceMs: options.finalGraceMs,
      doneMessage: 'Set up — back to your terminal.',
      renderFirst: value => {
        nonce.resolve(value);
        return renderNode(first, value);
      },
    },
    async (step, payload) => followNode(await nodeAt(first, step), payload, nonce.promise),
  );
  void wizard.then(
    () => undefined,
    error => failure.resolve(error),
  );
  return { wizard, nonce: nonce.promise, failure };
};

const answerOrFailure = async <T>(
  node: InitWizardQuestionNode,
  channel: InitWizardChannel,
): Promise<InitWizardAnswer<T>> => {
  const result = await Promise.race([
    node.answer.promise.then(answer => ({ kind: 'answer' as const, answer })),
    channel.failure.promise.then(error => ({ kind: 'failure' as const, error })),
  ]);
  if (result.kind === 'failure') throw result.error;
  return result.answer as InitWizardAnswer<T>;
};

const terminalSession = (state: InitWizardState): InitWizardState => ({ ...state, terminal: true });

const encryptContext = (node: InitWizardQuestionNode | undefined): Omit<InitWizardView, 'input' | 'step'> => {
  if (node?.view.step !== 'encrypt') return {};
  return {
    ...(node.view.localEnv === undefined ? {} : { localEnv: node.view.localEnv }),
    ...(node.view.target === undefined ? {} : { target: node.view.target }),
  };
};

/**
 * One browser window, held open across the CLI's first run.
 *
 * The session is a persistent immutable value. Each question returns the next
 * session with the accepted record folded in; while the CLI does its work, the
 * browser's answer POST waits on that next value's linked successor node.
 */
export class InitWizardSession {
  constructor(
    private readonly options: InitWizardOptions = {},
    private readonly state: InitWizardState = initialState(),
  ) {}

  /** Fold a fact into the run so the rail redraws from one immutable input. */
  record(patch: Readonly<Partial<InitWizardInput>>): InitWizardSession {
    return new InitWizardSession(this.options, {
      ...this.state,
      input: { ...this.state.input, ...patch },
    });
  }

  /** State why the caller is about to stop before it throws. */
  willBlock(
    step: InitStep,
    blocked: Blocked,
    extra: Readonly<{ names?: readonly string[]; facts?: readonly { readonly label: string; readonly value: string }[] }> = {},
  ): InitWizardSession {
    return new InitWizardSession(this.options, {
      ...this.state,
      block: {
        step,
        view: {
          blocked,
          ...(extra.names === undefined ? {} : { blockedNames: [...extra.names] }),
          ...(extra.facts === undefined ? {} : { blockedFacts: extra.facts.map(fact => ({ ...fact })) }),
        },
      },
    });
  }

  async askQuestion<T>(question: InitQuestion<T>): Promise<Readonly<{ value: T | null; session: InitWizardSession }>> {
    if (this.state.terminal) {
      throw new CapyError('The setup window has already closed.', ERROR_CODES.SERVICE_ERROR);
    }
    const node = nodeFor(question, this.state.input, (this.state.last?.index ?? -1) + 1);
    const channel = this.state.channel ?? startChannel(node, this.options);
    this.state.last?.next.resolve(node);
    const answer = await answerOrFailure<T>(node, channel);
    return {
      value: answer.value,
      session: new InitWizardSession(this.options, {
        ...this.state,
        channel,
        last: node,
        input: { ...this.state.input, ...answer.record },
        terminal: answer.terminal,
      }),
    };
  }

  /** Nothing more will be asked: release the held POST and finish the browser flow. */
  async finish(): Promise<InitWizardSession> {
    return this.end({ done: true, result: { cancelled: false } });
  }

  /** Serve the declared block (or generic coded error) as the final page. */
  async abort(err?: unknown): Promise<InitWizardSession> {
    const block = this.state.block;
    return this.end(nonce => ({
      screen: {
        html: renderScreen(
          'init-wizard',
          buildInitWizardData(
            {
              ...(block?.view ?? { blocked: blockedFromError(err) }),
              step: block?.step ?? this.state.last?.view.step ?? 'organization',
              input: this.state.input,
            },
            nonce,
          ),
        ),
        standalone: true,
        final: true,
      },
      result: { cancelled: true },
    }));
  }

  /** Redraw the consent stop with the immutable facts from its failed push. */
  async reportEncryptFailure(failure: InitEncryptFailure): Promise<InitWizardSession> {
    const state = {
      ...this.state,
      input: { ...this.state.input, encrypt: undefined },
    };
    return new InitWizardSession(this.options, state).end(nonce => ({
      screen: {
        html: renderScreen(
          'init-wizard',
          buildInitWizardData(
            { ...encryptContext(this.state.last), step: 'encrypt', input: state.input, encryptFailure: failure },
            nonce,
          ),
        ),
        standalone: true,
        final: true,
      },
      result: { cancelled: true },
    }));
  }

  private async end(
    decision: WizardDecision | ((nonce: string) => WizardDecision),
  ): Promise<InitWizardSession> {
    const terminal = new InitWizardSession(this.options, terminalSession(this.state));
    if (this.state.channel === undefined) return terminal;
    if (this.state.terminal || this.state.last === undefined) {
      await this.state.channel.wizard.catch(() => undefined);
      return terminal;
    }
    const resolved = typeof decision === 'function' ? decision(await this.state.channel.nonce) : decision;
    this.state.last.next.resolve({ kind: 'terminal', decision: resolved });
    await this.state.channel.wizard.catch(() => undefined);
    return terminal;
  }
}
