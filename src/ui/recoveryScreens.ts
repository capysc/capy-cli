// The three recovery flows, served as compiled screens.
//
// `capy recover`, `capy end-recover` and `capy transport` all handle material
// equivalent to a recovery phrase, and each one moves it in a different
// direction. Getting that direction wrong is the whole risk in this file, so
// each section states its own:
//
//   recover-master-key   INBOUND. The 24 words are TYPED. They cross the
//                        loopback because the CLI has to check them — that is
//                        the opposite of onboarding, where a GENERATED phrase
//                        must never travel back. Nothing about them is
//                        rendered, echoed, logged or put in a payload: there
//                        is no field here for the phrase, for the master key,
//                        or for a fingerprint of either.
//   end-recover-cleanup  NEITHER. Every file it names IS plaintext secret
//                        material. The payload carries FILENAMES; a preview of
//                        what is inside them would undo the whole command.
//   transport-machine    OUTBOUND, one way. The redeem code is a bearer
//                        credential for the account. It is rendered into the
//                        page and nowhere else — never printed, never logged,
//                        and structurally unable to come back: the only thing
//                        this screen's reducer accepts is an action.
//
// Everything else follows `syncConflictScreen.ts`: build the payload in an
// exported `buildXData(params, nonce)` so a test can assert its shape without
// standing a server up, serve it with `standalone: true` because a compiled
// screen is a whole document, refuse a malformed submit inline rather than
// applying a guess, and carry the CLI's own wording verbatim.
import { runBrowserWizard, type WizardDecision } from './browserWizard';
import { renderScreen } from './screens/serve';
import { recoverPlan } from '../core/recoverPlan';
import type {
  DecryptedFile,
  EndRecoverCleanupData,
  OracleGap,
  RecoverMasterKeyData,
  RecoverOrg,
  RecoverPhraseError,
  RecoverView,
  TransportMachineData,
} from './screens/contract';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to strings the CLI also PRINTS — an organization name it bolds, a
 * humanised age it dims — because a payload is not a terminal and an escape
 * renders as a literal `[90m` in the browser.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// recover-master-key
// ---------------------------------------------------------------------------

/**
 * What the trial decryption said about a phrase the user typed.
 *
 * A code rather than prose, minted where the condition is first known. The
 * screen owns the wording — `capy recover` and `capy decrypt` say different
 * things about the same failure — and it already holds all three sentences
 * verbatim, so shipping the text would be shipping a second copy of it.
 */
export type PhraseVerdict =
  | { code: 'MATCH'; kdfVersion: 1 | 2 }
  | { code: 'EMPTY' }
  | { code: 'INVALID' }
  | { code: 'NO_MATCH' }
  | { code: 'NO_ORACLE'; gap: OracleGap };

/** Whether the wrapped key reached the disk, and where. */
export type WriteOutcome =
  | { ok: true; keyPath: string }
  | { ok: false; message: string };

/**
 * What the CLI does at each stop.
 *
 * Injected rather than imported so that no key derivation, no trial
 * decryption and no wrapping happens in this module. `--web` changes where a
 * question is drawn; the crypto stays in `recoverCommand`, running the same
 * code the terminal path runs. The phrase is handed to these and is not
 * retained here beyond the submit that carries it.
 */
export interface RecoverOps {
  /**
   * Re-scope the session to the chosen organization, so the KMS wrap call
   * lands on that org's endpoint. False is a refusal the user sees at the org
   * stop rather than a crash after the browser closed.
   */
  scopeToOrg(orgId: string): Promise<boolean>;
  /** Trial-decrypt one of the organization's own values with this phrase. */
  verifyPhrase(orgId: string, phrase: string): Promise<PhraseVerdict>;
  /**
   * Derive, wrap and save. `kdfVersion` is the one the trial proved; omitted
   * on the unverified fork, where the caller falls back to the current
   * version — the same fallback the terminal path takes.
   */
  writeKey(orgId: string, phrase: string, kdfVersion?: 1 | 2): Promise<WriteOutcome>;
}

/**
 * Everything the page needs, and nothing that could carry key material.
 *
 * Separate from `WebRecoverParams` so a test can assert the payload's shape
 * without supplying a working set of crypto operations.
 */
export interface RecoverScreenState {
  /** The CLI prints `Signed in as <email>.`; the page puts it in the header. */
  userEmail?: string;
  /** Every organization this session can reach. One is still a list. */
  orgs: RecoverOrg[];
  /** How many words this run expects. The CLI's number, never the page's. */
  wordCount: number;
  /** The organization chosen so far. Undefined means the org stop is open. */
  orgId?: string;
  /** The overwrite gate has been agreed to. */
  overwriteAgreed?: boolean;
  /**
   * Set when the trial decryption could not run, with the reason. The run
   * then stands at the write stop being asked to write anyway — a fork the
   * terminal takes silently, on the user's behalf.
   */
  oracleGap?: OracleGap;
  /** Why the previous phrase was refused. */
  phraseError?: RecoverPhraseError;
}

export interface WebRecoverParams extends RecoverScreenState {
  ops: RecoverOps;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** What the browser did. `cancelled` means nothing was written. */
export interface WebRecoverResult {
  orgId: string;
  orgName: string;
  /** Which version the trial proved. Null when nothing could check the phrase. */
  kdfVersion: 1 | 2 | null;
  keyPath: string | null;
  cancelled: boolean;
}

/**
 * Which stop this run is standing on.
 *
 * Derived from the answers rather than set by the caller, so the screen that
 * gets served and the rail drawn beside it cannot disagree about where the
 * traveller is. `done` never appears: the compiled screen's result view draws
 * no control, so serving it would leave the wizard waiting for a submit that
 * can never arrive. The outcome is printed to the terminal instead, exactly as
 * the terminal path prints it.
 */
export function recoverScreenView(s: RecoverScreenState): RecoverView {
  if (!s.orgId) return 'organization';
  const org = s.orgs.find((o) => o.id === s.orgId);
  if (org?.hasKeyOnThisDevice && !s.overwriteAgreed) return 'overwrite';
  if (s.oracleGap) return 'unverified';
  return 'phrase';
}

/**
 * How each stop is answered without a browser.
 *
 * Per view, because the answer differs by stop and one of them has no answer
 * at all. `capy recover` takes no flags today, so nothing here promises one:
 * the escape from every stop is a terminal, and for the phrase stop that is
 * not a limitation to be fixed later. A recovery phrase passed in argv is in
 * the shell history and in every process listing on the machine.
 */
function nonTtyEscape(view: RecoverView): RecoverMasterKeyData['nonTty'] {
  if (view === 'organization') {
    return {
      command: 'capy recover',
      why: 'Which organization the phrase belongs to is never inherited from this directory — silently taking keep.lock’s organization is the bug that wrapped the wrong master key for the wrong org — and there is no flag that answers it.',
    };
  }
  if (view === 'overwrite') {
    return {
      command: 'capy recover',
      why: 'Continuing overwrites the wrapped key this device already holds. If your current key still works you do not need to recover, so this is never assumed.',
    };
  }
  if (view === 'unverified') {
    return {
      command: 'capy recover',
      why: 'Nothing here could check the phrase, so writing the key means guessing the KDF version. For an organization created before version 2 that guess produces a key which decrypts nothing, which is why it is a decision rather than a fallback.',
    };
  }
  return {
    command: 'capy recover',
    why: 'A recovery phrase is typed, never passed: in argv it is in the shell history and in every process listing on the machine. There is no non-interactive form of this step and there should not be one.',
  };
}

export function buildRecoverData(s: RecoverScreenState, nonce: string): RecoverMasterKeyData {
  const view = recoverScreenView(s);

  // Stripped ONCE, at the edge, before anything downstream can hold a copy.
  // Doing it per-field is how the rail ended up as the one surface still
  // carrying escapes: `orgs[].name` and `orgName` were cleaned and the same
  // name went into `recoverPlan` raw, so the station that reads back your
  // answer rendered a literal `[1m` beside the clean one in the body.
  const userEmail = s.userEmail === undefined ? undefined : stripAnsi(s.userEmail);
  const orgs = s.orgs.map((o) => ({
    id: o.id,
    name: stripAnsi(o.name),
    hasKeyOnThisDevice: o.hasKeyOnThisDevice,
  }));
  const org = orgs.find((o) => o.id === s.orgId);

  return {
    nonce,
    view,
    // The route is the plan's array, not one this file assembles for the page.
    // `signedIn` is true because `recover` authenticates before it opens
    // anything: by the time a screen exists, that stop is history.
    stops: recoverPlan({
      signedIn: true,
      userEmail,
      orgName: org?.name,
      hasKeyOnThisDevice: org?.hasKeyOnThisDevice,
      overwriteAgreed: s.overwriteAgreed,
      // The only state that stands at the write stop with a page open.
      phraseEntered: s.oracleGap !== undefined,
      wordCount: s.wordCount,
    }),
    userEmail,
    orgs,
    orgName: org?.name,
    orgId: org?.id,
    wordCount: s.wordCount,
    phraseError: s.phraseError,
    oracleGap: s.oracleGap,
    nonTty: nonTtyEscape(view),
  };
}

/**
 * Serve `capy recover`'s questions and do the work between them.
 *
 * The verification has to happen inside this loop rather than after it: a
 * phrase that matches nothing must come back as the phrase stop again, and a
 * phrase nothing could check must come back as a decision. Collecting all the
 * answers first and verifying afterwards would turn both into an exit code
 * after the browser had already closed.
 */
export async function recoverInBrowser(p: WebRecoverParams): Promise<WebRecoverResult> {
  // The nonce is minted inside `runBrowserWizard` and reaches a caller only
  // through `renderFirst`. Later standalone steps are rendered with that same
  // token rather than each flow minting its own.
  let nonce = '';

  let state: RecoverScreenState = {
    userEmail: p.userEmail,
    orgs: p.orgs,
    wordCount: p.wordCount,
    orgId: p.orgId,
    overwriteAgreed: p.overwriteAgreed,
    oracleGap: p.oracleGap,
    phraseError: p.phraseError,
  };

  /**
   * The phrase this run is standing on.
   *
   * Held ONLY between a phrase submit that nothing could verify and the answer
   * to "write it anyway", because that fork is two round trips and the second
   * one carries no phrase. It is a local in this frame, it is never rendered,
   * never logged and never put in a payload, and it is cleared the moment the
   * key is written or the run ends.
   */
  let pending = '';

  const render = (): string => renderScreen('recover-master-key', buildRecoverData(state, nonce));
  const advance = (): WizardDecision => ({ screen: { html: render(), standalone: true } });

  const out = await runBrowserWizard(
    {
      title: 'Recover master key',
      flow: 'recover',
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Recovered — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        pending = '';
        return {
          done: true,
          result: { orgId: '', orgName: '', kdfVersion: null, keyPath: null, cancelled: true },
        };
      }

      const view = recoverScreenView(state);

      if (view === 'organization') {
        const id = typeof payload.organizationId === 'string' ? payload.organizationId : '';
        const org = p.orgs.find((o) => o.id === id);
        // The page offers only the organizations this session can reach, so
        // anything else did not come from it — and wrapping a phrase's master
        // key for an organization it was never issued for is precisely the
        // failure `recover` exists to undo.
        if (!org) return { error: 'That organization is not one this session can reach.' };
        if (!(await p.ops.scopeToOrg(org.id))) {
          // The CLI's own sentence for this, minus the terminal's bolding —
          // which is stripped rather than assumed absent, because this string
          // is rendered into a page and an escape shows up there as `[1m`.
          return {
            error: `Failed to scope session to ${stripAnsi(org.name)}. Run capy and select this org, then retry.`,
          };
        }
        state = { ...state, orgId: org.id };
        return advance();
      }

      if (view === 'overwrite') {
        // The screen sends `true` or holds its button. Anything else is a
        // malformed submit, and guessing would destroy the key this device
        // already holds.
        if (payload.overwrite !== true) {
          return { error: 'That is not an answer the overwrite step can produce.' };
        }
        state = { ...state, overwriteAgreed: true };
        return advance();
      }

      const orgId = state.orgId;
      if (!orgId) return { error: 'There is nothing left to answer on this run.' };

      const settle = (outcome: WriteOutcome, kdfVersion: 1 | 2 | null): WizardDecision => {
        // A write that failed leaves the run exactly where it was — including
        // the phrase, so pressing the button again is a retry rather than a
        // dead end. Nothing was written, which is what the message says.
        if (!outcome.ok) return { error: outcome.message };
        pending = '';
        return {
          done: true,
          result: {
            orgId,
            orgName: p.orgs.find((o) => o.id === orgId)?.name ?? '',
            kdfVersion,
            keyPath: outcome.keyPath,
            cancelled: false,
          },
        };
      };

      if (view === 'unverified') {
        if (payload.writeUnverified !== true) {
          return { error: 'That is not an answer this step can produce.' };
        }
        if (!pending) {
          // The phrase this stop was about is gone — a fresh server, or a
          // submit replayed against a run that already finished with it. Ask
          // for it again rather than write a key derived from nothing.
          state = { ...state, oracleGap: undefined, phraseError: 'EMPTY' };
          return advance();
        }
        return settle(await p.ops.writeKey(orgId, pending), null);
      }

      // The phrase stop. `.trim()` and no more: the phrase IS the PBKDF2
      // password, so collapsing runs of whitespace here would derive a
      // different master key than the terminal derives from the same words.
      const phrase = typeof payload.phrase === 'string' ? payload.phrase.trim() : '';
      const verdict = await p.ops.verifyPhrase(orgId, phrase);

      if (verdict.code === 'EMPTY' || verdict.code === 'INVALID' || verdict.code === 'NO_MATCH') {
        // Re-ask rather than refuse in place. The reload clears the word
        // boxes, which is what a rejected phrase should leave behind, and the
        // reason travels as a code so one failure is never worded two ways.
        state = { ...state, phraseError: verdict.code };
        return advance();
      }

      if (verdict.code === 'NO_ORACLE') {
        pending = phrase;
        state = { ...state, phraseError: undefined, oracleGap: verdict.gap };
        return advance();
      }

      return settle(await p.ops.writeKey(orgId, phrase, verdict.kdfVersion), verdict.kdfVersion);
    },
  );
  return out as WebRecoverResult;
}

// ---------------------------------------------------------------------------
// end-recover-cleanup
// ---------------------------------------------------------------------------

export interface WebEndRecoverParams {
  /**
   * The session this sweep is closing. REQUIRED, and that is the whole of the
   * guarantee: `capy end-recover` returns early with no session and removes
   * nothing, so a page served without one would let a click unlink files the
   * terminal form would never have touched — and every row on it arrives
   * ticked, which makes that the DEFAULT answer rather than an opt-in.
   *
   * `--web` moves where a question is drawn. It does not move what a command
   * deletes, and the shape of this parameter is what stops the next edit from
   * making it. The screen still renders a sessionless state (see
   * `EndRecoverCleanupData.session`); nothing in this CLI produces one.
   */
  session: { orgName: string; startedAt: string };
  /** The directory being swept. It is only ever this one. */
  cwd: string;
  /** Files matching `.env.*.decrypted` here. Names only — never contents. */
  files: DecryptedFile[];
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** What the browser agreed to. `cancelled` means nothing may be removed. */
export interface WebEndRecoverResult {
  endSession: boolean;
  /** Files to delete, in the order the page listed them. */
  remove: string[];
  cancelled: boolean;
}

export function buildEndRecoverData(p: WebEndRecoverParams, nonce: string): EndRecoverCleanupData {
  return {
    nonce,
    view: 'review',
    session: { orgName: stripAnsi(p.session.orgName), startedAt: stripAnsi(p.session.startedAt) },
    cwd: stripAnsi(p.cwd),
    // Names, ages and sizes. Every one of these files is readable plaintext
    // and not a byte of their contents belongs in a payload.
    files: p.files.map((f) => ({
      name: f.name,
      age: f.age === undefined ? undefined : stripAnsi(f.age),
      size: f.size === undefined ? undefined : stripAnsi(f.size),
    })),
    nonTty: {
      command: 'capy end-recover',
      why: 'The terminal form takes no input at all: it ends the session and deletes every .env.*.decrypted file in this directory, with no preview and no confirmation. Choosing which to keep is what the browser adds.',
    },
  };
}

/**
 * Serve the sweep preview and wait for a decision.
 *
 * The submitted list is resolved against the files this run actually found,
 * never trusted: the answer to this page is a set of unlink calls.
 */
export async function endRecoverInBrowser(p: WebEndRecoverParams): Promise<WebEndRecoverResult> {
  // Nothing is served without a session — refused BEFORE the socket exists,
  // so there is no page for a browser to reach and no window to tick. The
  // type says the same thing; this is the check a JavaScript caller gets, and
  // it is here rather than only in the command because this is the function
  // that opens the port.
  if (!p.session) {
    throw new Error(
      'end-recover has no session to close, so there is nothing to serve: `capy end-recover` removes nothing in this state.',
    );
  }

  const out = await runBrowserWizard(
    {
      title: 'End recovery session',
      flow: 'end-recover',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Swept — back to your terminal.',
      renderFirst: (nonce) => renderScreen('end-recover-cleanup', buildEndRecoverData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { endSession: false, remove: [], cancelled: true } };
      }

      // Whether the session is cleared is this run's fact, not the page's
      // answer: the screen computes the flag from the payload it was served,
      // and this page is only ever served with a session, so anything but
      // `true` means the submit did not come from that screen. Checked rather
      // than obeyed — the value used below is the CLI's.
      if (payload.endSession !== true) {
        return { error: 'That is not an answer this step can produce.' };
      }

      const raw = payload.remove;
      if (!Array.isArray(raw)) return { error: 'That is not an answer this step can produce.' };
      const offered = new Set(p.files.map((f) => f.name));
      if (!raw.every((n) => typeof n === 'string' && offered.has(n))) {
        return { error: 'That is not a file this sweep offered.' };
      }

      // Rebuilt from the CLI's own list so the order is the one the page
      // showed and a duplicate cannot turn into a second unlink.
      const remove = p.files.map((f) => f.name).filter((n) => raw.includes(n));
      return { done: true, result: { endSession: true, remove, cancelled: false } };
    },
  );
  return out as WebEndRecoverResult;
}

// ---------------------------------------------------------------------------
// transport-machine
// ---------------------------------------------------------------------------

export interface WebTransportParams {
  /** The organization the key belongs to. */
  orgName: string;
  /** The address the inner key is bound to. Only this identity can redeem. */
  boundEmail: string;
  /** When the code stops working. */
  expiresAtIso: string;
  /**
   * SECRET. `capy redeem <code>` — the whole command for the other machine.
   * It goes into the page and nowhere else: not to stdout, not to a log, not
   * into a URL, and it cannot come back (see the reducer).
   */
  redeemCommand: string;
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
  /** Test hook only: fixes `now` so the expiry row is deterministic. */
  now?: Date;
}

/** What the browser said. `acknowledged` is false when the user cancelled. */
export interface WebTransportResult {
  acknowledged: boolean;
}

/**
 * A bare duration — "28 minutes", "7 days".
 *
 * The screen writes "in {x}" and "{x} from now" around it, so it must not
 * carry its own preposition. Display only: the state that decides colour is
 * `expiryState`, which is computed here rather than read back out of this
 * string.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  return unit(Math.floor(hours / 24), 'day');
}

/** Under an hour left is worth reading before you carry on. */
const SOON_MS = 60 * 60 * 1000;

export function buildTransportData(p: WebTransportParams, nonce: string): TransportMachineData {
  const now = (p.now ?? new Date()).getTime();
  const expiresAt = new Date(p.expiresAtIso).getTime();
  const remaining = Number.isNaN(expiresAt) ? NaN : expiresAt - now;

  const expiryState: TransportMachineData['expiryState'] = Number.isNaN(remaining)
    ? 'ok'
    : remaining <= 0
      ? 'expired'
      : remaining < SOON_MS
        ? 'soon'
        : 'ok';

  return {
    nonce,
    orgName: stripAnsi(p.orgName),
    boundEmail: stripAnsi(p.boundEmail),
    expiresAtIso: p.expiresAtIso,
    expiresIn: Number.isNaN(remaining) || remaining <= 0 ? undefined : formatDuration(remaining),
    expiryState,
    redeemCommand: p.redeemCommand,
    view: 'code',
    nonTty: {
      command: 'capy transport',
      why: 'There is no non-browser form of this step. The code is a wrapped copy of your encryption key, and the terminal form prints it to stdout — where anything reading this terminal, an AI assistant included, captures a credential that moves the whole account.',
    },
  };
}

/**
 * Show the transport code and wait for the user to close it out.
 *
 * The only thing this reducer accepts is an action. A payload carrying
 * anything else is refused before it is looked at, which is what makes it
 * structurally impossible for the code on the page to travel back over the
 * loopback — the one direction it must never move.
 */
export async function showTransportInBrowser(p: WebTransportParams): Promise<WebTransportResult> {
  const out = await runBrowserWizard(
    {
      title: 'Move to another machine',
      flow: 'transport',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Done — back to your terminal.',
      renderFirst: (nonce) => renderScreen('transport-machine', buildTransportData(p, nonce)),
    },
    async (_step, payload) => {
      const keys = Object.keys(payload);
      if (keys.length !== 1 || keys[0] !== '__action') {
        return { error: 'This page answers with an action and nothing else.' };
      }
      // `done` is the screen's "Close this out"; `cancel` is its quiet exit.
      // Neither changes what was minted — the code exists either way, and the
      // page says so — so both end the run rather than one of them retrying.
      if (payload.__action === 'done') return { done: true, result: { acknowledged: true } };
      if (payload.__action === 'cancel') return { done: true, result: { acknowledged: false } };
      return { error: 'That is not an action this screen offers.' };
    },
  );
  return out as WebTransportResult;
}
