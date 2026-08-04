/**
 * The one place that decides HOW a URL reaches a person.
 *
 * Before this module the decision was `open(url)`, written out four times — in
 * `browserWizard`, in `deployTokenCommand`, in `index-dev`, and in the OAuth
 * server — which meant it was really four decisions that happened to agree.
 * They must not agree, because the two things being opened are not the same
 * kind of thing:
 *
 * `handoff` — AUTHENTICATION. This one needs the whole browser. The person has
 *   to be able to read the address bar, pick a profile, and move the window to
 *   whichever browser they are already signed into; a chromeless popup strands
 *   anyone whose session lives somewhere else. Nothing here is served by us.
 *
 * `dialog` — EVERY LOOPBACK SCREEN. The CLI is serving this itself, at
 *   127.0.0.1, behind a single-use nonce. There is no session, no cookie and
 *   nothing to sign into, so the browser's own chrome contributes nothing but
 *   the impression that a five-line question is a web page. A borderless
 *   window reads as what it is: the terminal asking something.
 *
 * WHAT THIS CANNOT DO. There is no operating-system "web dialog". The
 * chromeless window is a Chromium flag (`--app=`), so it exists for Chrome,
 * Edge, Brave, Arc, Vivaldi, Opera and Chromium, and does not exist for Safari
 * at all; Firefox's `-new-window` still draws a full window. So this resolves
 * the DEFAULT browser and asks whether that browser can do it — never forcing
 * Chrome on someone whose default is Safari, because opening a browser the
 * person does not use is a worse failure than an ordinary window.
 *
 * The fallback is therefore common, not exceptional, and must not feel like a
 * degraded mode: it is exactly today's behaviour, and the URL is printed to the
 * terminal in every case regardless.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:process';

/** What is being opened. See the module comment — these are not interchangeable. */
export type ScreenKind = 'handoff' | 'dialog';

/**
 * Which engine the default browser is, as a decision, not as a name.
 *
 * `chromium` is the only value that changes behaviour; the rest are recorded so
 * a diagnostic can say WHY a window came out ordinary.
 */
export type BrowserFamily = 'chromium' | 'firefox' | 'webkit' | 'unknown';

export interface DefaultBrowser {
  family: BrowserFamily;
  /** Absolute path to the executable, when one was resolvable. */
  exec?: string;
}

/**
 * What `openScreen` is going to do, as data.
 *
 * Separated from doing it so the decision can be tested without launching a
 * browser — which matters more than usual here, because the thing under test
 * is "which browser process do we start", and getting that wrong in a test run
 * means starting the developer's own browser.
 */
export type OpenPlan =
  | { via: 'app-window'; exec: string; args: string[] }
  | { via: 'default-browser' }
  | { via: 'suppressed' };

/** Chromium's own window, in CSS pixels. Matches the screens' narrow measure. */
const DIALOG_SIZE = { width: 520, height: 780 };
/** `--measure-wide` is 52rem; a listing needs the room plus its gutters. */
const WIDE_DIALOG_SIZE = { width: 940, height: 840 };

/**
 * Stable application identifiers, per platform, for the browsers that can draw
 * a chromeless window.
 *
 * These are registry keys, not display names: a macOS bundle identifier, a
 * freedesktop `.desktop` basename, a Windows ProgId. They are the handle the
 * operating system itself keys on, so they do not change when a browser is
 * renamed or localised.
 */
/**
 * macOS: bundle identifier to the name of the `.app` it lives in.
 *
 * The name is here rather than looked up because looking it up does not work.
 * `mdfind kMDItemCFBundleIdentifier == …` is the documented way and it returns
 * nothing on a machine with Spotlight indexing disabled or restricted — which
 * is not exotic, it is the first machine this was tested on. Failing that
 * lookup does not fail loudly; it just means the popup silently never appears
 * and nobody knows why.
 *
 * A macOS app bundle also names its binary after itself
 * (`Google Chrome.app/Contents/MacOS/Google Chrome`), so this one table
 * answers both questions. `mdfind` is still tried afterwards, for an install
 * somewhere unusual.
 */
const CHROMIUM_APPS = new Map([
  ['com.google.chrome', 'Google Chrome'],
  ['com.google.chrome.beta', 'Google Chrome Beta'],
  ['com.google.chrome.dev', 'Google Chrome Dev'],
  ['com.google.chrome.canary', 'Google Chrome Canary'],
  ['com.microsoft.edgemac', 'Microsoft Edge'],
  ['com.microsoft.edgemac.beta', 'Microsoft Edge Beta'],
  ['com.microsoft.edgemac.dev', 'Microsoft Edge Dev'],
  ['com.brave.browser', 'Brave Browser'],
  ['com.brave.browser.beta', 'Brave Browser Beta'],
  ['com.brave.browser.nightly', 'Brave Browser Nightly'],
  ['com.vivaldi.vivaldi', 'Vivaldi'],
  ['org.chromium.chromium', 'Chromium'],
]);

/**
 * Chromium-BASED is not the same as Chromium-COMPATIBLE, and the difference is
 * a window that never appears.
 *
 * Arc, Dia and Opera all render with Blink and all discard `--app=`: launching
 * their binary with it opens an ordinary window, or nothing at all, and the
 * person is left staring at a terminal that says it opened something. They are
 * deliberately absent from the set above so they take the ordinary-window path,
 * which is a thing that definitely works.
 */

const FIREFOX_BUNDLE_IDS = new Set([
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'org.mozilla.nightly',
  'org.mozilla.librewolf',
]);

const WEBKIT_BUNDLE_IDS = new Set(['com.apple.safari', 'com.apple.safaritechnologypreview']);

/** `.desktop` basenames (lowercased, suffix stripped) that are Chromium-based. */
const CHROMIUM_DESKTOP = [
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
  'vivaldi',
];

/** Windows ProgIds for the `https` UserChoice association. */
const CHROMIUM_PROGIDS = ['chromehtml', 'msedgehtm', 'bravehtml', 'vivaldihtm'];

/** Every probe is best-effort and short: a browser must never be what hangs a flow. */
const PROBE_TIMEOUT_MS = 1500;

function probe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** macOS: the `https` handler recorded in LaunchServices, as a bundle identifier. */
function macDefaultBundleId(): string | null {
  const plist = `${process.env.HOME ?? ''}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`;
  if (!existsSync(plist)) return null;
  const json = probe('plutil', ['-convert', 'json', '-o', '-', plist]);
  if (!json) return null;
  let parsed: { LSHandlers?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  for (const h of parsed.LSHandlers ?? []) {
    if (h.LSHandlerURLScheme === 'https' && typeof h.LSHandlerRoleAll === 'string') {
      return h.LSHandlerRoleAll.toLowerCase();
    }
  }
  // No entry at all means nothing has ever overridden the system default.
  return 'com.apple.safari';
}

/** macOS: the binary inside an app bundle, given the bundle's path. */
function macExecInBundle(app: string): string | undefined {
  const name = probe('defaults', ['read', `${app}/Contents/Info.plist`, 'CFBundleExecutable']);
  if (name) {
    const exec = `${app}/Contents/MacOS/${name}`;
    if (existsSync(exec)) return exec;
  }
  // `Foo.app` almost always contains `MacOS/Foo`; worth trying when the plist
  // read is the thing that failed.
  const fallback = `${app}/Contents/MacOS/${app.split('/').pop()!.replace(/\.app$/, '')}`;
  return existsSync(fallback) ? fallback : undefined;
}

/** macOS: bundle identifier to the binary inside the bundle. */
function macExecForBundle(bundleId: string): string | undefined {
  const appName = CHROMIUM_APPS.get(bundleId);
  if (appName) {
    for (const dir of ['/Applications', `${process.env.HOME ?? ''}/Applications`]) {
      const app = `${dir}/${appName}.app`;
      if (!existsSync(app)) continue;
      const exec = macExecInBundle(app);
      if (exec) return exec;
    }
  }
  // Installed somewhere unusual. Spotlight may or may not answer.
  const found = probe('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`])?.split('\n')[0];
  return found && existsSync(found) ? macExecInBundle(found) : undefined;
}

function detectDarwin(): DefaultBrowser {
  const id = macDefaultBundleId();
  if (!id) return { family: 'unknown' };
  if (WEBKIT_BUNDLE_IDS.has(id)) return { family: 'webkit' };
  if (FIREFOX_BUNDLE_IDS.has(id)) return { family: 'firefox' };
  if (!CHROMIUM_APPS.has(id)) return { family: 'unknown' };
  const exec = macExecForBundle(id);
  return exec ? { family: 'chromium', exec } : { family: 'chromium' };
}

function detectLinux(): DefaultBrowser {
  const entry = probe('xdg-settings', ['get', 'default-web-browser']);
  if (!entry) return { family: 'unknown' };
  const base = entry.replace(/\.desktop$/i, '').toLowerCase();
  if (base.includes('firefox')) return { family: 'firefox' };
  if (!CHROMIUM_DESKTOP.some((c) => base.startsWith(c))) return { family: 'unknown' };
  // `Exec=` carries field codes (%U, %F); the binary is the first token.
  const dirs = [
    `${process.env.HOME ?? ''}/.local/share/applications`,
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
  ];
  for (const dir of dirs) {
    const file = `${dir}/${entry}`;
    if (!existsSync(file)) continue;
    // Read it directly rather than shelling out to grep: a desktop-entry path
    // is attacker-adjacent only in theory, but there is no reason for a shell
    // to see it at all.
    let line: string | undefined;
    try {
      line = readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('Exec='));
    } catch {
      continue;
    }
    const bin = line?.slice('Exec='.length).trim().split(/\s+/)[0];
    if (bin && (bin.startsWith('/') ? existsSync(bin) : true)) {
      return { family: 'chromium', exec: bin };
    }
  }
  return { family: 'chromium' };
}

function detectWindows(): DefaultBrowser {
  const choice = probe('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
    '/v',
    'ProgId',
  ]);
  const progId = choice?.match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1]?.toLowerCase();
  if (!progId) return { family: 'unknown' };
  if (progId.startsWith('firefox')) return { family: 'firefox' };
  if (!CHROMIUM_PROGIDS.some((p) => progId.startsWith(p))) return { family: 'unknown' };
  const cmd = probe('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
  const exec = cmd?.match(/REG_SZ\s+"([^"]+)"/)?.[1];
  return exec && existsSync(exec) ? { family: 'chromium', exec } : { family: 'chromium' };
}

let cached: DefaultBrowser | undefined;

/** Resolve the default browser once per process. Never throws. */
export function defaultBrowser(): DefaultBrowser {
  if (cached) return cached;
  try {
    cached =
      platform === 'darwin'
        ? detectDarwin()
        : platform === 'win32'
          ? detectWindows()
          : detectLinux();
  } catch {
    cached = { family: 'unknown' };
  }
  return cached;
}

export interface PlanOptions {
  kind: ScreenKind;
  /** A listing screen wants the wide measure; everything else takes the narrow one. */
  wide?: boolean;
  /** Injected in tests. Defaults to the detected default browser. */
  browser?: DefaultBrowser;
  /** Injected in tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide, without doing anything.
 *
 * Precedence, and each step exists because of a way this can go wrong:
 *  1. `CAPY_WEB_NO_OPEN` — nothing opens. The test suite and every CI run set
 *     this, and it is the backstop that keeps a suite from launching the
 *     developer's browser.
 *  2. `CAPY_WEB_WINDOW=tab` — an escape hatch for anyone who wants the address
 *     bar back, without having to know why we took it away.
 *  3. `handoff` — an ordinary window, always. Never a popup.
 *  4. A Chromium default browser with a resolvable binary — the app window.
 *  5. Anything else — an ordinary window.
 */
export function planOpen(url: string, opts: PlanOptions): OpenPlan {
  const env = opts.env ?? process.env;
  if (env.CAPY_WEB_NO_OPEN) return { via: 'suppressed' };
  if (env.CAPY_WEB_WINDOW === 'tab') return { via: 'default-browser' };
  if (opts.kind === 'handoff') return { via: 'default-browser' };

  const browser = opts.browser ?? defaultBrowser();
  if (browser.family !== 'chromium' || !browser.exec) return { via: 'default-browser' };

  const { width, height } = opts.wide ? WIDE_DIALOG_SIZE : DIALOG_SIZE;
  return {
    via: 'app-window',
    exec: browser.exec,
    // `--app=` is what removes the chrome. The rest keeps the window from
    // inheriting session-restore tabs or a "Chrome didn't shut down correctly"
    // bubble over a question someone is being asked to answer.
    args: [
      `--app=${url}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
}

/**
 * Open `url` the way `kind` says to, best effort.
 *
 * Never throws and never rejects: the URL is printed to the terminal by every
 * caller before this runs, so a browser that will not start is an inconvenience
 * and not a failure of the flow.
 */
export async function openScreen(url: string, opts: PlanOptions): Promise<OpenPlan> {
  const plan = planOpen(url, opts);
  try {
    if (plan.via === 'app-window') {
      // Detached: the window outlives the CLI process, which is the whole point
      // for an ending page served just before exit.
      const child = spawn(plan.exec, plan.args, { detached: true, stdio: 'ignore' });
      child.on('error', () => void fallback(url));
      child.unref();
    } else if (plan.via === 'default-browser') {
      await fallback(url);
    }
  } catch {
    /* best-effort; the printed URL is the real fallback */
  }
  return plan;
}

async function fallback(url: string): Promise<void> {
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    /* best-effort */
  }
}
