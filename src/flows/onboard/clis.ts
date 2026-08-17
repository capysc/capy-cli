// Which third-party CLIs Capy leans on, whether they are here, and WHY.
//
// The plan used to print `CLIs  stripe, vercel  (install + auth these)` — a
// bare list with no indication of which were already present, and no reason
// attached to any of them. Two names and an imperative is not something a
// person can act on: they cannot tell what is missing, and they cannot tell
// what breaks if they skip one.
//
// Capy never invokes these itself except through the CLI, so this file is a
// description of the CLI's real dependencies, not a policy. Each `why` names
// the operation that fails without it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliRequirement {
  cli: string;
  /** One clause: what stops working without it. */
  why: string;
  /** Present on PATH right now. */
  installed: boolean;
  /**
   * `deploy` is needed by any project that ships; `connector` only by the
   * providers this project actually uses. Separated so a caller can tell a
   * blocking gap from an optional one rather than reading the sentence.
   */
  kind: 'deploy' | 'connector';
}

/**
 * `gh` is not optional the way a vendor CLI is.
 *
 * Capy's CI-mode deploy is `git push` + `gh pr create` (`deploy/git.ts`), and
 * the GitHub Actions connector shells `gh` again to write repo secrets. So it
 * is listed for every project rather than only when a GitHub target was
 * detected: a project with no deploy target today still reaches for it the
 * first time secrets have to roll out anywhere.
 */
export const ALWAYS_NEEDED: Array<Omit<CliRequirement, 'installed'>> = [
  {
    cli: 'gh',
    kind: 'deploy',
    why: 'opens the rollout PR',
  },
];

/**
 * The CLIs for providers `capy connect` can actually drive today.
 *
 * Kept in step with `providers.ts`'s `status: 'implemented'` set by hand — one
 * entry, and a stale list here would have `capy_doctor` telling someone to
 * install a CLI for a connector that does not exist.
 */
export const PROVIDER_CLIS = ['stripe'];

/** Why each vendor CLI is wanted, keyed by the binary name the CLI shells. */
const WHY: Record<string, { why: string; kind: CliRequirement['kind'] }> = {
  gh: ALWAYS_NEEDED[0],
  stripe: { kind: 'connector', why: 'issues + rotates Stripe keys' },
  vercel: { kind: 'deploy', why: 'pushes secrets to Vercel' },
  wrangler: { kind: 'deploy', why: 'pushes secrets to Cloudflare' },
  aws: { kind: 'deploy', why: 'writes secrets to SSM' },
  fly: { kind: 'deploy', why: 'sets secrets on Fly.io' },
  supabase: { kind: 'connector', why: 'pairs Supabase' },
  'sentry-cli': { kind: 'connector', why: 'pairs Sentry' },
};

/**
 * Is `bin` on PATH?
 *
 * `which` rather than running the binary with `--version`: some of these are
 * slow to start, one of them (`aws`) can hit the network on startup in some
 * configurations, and none of that is worth paying to answer "does the file
 * exist". Mirrors what the CLI itself does in `deploy/git.ts`.
 */
export function isInstalled(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch {
    // No `which` (or spawn refused). Unknown is reported as missing: telling
    // someone to install something they already have costs a moment, and the
    // reverse costs them a failed deploy.
    return false;
  }
}

/**
 * The checklist: everything this project needs, each marked present or not.
 *
 * `names` are the CLIs the plan derived from the detected connectors and
 * deploy targets. `gh` is unioned in regardless — see ALWAYS_NEEDED.
 */
export function checkClis(names: string[]): CliRequirement[] {
  const wanted = [...new Set([...ALWAYS_NEEDED.map((r) => r.cli), ...names])];
  return wanted.map((cli) => {
    const meta = WHY[cli];
    return {
      cli,
      kind: meta?.kind ?? 'connector',
      // A CLI the plan surfaced but this file has no blurb for still gets a
      // row — silently dropping it would be worse than a generic sentence.
      why: meta?.why ?? 'needed by a detected integration',
      installed: isInstalled(cli),
    };
  });
}


/**
 * Is `bin` not just present but USABLE?
 *
 * Installed and authenticated are different failures with the same symptom —
 * `gh` on PATH with no token fails the rollout PR exactly like `gh` missing
 * does, and the checklist that only reports presence sends someone to
 * reinstall something they already have.
 *
 * `null` means "no cheap way to tell", which is reported as unknown rather
 * than guessed. Nothing here touches the network beyond what the vendor CLI
 * does locally, and each check is bounded so a hung binary cannot hang a tool
 * call.
 */
export type AuthState = 'ok' | 'missing' | 'unauthenticated' | 'unknown';

const AUTH_TIMEOUT_MS = 4000;

export function authState(cli: string): AuthState {
  if (!isInstalled(cli)) return 'missing';
  try {
    if (cli === 'gh') {
      // `gh auth status` exits non-zero when there is no usable token.
      const r = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: AUTH_TIMEOUT_MS });
      return r.status === 0 ? 'ok' : 'unauthenticated';
    }
    if (cli === 'stripe') {
      // A file read, not a spawn: `stripe` has no cheap status subcommand, and
      // its config is where the CLI itself looks for a usable key.
      const cfg = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'stripe', 'config.toml');
      if (!existsSync(cfg)) return 'unauthenticated';
      const body = readFileSync(cfg, 'utf8');
      // Any section holding a key at all. Whether it is EXPIRED or matches the
      // mode you want is the CLI's own gate (`stripeSessionGate`) and not
      // something to duplicate here — this only answers "have you ever paired".
      return /_api_key\s*=/.test(body) ? 'ok' : 'unauthenticated';
    }
  } catch {
    return 'unknown';
  }
  // vercel, wrangler, aws, fly: each has a status command, none of them cheap
  // or offline. Reported as unknown rather than paid for on every call.
  return 'unknown';
}

/** The checklist with auth resolved. Slower than `checkClis` — call deliberately. */
export function checkClisWithAuth(names: string[]): Array<CliRequirement & { auth: AuthState }> {
  return checkClis(names).map((r) => ({ ...r, auth: authState(r.cli) }));
}

/**
 * The health check with no project in hand.
 *
 * `capy_doctor` runs anywhere, including a directory Capy has never seen, so it
 * cannot derive which vendor CLIs THIS project needs. It reports the ones whose
 * absence is a problem regardless: `gh`, and the CLI for every provider Capy can
 * actually drive today — the answer to "could Capy do its credential work here
 * at all", which is a different question from "what does this repo use".
 */
export function baselineClis(): Array<CliRequirement & { auth: AuthState }> {
  const implemented = PROVIDER_CLIS;
  return checkClisWithAuth(implemented);
}
