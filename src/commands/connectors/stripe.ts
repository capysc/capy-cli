import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConnectorModule, ConnectResult, RotateResult, ConnectOpts, RotateOpts } from './registry';
import { ConnectorMetadata } from '../../types/index';
import { ResolvedContext, fingerprint } from './shared';

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

function ensureStripeCliInstalled(): void {
  try {
    execSync('stripe --version', { stdio: 'pipe' });
  } catch {
    console.error(`\n  ${B('stripe')} CLI not found.`);
    console.error('  Install: https://docs.stripe.com/stripe-cli#install');
    console.error(`  Or: ${B('brew install stripe/stripe-cli/stripe')}\n`);
    process.exit(1);
  }
}

/** Run `stripe login`, optionally for a named project. Inherits stdio so the user sees the browser flow. */
function runStripeLogin(projectName?: string): void {
  const args = ['login'];
  if (projectName && projectName !== 'default') args.push(`--project-name=${projectName}`);
  const result = spawnSync('stripe', args, { stdio: 'inherit' });
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

async function pickAccount(sections: StripeConfigSection[], requested?: string): Promise<StripeConfigSection> {
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

async function pickMode(forceLive: boolean): Promise<StripeMode> {
  if (forceLive) return 'live';
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

async function expiringSoonPrompt(expiresAt: number | undefined): Promise<boolean> {
  if (typeof expiresAt !== 'number') return false;
  const remainingDays = Math.floor((expiresAt - Date.now() / 1000) / 86400);
  if (remainingDays > 7) return false;
  console.log('');
  console.log(`  ${B('Heads up:')} this key expires in ${remainingDays} day(s).`);
  const inquirer = (await import('inquirer')).default;
  const { relogin } = await inquirer.prompt([{
    type: 'confirm',
    name: 'relogin',
    message: 'Re-run `stripe login` to refresh it first?',
    default: true,
  }]);
  return relogin;
}

async function promptNewVarName(): Promise<string> {
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
  if (existing.length === 0) return promptNewVarName();

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

  return picked === CREATE_NEW ? promptNewVarName() : picked;
}

async function confirmOverwrite(varName: string, ctx: ResolvedContext, force: boolean): Promise<boolean> {
  if (force) return true;
  if (!(varName in ctx.localPlaintext)) return true;
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{
    type: 'confirm',
    name: 'ok',
    message: `${varName} already has a value. Overwrite?`,
    default: false,
  }]);
  return ok;
}

async function connect(ctx: ResolvedContext, opts: ConnectOpts): Promise<ConnectResult> {
  const varName = await pickVarName(ctx, opts);
  if (!(await confirmOverwrite(varName, ctx, opts.force ?? false))) {
    console.log('Cancelled.');
    process.exit(0);
  }

  const mode = await pickMode(opts.live ?? false);

  // Read from the Stripe CLI's config. Login if needed.
  let sections = readStripeConfig();
  if (sections.length === 0) {
    console.log('No Stripe CLI session found. Running `stripe login`...');
    runStripeLogin(opts.account);
    sections = readStripeConfig();
    if (sections.length === 0) {
      console.error('\n  stripe login completed but no config.toml entries found.');
      process.exit(1);
    }
  }
  const section = await pickAccount(sections, opts.account);

  // If the existing key is already near expiry, offer to refresh first.
  const initial = readKeyFromSection(section, mode);
  if (await expiringSoonPrompt(initial.expiresAt)) {
    runStripeLogin(section.name);
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
  _opts: RotateOpts,
): Promise<RotateResult> {
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

  console.log('');
  console.log(`  Rotating ${B(varName)} via \`stripe login\` (account: ${sectionName}, mode: ${mode}).`);

  // `stripe login` is idempotent at the key level — re-pairing an already-
  // paired session refreshes the local credential but doesn't mint a new key
  // on Stripe's side. To force an actual rotation we have to logout first.
  // We logout for this project only (not --all), so other Stripe projects the
  // user is logged into are untouched.
  const loggedOut = runStripeLogout(sectionName);

  const loginArgs = ['login'];
  if (sectionName !== 'default') loginArgs.push(`--project-name=${sectionName}`);
  const loginResult = spawnSync('stripe', loginArgs, { stdio: 'inherit' });
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
  precheck: ensureStripeCliInstalled,
  connect,
  rotate,
};
