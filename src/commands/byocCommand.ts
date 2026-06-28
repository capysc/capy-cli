/**
 * `capy byoc [url]` — onramp for BYOC (self-hosted) instances.
 *
 * Default flow:
 *   1. Probe https://capy.internal/health.
 *   2. Validate the response is a Capy service (body has `service: "capy"`).
 *   3. Derive a profile name from the hostname; save and switch to it.
 *   4. Print a one-line next step.
 *
 * When the probe fails (DNS not set, off-LAN, server down, TLS error), loop
 * back and prompt for an explicit URL. Self-signed TLS triggers a separate
 * prompt to point at a CA bundle, which then gets stored in the profile so
 * future invocations don't need NODE_EXTRA_CA_CERTS.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  Profile,
  deriveProfileName,
  readProfileConfig,
  saveAndActivateProfile,
} from '../config/profileConfig';
import {
  generateSeedPhrase,
  validateSeedPhrase,
  seedPhraseToMasterKey,
} from '../crypto/keyManager';
import { saveLocalKey } from '../crypto/keyResolver';
import { saveLocalSession } from '../config/globalConfig';
import { displayAndConfirmRecoveryPhrase } from '../ui/recoveryPhrase';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

const DEFAULT_URL = 'https://capy.internal';
const PROBE_TIMEOUT_MS = 4000;

interface ProbeOk {
  ok: true;
  url: string;
  caBundle?: string;
}
interface ProbeFail {
  ok: false;
  reason: string;
  /** Set when the failure was a TLS cert error and the URL is otherwise valid. */
  selfSignedFor?: string;
}
type ProbeResult = ProbeOk | ProbeFail;

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Strip trailing slash so `${url}/path` doesn't double-slash.
  return url.replace(/\/+$/, '');
}

function isCertError(err: any): boolean {
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  return (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  );
}

async function probe(url: string, caBundle?: string): Promise<ProbeResult> {
  // If the caller supplied a CA bundle, build a one-shot dispatcher for this
  // probe so we can validate the bundle before saving it into the profile.
  let dispatcher: any = undefined;
  if (caBundle) {
    try {
      const ca = readFileSync(expandHome(caBundle), 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const undici = require('undici') as { Agent: new (opts: any) => any };
      dispatcher = new undici.Agent({ connect: { ca } });
    } catch (err) {
      return { ok: false, reason: `cannot read CA bundle: ${(err as Error).message}` };
    }
  }

  let res: Response;
  try {
    res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } as any : {}),
    });
  } catch (err: any) {
    if (isCertError(err)) {
      return { ok: false, reason: 'self-signed or untrusted TLS certificate', selfSignedFor: url };
    }
    const code = err?.cause?.code || err?.code || err?.name || 'unknown';
    return { ok: false, reason: `connection failed (${code})` };
  }

  if (res.status !== 200) {
    return { ok: false, reason: `health endpoint returned HTTP ${res.status}` };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'health endpoint did not return JSON' };
  }

  if (!body || body.service !== 'capy') {
    return { ok: false, reason: 'not a Capy service (missing `service: "capy"` in /health response)' };
  }

  return { ok: true, url, caBundle: caBundle ? expandHome(caBundle) : undefined };
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

async function promptForUrl(initial?: string): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { url } = await inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: 'Enter your BYOC URL:',
      default: initial,
      validate: (input: string) => {
        if (!input.trim()) return 'URL required';
        try {
          new URL(normalizeUrl(input));
          return true;
        } catch {
          return 'Invalid URL';
        }
      },
    },
  ]);
  return normalizeUrl(url);
}

async function promptForCaBundle(): Promise<string | null> {
  const inquirer = (await import('inquirer')).default;
  const { trust } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'trust',
      message: 'TLS cert is self-signed. Trust it via a CA bundle?',
      default: true,
    },
  ]);
  if (!trust) return null;

  const { path } = await inquirer.prompt([
    {
      type: 'input',
      name: 'path',
      message: 'Path to the CA bundle (e.g. caddy-root.crt):',
      validate: (input: string) => {
        if (!input.trim()) return 'Path required';
        try {
          readFileSync(expandHome(input.trim()), 'utf-8');
          return true;
        } catch {
          return 'File not readable';
        }
      },
    },
  ]);
  return path.trim();
}

async function promptForProfileName(suggested: string): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const existing = readProfileConfig();
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Profile name:',
      default: suggested,
      validate: (input: string) => {
        if (!input.trim()) return 'Name required';
        if (!/^[a-z0-9][a-z0-9-_]*$/i.test(input.trim())) {
          return 'Use letters, digits, hyphen, underscore';
        }
        return true;
      },
    },
  ]);
  const chosen = name.trim();

  if (existing?.profiles[chosen] && existing.profiles[chosen].url) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Profile "${chosen}" already exists (${existing.profiles[chosen].url}). Overwrite?`,
        default: false,
      },
    ]);
    if (!confirm) {
      // Prompt again rather than silently appending a suffix — the user
      // should explicitly choose a different name.
      return promptForProfileName(chosen);
    }
  }

  return chosen;
}

/**
 * The probe-and-prompt loop. Tries `initial` first, then keeps asking on
 * failure. The only way out (other than success) is the user hitting
 * Ctrl-C, which the top-level uncaughtException handler converts into a
 * clean exit.
 */
async function probeWithRetries(initial: string): Promise<ProbeOk> {
  let url = initial;
  let caBundle: string | undefined;

  while (true) {
    process.stdout.write(`Trying ${url}/health ... `);
    const result = await probe(url, caBundle);

    if (result.ok) {
      console.log(GREEN('✓') + ' found (capy service detected)');
      return result;
    }

    console.log(RED('✗') + ' ' + result.reason);

    if (result.selfSignedFor === url && !caBundle) {
      // Offer the CA-bundle path first — most likely fix when the URL is
      // right and only the cert is self-signed.
      const bundle = await promptForCaBundle();
      if (bundle) {
        caBundle = bundle;
        continue; // re-probe the same URL with the bundle
      }
      // User declined; fall through to URL prompt.
    }

    url = await promptForUrl(url);
    caBundle = undefined; // new URL, drop the old bundle assumption
  }
}

/**
 * Prompt for the recovery phrase that seeds the master key. Either generate a
 * fresh 24-word phrase (shown once, with a save-confirmation gate) or accept an
 * existing one. Returns the validated phrase.
 */
async function promptForRecoveryPhrase(): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Local key:',
      choices: [
        { name: 'Generate a new recovery phrase', value: 'generate' },
        { name: 'Enter an existing recovery phrase', value: 'enter' },
      ],
    },
  ]);

  if (mode === 'enter') {
    const { phrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'phrase',
        message: 'Enter your 24-word recovery phrase:',
        mask: '*',
        validate: (input: string) =>
          validateSeedPhrase(input.trim()) || 'Invalid 24-word BIP-39 phrase',
      },
    ]);
    return phrase.trim();
  }

  const phrase = generateSeedPhrase();
  await displayAndConfirmRecoveryPhrase(phrase, [
    'This recovery phrase generates the master key for',
    'every project on this machine.',
    '',
    '1) Only you have it — it is never sent anywhere',
    '2) It only exists here and now, and cannot be',
    '   retrieved when lost',
    '',
    'Local mode stores secrets ONLY on this machine.',
    'IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU!',
  ]);
  return phrase;
}

/** Prompt for a local passphrase with confirmation. */
async function promptForPassphrase(): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  while (true) {
    const { passphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Set a local passphrase (locks your key on this machine):',
        mask: '*',
        validate: (input: string) =>
          input.length >= 8 || 'Use at least 8 characters',
      },
    ]);
    const { confirm } = await inquirer.prompt([
      {
        type: 'password',
        name: 'confirm',
        message: 'Confirm passphrase:',
        mask: '*',
      },
    ]);
    if (passphrase === confirm) return passphrase;
    console.log(RED('✗') + ' Passphrases do not match. Try again.');
  }
}

/**
 * Derive M from a recovery phrase, wrap it at rest with a passphrase, save the
 * `local` profile, and open an unlocked session. Shared by the TTY (`localSetup`)
 * and browser (`localSetupWeb`) onboarding paths so the crypto/writes are
 * identical regardless of how the phrase + passphrase were collected. Throws on
 * failure. The phrase is consumed here and never returned or logged.
 */
export function finalizeLocalSetup(phrase: string, passphrase: string): void {
  const masterKey = seedPhraseToMasterKey(phrase);
  saveLocalKey(masterKey, passphrase);
  saveAndActivateProfile('local', { url: 'local://', localOnly: true, displayName: 'Local (this machine only)' });
  saveLocalSession(masterKey.toString('hex'));
}

/**
 * Local-only setup: derive M from a recovery phrase, wrap it at rest with a
 * passphrase, save the `local` profile, and open an unlocked session. No URL,
 * no probe, no server.
 */
async function localSetup(): Promise<number> {
  console.log(DIM('  Secrets will be stored only on this machine. No server, no account.'));
  console.log('');

  const phrase = await promptForRecoveryPhrase();
  const passphrase = await promptForPassphrase();

  try {
    finalizeLocalSetup(phrase, passphrase);
  } catch (err: any) {
    console.error(`Failed to set up local mode: ${err.message}`);
    return 1;
  }

  console.log('');
  console.log(`${GREEN('✓')} Local mode ready — profile ${B('local')} active`);
  console.log('');
  console.log(`  Run ${B('capy')} in a project directory to start.`);
  console.log(DIM('  Lock the key any time with `capy lock`.'));
  console.log('');
  return 0;
}

/**
 * Browser-rendered local-only setup (`capy byoc --web`). The recovery phrase is
 * shown in the loopback page and never touches this terminal — so an agent
 * driving this through the MCP never sees it.
 */
async function localSetupWeb(): Promise<number> {
  const { runLocalOnboardingWeb } = await import('../ui/onboardingWeb');
  console.log(DIM('  Setting up local mode in your browser — your recovery phrase stays in the page, never the terminal.'));

  let ok = false;
  try {
    ok = await runLocalOnboardingWeb(
      (phrase, passphrase) => finalizeLocalSetup(phrase, passphrase),
      { open: !process.env.CAPY_WEB_NO_OPEN },
    );
  } catch (err: any) {
    console.error(`Failed to set up local mode: ${err.message}`);
    return 1;
  }
  if (!ok) {
    console.log('');
    console.log('  Setup cancelled.');
    return 1;
  }

  console.log('');
  console.log(`${GREEN('✓')} Local mode ready — profile ${B('local')} active`);
  console.log('');
  console.log(`  Run ${B('capy')} in a project directory to start.`);
  console.log(DIM('  Lock the key any time with `capy lock`.'));
  console.log('');
  return 0;
}

async function promptUseLocalMode(): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { local } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'local',
      message: 'Use in local mode? (secrets are only stored on this machine)',
      default: false,
    },
  ]);
  return local;
}

export async function byocCommand(
  initialUrl?: string,
  opts: { web?: boolean } = {},
): Promise<number> {
  console.log('');

  // --web currently drives the local-only setup in the browser (the offline
  // first-run path, where the recovery phrase must stay off the terminal).
  if (opts.web) {
    return localSetupWeb();
  }

  // Ask first: local-only mode skips the URL probe entirely — there is no
  // server to reach.
  if (await promptUseLocalMode()) {
    return localSetup();
  }

  const startUrl = normalizeUrl(initialUrl || DEFAULT_URL);

  let result: ProbeOk;
  try {
    result = await probeWithRetries(startUrl);
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    return 1;
  }

  const suggested = deriveProfileName(result.url);
  const name = await promptForProfileName(suggested);

  const profile: Profile = { url: result.url };
  if (result.caBundle) profile.caBundle = result.caBundle;

  try {
    saveAndActivateProfile(name, profile);
  } catch (err: any) {
    console.error(`Failed to save profile: ${err.message}`);
    return 1;
  }

  console.log('');
  console.log(`${GREEN('✓')} Saved profile ${B(name)} and switched`);
  console.log('');
  console.log(`  Run ${B('capy')}.`);
  console.log(DIM('  (first authenticated command triggers login)'));
  console.log('');

  return 0;
}
