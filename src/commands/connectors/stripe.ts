import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConnectorModule, ConnectResult, RotateResult, ConnectOpts, RotateOpts } from './registry';
import { ConnectorMetadata } from '../../types/index';
import { ResolvedContext, fingerprint, findManagedConnector, keyTypePrefix } from './shared';
import { formatRelativeTime } from '../../ui/relativeTime';
import { isInteractive, refuseNonInteractive } from '../../ui/interactive';
import { connectPlan, type ConnectPlanInput } from './plans';
import type {
  Blocked,
  ConnectIncomingKey,
  ConnectModeOption,
  ConnectVarSlot,
  ConnectVarState,
  StripeAccount,
} from '../../ui/screens/contract';
import type { ConnectQuestion, WebConnectSetupParams } from '../../ui/connectScreens';

type StripeMode = 'test' | 'live';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const DEFAULT_VAR = 'STRIPE_SECRET_KEY';

// Name patterns we associate with stripe. Value-based matching isn't worth it
// — encrypted vars round-trip through capy: blobs, and the name alone is
// usually a strong enough signal in practice.
const STRIPE_NAME_RE = /STRIPE|RESTRICTED_KEY/i;

export function looksStripey(name: string): boolean {
  return STRIPE_NAME_RE.test(name);
}

/**
 * Partition a list of env var names into stripe-pattern matches and the rest.
 * Input order is preserved within each bucket (caller is expected to sort
 * upstream if they want alphabetical ordering).
 */
export function rankStripeVars(names: string[]): { matches: string[]; others: string[] } {
  const matches: string[] = [];
  const others: string[] = [];
  for (const n of names) {
    if (looksStripey(n)) matches.push(n);
    else others.push(n);
  }
  return { matches, others };
}

export function validateVarName(name: string): string | true {
  const trimmed = name.trim();
  if (!trimmed) return 'Variable name cannot be empty';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
    return 'Must be UPPER_SNAKE_CASE (letters, digits, underscore).';
  }
  return true;
}

export interface StripeConfigSection {
  name: string; // e.g. "default" or a --project-name
  display_name?: string;
  account_id?: string;
  test_mode_api_key?: string;
  live_mode_api_key?: string;
  test_mode_key_expires_at?: number;
  live_mode_key_expires_at?: number;
}

/** Path to ~/.config/stripe/config.toml (XDG_CONFIG_HOME respected). */
function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'stripe', 'config.toml');
}

/**
 * Tiny TOML reader for the shape Stripe writes — flat scalar fields under
 * `[<section>]` headers. Values are either bare numbers, booleans, or
 * double-quoted strings. Comments (`#`) and blank lines are skipped.
 *
 * Not a general TOML parser; deliberately narrow to avoid pulling a dep.
 */
export function parseStripeConfig(raw: string): StripeConfigSection[] {
  const sections: Map<string, StripeConfigSection> = new Map();
  let current = 'default';
  sections.set(current, { name: current });

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      let name = header[1].trim();
      // TOML quotes section names containing spaces/specials (e.g.
      // `["Acornpack Prod"]`). Strip one layer of matching outer quotes so
      // downstream `stripe login --project-name=` gets the canonical name,
      // not a literal-quoted variant that confuses stripe's section matching.
      if (
        (name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith("'") && name.endsWith("'"))
      ) {
        name = name.slice(1, -1);
      }
      current = name;
      if (!sections.has(current)) sections.set(current, { name: current });
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim().replace(/\s*#.*$/, '').trim();
    const section = sections.get(current)!;
    // Stripe CLI writes single-quoted strings; standard TOML uses double.
    // Accept both. Also accept ISO date strings on the *_expires_at fields
    // (Stripe stores them as 'YYYY-MM-DD' rather than unix seconds) and
    // convert to unix seconds so downstream code can compare uniformly.
    const isQuoted =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"));
    if (isQuoted) {
      const inner = val.slice(1, -1);
      if (key.endsWith('_expires_at') && /^\d{4}-\d{2}-\d{2}/.test(inner)) {
        const parsed = Date.parse(inner);
        if (!Number.isNaN(parsed)) {
          (section as any)[key] = Math.floor(parsed / 1000);
          continue;
        }
      }
      (section as any)[key] = inner;
    } else if (/^-?\d+$/.test(val)) {
      (section as any)[key] = parseInt(val, 10);
    } else if (val === 'true' || val === 'false') {
      (section as any)[key] = val === 'true';
    }
  }
  return Array.from(sections.values()).filter((s) => s.test_mode_api_key || s.live_mode_api_key || s.account_id);
}

function readStripeConfig(): StripeConfigSection[] {
  const path = configPath();
  if (!existsSync(path)) return [];
  return parseStripeConfig(readFileSync(path, 'utf-8'));
}

/**
 * The refusal a missing Stripe CLI produces.
 *
 * Declared once because the same condition is met twice: as a preview beside
 * the connector in the picker, and as the wall `capy connect stripe` runs into.
 * Two screens colouring and wording one condition differently is a bug in the
 * product, and the only structural fix is for both to render this object.
 */
export const STRIPE_CLI_MISSING: Blocked = {
  code: 'PROVIDER_CLI_MISSING',
  title: 'stripe CLI not found.',
  detail:
    'Capy reads the key the Stripe CLI already holds, so the CLI has to be on your PATH before this connector can run.',
  link: { label: 'Install the Stripe CLI', url: 'https://docs.stripe.com/stripe-cli#install' },
  remedy: 'brew install stripe/stripe-cli/stripe',
};

/** Is `stripe` on the PATH? The non-exiting half of `ensureStripeCliInstalled`. */
function stripeCliInstalled(): boolean {
  try {
    execSync('stripe --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function ensureStripeCliInstalled(): void {
  if (stripeCliInstalled()) return;
  console.error(`\n  ${B('stripe')} CLI not found.`);
  console.error(`  Install: ${STRIPE_CLI_MISSING.link!.url}`);
  console.error(`  Or: ${B(STRIPE_CLI_MISSING.remedy!)}\n`);
  process.exit(1);
}

/**
 * WHY SIGNING IN IS TWO CALLS AND NOT ONE.
 *
 * `stripe login` behaves differently depending on whether ITS stdin is a
 * terminal, and the difference is not cosmetic. With a TTY it prints a pairing
 * code, opens the browser and BLOCKS until the pairing is approved. Without one
 * it switches to `--non-interactive`: it prints a JSON object — `browser_url`,
 * `verification_code`, `next_step` — and EXITS 0 IMMEDIATELY, having signed
 * nobody in. Completing the pairing is the caller's job, via the `next_step`
 * command, which is what actually polls and writes the credential.
 *
 * Every run capy makes on behalf of an agent has a piped stdin, so every one of
 * them took the second path while the code was written for the first (CAP-365).
 * Two things went wrong at once. The JSON went to whatever was reading our
 * stdout — on the MCP transport that is the tool-result channel, so the pairing
 * URL and code were delivered to the AI agent instead of to the person who has
 * to approve them — and the pairing was then never completed, because nothing
 * ran `next_step`. The run died on a config that was never written.
 *
 * So: `startStripePairing` does step one with stdout PIPED (the JSON is ours to
 * render, never to leak), a surface of the caller's choosing shows the code to
 * the user, and `completeStripePairing` does step two and blocks.
 */
export interface StripePairing {
  /** The page the user approves on. Opened for them; never fetched by capy. */
  browserUrl: string;
  /**
   * The four words the user compares against the ones Stripe shows them.
   *
   * Not a credential and not sufficient to be one — it proves that the tab
   * being approved is the pairing this process started, which is the whole
   * reason to show it rather than just say "approve it".
   */
  verificationCode: string;
  /** What `--complete` polls until the approval lands. */
  pollUrl: string;
}

/**
 * How a sign-in ended, as a code rather than a sentence.
 *
 * Four outcomes and the caller has to tell them apart, because three of them
 * send the reader somewhere different: an unapproved pairing is a person who
 * walked away, an unsupported CLI is a `brew upgrade`, and a config that came
 * back unusable after a pairing that DID complete is the only one of the three
 * worth looking at config parsing for. The old code printed the third message
 * for all of them.
 */
export type StripeLoginOutcome =
  | { ok: true }
  /** The hand-off ran and nobody approved it. A wall: the run could not go on. */
  | { ok: false; reason: 'pairing-not-completed' }
  /**
   * Somebody said no — Cancel, or the window closed on the pairing screen.
   *
   * Apart from the others because it is not a failure. Nothing was written and
   * that was the intention, so it ends the run at 0; reporting a decision as a
   * fault is how a caller learns the wrong thing from a run that did nothing.
   */
  | { ok: false; reason: 'declined' }
  /** This `stripe` binary has no two-step non-interactive flow. */
  | { ok: false; reason: 'pairing-unsupported' }
  /** `stripe login` itself exited non-zero. Only reachable on the TTY path. */
  | { ok: false; reason: 'login-failed' };

/**
 * How long `--complete` may block before we stop waiting.
 *
 * The TTY path has never had a bound and keeps not having one — someone is
 * sitting there and can Ctrl+C. The non-TTY path is a tool call inside an agent
 * turn, and a tool call that never returns is worse than one that fails, so it
 * gets the same five minutes every other browser step in this CLI gets.
 */
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Pull the poll URL out of `next_step` and prove it is one.
 *
 * `next_step` is the only place the poll URL appears — the JSON has no
 * `poll_url` field — so there is no way to avoid reading it out of a string.
 * What we can avoid is TRUSTING it. Nothing here runs the string as a command,
 * which is what `next_step` literally is and which would make a shell out of a
 * value; the URL is lifted out and then accepted only if it parses, is https,
 * and sits on the same origin as `browser_url`. Both fields came out of one
 * object, and a `next_step` pointing somewhere `browser_url` does not is not
 * the next step of this pairing.
 */
function pollUrlFrom(nextStep: string, browserOrigin: string): string | null {
  const candidate = nextStep.match(/https:\/\/[^\s'"]+/)?.[0];
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.origin !== browserOrigin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * `stripe login --non-interactive`'s stdout, as the three things we act on.
 *
 * Exported for the unit tests: this is a wire format owned by another binary,
 * so the thing worth pinning is that a change in its shape fails CLOSED — null,
 * which the caller reports as "this CLI cannot do the hand-off" — rather than
 * half-parsing into a pairing that sends the user to nowhere.
 */
export function parseStripePairing(stdout: string): StripePairing | null {
  // Sliced to the outermost braces rather than parsed whole, so a future
  // version that prefixes a banner line does not turn into a hard refusal.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const browserUrl = typeof o.browser_url === 'string' ? o.browser_url : '';
  const nextStep = typeof o.next_step === 'string' ? o.next_step : '';
  const verificationCode = typeof o.verification_code === 'string' ? o.verification_code : '';
  if (!browserUrl || !nextStep) return null;
  let browserOrigin: string;
  try {
    const parsed = new URL(browserUrl);
    if (parsed.protocol !== 'https:') return null;
    browserOrigin = parsed.origin;
  } catch {
    return null;
  }
  const pollUrl = pollUrlFrom(nextStep, browserOrigin);
  if (!pollUrl) return null;
  return { browserUrl, verificationCode, pollUrl };
}

/** `-p` for every call in a pairing, so both halves land in the same section. */
function projectArgs(projectName?: string): string[] {
  return projectName && projectName !== 'default' ? [`--project-name=${projectName}`] : [];
}

/**
 * Step one: ask Stripe for a pairing, and hand it back rather than print it.
 *
 * `stdio[1]` is a PIPE and that is the fix. It was `inherit`, which on the MCP
 * transport meant the pairing URL and code went straight to the AI agent — the
 * one party in the room who must not be the one approving a credential pairing.
 * stderr stays inherited: it carries stripe's own diagnostics, which are for
 * whoever is reading the terminal.
 */
function startStripePairing(projectName?: string): StripePairing | null {
  const result = spawnSync(
    'stripe',
    ['login', '--non-interactive', ...projectArgs(projectName)],
    // `input: ''` closes stdin immediately. Belt and braces with the explicit
    // flag: the CLI picks this mode off a non-TTY stdin anyway, and a binary
    // old enough not to know the flag exits non-zero rather than blocking.
    { input: '', stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf-8' },
  );
  if (result.status !== 0) return null;
  return parseStripePairing(result.stdout ?? '');
}

/**
 * Step two: block until the person approves, then let stripe write its config.
 *
 * stdout is piped for the same reason as step one — the success banner is
 * stripe talking to a terminal, and under MCP there isn't one — and the verdict
 * is the exit code, never the banner.
 */
function completeStripePairing(pairing: StripePairing, projectName?: string): boolean {
  const result = spawnSync(
    'stripe',
    ['login', '--complete', pairing.pollUrl, ...projectArgs(projectName)],
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: PAIRING_TIMEOUT_MS },
  );
  return result.status === 0;
}

/**
 * Sign in to Stripe, on whichever of the three surfaces this run actually has.
 *
 * `handoff` is the browser one and it owns the whole middle of the flow: it is
 * given the pairing to render and the thunk that blocks, because the only place
 * a loopback wizard may block is inside its own reducer. Without one — a script,
 * a CI job, a piped run with no `--web` — the pairing is announced on the
 * terminal and completed inline.
 *
 * A REAL TTY IS UNTOUCHED. `stripe login` with an inherited terminal does all of
 * this itself, better, and has always worked; the two-step exists precisely
 * because that is the path a non-TTY caller never gets.
 */
async function runStripeLogin(args: {
  projectName?: string;
  nonTty?: boolean;
  /**
   * This run's stdout is a relay to an AI agent rather than a terminal someone
   * is reading — which is what `--web` means, and the whole reason it exists.
   *
   * It gates ONE line: the pairing URL, which carries the session token in its
   * query string. The verification code goes out either way, because it is a
   * string to compare against the one Stripe shows and is worth nothing without
   * the URL. A caller that sets this and supplies no `handoff` is trading a
   * fallback for a leak, and that is the right trade — see `rotate`.
   */
  web?: boolean;
  handoff?: (
    pairing: StripePairing,
    complete: () => boolean,
  ) => Promise<'paired' | 'declined' | 'not-approved'>;
}): Promise<StripeLoginOutcome> {
  const { projectName, nonTty, web, handoff } = args;

  if (!handoff && isInteractive(nonTty)) {
    const result = spawnSync('stripe', ['login', ...projectArgs(projectName)], { stdio: 'inherit' });
    return result.status === 0 ? { ok: true } : { ok: false, reason: 'login-failed' };
  }

  const pairing = startStripePairing(projectName);
  if (!pairing) return { ok: false, reason: 'pairing-unsupported' };

  const complete = (): boolean => completeStripePairing(pairing, projectName);

  if (handoff) {
    // NOTHING ABOUT THE PAIRING IS PRINTED HERE. The browser surface shows the
    // code on a page only the user can see, and `browser_url` carries the
    // pairing token in its query string — putting it on stdout would hand the
    // agent the very thing this branch exists to keep from it.
    const ending = await handoff(pairing, complete);
    if (ending === 'paired') return { ok: true };
    return { ok: false, reason: ending === 'declined' ? 'declined' : 'pairing-not-completed' };
  }

  // writeSync (not console.log) so this flushes before the blocking
  // `--complete` spawnSync — otherwise a backgrounded run buffers it and it
  // appears only after auth completes, out of order with the pairing code.
  writeSync(
    1,
    `\n  ${B('Approve this pairing in your browser.')} Check that Stripe shows you the\n` +
      '  same code, then approve. Waiting for you to authenticate…\n\n' +
      `    Code: ${B(pairing.verificationCode)}\n` +
      // THE URL IS WITHHELD ON A RELAYED STDOUT. It carries the pairing token,
      // and the reader there is the agent. Losing the fallback costs a browser
      // that failed to open; printing it costs the thing being paired.
      (web
        ? '    A Stripe tab should have opened. If it did not, run `stripe login`\n' +
          '    in a terminal and then re-run this command.\n\n'
        : `    Open: ${pairing.browserUrl}\n\n`),
  );
  // Best effort. A hand-off wants the whole browser — an address bar, a profile
  // picker — so it is never the chromeless dialog a loopback screen gets.
  const { openScreen } = await import('../../ui/openScreen');
  await openScreen(pairing.browserUrl, { kind: 'handoff' });

  return complete() ? { ok: true } : { ok: false, reason: 'pairing-not-completed' };
}

/**
 * Best-effort `stripe logout -p <project>`. Returns whether the call succeeded
 * — failure isn't fatal, but matters because the caller needs to know whether
 * the local pairing is still intact (so the post-login error message can be
 * accurate). stdio is suppressed because logout is chatty and the caller is
 * about to print its own status anyway.
 */
function runStripeLogout(projectName?: string): boolean {
  const args = ['logout'];
  if (projectName && projectName !== 'default') args.push(`--project-name=${projectName}`);
  const result = spawnSync('stripe', args, { stdio: 'pipe' });
  return result.status === 0;
}

/**
 * Strip quote and backslash characters from a section name before re-feeding it
 * to `stripe login --project-name=`.
 *
 * Why: stripe writes section headers in TOML, which escapes any quotes in the
 * name (`["my proj"]` for a name containing a double-quote). If we read that
 * section's parsed name back out and pass it as `--project-name=` to the next
 * login, the name now contains literal quote chars — stripe writes a NEW
 * section with those quotes in the name (further escaped). Each rotation
 * stacks another layer, producing dozens of duplicate sections for the same
 * account_id. Normalizing to alphanumerics + spaces + dashes/underscores
 * breaks the cycle.
 */
export function normalizeProjectName(name: string): string {
  return name.replace(/[\\'"]/g, '').trim();
}

async function pickAccount(
  sections: StripeConfigSection[],
  requested?: string,
  nonTty?: boolean,
): Promise<StripeConfigSection> {
  if (requested) {
    const match = sections.find(
      (s) => s.account_id === requested || s.name === requested || s.display_name === requested,
    );
    if (!match) {
      console.error(`\n  No Stripe account matching "${requested}" in config.toml.`);
      process.exit(1);
    }
    return match;
  }
  if (sections.length === 1) return sections[0];

  if (!isInteractive(nonTty)) {
    refuseNonInteractive(
      `${sections.length} Stripe accounts in config.toml; can't pick one without a prompt`,
      `Pass --account <id> (one of: ${sections.map((s) => s.account_id ?? s.name).join(', ')}).`,
    );
  }

  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([{
    type: 'list',
    name: 'picked',
    message: 'Stripe account:',
    choices: sections.map((s) => ({
      name: `${s.display_name ?? s.name} (${s.account_id ?? 'no account_id'})`,
      value: s.name,
    })),
  }]);
  return sections.find((s) => s.name === picked)!;
}

async function pickMode(forceLive: boolean, nonTty?: boolean): Promise<StripeMode> {
  if (forceLive) return 'live';
  // Non-interactive: default to the safe mode. Live is only ever reached via an
  // explicit --live (forceLive above), never by defaulting.
  if (!isInteractive(nonTty)) return 'test';
  const inquirer = (await import('inquirer')).default;
  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: 'Mode:',
    choices: [
      { name: 'Test', value: 'test' },
      { name: 'Live', value: 'live' },
    ],
    default: 'test',
  }]);
  return mode;
}

// ---------------------------------------------------------------------------
// What the browser screens are told
//
// Every describer below is a pure read of state the command already has:
// keep.lock, the decrypted .env in `ctx.localPlaintext`, and Stripe's own
// config.toml. NONE of them puts a key value in a payload — the two that touch
// one reduce it to `fingerprint()`'s `abc…xyz` form or to `slice(0, 8)`, which
// is the same rule the terminal's tables already follow.
// ---------------------------------------------------------------------------

/** Days until `expiresAt`, negative once past. Undefined when nothing is recorded. */
function daysUntil(expiresAt: number | undefined): number | undefined {
  if (typeof expiresAt !== 'number') return undefined;
  return Math.floor((expiresAt - Date.now() / 1000) / 86400);
}

/**
 * `abc…xyz` of a value, or nothing at all when the value is too short to
 * redact.
 *
 * `fingerprint()` returns anything seven characters or shorter VERBATIM, which
 * is right for a terminal the user is already looking at and wrong for a
 * payload: a short value in `.env` would travel whole. The screen renders an
 * absent fingerprint as "not recorded", which is the honest reading.
 */
function safeSnippet(value: string): string | undefined {
  return value.length > 7 ? fingerprint(value) : undefined;
}

/** The section a run would use, without exiting when there isn't one. */
function resolveSection(
  sections: StripeConfigSection[],
  requested?: string,
): StripeConfigSection | undefined {
  if (requested) {
    return sections.find(
      (s) => s.account_id === requested || s.name === requested || s.display_name === requested,
    );
  }
  return sections.length === 1 ? sections[0] : undefined;
}

/** The key a section holds for a mode, without exiting when it holds none. */
function keyForMode(
  section: StripeConfigSection,
  mode: StripeMode,
): { value: string; expiresAt?: number } | undefined {
  const value = mode === 'live' ? section.live_mode_api_key : section.test_mode_api_key;
  if (!value) return undefined;
  return {
    value,
    expiresAt: mode === 'live' ? section.live_mode_key_expires_at : section.test_mode_key_expires_at,
  };
}

/**
 * The sections that can actually serve `mode` right now.
 *
 * "Signed in" used to mean `sections.length > 0` — does config.toml have any
 * section at all. That is not the same question, and the gap is the whole
 * reason `connect` can decline to re-authenticate when it should not:
 *
 *  - `parseStripeConfig` keeps a section that has only an `account_id` and no
 *    key of either kind, so a config holding nothing usable still read as a
 *    live session. The run then died further down in `readKeyFromSection`,
 *    telling the user to run `stripe login` — the exact thing the command had
 *    just decided not to do for them.
 *  - A section whose key for this mode has EXPIRED read as signed in too.
 *    A pairing that no longer works is not a pairing.
 *
 * An absent expiry counts as usable: Stripe does not always record one, and
 * refusing a key because we cannot see a date would be inventing a problem.
 */
export function usableFor(sections: StripeConfigSection[], mode: StripeMode): StripeConfigSection[] {
  return sections.filter((s) => {
    const key = keyForMode(s, mode);
    if (!key) return false;
    const days = daysUntil(key.expiresAt);
    return days === undefined || days >= 0;
  });
}

/** config.toml's sections, as the account picker's rows. */
export function toStripeAccounts(sections: StripeConfigSection[]): StripeAccount[] {
  return sections.map((s) => ({
    id: s.name,
    ...(s.display_name ? { displayName: s.display_name } : {}),
    ...(s.account_id ? { accountId: s.account_id } : {}),
    hasTestKey: Boolean(s.test_mode_api_key),
    hasLiveKey: Boolean(s.live_mode_api_key),
  }));
}

/**
 * The two modes, and whether this machine can actually serve each of them.
 *
 * The terminal offers `Test` and `Live` unconditionally and finds out
 * afterwards, in `readKeyFromSection`, that there is no key of that mode — an
 * exit, one question too late. Availability is known here, from the same
 * config the key is read out of.
 */
export function stripeModeOptions(
  sections: StripeConfigSection[],
  requested: string | undefined,
  devMode: boolean,
): ConnectModeOption[] {
  const section = resolveSection(sections, requested);
  return (['test', 'live'] as const).map((id) => {
    if (id === 'live' && devMode) {
      // capy-dev points at a dev service and a live key must never cross that
      // line. The command refuses it twice already; saying so beside the
      // option is the same refusal, one question earlier.
      return { id, available: false, blockedBy: 'DEV_MODE' as const };
    }
    const key = section ? keyForMode(section, id) : undefined;
    // With no section resolved — several accounts and none named, or nothing
    // paired yet — availability is genuinely unknown, so the mode is offered
    // when ANY section could serve it. A definite `false` here would be a
    // claim this code cannot make.
    const possible = section
      ? Boolean(key)
      : sections.length === 0 || sections.some((s) => keyForMode(s, id));
    return {
      id,
      available: possible,
      ...(possible ? {} : { blockedBy: 'NO_KEY' as const }),
      ...(key && keyTypePrefix(key.value) ? { keyPrefix: keyTypePrefix(key.value) as string } : {}),
      ...(key && daysUntil(key.expiresAt) !== undefined
        ? { expiresInDays: daysUntil(key.expiresAt) as number }
        : {}),
    };
  });
}

/**
 * The condition where the mode question has no answer — or nothing, when at
 * least one mode can still run.
 *
 * `stripeModeOptions` can refuse BOTH: one config section holding only a live
 * key, read by `capy-dev`, makes live `DEV_MODE` and test `NO_KEY`. The screen
 * disables an unavailable row and `askConnectInBrowser` refuses one on submit,
 * so what is left is a page with two dead options and no way forward. A state
 * with no runnable answer is a wall, and a wall says why.
 *
 * Keyed off `blockedBy` codes, never off the copy the screen renders for them.
 */
export function noRunnableMode(modes: ConnectModeOption[]): Blocked | undefined {
  if (modes.some((m) => m.available)) return undefined;
  const blockedBy = new Set(modes.map((m) => m.blockedBy));
  if (blockedBy.has('DEV_MODE')) {
    return {
      code: 'DEV_MODE_NO_TEST_KEY',
      title: 'capy-dev cannot use the only key Stripe is holding',
      detail:
        'The Stripe config has a live-mode key and no test-mode key, and capy-dev refuses live mode outright — a dev build points at a dev service, and a live key must never cross that line.',
      remedy: 'stripe login',
    };
  }
  return {
    code: 'NO_STRIPE_KEY',
    title: 'No Stripe API key on this machine',
    detail:
      'The Stripe CLI config holds neither a test-mode nor a live-mode key for this account, so there is no key for Capy to read. Pairing again writes one.',
    remedy: 'stripe login',
  };
}

/** The variables already on this branch, as the variable step's rows. */
export function stripeVarSlots(ctx: ResolvedContext): ConnectVarSlot[] {
  const { matches, others } = rankStripeVars(Object.keys(ctx.localPlaintext).sort());
  return [...matches, ...others].map((name) => ({
    name,
    looksRelated: looksStripey(name),
    // Every row here is a name .env already holds. `hasValue` records that
    // fact rather than testing for emptiness. It no longer routes anything
    // through an overwrite guard — `connect` stopped writing values, so there
    // is no overwrite left to guard — and the screen uses it to say which
    // slots are occupied.
    hasValue: true,
    ...(findManagedConnector(ctx.keep, name, ctx.branch)?.provider
      ? { managedBy: findManagedConnector(ctx.keep, name, ctx.branch)!.provider }
      : {}),
  }));
}

/** What is sitting in the slot the key would replace. Shape only, never the value. */
export function currentVarState(ctx: ResolvedContext, varName: string): ConnectVarState {
  const connector = findManagedConnector(ctx.keep, varName, ctx.branch);
  const entry = (ctx.keep.variables[varName] ?? []).find((e) => e.branch === ctx.branch);
  const snippet = safeSnippet(ctx.localPlaintext[varName] ?? '');
  return {
    ...(snippet ? { fingerprint: snippet } : {}),
    ...(connector?.provider ? { managedBy: connector.provider } : {}),
    ...(connector?.mode === 'test' || connector?.mode === 'live' ? { mode: connector.mode } : {}),
    ...(typeof connector?.created_at === 'number'
      ? { age: formatRelativeTime(new Date(connector.created_at * 1000).toISOString()) }
      : {}),
    // A keep.lock entry seeded by `attachConnector` before any push carries an
    // empty resource_id and value_hash. Anything else came back from the
    // service, which means teammates on this branch are holding it.
    pushed: Boolean(entry && entry.value_hash !== ''),
  };
}

/**
 * The key that would replace it, as far as the run has committed to one.
 *
 * NO LONGER ON THE CONNECT PATH. It described the incoming half of the
 * overwrite guard, and `connect` no longer overwrites anything — it records
 * the link and leaves the value alone. Kept because the `overwrite` screen is
 * still declared in the contract and this is the only honest describer for it,
 * but nothing in the command calls it.
 *
 * The limitation that made it worth removing, recorded so a future caller does
 * not reintroduce it: it runs before the account is settled and before any
 * `stripe login`, so with several accounts paired and none named there is no
 * key to describe. The contract makes `keyPrefix` and `fingerprint` required,
 * so they arrive as empty strings — a guard that renders a blank where the
 * replacement should be. Any flow that adopts this must settle the account
 * first.
 */
export function describeIncomingKey(
  sections: StripeConfigSection[],
  mode: StripeMode,
  requested?: string,
): ConnectIncomingKey {
  const section = resolveSection(sections, requested);
  const key = section ? keyForMode(section, mode) : undefined;
  return {
    keyPrefix: (key && keyTypePrefix(key.value)) || '',
    mode,
    ...(section?.account_id ? { accountId: section.account_id } : {}),
    fingerprint: key ? (safeSnippet(key.value) ?? '') : '',
  };
}

/** Everything `connectPlan` needs that is not an answer this session collects. */
function planFor(
  ctx: ResolvedContext,
  opts: ConnectOpts,
  settled: Partial<ConnectPlanInput> = {},
): ConnectPlanInput {
  return {
    provider: 'stripe',
    branch: ctx.branch,
    requiresTool: 'stripe',
    requiresAuth: true,
    ...(opts.var ? { varName: opts.var.trim(), varFromFlag: true } : {}),
    ...(opts.live ? { mode: 'live' as const, modeFromFlag: true } : {}),
    ...(opts.account ? { account: opts.account, accountFromFlag: true } : {}),
    push: !opts.noPush,
    ...(opts.noPush ? { pushFromFlag: true } : {}),
    ...settled,
  };
}

/** The params every `connect-setup` serve in this file shares. */
function webParams(
  ctx: ResolvedContext,
  opts: ConnectOpts,
  questions: ConnectQuestion[],
  settled: Partial<ConnectPlanInput> = {},
): WebConnectSetupParams {
  return {
    provider: 'stripe',
    projectName: ctx.keep.project_name,
    branch: ctx.branch,
    plan: planFor(ctx, opts, settled),
    questions,
    // Honoured by every browser path so a test never opens the developer's
    // real browser; the URL is printed either way.
    open: !process.env.CAPY_WEB_NO_OPEN,
  };
}

function readKeyFromSection(section: StripeConfigSection, mode: StripeMode): { value: string; expiresAt?: number } {
  const value = mode === 'live' ? section.live_mode_api_key : section.test_mode_api_key;
  const expiresAt = mode === 'live' ? section.live_mode_key_expires_at : section.test_mode_key_expires_at;
  if (!value) {
    console.error(`\n  No ${mode}-mode API key found in stripe config for "${section.name}".`);
    console.error(`  Run ${B('stripe login')} first.`);
    process.exit(1);
  }
  return { value, expiresAt };
}

/**
 * Sanity-check shape of a Stripe restricted/secret key. Kept exported because
 * it's a useful guard for any future code path that handles a Stripe key
 * value (e.g. import flows). Mode hint is optional.
 */
export function validateRestrictedKey(value: string, expectedMode?: StripeMode): string | true {
  const trimmed = value.trim();
  if (!trimmed) return 'Key cannot be empty';
  if (!/^(rk|sk)_(test|live)_[A-Za-z0-9]{8,}$/.test(trimmed)) {
    return 'Key must start with rk_test_, rk_live_, sk_test_, or sk_live_';
  }
  if (expectedMode) {
    const isLive = trimmed.startsWith('rk_live_') || trimmed.startsWith('sk_live_');
    const isTest = trimmed.startsWith('rk_test_') || trimmed.startsWith('sk_test_');
    if (expectedMode === 'test' && isLive) {
      return 'You picked test mode but pasted a live-mode key (rk_live_/sk_live_). Refusing to write a live key into a test slot.';
    }
    if (expectedMode === 'live' && isTest) {
      return 'You picked live mode but pasted a test-mode key (rk_test_/sk_test_). Refusing to mismatch.';
    }
  }
  return true;
}



/**
 * Pick which env var the Stripe connection describes. Order:
 *   1. `--var` flag (no prompt, validated).
 *   2. Otherwise a list of the branch's variables: stripe-pattern matches
 *      first, everything else after.
 *
 * NO "Create new…" ROW, and no name prompt when the branch is empty. `connect`
 * links an existing variable to a provider — it does not write a value, so
 * there is nothing for a variable it invents to hold. Offering to create one
 * would walk the user through naming it and then refuse, which is a worse
 * ending than the refusal on its own.
 */
async function pickVarName(ctx: ResolvedContext, opts: ConnectOpts): Promise<string> {
  if (opts.var) {
    const result = validateVarName(opts.var);
    if (result !== true) {
      console.error(`\n  ${result} (got "${opts.var}")\n`);
      process.exit(1);
    }
    return opts.var.trim();
  }

  const existing = Object.keys(ctx.localPlaintext).sort();
  if (existing.length === 0) {
    console.error(`\n  No variables on branch ${ctx.branch} to connect.`);
    console.error('  Add the variable that holds your Stripe key to .env, run `capy` to sync,');
    console.error('  then run this again.\n');
    process.exit(1);
  }

  if (!isInteractive(opts.nonTty)) {
    refuseNonInteractive(
      'which variable holds your Stripe key is ambiguous without a prompt',
      `Pass --var <NAME> (existing: ${existing.join(', ')}).`,
    );
  }

  const { matches, others } = rankStripeVars(existing);

  const inquirer = (await import('inquirer')).default;
  const choices: any[] = [];

  if (matches.length > 0) {
    for (const n of matches) {
      choices.push({ name: `${n}  ${DIM('(looks like a Stripe var)')}`, value: n });
    }
    if (others.length > 0) choices.push(new inquirer.Separator());
  }
  for (const n of others) choices.push({ name: n, value: n });

  const { picked } = await inquirer.prompt([{
    type: 'list',
    name: 'picked',
    message: 'Which variable holds your Stripe key?',
    choices,
    default: matches[0] ?? existing[0],
  }]);

  return picked;
}


/**
 * The two questions that need nothing from Stripe, plus the guard between
 * them, served as one browser session.
 *
 * ONE ORDERING DIFFERENCE FROM THE TERMINAL, and it is deliberate. The terminal
 * asks variable → overwrite? → mode, because its overwrite guard is a bare
 * `STRIPE_SECRET_KEY already has a value. Overwrite?` and needs to know nothing
 * to ask it. The browser guard shows what is in the slot beside what would
 * replace it, and the replacement cannot be described until the mode is
 * settled — so the mode is settled first. Both orders ask the same three
 * questions, refuse on the same answer and write the same thing; only the guard
 * is better informed on one of them.
 */
async function askConnectPhaseA(
  ctx: ResolvedContext,
  opts: ConnectOpts,
): Promise<{
  varName: string;
  mode: StripeMode;
  cancelled: boolean;
  /**
   * The run stopped because it could not ask, not because someone declined.
   * Kept apart from `cancelled` so the exit code can be: a refusal is a 0, a
   * wall is a 1, and reporting one as the other is how a caller learns the
   * wrong thing from a run that did nothing.
   */
  blocked?: boolean;
}> {
  const { askConnectInBrowser } = await import('../../ui/connectScreens');

  // `--var` settles the variable, with the same validation the terminal path
  // applies — a flag is not an excuse to write a name .env cannot hold.
  let varName = '';
  if (opts.var) {
    const problem = validateVarName(opts.var);
    if (problem !== true) {
      console.error(`\n  ${problem} (got "${opts.var}")\n`);
      process.exit(1);
    }
    varName = opts.var.trim();
  }
  let mode: StripeMode | undefined = opts.live ? 'live' : undefined;

  // Read once, before anything opens: it is a pure read of Stripe's own
  // config, and it is what lets the rail say whether a sign-in is coming and
  // the mode question say which modes this machine can actually serve.
  const sections = readStripeConfig();
  // `connect()` runs `stripe login` exactly when there is no section, so this
  // is not a guess about the future — it is the condition that decides it.
  const settled: Partial<ConnectPlanInput> = {
    // APPROXIMATE, and deliberately so: the mode may not be settled yet, so
    // the precise question `connect()` will ask — "is there a usable key for
    // THIS mode" — cannot be answered here. "Some section holds a key of
    // either kind" is the closest honest preview, and it is already stricter
    // than the `sections.length > 0` this used to be, which counted a section
    // carrying nothing but an account id.
    alreadySignedIn:
      opts.reauth !== true &&
      sections.some((sec) => keyForMode(sec, 'test') || keyForMode(sec, 'live')),
    ...(resolveSection(sections, opts.account)?.account_id
      ? { account: resolveSection(sections, opts.account)!.account_id }
      : {}),
  };

  // Both in one session, so answering the first is a page reload rather than a
  // second URL to relay. They are separable from the guard below because
  // neither depends on the other's answer — the guard depends on both.
  const questions: ConnectQuestion[] = [];
  if (!varName) {
    questions.push({ kind: 'var', vars: stripeVarSlots(ctx), defaultVarName: DEFAULT_VAR });
  }
  if (!mode) {
    const modes = stripeModeOptions(sections, opts.account, opts.devMode === true);
    const wall = noRunnableMode(modes);
    if (wall) {
      // Both modes refused. The screen disables an unavailable row and the
      // reducer refuses one, so asking here would be serving a question with
      // no answer: the run would sit on that page until the wizard's
      // five-minute timeout, having told the user nothing. A wall is an
      // ending, not a question — it goes out through the ending server, which
      // waits for the browser to have it and then lets the command finish.
      const { showConnectBlockedInBrowser } = await import('../../ui/connectScreens');
      await showConnectBlockedInBrowser({
        provider: 'stripe',
        projectName: ctx.keep.project_name,
        branch: ctx.branch,
        step: 'mode',
        stops: connectPlan({
          ...planFor(ctx, opts, { ...settled, ...(varName ? { varName } : {}) }),
          standing: 'mode',
        }),
        blocked: wall,
        open: !process.env.CAPY_WEB_NO_OPEN,
      });
      return { varName, mode: 'test', cancelled: true, blocked: true };
    }
    questions.push({ kind: 'mode', modes });
  }
  if (questions.length > 0) {
    const out = await askConnectInBrowser(
      webParams(ctx, opts, questions, { ...settled, ...(varName ? { varName } : {}) }),
    );
    if (out.cancelled) return { varName, mode: mode ?? 'test', cancelled: true };
    varName = out.answers.var ?? varName;
    mode = out.answers.mode ?? mode;
  }
  // A session that came back without an answer to a question it was given has
  // not answered it. Falling through on a default would write a key nobody
  // asked for, into a variable nobody named.
  if (!varName || !mode) return { varName, mode: mode ?? 'test', cancelled: true };
  const settledMode: StripeMode = mode;

  // NO OVERWRITE GUARD, because there is no longer an overwrite. `connect`
  // records the link and leaves the value alone, so the question this used to
  // ask — "STRIPE_SECRET already has a value, replace it?" — has no subject.
  //
  // It is worth saying why it went rather than just that it did. The guard was
  // the only thing standing between a user and a silently replaced credential,
  // and in the configuration that matters most it could not describe what it
  // was about to write: `describeIncomingKey` resolves a section only when
  // `--account` was passed or exactly one account is paired, so with two
  // paired accounts both `keyPrefix` and `fingerprint` arrived as empty
  // strings. The screen showed the current value's fingerprint beside a blank.
  // Approving that reads as approving nothing. Removing the write removes the
  // hazard the guard was failing to describe.

  return { varName, mode: settledMode, cancelled: false };
}

/**
 * What a sign-in that did not sign anyone in says, per reason.
 *
 * A switch and not a ternary chain, so the compiler is what proves every reason
 * has a wall — including `declined`, which must never reach here: it is a
 * refusal, ends the run at 0, and draws nothing. A chain would have quietly
 * handed it the last branch's message and called a decision a failure.
 *
 * ONE OBJECT PER REASON, read by both surfaces. The browser renders it as the
 * wall and the terminal prints the same three lines, which is the only way the
 * two can be claimed to be describing the same run.
 */
function stripeLoginWall(
  reason: Exclude<Extract<StripeLoginOutcome, { ok: false }>['reason'], 'declined'>,
  varName: string,
): Blocked {
  switch (reason) {
    case 'pairing-unsupported':
      return {
        code: 'PROVIDER_PAIRING_UNSUPPORTED',
        title: 'This Stripe CLI cannot hand off a pairing.',
        detail:
          'Capy asked the Stripe CLI for a pairing URL and it did not produce one, so there was nothing to send you to. Signing in from a terminal still works.',
        remedy: 'brew upgrade stripe/stripe-cli/stripe && stripe login',
      };
    case 'pairing-not-completed':
      return {
        code: 'PROVIDER_PAIRING_NOT_COMPLETED',
        title: 'The Stripe pairing was not approved.',
        detail:
          'Nothing was written and nothing changed. Capy waited for Stripe to report the approval and it never came — the tab was closed, the code did not match, or nobody got to it.',
        remedy: `capy connect stripe --var ${varName}`,
      };
    case 'login-failed':
      return {
        code: 'PROVIDER_LOGIN_FAILED',
        title: 'stripe login failed or was cancelled.',
        detail: 'The Stripe CLI exited without signing in. Nothing was written and nothing changed.',
        remedy: `capy connect stripe --var ${varName}`,
      };
  }
}

/** The account picker, in a browser. Rows are config.toml's sections, verbatim. */
async function pickAccountInBrowser(
  ctx: ResolvedContext,
  opts: ConnectOpts,
  sections: StripeConfigSection[],
  settled: { varName: string; mode: StripeMode } & Partial<ConnectPlanInput>,
): Promise<StripeConfigSection> {
  const requested = resolveSection(sections, opts.account);
  if (opts.account && !requested) {
    console.error(`\n  No Stripe account matching "${opts.account}" in config.toml.`);
    process.exit(1);
  }
  if (requested) return requested;

  const { askConnectInBrowser } = await import('../../ui/connectScreens');
  const out = await askConnectInBrowser(
    webParams(ctx, opts, [{ kind: 'account', accounts: toStripeAccounts(sections) }], settled),
  );
  if (out.cancelled || !out.answers.account) {
    console.log('  Cancelled.');
    process.exit(0);
  }
  return sections.find((s) => s.name === out.answers.account)!;
}


async function connect(ctx: ResolvedContext, opts: ConnectOpts): Promise<ConnectResult> {
  const web = opts.web === true;

  let varName: string;
  let mode: StripeMode;
  if (web) {
    const answered = await askConnectPhaseA(ctx, opts);
    if (answered.cancelled) {
      // Two endings, and they are not the same fact. A decline wrote nothing
      // and that was the point (0); a wall wrote nothing because the run could
      // not proceed (1). Both pages have already been delivered by the time
      // this line runs — `askConnectInBrowser` returns after its wizard has
      // closed, and `showConnectBlockedInBrowser` waits for the browser to
      // hold the page — so exiting here can no longer outrun either.
      console.log(answered.blocked ? '  Nothing to connect.' : 'Cancelled.');
      process.exit(answered.blocked ? 1 : 0);
    }
    varName = answered.varName;
    mode = answered.mode;
  } else {
    varName = await pickVarName(ctx, opts);
    mode = await pickMode(opts.live ?? false, opts.nonTty);
  }

  // The variable has to already exist, because `connect` no longer creates it.
  // Attaching a connector to a name `.env` does not hold would put a keep.lock
  // entry — provider, mode, account, fingerprint — against nothing, and the
  // first thing to notice would be a `rotate` that has no value to replace.
  if (!(varName in ctx.localPlaintext)) {
    console.error(`\n  ${B(varName)} is not in .env on branch ${ctx.branch}.`);
    console.error('  `connect` links an existing variable to a provider; it does not create one.');
    console.error(`  Add ${B(varName)} to .env, run ${B('capy')} to sync, then connect it.\n`);
    process.exit(1);
  }

  // Read from the Stripe CLI's config. Sign in when there is no usable
  // session, or when the caller explicitly asked for a fresh one.
  //
  // WHY RE-RUNNING `connect` DOES NOT RE-AUTHENTICATE BY DEFAULT. `stripe
  // login` is not a read: it rewrites the user's `config.toml` and can make
  // Stripe issue a new key, so it changes the pairing every other project on
  // the machine is using. Doing that on every `connect` would make a command
  // that records a link into one that quietly re-issues credentials — the same
  // reason the near-expiry refresh offer was taken off this route. `--reauth`
  // is how you ask for it on purpose, and a session that cannot serve the mode
  // you picked is not a decision at all: there is nothing to record without
  // one.
  let sections = readStripeConfig();
  const reason: 'reauth' | 'none' | 'unusable' | null = opts.reauth
    ? 'reauth'
    : sections.length === 0
      ? 'none'
      : usableFor(sections, mode).length === 0
        ? 'unusable'
        : null;
  // Whether the sign-in stop is one this run travelled or one it skipped. The
  // rail states it either way, because "Capy did not have to sign you in" is a
  // fact about the route, not an absence.
  const auth: Partial<ConnectPlanInput> =
    reason === null ? { alreadySignedIn: true } : { signedIn: true };
  if (reason !== null) {
    // `stripe login` is a browser pairing the user completes by hand. Under
    // `--web` it is a screen like every other stop on this route; without one
    // it is announced on the terminal. Either way the CLI does the polling —
    // see `runStripeLogin` for why that is two calls and not one.
    const why =
      reason === 'reauth'
        ? '--reauth: pairing with Stripe again'
        : reason === 'none'
          ? 'No Stripe CLI session found'
          : `No usable ${mode}-mode key in the Stripe CLI config (missing or expired)`;
    console.log(
      isInteractive(opts.nonTty)
        ? `${why}. Running ${B('stripe login')}...`
        : `  ${why} — starting browser pairing.`,
    );
    const outcome = await runStripeLogin({
      projectName: opts.account,
      nonTty: opts.nonTty,
      web,
      ...(web
        ? {
            handoff: async (pairing, complete) => {
              const { signInInBrowser } = await import('../../ui/connectScreens');
              return signInInBrowser(
                webParams(
                  ctx,
                  opts,
                  [
                    {
                      kind: 'auth',
                      // What the screen names as the command being handed off
                      // to. `stripe login` and not the two-step it expands
                      // into: the expansion is our implementation detail, and
                      // this line exists so the hand-off is never a mystery,
                      // not so it can be copied.
                      command: 'stripe login',
                      state: 'ready',
                      ...(pairing.verificationCode
                        ? { pairingCode: pairing.verificationCode }
                        : {}),
                    },
                  ],
                  // `auth` is deliberately NOT folded in here, and it is the
                  // one screen on this route where it must not be. It carries
                  // `signedIn: true` — the fact the run is about to establish —
                  // and `connectPlan` resolves an answered stop to `done`
                  // before it looks at where the traveller is standing. Folding
                  // it forward would draw "Sign in ✓ paired" on the very page
                  // asking someone to go and do it.
                  { varName, mode },
                ),
                async () => {
                  // The hand-off proper: the whole browser, because the person
                  // has to be able to see the address bar and pick the profile
                  // their Stripe session lives in.
                  const { openScreen } = await import('../../ui/openScreen');
                  await openScreen(pairing.browserUrl, { kind: 'handoff' });
                  return complete();
                },
              );
            },
          }
        : {}),
    });
    // A DECLINE IS NOT A FAILURE, so it gets no wall and no non-zero exit. The
    // page that asked has already closed itself — `signInInBrowser` does not
    // resolve until it has — so there is nothing left to serve and nothing to
    // outrun by exiting here. Same shape as the decline in `askConnectPhaseA`.
    if (!outcome.ok && outcome.reason === 'declined') {
      console.log('  Cancelled.');
      process.exit(0);
    }

    sections = readStripeConfig();

    // FOUR WALLS, NOT ONE. This used to print "stripe login completed but the
    // config still holds no usable key" whatever happened, including for the
    // common case where login did not complete at all — which sends the reader
    // to look at config parsing when the cause is a pairing nobody approved.
    const usable = usableFor(sections, mode).length > 0;
    if (!outcome.ok || !usable) {
      const wall: Blocked = outcome.ok
        ? {
            // The one case the old message was ever right about: the pairing
            // DID complete, and the config that came back still cannot serve
            // the mode this run needs.
            code: 'PROVIDER_MODE_UNAVAILABLE',
            title: `Signed in, but there is no usable ${mode}-mode key.`,
            detail: `The pairing completed and Stripe wrote its config, and that config holds no ${mode}-mode key Capy can read — so there is nothing to record a link against.`,
            remedy: 'stripe config --list',
          }
        : stripeLoginWall(outcome.reason, varName);

      if (web) {
        // SERVED BEFORE THE EXIT, not after it. `showConnectBlockedInBrowser`
        // does not return until the browser is holding the page, and the page
        // comes off a loopback server inside THIS process — so exiting first,
        // which is what this site used to do, closed the server microseconds
        // before it could answer and turned the failure into a window that
        // simply stopped. Same hazard, and same order, as the live-gate
        // decline in connectCommand.ts.
        const { showConnectBlockedInBrowser } = await import('../../ui/connectScreens');
        await showConnectBlockedInBrowser({
          provider: 'stripe',
          projectName: ctx.keep.project_name,
          branch: ctx.branch,
          step: 'auth',
          // Same reason the sign-in screen drops `auth`: the run stopped ON
          // this stop, so a rail claiming it was travelled is a rail
          // contradicting the page it is drawn on.
          stops: connectPlan({ ...planFor(ctx, opts, { varName, mode }), standing: 'auth' }),
          blocked: wall,
          open: !process.env.CAPY_WEB_NO_OPEN,
        });
      }
      console.error(`\n  ${wall.title}`);
      console.error(`  ${wall.detail}`);
      if (wall.remedy) console.error(`  ${B(wall.remedy)}`);
      console.error('');
      process.exit(1);
    }
  }
  const section = web
    ? await pickAccountInBrowser(ctx, opts, sections, { ...auth, varName, mode })
    : await pickAccount(sections, opts.account, opts.nonTty);

  // NO NEAR-EXPIRY REFRESH OFFER. It used to live here, and it re-ran
  // `stripe login` — which rewrites the user's Stripe pairing and can make
  // Stripe issue a fresh key. That is a credential operation, and `connect`
  // does not do credential operations; it records the link and stops. The old
  // offer earned its place when connect wrote the key into `.env`, because
  // writing one that expires next week was worth interrupting for. Nothing is
  // written now, so re-pairing would only change which fingerprint gets
  // recorded — a poor trade for mutating the pairing underneath the user.
  //
  // The expiry is still recorded, so `capy rotate` is the command that acts on
  // it, which is where that decision belongs.
  const initial = readKeyFromSection(section, mode);

  return {
    varName,
    entry: {
      provider: 'stripe',
      source: 'cli',
      mode,
      account_id: section.account_id,
      expires_at: initial.expiresAt,
      created_at: Math.floor(Date.now() / 1000),
      fingerprint: fingerprint(initial.value),
      ...(keyTypePrefix(initial.value) ? { key_prefix: keyTypePrefix(initial.value) as string } : {}),
    },
  };
}

async function rotate(
  _ctx: ResolvedContext,
  varName: string,
  previous: ConnectorMetadata,
  opts: RotateOpts,
): Promise<RotateResult> {
  // Stripe rotation re-pairs the CLI: `stripe logout` then `stripe login`, a
  // browser flow. We can't mint a key headlessly (the managed-keys API needs a
  // Stripe marketplace app and doesn't yet issue restricted keys), but the
  // browser step itself works in assisted non-interactive mode: the user
  // completes the pairing out-of-band while we poll. runStripeLogin clears the
  // "Press Enter" gate for us. So we proceed rather than refuse.
  const nonTty = opts.nonTty;
  if (previous.mode !== 'test' && previous.mode !== 'live') {
    console.error(
      `\n  ${varName} keep.lock entry has invalid mode "${previous.mode ?? '(unset)'}".`,
    );
    console.error(`  Expected 'test' or 'live'. Re-run \`capy connect stripe\`.`);
    process.exit(1);
  }
  const mode: StripeMode = previous.mode;

  // Re-run stripe login and diff against capy's *recorded* fingerprint, not
  // the pre-login config.toml value. The user may have already done their own
  // `stripe logout && stripe login` outside capy — in which case the config
  // value already changed (relative to what capy knows), capy's re-login is
  // a no-op (already paired), and the pre/post comparison would falsely flag
  // it as "no change." Comparing to previous.fingerprint catches both
  // capy-driven and externally-driven rotations.
  // Find the section by account_id, then normalize the name to strip any
  // quote/backslash chars that may have accumulated from prior rotations
  // (see normalizeProjectName for the full why). If normalization produces
  // an empty string, fall back to "default" — never pass garbage to stripe.
  const sectionName = (() => {
    const sections = readStripeConfig();
    const byAccount = previous.account_id ? sections.find((s) => s.account_id === previous.account_id) : undefined;
    if (!byAccount) return 'default';
    const normalized = normalizeProjectName(byAccount.name);
    return normalized.length > 0 ? normalized : 'default';
  })();

  writeSync(1, `\n  Rotating ${B(varName)} via \`stripe login\` (account: ${sectionName}, mode: ${mode}).\n`);

  // `stripe login` is idempotent at the key level — re-pairing an already-
  // paired session refreshes the local credential but doesn't mint a new key
  // on Stripe's side. To force an actual rotation we have to logout first.
  // We logout for this project only (not --all), so other Stripe projects the
  // user is logged into are untouched.
  const loggedOut = runStripeLogout(sectionName);

  // The same two-step hand-off `connect` uses, and for the same reason: with a
  // piped stdin `stripe login` prints its pairing JSON and exits without
  // signing anyone in, so this used to spray the pairing URL and code onto the
  // channel the AI agent reads and then fail on a config nothing had written.
  //
  // NO BROWSER SCREEN HERE YET. `rotate --web` gets the hand-off — the Stripe
  // tab opens and the poll runs — but not a Capy page around it, because the
  // rail this screen draws is `connect`'s and drawing a connect route through a
  // rotation would be a worse lie than drawing nothing. `rotate-progress`
  // already carries a `pairing` field for it; wiring that is its own change.
  const loginOutcome = await runStripeLogin({ projectName: sectionName, nonTty, web: opts.web === true });
  if (!loginOutcome.ok) {
    console.error('');
    console.error(
      loginOutcome.reason === 'pairing-unsupported'
        ? `  This ${B('stripe')} CLI cannot hand off a pairing, so the re-login could not start.`
        : `  ${B('stripe login')} failed or was cancelled after logout.`,
    );
    if (loggedOut) {
      console.error(`  Heads up: ${B(varName)} in your local .env still holds the previous key,`);
      console.error(`  but your Stripe CLI is now logged out of "${sectionName}". The previous`);
      console.error(`  key may have been revoked by Stripe. Re-run ${B(`capy rotate ${varName}`)}`);
      console.error('  to recover.');
    }
    process.exit(1);
  }

  const sections = readStripeConfig();
  const section = sections.find((s) => s.name === sectionName);
  if (!section) {
    console.error('\n  Could not re-read stripe config after login.');
    process.exit(1);
  }
  const next = readKeyFromSection(section, mode);
  const nextFp = fingerprint(next.value);

  if (nextFp === previous.fingerprint) {
    // Stripe is deduplicating: `stripe login` after a recent successful pairing
    // returns the same restricted key rather than minting a new one. There's no
    // CLI-side workaround — the dedup happens on Stripe's side. The user can
    // wait a few minutes and retry, or revoke the existing key in the dashboard
    // to force the next login to issue a fresh one.
    const dashUrl = `https://dashboard.stripe.com/${mode === 'live' ? '' : 'test/'}apikeys`;
    console.error('\n  Stripe returned the same key — no rotation happened.');
    console.error('');
    console.error('  This usually means a rotation happened very recently and Stripe is');
    console.error('  deduplicating the pairing. Two ways to recover:');
    console.error('    1. Wait a few minutes and re-run `capy rotate`.');
    console.error(`    2. Revoke the existing key at ${dashUrl}`);
    console.error('       and re-run `capy rotate` — Stripe will issue a fresh one.');
    console.error('');
    process.exit(1);
  }

  return {
    value: next.value,
    entry: {
      ...previous,
      mode,
      account_id: section.account_id ?? previous.account_id,
      expires_at: next.expiresAt,
      rotated_at: Math.floor(Date.now() / 1000),
      fingerprint: nextFp,
      ...(keyTypePrefix(next.value) ? { key_prefix: keyTypePrefix(next.value) as string } : {}),
    },
  };
}

export const stripeConnector: ConnectorModule = {
  name: 'stripe',
  description: 'Stripe API key (test or live, restricted)',
  requiresAuth: true, // rotate shells out to `stripe login` (browser flow)
  requiresTool: 'stripe',
  toolInstalled: stripeCliInstalled,
  toolMissing: STRIPE_CLI_MISSING,
  precheck: ensureStripeCliInstalled,
  connect,
  rotate,
};
