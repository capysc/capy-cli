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
 * Run `stripe login`, optionally for a named project. Inherits stdout/stderr so
 * the user sees the pairing code + URL and the browser flow.
 *
 * In non-interactive (assisted-agent) mode there's no TTY attached to our
 * stdin, so `stripe login`'s "Press Enter to open the browser" gate would hang.
 * We feed it a single newline via `input` to clear that gate; stripe then
 * prints the pairing code + URL (visible on the inherited stdout) and polls for
 * the browser callback, which the user completes out-of-band. stdin hits EOF
 * after the newline, which is fine — the pairing step needs no further input.
 */
function runStripeLogin(projectName?: string, nonTty?: boolean): void {
  const args = ['login'];
  if (projectName && projectName !== 'default') args.push(`--project-name=${projectName}`);
  if (nonTty) {
    // writeSync (not console.log) so this flushes before the blocking
    // `stripe login` spawnSync — otherwise a backgrounded run buffers it and
    // it appears only after auth completes, out of order with the pairing code.
    writeSync(
      1,
      `\n  ${B('Opening Stripe in your browser.')} Compare the pairing code shown below\n` +
        '  with the one in the browser, then approve. Waiting for you to authenticate…\n\n',
    );
  }
  const result = nonTty
    ? spawnSync('stripe', args, { input: '\n', stdio: ['pipe', 'inherit', 'inherit'] })
    : spawnSync('stripe', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('\nstripe login failed or was cancelled.');
    process.exit(1);
  }
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
    // Every row here is a name .env already holds, so every one of them routes
    // through the overwrite guard. `hasValue` is that fact, not a test for
    // emptiness — the guard fires on presence.
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
 * KNOWN LIMITATION, reported rather than papered over: `confirmOverwrite` runs
 * before the account is settled and before any `stripe login`, so when several
 * accounts are paired and none was named there is no key to describe yet. The
 * contract makes `keyPrefix` and `fingerprint` required, so they arrive empty
 * in that case — `ConnectVarState` already models the same absence properly on
 * the other side of the comparison, and `ConnectIncomingKey` needs to as well.
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

async function expiringSoonPrompt(expiresAt: number | undefined, nonTty?: boolean): Promise<boolean> {
  if (typeof expiresAt !== 'number') return false;
  const remainingDays = Math.floor((expiresAt - Date.now() / 1000) / 86400);
  if (remainingDays > 7) return false;
  console.log('');
  console.log(`  ${B('Heads up:')} this key expires in ${remainingDays} day(s).`);
  // Non-interactive: don't offer the (browser-bound) re-login here. Take the
  // existing key as-is; the caller can re-run interactively to refresh it.
  if (!isInteractive(nonTty)) {
    console.log(`  ${B('skipping')} re-login (non-interactive); using the current key.`);
    return false;
  }
  const inquirer = (await import('inquirer')).default;
  const { relogin } = await inquirer.prompt([{
    type: 'confirm',
    name: 'relogin',
    message: 'Re-run `stripe login` to refresh it first?',
    default: true,
  }]);
  return relogin;
}

async function promptNewVarName(nonTty?: boolean): Promise<string> {
  if (!isInteractive(nonTty)) {
    refuseNonInteractive(
      'no variable name to write the Stripe key to',
      'Pass --var <NAME> (e.g. --var STRIPE_API_KEY).',
    );
  }
  const inquirer = (await import('inquirer')).default;
  const { name } = await inquirer.prompt([{
    type: 'input',
    name: 'name',
    message: 'New variable name:',
    default: DEFAULT_VAR,
    validate: validateVarName,
  }]);
  return (name as string).trim();
}

/**
 * Pick which env var should hold the Stripe key. Order:
 *   1. `--var` flag (no prompt, validated).
 *   2. If no existing vars, prompt for a name with DEFAULT_VAR as default.
 *   3. Otherwise show a list: stripe-pattern matches first, others next, then
 *      "Create new…" at the bottom.
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
  if (existing.length === 0) return promptNewVarName(opts.nonTty);

  if (!isInteractive(opts.nonTty)) {
    refuseNonInteractive(
      'which variable holds your Stripe key is ambiguous without a prompt',
      `Pass --var <NAME> (existing: ${existing.join(', ')}).`,
    );
  }

  const { matches, others } = rankStripeVars(existing);

  const inquirer = (await import('inquirer')).default;
  const CREATE_NEW = '__create_new__';
  const choices: any[] = [];

  if (matches.length > 0) {
    for (const n of matches) {
      choices.push({ name: `${n}  ${DIM('(looks like a Stripe var)')}`, value: n });
    }
    if (others.length > 0) choices.push(new inquirer.Separator());
  }
  for (const n of others) choices.push({ name: n, value: n });
  choices.push(new inquirer.Separator());
  choices.push({ name: 'Create new variable…', value: CREATE_NEW });

  const { picked } = await inquirer.prompt([{
    type: 'list',
    name: 'picked',
    message: 'Which variable holds your Stripe key?',
    choices,
    default: matches[0] ?? CREATE_NEW,
  }]);

  return picked === CREATE_NEW ? promptNewVarName(opts.nonTty) : picked;
}

async function confirmOverwrite(
  varName: string,
  ctx: ResolvedContext,
  force: boolean,
  nonTty?: boolean,
): Promise<boolean> {
  if (force) return true;
  if (!(varName in ctx.localPlaintext)) return true;
  if (!isInteractive(nonTty)) {
    refuseNonInteractive(
      `${varName} already has a value; refusing to overwrite without confirmation`,
      'Pass -f/--force to overwrite it.',
    );
  }
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{
    type: 'confirm',
    name: 'ok',
    message: `${varName} already has a value. Overwrite?`,
    default: false,
  }]);
  return ok;
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
    alreadySignedIn: sections.length > 0,
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

  if (!opts.force && varName in ctx.localPlaintext) {
    const questions: ConnectQuestion[] = [
      {
        kind: 'overwrite',
        varName,
        current: currentVarState(ctx, varName),
        incoming: describeIncomingKey(sections, settledMode, opts.account),
      },
    ];
    const out = await askConnectInBrowser(
      webParams(ctx, opts, questions, { ...settled, varName, mode: settledMode }),
    );
    if (out.cancelled || out.answers.overwrite !== true) {
      return { varName, mode: settledMode, cancelled: true };
    }
  }

  return { varName, mode: settledMode, cancelled: false };
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

/**
 * The near-expiry offer, in a browser.
 *
 * Same threshold and same two outcomes as `expiringSoonPrompt`; what changes is
 * that a headless run gets asked at all. Without a browser it takes the key
 * as-is, because the alternative is a `stripe login` nobody is there to
 * approve.
 */
async function offerRefreshInBrowser(
  ctx: ResolvedContext,
  opts: ConnectOpts,
  expiresAt: number | undefined,
  settled: { varName: string; mode: StripeMode; account: string } & Partial<ConnectPlanInput>,
): Promise<boolean> {
  const remainingDays = daysUntil(expiresAt);
  if (remainingDays === undefined || remainingDays > 7) return false;
  const { askConnectInBrowser } = await import('../../ui/connectScreens');
  const out = await askConnectInBrowser(
    webParams(
      ctx,
      opts,
      [
        {
          kind: 'refresh',
          mode: settled.mode,
          expiresInDays: remainingDays,
          command: 'stripe login',
        },
      ],
      settled,
    ),
  );
  // Cancelling the offer is not cancelling the connect: the terminal's default
  // here is "re-pair", and its decline is "take the key that is there".
  return out.cancelled ? false : out.answers.refresh === true;
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
    if (!(await confirmOverwrite(varName, ctx, opts.force ?? false, opts.nonTty))) {
      console.log('Cancelled.');
      process.exit(0);
    }
    mode = await pickMode(opts.live ?? false, opts.nonTty);
  }

  // Read from the Stripe CLI's config. Login if needed.
  let sections = readStripeConfig();
  // Whether the sign-in stop is one this run travelled or one it skipped. The
  // rail states it either way, because "Capy did not have to sign you in" is a
  // fact about the route, not an absence.
  const auth: Partial<ConnectPlanInput> =
    sections.length > 0 ? { alreadySignedIn: true } : { signedIn: true };
  if (sections.length === 0) {
    // No paired session yet. `stripe login` is a browser flow; in non-interactive
    // (assisted-agent) mode we still run it — the human completes the pairing in
    // the browser out-of-band while the CLI polls. runStripeLogin handles the
    // "Press Enter" gate for us in that mode.
    if (!isInteractive(opts.nonTty)) {
      console.log('  No Stripe CLI session found — starting browser pairing.');
    } else {
      console.log('No Stripe CLI session found. Running `stripe login`...');
    }
    runStripeLogin(opts.account, opts.nonTty);
    sections = readStripeConfig();
    if (sections.length === 0) {
      console.error('\n  stripe login completed but no config.toml entries found.');
      process.exit(1);
    }
  }
  const section = web
    ? await pickAccountInBrowser(ctx, opts, sections, { ...auth, varName, mode })
    : await pickAccount(sections, opts.account, opts.nonTty);

  // If the existing key is already near expiry, offer to refresh first.
  const initial = readKeyFromSection(section, mode);
  const relogin = web
    ? await offerRefreshInBrowser(ctx, opts, initial.expiresAt, {
        ...auth,
        varName,
        mode,
        account: section.account_id ?? section.name,
      })
    : await expiringSoonPrompt(initial.expiresAt, opts.nonTty);
  if (relogin) {
    runStripeLogin(section.name, opts.nonTty);
    sections = readStripeConfig();
    const refreshed = sections.find((s) => s.name === section.name);
    if (!refreshed) {
      console.error('\n  Could not re-read stripe config after login.');
      process.exit(1);
    }
    const refetched = readKeyFromSection(refreshed, mode);
    return {
      varName,
      value: refetched.value,
      entry: {
        provider: 'stripe',
        source: 'cli',
        mode,
        account_id: refreshed.account_id,
        expires_at: refetched.expiresAt,
        created_at: Math.floor(Date.now() / 1000),
        fingerprint: fingerprint(refetched.value),
      },
    };
  }

  return {
    varName,
    value: initial.value,
    entry: {
      provider: 'stripe',
      source: 'cli',
      mode,
      account_id: section.account_id,
      expires_at: initial.expiresAt,
      created_at: Math.floor(Date.now() / 1000),
      fingerprint: fingerprint(initial.value),
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

  if (nonTty) {
    // writeSync (not console.log) so this flushes before the blocking
    // `stripe login` spawnSync — otherwise a backgrounded run buffers it and
    // it appears only after auth completes, out of order with the pairing code.
    writeSync(
      1,
      `\n  ${B('Opening Stripe in your browser.')} Compare the pairing code shown below\n` +
        '  with the one in the browser, then approve. Waiting for you to authenticate…\n\n',
    );
  }
  const loginArgs = ['login'];
  if (sectionName !== 'default') loginArgs.push(`--project-name=${sectionName}`);
  // In assisted non-interactive mode, feed the "Press Enter" gate a newline and
  // keep stdout/stderr inherited so the pairing code + URL surface to the user.
  const loginResult = nonTty
    ? spawnSync('stripe', loginArgs, { input: '\n', stdio: ['pipe', 'inherit', 'inherit'] })
    : spawnSync('stripe', loginArgs, { stdio: 'inherit' });
  if (loginResult.status !== 0) {
    console.error('');
    console.error(`  ${B('stripe login')} failed or was cancelled after logout.`);
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
