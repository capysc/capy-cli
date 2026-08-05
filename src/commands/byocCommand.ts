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
// Type-only: erased at compile time, so the TTY path does not pull the browser
// screens into its module graph.
import type { ProbeCode, ProbeOutcome } from '../ui/screens/contract';

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
  /** Machine-readable outcome, always `ok` here. */
  code: ProbeCode;
  reason: string;
}
interface ProbeFail {
  ok: false;
  reason: string;
  /**
   * Why it failed, as a code.
   *
   * The reason is the sentence a human reads; this is what anything decides
   * on. Exactly one code opens the CA-bundle sub-flow, and picking that out by
   * searching for "self-signed" in a string is a bug waiting for a reword —
   * which is what `selfSignedFor` was standing in for before this existed.
   */
  code: ProbeCode;
  /** `err.cause.code || err.code || err.name` on a transport failure. */
  transportCode?: string;
  /** Set when `code` is `http_status`. */
  httpStatus?: number;
  /** What the untrusted certificate says. Best effort; only on `tls_untrusted`. */
  cert?: ProbeOutcome['cert'];
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

/**
 * Ask `{url}/health` whether it is a Capy service.
 *
 * `withCert` is opt-in and costs a second handshake, so only the browser flow
 * asks for it: that flow puts the certificate on screen before asking anyone
 * to trust its authority, and the terminal has nowhere to show it and would be
 * paying up to four extra seconds to print the same one red line.
 */
async function probe(
  url: string,
  caBundle?: string,
  opts: { withCert?: boolean } = {},
): Promise<ProbeResult> {
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
      return {
        ok: false,
        code: 'ca_unreadable',
        reason: `cannot read CA bundle: ${(err as Error).message}`,
      };
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
      return {
        ok: false,
        code: 'tls_untrusted',
        reason: 'self-signed or untrusted TLS certificate',
        // Best effort, and only once we already know the handshake failed on
        // trust: the browser flow asks the user to trust a certificate
        // authority, and the terminal asks that with a default of yes while
        // showing nothing about the certificate at all.
        cert: opts.withCert ? await peekCertificate(url) : undefined,
      };
    }
    const code = err?.cause?.code || err?.code || err?.name || 'unknown';
    return {
      ok: false,
      code: 'connection_failed',
      reason: `connection failed (${code})`,
      transportCode: String(code),
    };
  }

  if (res.status !== 200) {
    return {
      ok: false,
      code: 'http_status',
      reason: `health endpoint returned HTTP ${res.status}`,
      httpStatus: res.status,
    };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'not_json', reason: 'health endpoint did not return JSON' };
  }

  if (!body || body.service !== 'capy') {
    return {
      ok: false,
      code: 'not_capy',
      reason: 'not a Capy service (missing `service: "capy"` in /health response)',
    };
  }

  return {
    ok: true,
    code: 'ok',
    reason: 'found (capy service detected)',
    url,
    caBundle: caBundle ? expandHome(caBundle) : undefined,
  };
}

/**
 * Read what the untrusted certificate actually says.
 *
 * A second handshake with verification off, purely to look: the fetch above
 * has already refused this endpoint, and nothing is sent — no credentials, no
 * request, the socket is closed as soon as the peer's certificate is on the
 * table. Best effort throughout; an instance that will not complete even an
 * unverified handshake simply has no facts to show, and the flow says so by
 * having none rather than by inventing any.
 */
async function peekCertificate(url: string): Promise<ProbeOutcome['cert']> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'https:') return undefined;

  const tls = await import('tls');
  return new Promise((resolve) => {
    const done = (value: ProbeOutcome['cert']): void => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const socket = tls.connect(
      {
        host: target.hostname,
        port: Number(target.port) || 443,
        servername: target.hostname,
        rejectUnauthorized: false,
      },
      () => {
        const peer = socket.getPeerCertificate();
        if (!peer || !peer.subject) return done(undefined);
        const expiresAt = new Date(peer.valid_to);
        const valid = !Number.isNaN(expiresAt.getTime());
        // A DN field can repeat (two OUs, two CNs), and node hands back an
        // array when it does. One line either way.
        const one = (v: string | string[] | undefined): string | undefined =>
          Array.isArray(v) ? v.join(', ') : v;
        done({
          subject: one(peer.subject.CN) || one(peer.subject.O) || '(unnamed)',
          issuer: one(peer.issuer?.CN) || one(peer.issuer?.O) || '(unnamed)',
          // Already formatted here, because the screen treats it as display.
          expires: valid ? expiresAt.toISOString().slice(0, 10) : peer.valid_to,
          expired: valid ? expiresAt.getTime() < Date.now() : false,
        });
      },
    );
    socket.on('error', () => done(undefined));
    const timer = setTimeout(() => done(undefined), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
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

    if (result.code === 'tls_untrusted' && !caBundle) {
      // Offer the CA-bundle path first — most likely fix when the URL is
      // right and only the cert is self-signed. Keyed off the code, never off
      // the sentence: this is the one outcome that opens the sub-flow.
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
  await displayAndConfirmRecoveryPhrase(phrase, LOCAL_PHRASE_NOTES);
  return phrase;
}

/**
 * The warning the CLI prints beside a local-mode recovery phrase.
 *
 * Named so the browser path can carry the same words. Two wordings for one
 * warning is the thing that makes a product feel like two products, and this
 * particular warning is the one nobody gets a second chance to read.
 */
export const LOCAL_PHRASE_NOTES = [
  'This recovery phrase generates the master key for',
  'every project on this machine.',
  '',
  '1) Only you have it — it is never sent anywhere',
  '2) It only exists here and now, and cannot be',
  '   retrieved when lost',
  '',
  'Local mode stores secrets ONLY on this machine.',
  'IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU!',
];

/**
 * The floor a local passphrase has to clear.
 *
 * One definition, handed to the browser path as well: the page holds its
 * button on this number and the CLI refuses on it, and a page whose floor had
 * drifted from the validator's would offer a button that cannot be pressed.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

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
          input.length >= MIN_PASSPHRASE_LENGTH ||
          `Use at least ${MIN_PASSPHRASE_LENGTH} characters`,
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
      {
        open: !process.env.CAPY_WEB_NO_OPEN,
        bodyLines: LOCAL_PHRASE_NOTES,
        minPassphraseLength: MIN_PASSPHRASE_LENGTH,
      },
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

/**
 * Connect to a self-hosted instance, in the browser.
 *
 * The terminal's version of this is a `while (true)` whose only exit other than
 * success is Ctrl-C, so a run that mistypes a host it no longer remembers has
 * no way out at all. Here every step has a Cancel, and every failure keeps the
 * distinction between "that name did not resolve", "nothing is listening" and
 * "nothing answered in four seconds", which the terminal prints as three
 * variants of one red line and then asks the same question about.
 */
async function connectSetupWeb(initialUrl?: string): Promise<number> {
  const { connectByocInBrowser } = await import('../ui/byocScreens');
  const existing = readProfileConfig();

  const settled = await connectByocInBrowser({
    defaultUrl: normalizeUrl(initialUrl || DEFAULT_URL),
    urlSource: initialUrl ? 'argv' : 'builtin',
    probe: async (url, caBundle) => {
      const result = await probe(url, caBundle, { withCert: true });
      return {
        url,
        code: result.code,
        reason: result.reason,
        ...(result.ok
          ? {}
          : {
              httpStatus: result.httpStatus,
              transportCode: result.transportCode,
              cert: result.cert,
            }),
        ...(caBundle ? { caBundle } : {}),
      };
    },
    suggestName: deriveProfileName,
    existingProfiles: Object.entries(existing?.profiles ?? {})
      .filter(([, p]) => Boolean(p.url))
      .map(([name, p]) => ({ name, url: p.url!, active: existing?.default === name })),
    open: !process.env.CAPY_WEB_NO_OPEN,
  });

  if (settled.cancelled) {
    console.log('');
    console.log('  Cancelled. Every profile you already have is exactly as it was.');
    console.log('');
    return 1;
  }

  const profile: Profile = { url: settled.url };
  if (settled.caBundle) profile.caBundle = expandHome(settled.caBundle);

  try {
    saveAndActivateProfile(settled.profileName, profile);
  } catch (err: any) {
    console.error(`Failed to save profile: ${err.message}`);
    return 1;
  }

  console.log('');
  console.log(`${GREEN('✓')} Saved profile ${B(settled.profileName)} and switched`);
  console.log('');
  console.log(`  Run ${B('capy')}.`);
  console.log(DIM('  (first authenticated command triggers login)'));
  console.log('');
  return 0;
}

export async function byocCommand(
  initialUrl?: string,
  opts: { web?: boolean } = {},
): Promise<number> {
  console.log('');

  if (opts.web) {
    // "Use in local mode?" is the one question `--web` has no screen for: the
    // local flow renders a recovery phrase and the connect flow renders a
    // server URL, and neither screen has a fork to the other. The argument
    // answers it instead — `capy byoc <url>` is an address to connect to, and
    // `capy byoc` with nothing to connect to is the offline path. Until now
    // the URL was accepted and silently dropped, and local mode was set up
    // regardless.
    //
    // KNOWN DIVERGENCE, and it is a divergence in LOGIC rather than rendering,
    // which is the one thing `--web` is not supposed to do: `capy byoc <url>`
    // in a terminal can still answer yes and land in local mode, and here it
    // cannot. Closing it needs the question to exist as a step somebody can
    // answer — a fork at the head of `byoc-connect`, or a first stop of its
    // own — which is a packages/ui change this parcel reports rather than
    // makes. Until then the argument is the only signal there is, and reading
    // it beats dropping it.
    return initialUrl ? connectSetupWeb(initialUrl) : localSetupWeb();
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
