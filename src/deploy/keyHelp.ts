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
 *     Vercel's own CLI points at `https://vercel.com/account/tokens`, which
 *     redirects (308) to this path.
 *   - Dokploy: inside the user's OWN Dokploy, Settings → Profile → API/CLI
 *     section (docs: https://docs.dokploy.com/docs/api, "go to the
 *     /settings/profile page and go to API/CLI Section and generate the
 *     token"). In the dashboard that page is `<base URL>/dashboard/settings/profile`.
 *     With no known base URL the docs page is the link.
 */

export interface KeyHelp {
  link: { label: string; url: string };
  /** One plain instruction for the human. */
  remedy: string;
}

export const VERCEL_TOKEN_PAGE_URL = 'https://vercel.com/account/settings/tokens';
export const DOKPLOY_API_DOCS_URL = 'https://docs.dokploy.com/docs/api';

const VERCEL_SECRET_NAMES: readonly string[] = ['_CONNECTOR_VERCEL_TOKEN', '_TARGET_VERCEL_TOKEN'];
const DOKPLOY_SECRET_NAMES: readonly string[] = ['_CONNECTOR_DOKPLOY_API_KEY', '_TARGET_DOKPLOY_API_KEY'];

/** Where to get the Vercel token `secretName` holds. */
export function vercelKeyHelp(secretName: string): KeyHelp {
  return {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    link: { label: 'Vercel token page', url: VERCEL_TOKEN_PAGE_URL },
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    remedy: `Create a token at the link and save it with \`capy system set ${secretName}\`, or run \`capy connect vercel --create-token\`.`,
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
  return {
    link: dokployKeyPage(baseUrl),
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    remedy: `Open the link, find the API/CLI section, generate a key, and save it with \`capy system set ${secretName}\`.`,
  };
}

/** Help for one of the four known key names; `null` for any other name. */
export function keyHelpForName(name: string, baseUrl?: string): KeyHelp | null {
  if (VERCEL_SECRET_NAMES.includes(name)) return vercelKeyHelp(name);
  if (DOKPLOY_SECRET_NAMES.includes(name)) return dokployKeyHelp(name, baseUrl);
  return null;
}

/** The two JSON/object fields, to spread into a refusal. */
export function keyHelpFields(help: KeyHelp): { link: { label: string; url: string }; remedy: string } {
  return { link: help.link, remedy: help.remedy };
}

/** Human text for stderr: the link, then the one instruction. */
export function formatKeyHelp(help: KeyHelp): string {
  return `  ${help.link.label}: ${help.link.url}\n  ${help.remedy}`;
}
