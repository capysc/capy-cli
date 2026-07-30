// The three browser flows that handle a recovery phrase or a passphrase,
// served as compiled screens: local-mode setup (`capy byoc --web`), creating a
// cloud organization (`capy org --web` → "Create new organization +"), and
// unlocking the local key.
//
// SECURITY INVARIANT, and the reason this file exists at all: a 24-word
// recovery phrase generated here is rendered into the loopback page for the
// user to write down and NOTHING ELSE. It is never printed to stdout/stderr,
// never logged, never part of a return value, and never permitted back in a
// submit payload — so when an agent shells `capy byoc --web` or `capy org
// --web` through the MCP, the phrase cannot reach the model. The phrase lives
// in a closure here and is handed straight to the caller's `finalize`, which
// derives the master key. `tests/commands/webPhraseLeak.test.ts` holds the
// invariant against a real spawned process.
//
// The generated-phrase steps therefore answer with a BOOLEAN — `confirmed:
// true` — and a payload that carries a phrase on those steps is refused rather
// than trusted: the screen cannot produce one, so it did not come from the
// screen. Restoring a phrase the user already holds is the deliberate
// exception and a different risk: they type it, it has to reach the CLI to be
// checked, and it crosses the same pinned loopback the passphrase does.
//
// This replaces the hand-written HTML these flows used to serve. Every
// behaviour is kept — the same questions, the same validation, the same
// closure-only phrase — and only the rendering moved.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import { generateSeedPhrase, validateSeedPhrase } from '../crypto/keyManager';
import {
  createOrgPlan,
  localOnboardingPlan,
  PHRASE_SOURCE_LABELS,
} from '../core/onboardingPlan';
import type {
  CreateOrganizationData,
  LocalOnboardingData,
  LocalPassphraseUnlockData,
  UnlockTrigger,
} from './screens/contract';

/**
 * How many words a valid recovery phrase has.
 *
 * Mirrors `validateSeedPhrase`, which refuses anything but this count, and is
 * carried in the payload so no screen hardcodes 24 in its own copy.
 */
export const SEED_PHRASE_WORDS = 24;

/**
 * The CLI's floor for a local passphrase.
 *
 * A default, not the definition: `byocCommand` owns the number because its TTY
 * validator is the thing that refuses, and it hands the same value in. This
 * exists so a caller that forgets is still holding a floor rather than none.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * The warning blocks these screens render are the same arrays the TTY path
 * prints, and a payload is not a terminal: an escape would render as a literal
 * `[90m` in the browser.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

export interface OnboardingWebOptions {
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
  /** The warning block the CLI prints beside the phrase. Display only. */
  bodyLines?: string[];
  /** The CLI's own floor, so the page and the validator cannot disagree. */
  minPassphraseLength?: number;
}

// ---------------------------------------------------------------------------
// local-onboarding — capy byoc --web
// ---------------------------------------------------------------------------

/** Which question local-mode setup is standing on, given what it has answered. */
type LocalOnboardingView = 'choose-source' | 'phrase' | 'enter-phrase' | 'passphrase';

export interface LocalOnboardingState {
  source?: 'generate' | 'enter';
  /** The generated phrase, when this run generated one. NEVER returned. */
  phraseWords?: string[];
  phraseSettled?: boolean;
}

function localOnboardingView(s: LocalOnboardingState): LocalOnboardingView {
  if (s.source === undefined) return 'choose-source';
  if (!s.phraseSettled) return s.source === 'generate' ? 'phrase' : 'enter-phrase';
  return 'passphrase';
}

/**
 * How this step is answered without a browser: it is not.
 *
 * An empty `command` is the contract's way of saying a step refuses headlessly
 * rather than taking a recovery phrase or a passphrase off a command line,
 * where it would land in shell history, `ps` output and an agent's transcript.
 */
const NO_HEADLESS_SECRET: LocalOnboardingData['nonTty'] = {
  command: '',
  why: 'A recovery phrase and a passphrase are the two things this command must never read from argv or the environment: both would outlive the run in shell history and in whatever captured its output. This step needs a person.',
};

export function buildLocalOnboardingData(
  p: LocalOnboardingState & { bodyLines?: string[]; minPassphraseLength?: number },
  nonce: string,
): LocalOnboardingData {
  const view = localOnboardingView(p);
  return {
    nonce,
    view,
    stops: localOnboardingPlan({
      source: p.source,
      phraseSettled: p.phraseSettled,
    }),
    source: p.source,
    // Only ever on the display step, and only the words this process generated.
    // A restored phrase is never echoed back into a page.
    phraseWords: view === 'phrase' ? p.phraseWords : undefined,
    bodyLines: p.bodyLines?.map(stripAnsi),
    expectedWords: SEED_PHRASE_WORDS,
    minPassphraseLength: p.minPassphraseLength ?? MIN_PASSPHRASE_LENGTH,
    nonTty: NO_HEADLESS_SECRET,
  };
}

/**
 * Drive local-only onboarding in the browser: where the recovery phrase comes
 * from, the phrase itself, and a local passphrase — then `finalize`, which
 * derives and persists the wrapped master key, entirely inside this process.
 * Resolves true on success, false if the user cancelled or closed the page.
 *
 * The phrase is intentionally NOT part of the return value.
 */
export async function runLocalOnboardingWeb(
  finalize: (phrase: string, passphrase: string) => void,
  opts: OnboardingWebOptions = {},
): Promise<boolean> {
  // Closure-only state. `phrase` is never serialized into a result and only
  // ever reaches a payload as `phraseWords` on the one step that displays it.
  let phrase: string | null = null;
  const minLength = opts.minPassphraseLength ?? MIN_PASSPHRASE_LENGTH;
  const state: LocalOnboardingState = {};
  let nonce = '';

  const render = (): string =>
    renderScreen(
      'local-onboarding',
      buildLocalOnboardingData(
        { ...state, bodyLines: opts.bodyLines, minPassphraseLength: minLength },
        nonce,
      ),
    );

  const result = await runBrowserWizard(
    {
      title: 'Set up Capy — local mode',
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: opts.open ?? true,
      onListen: opts.onListen,
      timeoutMs: opts.timeoutMs,
      doneMessage: 'Local mode is ready — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: { ok: false } };

      const view = localOnboardingView(state);

      if (view === 'choose-source') {
        const source = payload.source;
        if (source !== 'generate' && source !== 'enter') {
          // The screen offers exactly two rows, so anything else is a
          // malformed submit rather than a user mistake.
          return { error: 'That is not a phrase source this step offers.' };
        }
        state.source = source;
        if (source === 'generate') {
          phrase = generateSeedPhrase();
          state.phraseWords = phrase.split(/\s+/).filter(Boolean);
        }
        return { screen: { html: render(), standalone: true } };
      }

      if (view === 'phrase') {
        // A generated phrase travels one way only. The display step sends back
        // consent and nothing else, so a payload carrying words did not come
        // from that step — and accepting it would be taking a master key off
        // the wire to key somebody's machine with.
        if ('phrase' in payload) {
          return { error: 'The recovery phrase is not something this step sends back.' };
        }
        if (payload.confirmed !== true) {
          return { error: 'Confirm you have written down the recovery phrase first.' };
        }
        state.phraseSettled = true;
        return { screen: { html: render(), standalone: true } };
      }

      if (view === 'enter-phrase') {
        const entered = typeof payload.phrase === 'string' ? payload.phrase.trim() : '';
        if (!validateSeedPhrase(entered)) {
          // Inline, NOT a fresh page: re-serving would wipe what the user
          // typed, and a phrase is 24 words to retype over one wrong one.
          return {
            error: `That is not a valid ${SEED_PHRASE_WORDS}-word recovery phrase. Check the words and try again.`,
          };
        }
        phrase = entered;
        state.phraseSettled = true;
        return { screen: { html: render(), standalone: true } };
      }

      // passphrase. Inline errors keep the two fields on screen; the checks are
      // the CLI's own, in the CLI's own order (length before match).
      const pass = typeof payload.passphrase === 'string' ? payload.passphrase : '';
      const confirm = typeof payload.confirm === 'string' ? payload.confirm : '';
      if (pass.length < minLength) {
        return { error: `Use at least ${minLength} characters.` };
      }
      if (pass !== confirm) return { error: 'Passphrases do not match.' };
      if (!phrase) {
        // Unreachable through the screens, and not survivable if it happens:
        // there is nothing to derive a key from.
        return { error: 'Lost the recovery phrase — please restart setup.' };
      }
      try {
        finalize(phrase, pass);
      } catch (err) {
        // Never "nothing was changed": finalize writes the wrapped key, the
        // profile and the session in sequence, so a failure part-way through
        // has changed something.
        const detail = err instanceof Error ? err.message : 'the key could not be written';
        return { error: `Could not set up local mode: ${detail}.` };
      }
      return { done: true, result: { ok: true } };
    },
  );

  return !!(result && typeof result === 'object' && (result as { ok?: boolean }).ok);
}

// ---------------------------------------------------------------------------
// create-organization — capy org --web → "Create new organization +"
// ---------------------------------------------------------------------------

/**
 * The availability verdict, as a code.
 *
 * `checkOrgName` answers a question and the CLI turns the answer into a
 * sentence; this carries the answer. `unreachable` is its own case because the
 * CLI swallows a failed check and treats the name as free, which is a decision
 * the page has to be able to describe rather than a silence.
 */
export type OrgNameVerdict = 'available' | 'taken' | 'unreachable';

export interface WebCreateOrgParams {
  /**
   * SECRET. The recovery phrase the organization's master key is derived from.
   * Rendered into this page and nowhere else; never returned from here.
   */
  phrase: string;
  /** The zero-trust warning block, verbatim from the CLI. Display only. */
  bodyLines: string[];
  learnMoreUrl?: string;
  /** Prefill for the field — a name a previous attempt already produced. */
  name?: string;
  /** A refusal the CLI made before this page was served. */
  nameError?: 'RACE_409';
  /**
   * The CLI's cap on an organization name. Required rather than defaulted: the
   * command owns the number, and a default here would be a second copy of it
   * free to drift from the validator that actually refuses.
   */
  maxNameLength: number;
  /** Server-side availability check. Returns a verdict, never a sentence. */
  checkName?: (name: string) => Promise<OrgNameVerdict>;
  /**
   * Ask for the name and stop there.
   *
   * The 409 retry: the phrase has already been shown and written down, and the
   * only thing the server refused was the name. Showing the grid a second time
   * would contradict the page's own "this is the only time it is shown", and
   * the terminal does not do it either — its retry loop re-prompts the name and
   * nothing else.
   */
  nameOnly?: boolean;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** What the browser decided. `cancelled` means no organization may be created. */
export interface WebCreateOrgResult {
  name: string;
  cancelled: boolean;
}

interface CreateOrgState {
  name: string;
  nameError?: CreateOrganizationData['nameError'];
}

/**
 * Why this step cannot be answered headlessly. Phrase-only, unlike local
 * setup: creating an organization never asks for a passphrase.
 */
const NO_HEADLESS_PHRASE: CreateOrganizationData['nonTty'] = {
  command: '',
  why: 'The recovery phrase is shown once and must be written down by the person who will need it. A run with nowhere to show it has nowhere to show it, so this step refuses rather than generating a master key nobody read.',
};

export function buildCreateOrganizationData(
  p: WebCreateOrgParams & { state?: Partial<CreateOrgState> },
  nonce: string,
): CreateOrganizationData {
  const name = (p.state?.name ?? p.name ?? '').trim();
  const nameError = p.state?.nameError ?? p.nameError;
  // Two views, not four. `creating` and `created` are the terminal's to report:
  // the organization is created after this window closes, so a page claiming
  // either would be claiming an outcome the CLI has not reached.
  const view = name && !nameError && !p.nameOnly ? 'phrase' : 'name';

  return {
    nonce,
    stops: createOrgPlan({
      name: view === 'name' ? undefined : name,
      // A name-only run is a retry: the phrase stop is behind it, and the rail
      // says so rather than promising a reveal that is not coming.
      confirmed: p.nameOnly === true,
    }),
    view,
    name,
    // Only ever the verdict that produced a refusal. `available` and
    // `unreachable` are checked on submit and acted on immediately, so no page
    // is ever served carrying them.
    nameStatus: nameError === 'TAKEN' ? 'taken' : undefined,
    nameError,
    maxNameLength: p.maxNameLength,
    // The words reach the page on the one step that displays them, and reach
    // nothing else, ever.
    phraseWords: view === 'phrase' ? p.phrase.split(/\s+/).filter(Boolean) : undefined,
    bodyLines: p.bodyLines.map(stripAnsi),
    learnMoreUrl: p.learnMoreUrl,
    nonTty: NO_HEADLESS_PHRASE,
  };
}

/**
 * Name a new organization and show the recovery phrase its master key comes
 * from, in one wizard.
 *
 * Replaces two separate loopback windows — a text prompt and a phrase display —
 * that shared no rail, so the user met a write-it-down step they had not been
 * told was coming, in a second page that looked like a different command.
 *
 * The phrase is a parameter rather than generated here because the CLI holds
 * one phrase across a 409 retry: the name is claimed while you are reading the
 * words, and the same words must key whatever name you pick next.
 */
export async function createOrganizationInBrowser(
  p: WebCreateOrgParams,
): Promise<WebCreateOrgResult> {
  const max = p.maxNameLength;
  const state: CreateOrgState = { name: (p.name ?? '').trim(), nameError: p.nameError };
  let nonce = '';

  const render = (): string =>
    renderScreen('create-organization', buildCreateOrganizationData({ ...p, state }, nonce));

  const out = await runBrowserWizard(
    {
      title: 'New organization',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Confirmed — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { name: '', cancelled: true } };
      }

      // The name step is where a run stands until a name has survived the
      // availability check; `nameError` puts it back there.
      const onName = !state.name || state.nameError !== undefined;

      if (onName) {
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        // The screen holds its button on both of these, so either arriving is
        // a submit the screen could not have produced.
        if (!name) return { error: 'Organization name cannot be empty' };
        if (name.length > max) {
          return { error: `Organization name must be ${max} characters or fewer` };
        }

        const verdict = p.checkName ? await p.checkName(name) : 'unreachable';
        if (verdict === 'taken') {
          // A real refusal rather than a malformed submit: the page could not
          // have known. It comes back as a fresh page carrying the name and
          // the code, which is what the field's own "already taken" copy is
          // built to render.
          state.name = name;
          state.nameError = 'TAKEN';
          return { screen: { html: render(), standalone: true } };
        }
        // `unreachable` proceeds, matching the CLI: `validateOrgName` swallows
        // a failed check and treats the name as free. The collision then
        // reappears as a 409, which is what `RACE_409` exists for.
        state.name = name;
        state.nameError = undefined;
        if (p.nameOnly) return { done: true, result: { name, cancelled: false } };
        return { screen: { html: render(), standalone: true } };
      }

      // The phrase step. See the header: consent travels, words do not.
      if ('phrase' in payload || 'phraseWords' in payload) {
        return { error: 'The recovery phrase is not something this step sends back.' };
      }
      if (payload.confirmed !== true) {
        return { error: 'Confirm you have written down the recovery phrase first.' };
      }
      return { done: true, result: { name: state.name, cancelled: false } };
    },
  );
  return out as WebCreateOrgResult;
}

// ---------------------------------------------------------------------------
// local-passphrase-unlock — the passphrase that opens the local key
// ---------------------------------------------------------------------------

/** What an unlock attempt did, as a shape rather than as an exception message. */
export type UnlockAttempt = { ok: true; masterKeyHex: string } | { ok: false };

export interface WebPassphraseUnlockParams {
  /** Which command is waiting on the passphrase. */
  triggeredBy?: UnlockTrigger;
  /** The literal command line, for `capy run -- <cmd>`. */
  triggerCommand?: string;
  projectName?: string;
  /** Whether the key was locked on purpose or by the idle clock. */
  lockedBy?: 'command' | 'idle';
  /** Idle auto-lock, in milliseconds. */
  idleTimeoutMs?: number;
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

export function buildPassphraseUnlockData(
  p: WebPassphraseUnlockParams,
  nonce: string,
): LocalPassphraseUnlockData {
  return {
    nonce,
    view: 'unlock',
    triggeredBy: p.triggeredBy,
    triggerCommand: p.triggerCommand,
    projectName: p.projectName,
    lockedBy: p.lockedBy,
    idleTimeoutMs: p.idleTimeoutMs,
    nonTty: {
      command: '',
      why: 'A passphrase read from argv or the environment defeats the lock it is protecting: it outlives the run in shell history and in whatever captured the invocation. This step needs a person.',
    },
  };
}

/**
 * Ask for the local passphrase in the browser and hand back the unwrapped
 * master key.
 *
 * `attempt` does the unwrapping inside this process and answers with a shape,
 * not an exception: `decryptLocalMasterKeyHex` throws the same
 * PERMISSION_DENIED for a wrong passphrase and for a keystore that does not
 * exist, so telling them apart here would mean reading its sentence.
 *
 * Resolves null when the user cancelled or closed the page. The passphrase
 * itself stays in this closure — only the key the caller asked for comes back,
 * which is exactly what `decryptLocalMasterKeyHex` already returns.
 */
export async function unlockPassphraseInBrowser(
  attempt: (passphrase: string) => UnlockAttempt,
  p: WebPassphraseUnlockParams = {},
): Promise<string | null> {
  const out = await runBrowserWizard(
    {
      title: 'Local passphrase',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Unlocked — back to your terminal.',
      renderFirst: (nonce) =>
        renderScreen('local-passphrase-unlock', buildPassphraseUnlockData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: { key: null } };

      const passphrase = typeof payload.passphrase === 'string' ? payload.passphrase : '';
      // The screen holds its button on an empty field, so this is a submit it
      // could not have produced — and deriving a wrapping key from "" is not a
      // guess worth making about somebody's keystore.
      if (passphrase === '') return { error: 'Enter your local passphrase.' };

      const result = attempt(passphrase);
      if (!result.ok) {
        // Inline, so the field comes back rather than the command dying. The
        // terminal path has no retry at all: a wrong passphrase is a typed
        // error and the command exits.
        return { error: 'Incorrect passphrase.' };
      }
      return { done: true, result: { key: result.masterKeyHex } };
    },
  );
  const key = (out as { key?: unknown }).key;
  return typeof key === 'string' ? key : null;
}
