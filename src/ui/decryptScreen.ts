// `capy decrypt --web`, served as the compiled `seed-phrase-decrypt` screen.
//
// The one prompt this command has is `Enter your 24-word seed phrase:` — an
// inquirer password field. It is the offline escape hatch: hold the phrase and
// this project's secrets open with no server, no session and nobody's
// permission.
//
// SECRET-BEARING ON BOTH ENDS, and they are different kinds of secret:
//
//   in   the phrase, typed into the page and posted once to the loopback
//        server. It is never in a payload, never in a URL, never echoed back,
//        and this module holds it for exactly as long as the attempt takes.
//   out  a real plaintext file on disk. The result payload carries a COUNT and
//        a FILENAME and nothing else — no variable names, no values. The CLI
//        is careful about this too, and the browser, which is screen-shared
//        far more often than a terminal is, has to be more so.
//
// Two things the terminal does silently and the browser says out loud. An
// unexpired `~/.capy/recover/session.json` makes this command prompt for
// nothing at all and reuse a cached master key; that is a station on the rail
// now, with a sentence before it happens. And `capy decrypt` has no
// `assertNotLocalOnly` gate, so in local mode the recovery phrase decrypts
// around the passphrase lock — the screen says so rather than repeating a
// promise the code does not keep.
import { runBrowserWizard, BrowserRefusal, type WebRefusal } from './browserWizard';
import { renderScreen } from './screens/serve';
import { decryptPlan } from '../core/decryptPlan';
import type { DecryptPhraseError, SeedPhraseDecryptData } from './screens/contract';

/** The phrase length the CLI expects. Carried in the payload; never assumed. */
export const SEED_PHRASE_WORDS = 24;

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * The CLI bolds the project name and the output path when it PRINTS them, and
 * a payload is not a terminal: an escape that renders as dim grey in a shell
 * renders as a literal `[90m` in a browser. Applied to every display string
 * this screen carries, at the one place they are assembled.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** How this run ended when it did not decrypt anything. */
export type DecryptRefusal = WebRefusal;

/**
 * How long the result page stays reachable when nobody comes for it.
 *
 * The page is served by a socket in THIS process, so the process has to stay
 * up for the browser to be able to load it — but only until it does. A run
 * where nothing opens it (a headless agent, `--no-open`, an `open()` that
 * silently failed) used to hold the terminal for the ScreenServer's full two
 * minutes AFTER the plaintext was written and the result already printed.
 */
export const RESULT_PAGE_GRACE_MS = 20_000;

export interface WebDecryptParams {
  projectName: string;
  branch: string;
  /** `.env.{branch}.decrypted` — what the plaintext lands in. */
  outputFile: string;
  /** An unexpired recovery session already holds this org's master key. */
  session?: { orgName: string; startedAt: string };
  /** This profile is local-only, so the passphrase lock is not consulted. */
  localOnly?: boolean;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * What the browser answered. `cancelled` means nothing was decrypted.
 *
 * `reason` says which refusal it was — the page's own Cancel, a closed window,
 * or a step nobody answered. All three write nothing; they read differently in
 * the terminal, and a run that ends by throwing "Timed out waiting for the
 * browser" reads as a decrypt that broke rather than one that never happened.
 */
export type WebDecryptResult =
  | { action: 'decrypted'; count: number; wrote: boolean }
  | { action: 'cancelled'; reason: DecryptRefusal };

/**
 * One attempt at opening this `.env`, run by the caller because the key
 * material is the command's business and not this transport's.
 *
 * The two failures are the CLI's own two: `INVALID` is the client-side test
 * (the word count, the wordlist, the checksum) and `KEY_MISMATCH` is the
 * answer after the trial — no KDF version decrypted anything. The terminal
 * distinguishes them and so does the screen, which is why the reason is an
 * enum rather than a sentence to match on.
 */
export type DecryptAttempt =
  | { ok: true; count: number; wrote: boolean }
  | { ok: false; reason: DecryptPhraseError };

export function buildDecryptData(
  p: WebDecryptParams,
  nonce: string,
  state: { view: SeedPhraseDecryptData['view']; phraseError?: DecryptPhraseError; result?: { count: number; wrote: boolean } } = {
    view: 'phrase',
  },
): SeedPhraseDecryptData {
  const usingSession = p.session !== undefined;
  const outputFile = stripAnsi(p.outputFile);
  const data: SeedPhraseDecryptData = {
    nonce,
    // A run with a live session is not asked for a phrase at all, so the view
    // it opens on is the CLI's fact rather than the caller's choice.
    view: state.view === 'phrase' && usingSession ? 'session' : state.view,
    stops: decryptPlan({
      wordCount: SEED_PHRASE_WORDS,
      outputFile,
      usingSession,
      finished: state.view === 'result',
    }),
    projectName: stripAnsi(p.projectName),
    branch: stripAnsi(p.branch),
    outputFile,
    wordCount: SEED_PHRASE_WORDS,
    nonTty: usingSession
      ? {
          command: 'capy decrypt',
          why: 'A recovery session on this machine already holds the key, so this run needs no phrase. Headlessly it writes the plaintext file straight away — the question above is what a browser adds.',
        }
      : {
          command: 'capy decrypt',
          why: 'A seed phrase can never come from a flag or an environment variable — argv lands in your shell history and in every process listing. This step refuses with exit 3 and asks for a terminal; today it blocks on a piped stdin and then prints "Cancelled." and exits 0, which reads as a decrypt that succeeded and wrote nothing.',
        },
  };

  if (p.session) {
    data.session = { orgName: stripAnsi(p.session.orgName), startedAt: stripAnsi(p.session.startedAt) };
  }
  if (p.localOnly) data.localOnly = true;
  if (state.phraseError) data.phraseError = state.phraseError;
  if (state.result) data.result = state.result;
  // The result view is COUNTS ONLY. Nothing else about the file crosses: the
  // whole point of the command is that the plaintext goes to a file, not to a
  // screen someone might be sharing.
  return data;
}

/**
 * Serve the phrase step and hand each answer to `attempt`.
 *
 * The phrase never reaches this module's return value, is never printed, and
 * is not held past the call that uses it. A wrong phrase is answered by
 * re-serving the step with `phraseError` — the payload has a field for exactly
 * that, and the screen renders the CLI's own sentence for it — rather than by
 * an inline message the user has to interpret while 24 boxes still hold the
 * words that did not work.
 */
export async function decryptInBrowser(
  p: WebDecryptParams,
  attempt: (input: { phrase: string } | { useSession: true }) => Promise<DecryptAttempt>,
): Promise<WebDecryptResult> {
  let nonce = '';
  const usingSession = p.session !== undefined;
  const render = (state: Parameters<typeof buildDecryptData>[2]): string =>
    renderScreen('seed-phrase-decrypt', buildDecryptData(p, nonce, state));

  let out: unknown;
  try {
    out = await runBrowserWizard(
    {
      title: `Decrypt secrets — ${p.projectName}/${p.branch}`,
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Decrypted — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render({ view: 'phrase' });
      },
      // Closing the tab decrypts nothing, and now says so instead of holding
      // the terminal for five minutes and throwing. A wrong phrase re-serves
      // this same step, which is a reload — the wizard waits out its grace
      // before believing a page that left, so retyping is not a refusal.
      closeIsRefusal: {
        result: { action: 'cancelled', reason: 'closed' } satisfies WebDecryptResult,
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { action: 'cancelled', reason: 'declined' } };
      }
      if (payload.__action !== 'submit') {
        return { error: 'That is not an action this screen offers.' };
      }

      let input: { phrase: string } | { useSession: true };
      if (usingSession) {
        // The session view sends one flag and nothing else. Anything else did
        // not come from it, and reusing a cached master key off the back of a
        // submit the screen could not have produced is not a thing to guess at.
        if (payload.useSession !== true) {
          return { error: 'That is not an answer the session step can produce.' };
        }
        input = { useSession: true };
      } else {
        const phrase = typeof payload.phrase === 'string' ? payload.phrase : null;
        // The screen checks all three conditions — the word count, the
        // wordlist and the checksum — before anything leaves the tab, and
        // holds its button on every one. A phrase that is not even a string
        // did not come from it.
        if (phrase === null) {
          return { error: 'That is not an answer the phrase step can produce.' };
        }
        input = { phrase };
      }

      const verdict = await attempt(input);
      if (!verdict.ok) {
        if (usingSession) {
          // Nothing to retype: the key came from a cached session, so asking
          // the step again would ask the same question and get the same
          // answer. The CLI's own sentence, refused inline.
          return {
            error:
              'Decryption failed. The recovery session on this machine does not open this project. Run capy end-recover and try again with the seed phrase for this org.',
          };
        }
        // Re-served rather than refused inline: the words are wrong, so
        // keeping them in the boxes would only invite the same submit again —
        // and `phraseError` exists so the screen can say WHICH of the CLI's
        // two refusals happened, in the CLI's own words.
        return { screen: { html: render({ view: 'phrase', phraseError: verdict.reason }), standalone: true } };
      }
      return {
        done: true,
        result: { action: 'decrypted', count: verdict.count, wrote: verdict.wrote },
      };
    },
    );
  } catch (err) {
    // A step nobody answered wrote nothing, which is what `cancelled` means.
    // A socket that would not bind is a fault and still throws.
    if (err instanceof BrowserRefusal && err.reason === 'timeout') {
      return { action: 'cancelled', reason: 'timeout' };
    }
    throw err;
  }
  return out as WebDecryptResult;
}

/**
 * Put the outcome in front of whoever asked for it.
 *
 * Its own page rather than the wizard's generic ending, because the one thing
 * on it that changes what the reader does next is "That file is plaintext" —
 * the CLI's own line is `Run capy end-recover when done to clean up`, which
 * reads as tidiness rather than as a live secret sitting in the directory.
 *
 * Served by `ScreenServer`, which is the display-only server: its policy gives
 * the page no `connect-src` at all, so a page rendering the aftermath of a
 * decrypt has no way to speak to anything, including us.
 */
export async function showDecryptResult(
  p: WebDecryptParams,
  result: { count: number; wrote: boolean },
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  // `serveEndingPage` is the one implementation of "serve the last page, print
  // where it is, and hold until the browser has it". This used to be a second
  // one — a hand-rolled `onServed` hook on `ScreenServer` plus a racing timer —
  // which is exactly the kind of parallel mechanism that drifts: the shared one
  // already waits on `delivered`, already prints before it opens, and already
  // pays the flush margin. The only thing decrypt needs of its own is the lead
  // line and a shorter ceiling than a general ending gets.
  const { serveEndingPage } = await import('./endingPage');
  const { url } = await serveEndingPage(
    'seed-phrase-decrypt',
    buildDecryptData(p, '', { view: 'result', result }),
    {
      open: p.open,
      onListen: p.onListen,
      timeoutMs: opts.timeoutMs ?? RESULT_PAGE_GRACE_MS,
      lead: 'The result, in your browser:',
    },
  );
  return url;
}
