/**
 * Where to get an API key (Vince's rule: every time Capy asks for, or refuses
 * for lack of, a Vercel token or a Dokploy API key, it says where to get one).
 *
 * One shape for every surface — the hidden prompt, human refusals on stderr,
 * and the `--json` refusal objects — so an agent can relay `link` + `remedy`
 * to the human. `link` and `remedy` are the same field names as
 * `Blocked` in `ui/screens/contract.ts`.
 *
 * Pages (checked 2026-10-01):
 *   - Vercel: the dashboard's token page, `https://vercel.com/account/settings/tokens`.
 *     A `vercel login` session is OAuth and cannot create tokens, so the token
 *     must be made in the dashboard; Vercel has no org-owned key, but a token
 *     can be scoped to one team ("Scope").
 *   - Dokploy: inside the user's OWN Dokploy, Settings → Profile → API/CLI
 *     section (docs: https://docs.dokploy.com/docs/api, "go to the
 *     /settings/profile page and go to API/CLI Section and generate the
 *     token"). In the dashboard that page is `<base URL>/dashboard/settings/profile`.
 *     With no known base URL the docs page is the link.
 */

export interface KeyHelp {
  link: { label: string; url: string };
  /** The instructions for the human, as one string. */
  remedy: string;
  /** The same instructions, one per terminal line (stderr). */
  lines: readonly string[];
}

export const VERCEL_TOKEN_PAGE_URL = 'https://vercel.com/account/settings/tokens';
export const DOKPLOY_API_DOCS_URL = 'https://docs.dokploy.com/docs/api';

const VERCEL_SECRET_NAMES: readonly string[] = ['_CONNECTOR_VERCEL_TOKEN', '_TARGET_VERCEL_TOKEN'];
const DOKPLOY_SECRET_NAMES: readonly string[] = ['_CONNECTOR_DOKPLOY_API_KEY', '_TARGET_DOKPLOY_API_KEY'];

/** `save`: the key is saved with `capy system set` (refusals, non-interactive). `paste`: a hidden prompt follows right here. */
export type KeyHelpMode = 'save' | 'paste';

export interface KeyHelpOptions {
  /** Dokploy: the dashboard's base URL, so the link is that Dokploy's own page. */
  baseUrl?: string;
  /** Vercel: the slug of the team that owns the project, when Capy knows it. */
  team?: string;
  mode?: KeyHelpMode;
}

/**
 * A team id (`team_…`) is not a slug and is never shown as one; `--team`
 * takes either, so this is the one place that tells them apart.
 */
export function teamSlugOf(team: string | undefined): string | undefined {
  const trimmed = team?.trim();
  if (!trimmed || trimmed.startsWith('team_')) return undefined;
  return trimmed;
}

/** Where to get the Vercel token `secretName` holds. */
export function vercelKeyHelp(secretName: string, opts: KeyHelpOptions = {}): KeyHelp {
  const team = teamSlugOf(opts.team);
  // COPY-FLAG (approved wording)
  const first = `Create a token at ${VERCEL_TOKEN_PAGE_URL}. Set Scope to the team that owns the project${team ? ` (${team})` : ''}.`;
  // COPY-FLAG (approved wording)
  const second = opts.mode === 'paste' ? 'Then paste it here.' : `Then save it: capy system set ${secretName}`;
  return {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    link: { label: 'Vercel token page', url: VERCEL_TOKEN_PAGE_URL },
    remedy: `${first} ${second}`,
    lines: [first, second],
  };
}

export interface TokenProblemHelpOptions {
  /** True when the run waits for Enter to replace the token right here; the second step then says so. */
  pressEnter?: boolean;
}

/**
 * What to do when a Vercel token stops a run (rejected, or valid but without
 * access): two numbered steps. `remedy` is both, one per line.
 */
export function vercelTokenProblemHelp(secretName: string, opts: TokenProblemHelpOptions = {}): KeyHelp {
  // Approved wording.
  const first = `1) Create a token with team access at ${VERCEL_TOKEN_PAGE_URL}`;
  // Approved wording.
  const second = `2) Run capy system set ${secretName}${opts.pressEnter ? ' (or press enter to continue)' : ''}`;
  return {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    link: { label: 'Vercel token page', url: VERCEL_TOKEN_PAGE_URL },
    remedy: `${first}\n${second}`,
    lines: [first, second],
  };
}

/** The Dokploy page that makes API keys: inside the user's own Dokploy when its address is known, else the docs. */
export function dokployKeyPage(baseUrl: string | undefined): { label: string; url: string } {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  return base
    ? // COPY-FLAG: new user-facing string, minimal/neutral wording.
      { label: 'Dokploy API keys', url: `${base}/dashboard/settings/profile` }
    : // COPY-FLAG: new user-facing string, minimal/neutral wording.
      { label: 'Dokploy API docs', url: DOKPLOY_API_DOCS_URL };
}

/** Where to get the Dokploy API key `secretName` holds. */
export function dokployKeyHelp(secretName: string, baseUrl?: string): KeyHelp {
  const link = dokployKeyPage(baseUrl);
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const remedy = `Open ${link.url}, find the API/CLI section, generate a key, and save it with \`capy system set ${secretName}\`.`;
  return { link, remedy, lines: [remedy] };
}

/** Help for one of the four known key names; `null` for any other name. */
export function keyHelpForName(name: string, opts: KeyHelpOptions = {}): KeyHelp | null {
  if (VERCEL_SECRET_NAMES.includes(name)) return vercelKeyHelp(name, opts);
  if (DOKPLOY_SECRET_NAMES.includes(name)) return dokployKeyHelp(name, opts.baseUrl);
  return null;
}

/** The two JSON/object fields, to spread into a refusal. */
export function keyHelpFields(help: KeyHelp): { link: { label: string; url: string }; remedy: string } {
  return { link: help.link, remedy: help.remedy };
}

/** Human text for stderr: one line per instruction. A refusal that carries only `remedy` prints it as one line (the remedy already holds the link). */
export function formatKeyHelp(help: { remedy: string; lines?: readonly string[] }): string {
  return (help.lines ?? [help.remedy]).map((line) => `  ${line}`).join('\n');
}
