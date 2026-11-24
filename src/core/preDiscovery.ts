/**
 * Pre-discovery for `capy setup` (CAP-891): which integrations this folder looks like it uses, and the command that
 * comes next for each. It reads local signals only: whether a few well-known files exist, the NAMES of the variables
 * in `.env`, and whether a token variable is set in the environment. It never reads a value, never calls a provider
 * and never opens the organization's system store.
 *
 * `capy connect <provider> --discover` and `capy deploy <provider> --discover` are the real discovery, and they need
 * a provider token that an owner or admin keeps in the system store. Setup cannot see that store without opening it
 * (which is owners/admins only and creates it when it is missing), so the token is reported as `present` only when the
 * fallback environment variable is set, and `unknown` otherwise. The dry run named in `next` answers with a coded
 * refusal when the token is missing.
 *
 * Pure: every input is a parameter.
 */
import { DEFAULT_TOKEN_ENV as DOKPLOY_TOKEN_ENV, DOKPLOY_BASE_URL_VAR_NAME, DOKPLOY_CONNECTOR_SECRET_NAME } from '../deploy/dokployApi';
import { DEFAULT_VERCEL_TOKEN_ENV, VERCEL_CONNECTOR_SECRET_NAME } from '../deploy/vercelApi';

export interface PreDiscoveryInput {
  /** Whether a path, relative to the folder, exists. */
  readonly exists: (relativePath: string) => boolean;
  /** The names of the variables in the folder's `.env`. Never the values. */
  readonly envNames: readonly string[];
  /** Whether an environment variable of this name is set to something. */
  readonly envIsSet: (name: string) => boolean;
  /** The binary the next commands start with (`capy`, `capy-dev`, `capy-staging`). */
  readonly bin: string;
}

export interface IntegrationToken {
  /** The system store entry discovery reads. */
  readonly name: string;
  /** `present`: the fallback environment variable is set. `unknown`: setup cannot tell; the dry run in `next` can. */
  readonly state: 'present' | 'unknown';
  /** The environment variable that stands in for the system store entry. */
  readonly env: string;
  /** How an owner or admin saves the token (hidden prompt; a person runs it, in a terminal). */
  readonly set: string;
}

export interface Integration {
  readonly provider: 'vercel' | 'dokploy' | 'stripe' | 'workos';
  /** What was found: file names, and variable names prefixed with `.env:` or `env:`. Names only. */
  readonly found: readonly string[];
  /** Present for the providers whose discovery needs a token from the system store. */
  readonly token?: IntegrationToken;
  /** Other system store entries discovery reads that are not secrets (a dashboard URL), and how to save each. */
  readonly settings?: readonly { readonly name: string; readonly set: string }[];
  /** The command that comes next for this provider. It changes nothing. */
  readonly next: string;
}

const VERCEL_FILES = ['.vercel/project.json', 'vercel.json'] as const;

function token(input: PreDiscoveryInput, name: string, env: string): IntegrationToken {
  return { name, state: input.envIsSet(env) ? 'present' : 'unknown', env, set: `${input.bin} system set ${name}` };
}

function vercel(input: PreDiscoveryInput): readonly Integration[] {
  const found = [
    ...VERCEL_FILES.filter((file) => input.exists(file)),
    ...(input.envIsSet(DEFAULT_VERCEL_TOKEN_ENV) ? [`env:${DEFAULT_VERCEL_TOKEN_ENV}`] : []),
  ];
  if (found.length === 0) return [];
  return [{
    provider: 'vercel',
    found,
    token: token(input, VERCEL_CONNECTOR_SECRET_NAME, DEFAULT_VERCEL_TOKEN_ENV),
    next: `${input.bin} connect vercel --discover --dry-run --json`,
  }];
}

/** Dokploy leaves no file in a repo, so the only local signals are variable names. */
function dokploy(input: PreDiscoveryInput): readonly Integration[] {
  const found = [
    ...input.envNames.filter((name) => /DOKPLOY/i.test(name)).map((name) => `.env:${name}`),
    ...(input.envIsSet(DOKPLOY_TOKEN_ENV) ? [`env:${DOKPLOY_TOKEN_ENV}`] : []),
  ];
  if (found.length === 0) return [];
  return [{
    provider: 'dokploy',
    found,
    token: token(input, DOKPLOY_CONNECTOR_SECRET_NAME, DOKPLOY_TOKEN_ENV),
    // Discovery also needs the dashboard URL, which is a system store entry of its own (or `--base-url`).
    settings: [{ name: DOKPLOY_BASE_URL_VAR_NAME, set: `${input.bin} system set ${DOKPLOY_BASE_URL_VAR_NAME}` }],
    next: `${input.bin} connect dokploy --discover --dry-run --json`,
  }];
}

function byNames(input: PreDiscoveryInput, provider: 'stripe' | 'workos', pattern: RegExp): readonly Integration[] {
  const found = input.envNames.filter((name) => pattern.test(name)).map((name) => `.env:${name}`);
  return found.length === 0 ? [] : [{ provider, found, next: `${input.bin} connect ${provider}` }];
}

/** The integrations this folder shows signs of, in a fixed order. Empty when it shows none. */
export function preDiscover(input: PreDiscoveryInput): readonly Integration[] {
  return [
    ...vercel(input),
    ...dokploy(input),
    ...byNames(input, 'stripe', /^STRIPE_/i),
    ...byNames(input, 'workos', /^WORKOS_/i),
  ];
}
