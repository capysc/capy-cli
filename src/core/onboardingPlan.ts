/**
 * The routes the org / onboarding commands travel, computed before anything
 * opens a browser.
 *
 * FOUR pure functions, for the reason `branchCreatePlan` is one: the rail a
 * person reads and the array a headless caller parses have to be the same
 * object, and two builders — one for the page, one for `--json` — make that a
 * promise nobody can keep past the first divergence. Nothing in here touches
 * the network, the filesystem or a screen; it takes what a run has answered so
 * far and says what the whole journey is, including the stops this run will
 * not visit.
 *
 * A stop this run skips is declared `skipped` rather than dropped. Dropping it
 * would make the rail describe the run instead of the route, and "why was I
 * never asked about the certificate?" is a question the route answers and a
 * filtered list does not.
 *
 * `detail` is only on the byoc rail. The generated contract's base `Stop`
 * carries id/label/state/answer and nothing else, while the kit's own `Stop`
 * renders `detail`, `manual`, `blank` and `flag`; only `ByocStop` re-declares
 * them on the CLI side. So the byoc route says what happens at each station and
 * the other three draw bare labels — which is the honest result of a contract
 * that does not carry the field, not a decision made here.
 */
import type { ByocStop, Stop } from '../ui/screens/contract';

// ---------------------------------------------------------------------------
// capy org — pick an organization, then a project
// ---------------------------------------------------------------------------

/**
 * The stops that exist only on the create-a-new-organization branch.
 *
 * Shipped to the screen as `createStopIds` so it can strike them through while
 * an existing organization is selected and light them up when the create row
 * is. The knowledge of which route a stop belongs to stays with the code that
 * computed the route, rather than being hardcoded in the screen that draws it.
 */
export const ORG_CREATE_STOP_IDS = ['name', 'phrase', 'create'];

export interface OrgSwitchInput {
  /** The organization chosen so far, by name. Undefined means unanswered. */
  orgName?: string;
  /**
   * The create-a-new-organization row is the one selected, and its three stops
   * are ahead of this run.
   *
   * Applied client-side rather than here on the live picker: the CLI serves the
   * list once and the screen re-labels `createStopIds` as the selection moves,
   * because that transition happens between two renders the command never sees.
   * The command's own use of this input is the moment the row is submitted.
   */
  creating?: boolean;
  /**
   * The create route has been WALKED: the organization was named, its recovery
   * phrase was shown and confirmed, and it exists.
   *
   * Distinct from `creating`, which puts those stops ahead of the traveller.
   * `nameFirstProjectInBrowser` is served immediately after all three happened,
   * and a rail that struck them through there would tell a user who had just
   * written down 24 words that the step was "not needed".
   */
  created?: boolean;
  /** The project chosen (or named) so far. Undefined means unanswered. */
  projectName?: string;
}

/**
 * `capy org`'s whole route, create branch included.
 *
 * The create stops are on the map from the start, per §8.1: choosing "create a
 * new organization" is not a discovery. Without them the rail promised
 * "Organization → Project" to an account with no organizations, whose only
 * reachable path is four stops long and includes a recovery-phrase reveal that
 * cannot be undone.
 *
 * The `project` stop is declared on every run because this CLI asks for a
 * project on every run — including one where the directory already has a
 * keep.lock. CAP-316 will change that; until it does, a route that omitted the
 * stop would be describing a command that does not exist yet.
 */
export function orgSwitchPlan(input: OrgSwitchInput): Stop[] {
  const created = input.created === true;
  const creating = input.creating === true && !created;
  const orgAnswered = creating || created || (input.orgName ?? '') !== '';
  const projectAnswered = (input.projectName ?? '') !== '';

  const org: Stop = orgAnswered
    ? {
        id: 'org',
        label: 'Organization',
        state: 'done',
        // The create row's own wording, verbatim from the screen's option list,
        // so the rail names what was picked rather than paraphrasing it. Once
        // the organization exists it has a name, and the name is the answer.
        answer: creating ? 'Create a new organization' : input.orgName!,
      }
    : { id: 'org', label: 'Organization', state: 'current' };

  /**
   * A create-only stop, in one of its three lives: struck through on the switch
   * branch, ahead of the traveller while the create row is merely selected, and
   * behind them once the route has been walked.
   */
  const createStop = (id: string, label: string, answer?: string): Stop => ({
    id,
    label,
    state: created ? 'done' : creating ? 'upcoming' : 'skipped',
    ...(created && answer ? { answer } : {}),
  });

  return [
    org,
    createStop('name', 'Name', input.orgName),
    // No `answer` beyond the consent, ever: see `createOrgPlan`.
    createStop('phrase', 'Recovery phrase', 'written down'),
    createStop('create', 'Create', input.orgName),
    projectAnswered
      ? { id: 'project', label: 'Project', state: 'done', answer: input.projectName! }
      : {
          id: 'project',
          label: 'Project',
          // Only the first unanswered stop is where the traveller stands, and
          // while the create branch is still ahead, three stations sit in front
          // of this one. Once they are behind, this is where the run is.
          state: orgAnswered && !creating ? 'current' : 'upcoming',
        },
  ];
}

// ---------------------------------------------------------------------------
// Creating an organization — name, phrase, create
// ---------------------------------------------------------------------------

export interface CreateOrgInput {
  /** The name settled so far. Undefined or blank means unanswered. */
  name?: string;
  /** The recovery phrase has been shown and written down. */
  confirmed?: boolean;
}

/**
 * The three stations of `capy org` → "Create new organization +".
 *
 * Declared before the phrase is generated so a user knows a write-it-down step
 * is coming while there is still somewhere to put the pen.
 */
export function createOrgPlan(input: CreateOrgInput): Stop[] {
  const named = (input.name ?? '').trim() !== '';
  const confirmed = input.confirmed === true;

  return [
    named
      ? { id: 'name', label: 'Name', state: 'done', answer: input.name!.trim() }
      : { id: 'name', label: 'Name', state: 'current' },
    {
      id: 'phrase',
      label: 'Recovery phrase',
      state: confirmed ? 'done' : named ? 'current' : 'upcoming',
      // No `answer`. The answer to this stop is 24 words of master key, and a
      // rail that echoed any of it would defeat the page it is drawn on. The
      // consent is the only thing that happened here that can be written down.
      ...(confirmed ? { answer: 'written down' } : {}),
    },
    { id: 'create', label: 'Create', state: 'upcoming' },
  ];
}

// ---------------------------------------------------------------------------
// capy byoc — local mode
// ---------------------------------------------------------------------------

/** The CLI's own menu wording, carried to the rail so both surfaces agree. */
export const PHRASE_SOURCE_LABELS: Record<'generate' | 'enter', string> = {
  generate: 'Generate a new recovery phrase',
  enter: 'Enter an existing recovery phrase',
};

export interface LocalOnboardingInput {
  /** Which source this run took, once chosen. */
  source?: 'generate' | 'enter';
  /** The phrase step is behind us: written down, or typed and accepted. */
  phraseSettled?: boolean;
  /** The passphrase was accepted and the key written. */
  passphraseSettled?: boolean;
}

/**
 * `capy byoc --web`'s route: where the phrase comes from, the phrase itself, a
 * passphrase, and the write.
 *
 * The `replace-key` station the screen can draw is deliberately NOT here.
 * Nothing in this CLI checks whether a key already exists — `saveLocalKeyRecord`
 * overwrites unconditionally and `hasLocalKey` has no callers — so a run never
 * reaches that decision, and declaring a stop the command has never considered
 * would be the rail claiming knowledge the command does not have.
 */
export function localOnboardingPlan(input: LocalOnboardingInput): Stop[] {
  const sourced = input.source !== undefined;
  const phraseDone = input.phraseSettled === true;
  const passDone = input.passphraseSettled === true;

  return [
    sourced
      ? {
          id: 'source',
          label: 'Phrase source',
          state: 'done',
          answer: PHRASE_SOURCE_LABELS[input.source!],
        }
      : { id: 'source', label: 'Phrase source', state: 'current' },
    {
      id: 'phrase',
      label: 'Recovery phrase',
      // No `answer` on this stop, ever: see `createOrgPlan`.
      state: phraseDone ? 'done' : sourced ? 'current' : 'upcoming',
    },
    {
      id: 'passphrase',
      label: 'Passphrase',
      state: passDone ? 'done' : phraseDone ? 'current' : 'upcoming',
    },
    { id: 'finish', label: 'Finish setup', state: 'upcoming' },
  ];
}

// ---------------------------------------------------------------------------
// capy byoc <url> — connect to a self-hosted instance
// ---------------------------------------------------------------------------

export interface ByocConnectInput {
  /**
   * The URL SETTLED so far, normalized.
   *
   * Settled, not attempted. A probe that failed puts the page back on the
   * address question, and an address the run is standing on again is not an
   * answer — the rail said `Server URL https://capy.internal` with a tick
   * beside it while the field underneath was asking for the address a third
   * time. The field keeps the text (it is edited, not retyped); the rail keeps
   * only what was agreed.
   */
  url?: string;
  /** It came from the argv positional rather than from a question. */
  urlFromArgv?: boolean;
  /** A probe has accepted this URL as a Capy service. */
  verified?: boolean;
  /**
   * Whether this run has a certificate to answer for.
   *
   * Three states on purpose, and the third is the load-bearing one.
   * `undefined` is "nothing has learned anything about a certificate yet",
   * which is not the same as "the certificate is fine": the stop is declared
   * `blank` so the rail shows a station the plan still needs an answer for,
   * rather than quietly promising it will be skipped. Only a completed
   * handshake may pass `false` — a name that did not resolve, a refused
   * connection or a /health that was not Capy never reached a certificate and
   * so cannot strike that station through.
   */
  certUntrusted?: boolean;
  /** The CA bundle path settled so far. */
  caBundle?: string;
  /** The profile name settled so far. */
  profileName?: string;
}

/**
 * The route `capy byoc <url>` travels.
 *
 * The terminal has no route at all: it is a `while (true)` around a probe and a
 * re-prompt whose only exit other than success is Ctrl-C, so a user three URLs
 * deep cannot tell how many questions are left or that a certificate question
 * exists until one appears.
 */
export function byocConnectPlan(input: ByocConnectInput): ByocStop[] {
  const urlAnswered = (input.url ?? '') !== '';
  const verified = input.verified === true;
  const named = (input.profileName ?? '') !== '';

  const url: ByocStop = urlAnswered
    ? {
        id: 'url',
        label: 'Server URL',
        state: 'done',
        detail: 'where your self-hosted Capy lives',
        answer: input.url,
        // Positional rather than a flag, so there is no `--x` to quote. Naming
        // the argument is still the honest answer to "why was I not asked?".
        ...(input.urlFromArgv ? { flag: 'argument' } : {}),
      }
    : {
        id: 'url',
        label: 'Server URL',
        state: 'current',
        detail: 'where your self-hosted Capy lives',
      };

  const trust: ByocStop = {
    id: 'trust',
    label: 'Certificate',
    detail: 'name the authority that signed it',
    // Finding a root certificate on disk is work the user does outside Capy,
    // which is what a dotted track means.
    state: input.caBundle
      ? // A bundle that made the instance verify is an ANSWER to this stop, so
        // it is read before the verdict that produced the question. The other
        // order struck the station through and then hung the bundle path off
        // it as the answer to a question it claimed was never asked.
        'done'
      : input.certUntrusted === false
        ? 'skipped'
        : input.certUntrusted === true
          ? 'current'
          : 'upcoming',
    manual: true,
    ...(input.caBundle ? { answer: input.caBundle } : {}),
    // Nothing has looked yet: the plan needs an answer here and does not have
    // one. A failed probe that never reached a certificate lands here too.
    ...(input.certUntrusted === undefined ? { blank: true } : {}),
  };

  return [
    url,
    {
      id: 'verify',
      label: 'Verify',
      detail: 'ask /health whether it is Capy',
      // One stop is `current`, and it is the one the page is standing on. An
      // untrusted certificate moves the run to the station that answers it —
      // the handshake will be tried again from there — so `verify` waits its
      // turn rather than lighting up beside the stop that overtook it.
      state: verified
        ? 'done'
        : urlAnswered && input.certUntrusted !== true
          ? 'current'
          : 'upcoming',
    },
    trust,
    named
      ? {
          id: 'name',
          label: 'Profile name',
          state: 'done',
          detail: 'what you type after capy use',
          answer: input.profileName,
        }
      : {
          id: 'name',
          label: 'Profile name',
          state: verified ? 'current' : 'upcoming',
          detail: 'what you type after capy use',
        },
    {
      id: 'save',
      label: 'Save',
      state: 'upcoming',
      detail: 'write the profile and switch to it',
    },
  ];
}
