import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConnectorModule, ConnectResult, RotateResult, ConnectOpts, RotateOpts } from './registry';
import { ConnectorMetadata } from '../../types/index';
import { ResolvedContext, fingerprint, keyTypePrefix } from './shared';
import { isInteractive, refuseNonInteractive } from '../../ui/interactive';
import type { Blocked } from '../../ui/screens/contract';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

const DEFAULT_VAR = 'WORKOS_API_KEY';

/**
 * The variable that decides WHICH key this connector touches.
 *
 * A WorkOS API key is not free-floating: it belongs to an application, which
 * belongs to an environment, and the environment is identified in the app's
 * config by its client ID. So `WORKOS_CLIENT_ID` sitting next to the key in
 * `.env` is the only thing that says which of the team's environments this
 * project actually talks to. Rotating without reading it would mint a key in
 * whichever environment happened to sort first and hand it to an app pointed
 * at a different one — a rotation that "succeeds" and takes production down.
 */
const CLIENT_ID_VAR = 'WORKOS_CLIENT_ID';

const GRAPHQL_URL = 'https://api.workos.com/graphql';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long the new key and the old one are both valid during a rotation.
 *
 * `expireKey` takes a future `expiredAt`, so the old key does not have to die
 * the instant the new one exists. That gap is the whole difference between a
 * rotation and an outage: `capy rotate` writes the new value to `.env` and
 * pushes it, but the deploy that picks it up happens on the user's schedule,
 * not ours. One hour is long enough for a deploy to land and short enough that
 * a leaked key is not left usable overnight.
 */
const OVERLAP_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Credential acquisition
// ---------------------------------------------------------------------------

export const WORKOS_CLI_MISSING: Blocked = {
  code: 'PROVIDER_CLI_MISSING',
  title: 'workos CLI not found.',
  detail:
    'Capy reads the credentials the WorkOS CLI already holds, so the CLI has to be on your PATH before this connector can run.',
  link: { label: 'WorkOS CLI', url: 'https://github.com/workos/cli' },
  remedy: 'npm i -g workos',
};

export const WORKOS_NOT_LOGGED_IN: Blocked = {
  code: 'PROVIDER_NOT_AUTHENTICATED',
  title: 'Not signed in to WorkOS.',
  detail:
    'The WorkOS CLI holds no credentials for this machine. Sign in once and Capy can read the session from then on.',
  link: { label: 'WorkOS CLI auth', url: 'https://github.com/workos/cli' },
  remedy: 'workos auth login',
};

/** Is `workos` on the PATH? The non-exiting half of `ensureWorkOSCliInstalled`. */
function workosCliInstalled(): boolean {
  try {
    execSync('workos --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function ensureWorkOSCliInstalled(): void {
  if (workosCliInstalled()) return;
  console.error(`\n  ${B('workos')} CLI not found.`);
  console.error(`  Install: ${WORKOS_CLI_MISSING.link!.url}`);
  console.error(`  Or: ${B(WORKOS_CLI_MISSING.remedy!)}\n`);
  process.exit(1);
}

interface WorkOSCredentials {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

export function isCredentials(parsed: unknown): parsed is WorkOSCredentials {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const c = parsed as Record<string, unknown>;
  return typeof c.accessToken === 'string' && typeof c.expiresAt === 'number';
}

const CREDENTIALS_FILE = () => join(homedir(), '.workos', 'credentials.json');

/**
 * WHY WE READ ANOTHER TOOL'S CREDENTIAL STORE.
 *
 * The same reason the Stripe connector reads `config.toml`: the provider CLI
 * has already done the browser round-trip, and making the user do a second one
 * for Capy would be a worse product. The WorkOS CLI keeps its blob in the
 * system keyring under service `workos-cli`, account `credentials`, and falls
 * back to `~/.workos/credentials.json` when the keyring is unavailable or when
 * the user passed `--insecure-storage`.
 *
 * We try the file first and the keyring second, which is the opposite of the
 * CLI's own order and deliberate: the file read cannot prompt, and on macOS a
 * keychain read by an unfamiliar binary can raise a system dialog. Reaching
 * for the quiet path first means the common case never interrupts anyone.
 */
function readStoredCredentials(): WorkOSCredentials | null {
  const fromFile = readCredentialsFile();
  if (fromFile) return fromFile;
  return readCredentialsKeyring();
}

function readCredentialsFile(): WorkOSCredentials | null {
  const path = CREDENTIALS_FILE();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isCredentials(parsed) ? parsed : null;
  } catch {
    // A malformed blob reads as logged-out rather than crashing the command —
    // the remedy is the same either way (`workos auth login`).
    return null;
  }
}

function readCredentialsKeyring(): WorkOSCredentials | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync('security find-generic-password -s workos-cli -a credentials -w', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed: unknown = JSON.parse(raw.trim());
    return isCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A usable access token, by whichever route costs the user least.
 *
 * THREE STEPS, CHEAPEST FIRST. The stored token if it is still good; a silent
 * refresh if not; and `workos auth login` — a browser hand-off — only when the
 * refresh cannot save it.
 *
 * The third step is what makes this safe to own. WorkOS refresh tokens are
 * single-use: `/oauth2/token` returns a replacement and retires the token
 * spent, and the CLI does not write its rotations to the file Capy reads
 * (`credentials.json` is byte-identical across a `workos` command that
 * succeeded well past expiry). So a refresh here can strand the CLI's stored
 * token, and the honest recovery is the same one the Stripe connector uses:
 * hand off to the provider's own login, let it re-establish its session, and
 * read what it wrote. No writing into another tool's credential store, and no
 * dead end for the user.
 *
 * Note the asymmetry with Stripe, which shells out to `stripe login` on EVERY
 * rotate. This logs in only when the session cannot be renewed, so the common
 * path stays unattended — which is why the module leaves `requiresAuth` unset
 * and announces the hand-off when it actually happens.
 */
async function ensureFreshToken(creds: WorkOSCredentials, nonTty?: boolean): Promise<string> {
  const skewMs = 60_000;
  if (creds.expiresAt - Date.now() > skewMs) return creds.accessToken;

  const refreshed = creds.refreshToken ? await tryRefreshAccessToken(creds.refreshToken) : undefined;
  if (refreshed) return refreshed;

  return loginAndReadToken(nonTty);
}

/**
 * Re-establish the WorkOS session by running the provider's own login, then
 * read the credential it wrote.
 *
 * Blocking and interactive by nature — `workos auth login` opens a browser and
 * waits — so stdio is inherited and the refusal comes first when there is
 * nobody to answer it.
 */
async function loginAndReadToken(nonTty?: boolean): Promise<string> {
  if (!isInteractive(nonTty)) {
    refuseNonInteractive(
      'your WorkOS session has expired and renewing it needs a browser sign-in',
      'Run `workos auth login`, then run this again.',
    );
  }

  console.log(`\n  Your WorkOS session has expired. Opening ${B('workos auth login')}.`);
  const result = spawnSync('workos', ['auth', 'login'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n  ${B('workos auth login')} failed or was cancelled. Nothing was changed.\n`);
    process.exit(1);
  }

  const renewed = readStoredCredentials();
  if (!renewed || renewed.expiresAt - Date.now() <= 0) {
    console.error(`\n  Signed in, but Capy could not read a usable WorkOS session afterwards.`);
    console.error(`  If you signed in with a different account, run ${B('workos auth status')} to check.\n`);
    process.exit(1);
  }
  return renewed.accessToken;
}

/**
 * The OAuth client the WorkOS CLI authenticates as, and the AuthKit domain it
 * authenticates against.
 *
 * BAKED IN, NOT READ FROM DISK, because that is where they live in the CLI
 * too — `cli.config.ts` holds both as constants and `getCliAuthClientId()` /
 * `getAuthkitDomain()` return them. `~/.workos/config.json` looks like it
 * should carry them and does not: its `clientId` fields are per-environment
 * WorkOS client IDs (`client_01JD4…`), a different thing entirely, and reading
 * one of those into the refresh grant sends the wrong client and fails every
 * renewal.
 *
 * Refreshing as the CLI's client is what makes reusing the CLI's session
 * coherent: the refresh token was issued to that client, so no other client
 * id can redeem it.
 */
const WORKOS_CLI_OAUTH_CLIENT_ID = 'client_01KFKHSZWK9ADVJV854PDFQCCR';
const WORKOS_AUTHKIT_DOMAIN = 'https://signin.workos.com';

/** Mirrors the CLI's own override so a staging AuthKit can be pointed at. */
function authkitDomain(): string {
  return process.env.WORKOS_AUTHKIT_DOMAIN || WORKOS_AUTHKIT_DOMAIN;
}

/**
 * Try to renew silently. Returns undefined rather than exiting on any failure,
 * because the caller has a better move than dying: hand off to `workos auth
 * login`. An expired-or-spent refresh token is the ordinary case here, not an
 * error worth a stack trace.
 */
async function tryRefreshAccessToken(refreshToken: string): Promise<string | undefined> {
  try {
    const res = await fetchJson(`${authkitDomain()}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: WORKOS_CLI_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
    const token = (res as Record<string, unknown>).access_token;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A GraphQL error carrying the server's own machine-readable code.
 *
 * The code is what callers branch on. WorkOS puts a stable enum in
 * `extensions.code` — `FORBIDDEN`, `BAD_USER_INPUT`, `GRAPHQL_VALIDATION_FAILED`
 * — alongside prose that exists for humans and changes without notice. The
 * message is carried for display only and must never be parsed.
 */
export class WorkOSGraphQLError extends Error {
  override readonly name = 'WorkOSGraphQLError';

  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

interface GraphQLResponse<T> {
  readonly data?: T | null;
  readonly errors?: ReadonlyArray<{
    readonly message?: string;
    readonly extensions?: {
      readonly code?: string;
      readonly exception?: { readonly status?: number };
    };
  }>;
}

async function graphql<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const body = await fetchJson(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      // The dashboard tags every call with the operation name and the server
      // logs it. Sending it keeps Capy's traffic legible on WorkOS's side
      // rather than anonymous.
      'x-operation-name': operationName,
    },
    body: JSON.stringify({ query, variables, operationName }),
  });
  const res = body as GraphQLResponse<T>;
  const firstError = res.errors?.[0];
  if (firstError) {
    throw new WorkOSGraphQLError(
      firstError.message ?? 'WorkOS request failed',
      firstError.extensions?.code,
      firstError.extensions?.exception?.status,
    );
  }
  if (res.data === undefined || res.data === null) {
    throw new WorkOSGraphQLError('WorkOS returned no data', undefined, undefined);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// Environment + key model
// ---------------------------------------------------------------------------

/**
 * NONE OF THESE OPERATIONS ARE PUBLIC API.
 *
 * `keys`, `createKey` and `expireKey` are the dashboard's own GraphQL, and
 * they are absent from both the WorkOS CLI's 357-operation catalog and the
 * WorkOS MCP's operation index. Schema introspection is disabled on the
 * endpoint, so these documents were derived by probing and confirmed against
 * live responses rather than read off a spec. They can change without notice,
 * and the connector's job when they do is to fail loudly on a typed code
 * rather than quietly mis-parse.
 *
 * One trap worth naming, because the names are nearly identical and the
 * catalog documents only the wrong half: ORGANIZATION keys use
 * `ExpireApiKeyInput { apiKeyId, expiresAt }`, while the ENVIRONMENT keys this
 * connector manages use `ExpireKeyInput { keyId, expiredAt }`. Different
 * field names, different noun, silently wrong results if crossed.
 */
const TEAM_ENVIRONMENTS_QUERY = `
  query teamProjectsV2 {
    currentTeam {
      projectsV2 {
        name
        environments { id name sandbox clientId }
      }
    }
  }
`;

const KEYS_QUERY = `
  query keys($environmentId: String!) {
    keys(environmentId: $environmentId) {
      data { id name displayValue applicationId expiredAt }
    }
  }
`;

const CREATE_KEY_MUTATION = `
  mutation createKey($input: CreateKeyInput!) {
    createKey(input: $input) {
      __typename
      ... on KeyCreated {
        key {
          key { id name createdAt applicationId }
          value
        }
      }
    }
  }
`;

const EXPIRE_KEY_MUTATION = `
  mutation expireKey($input: ExpireKeyInput!) {
    expireKey(input: $input) { __typename }
  }
`;

interface TeamEnvironment {
  readonly id: string;
  readonly name: string | null;
  readonly sandbox: boolean | null;
  readonly clientId: string | null;
}

export interface WorkOSKey {
  readonly id: string;
  readonly name: string | null;
  readonly displayValue: string | null;
  readonly applicationId: string | null;
  readonly expiredAt: string | null;
}

async function fetchEnvironments(token: string): Promise<readonly TeamEnvironment[]> {
  const data = await graphql<{
    currentTeam: {
      projectsV2: ReadonlyArray<{ name: string | null; environments: readonly TeamEnvironment[] | null }> | null;
    } | null;
  }>(token, 'teamProjectsV2', TEAM_ENVIRONMENTS_QUERY);
  const projects = data.currentTeam?.projectsV2 ?? [];
  return projects.flatMap((p) => p.environments ?? []);
}

async function fetchKeys(token: string, environmentId: string): Promise<readonly WorkOSKey[]> {
  const data = await graphql<{ keys: { data: readonly WorkOSKey[] } }>(
    token,
    'keys',
    KEYS_QUERY,
    { environmentId },
  );
  return data.keys.data;
}

/** The environment + application a given `WORKOS_CLIENT_ID` resolves to. */
interface ResolvedTarget {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly sandbox: boolean;
  readonly clientId: string;
}

/**
 * A WorkOS API key by SHAPE: `sk_test_` or `sk_live_` and a body.
 *
 * Same reasoning as the client ID below — the name is a convention and the
 * value is a fact. A project may hold the key as `WORKOS_SECRET`,
 * `WORKOS_API_KEY`, or something the team invented, and all of them are
 * unmistakable by prefix.
 *
 * Deliberately loose about the body. WorkOS keys observed here are
 * `sk_test_` + base64url of `<key_id>,<secret>`, but that is an encoding
 * Capy has no business pinning: a length or alphabet rule would start
 * rejecting real keys the day WorkOS changes it, and the prefix alone is
 * already specific enough that nothing else in a `.env` collides with it.
 */
const API_KEY_VALUE_RE = /^sk_(test|live)_\S+$/;

export function looksLikeWorkOSApiKey(value: string): boolean {
  return API_KEY_VALUE_RE.test(value.trim());
}

/** Does the NAME also suggest WorkOS? Only a tiebreaker, never qualifying. */
export function looksLikeWorkOSKeyName(name: string): boolean {
  return /workos/i.test(name);
}

export interface ApiKeyCandidate {
  readonly name: string;
  readonly byName: boolean;
}

/**
 * Every `.env` variable holding an `sk_test_`/`sk_live_` value, WorkOS-named
 * ones first.
 *
 * NOTE THE COLLISION THIS CANNOT RESOLVE ALONE: Stripe secret keys share the
 * `sk_test_`/`sk_live_` prefix exactly. Shape gets us the candidate set and
 * nothing more, which is why a name hint decides between them and why two
 * unnamed candidates are asked about rather than guessed. Picking wrong here
 * would point a WorkOS rotation at the variable holding a Stripe key.
 */
export function findApiKeyCandidates(
  env: Readonly<Record<string, string>>,
): readonly ApiKeyCandidate[] {
  const matches = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && looksLikeWorkOSApiKey(value))
    .map(([name]) => ({ name, byName: looksLikeWorkOSKeyName(name) }));
  return [...matches].sort(
    (a, b) => Number(b.byName) - Number(a.byName) || a.name.localeCompare(b.name),
  );
}

/**
 * Which variable holds the WorkOS key: the flag if given, else shape + name,
 * else ask.
 */
async function chooseApiKeyVar(ctx: ResolvedContext, opts: ConnectOpts): Promise<string> {
  if (opts.var) {
    const requested = opts.var.trim();
    if (!(requested in ctx.localPlaintext)) {
      console.error(`\n  ${B(requested)} is not in .env on branch ${ctx.branch}.`);
      console.error('  `connect` links an existing variable to a provider; it does not create one.\n');
      process.exit(1);
    }
    return requested;
  }

  const candidates = findApiKeyCandidates(ctx.localPlaintext);

  if (candidates.length === 0) {
    console.error(`\n  No WorkOS API key found in .env on branch ${ctx.branch}.`);
    console.error(`  Capy looked for a variable holding an ${B('sk_test_…')} or ${B('sk_live_…')} value`);
    console.error(`  (conventionally ${B(DEFAULT_VAR)}). Add it, run ${B('capy')} to sync, then connect,`);
    console.error(`  or name it explicitly with ${B('--var <NAME>')}.\n`);
    process.exit(1);
  }

  const named = candidates.filter((c) => c.byName);
  const unambiguous = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (unambiguous) {
    if (unambiguous.name !== DEFAULT_VAR) {
      console.log(`  Using ${B(unambiguous.name)} as the WorkOS API key.`);
    }
    return unambiguous.name;
  }

  if (!isInteractive(opts.nonTty)) {
    refuseNonInteractive(
      'which variable holds your WorkOS key is ambiguous without a prompt',
      `Pass --var <NAME> (candidates: ${candidates.map((c) => c.name).join(', ')}).`,
    );
  }

  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    {
      type: 'list',
      name: 'picked',
      message: 'Which variable holds your WorkOS API key?',
      choices: candidates.map((c) => ({
        name: c.byName ? `${c.name}  ${DIM('(looks like a WorkOS var)')}` : c.name,
        value: c.name,
      })),
      default: candidates[0].name,
    },
  ]);
  return picked;
}

/**
 * A WorkOS client ID by SHAPE: `client_` followed by a 26-character ULID body
 * in Crockford base32 (no I, L, O or U).
 *
 * The value is what identifies this variable, not the name. `WORKOS_CLIENT_ID`
 * is the documented spelling and plenty of projects use something else —
 * `AUTH_CLIENT_ID`, `NEXT_PUBLIC_WORKOS_CLIENT_ID`, `WORKOS_CLIENT`. Keying off
 * the name would refuse to work for all of them while the answer sits in the
 * file in an unmistakable format.
 */
const CLIENT_ID_VALUE_RE = /^client_[0-9A-HJKMNP-TV-Z]{26}$/i;

export function looksLikeWorkOSClientId(value: string): boolean {
  return CLIENT_ID_VALUE_RE.test(value.trim());
}

/** Does the NAME also suggest a WorkOS client ID? Only a tiebreaker. */
export function looksLikeClientIdName(name: string): boolean {
  return /client/i.test(name) && /workos|^client_?id$|auth/i.test(name);
}

export interface ClientIdCandidate {
  readonly name: string;
  readonly value: string;
  /** The name agrees with the value. Used to break ties, never to qualify. */
  readonly byName: boolean;
}

/**
 * Every `.env` variable whose value is shaped like a WorkOS client ID,
 * name-agreeing ones first.
 *
 * Shape is the qualifying test and the name is only a sort key, which is the
 * whole point: a project that calls it `AUTH_CLIENT_ID` is found, and a
 * project with a variable named `WORKOS_CLIENT_ID` holding a placeholder or a
 * Stripe id is not silently accepted because the name looked right.
 */
export function findClientIdCandidates(
  env: Readonly<Record<string, string>>,
): readonly ClientIdCandidate[] {
  const matches = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && looksLikeWorkOSClientId(value))
    .map(([name, value]) => ({ name, value, byName: looksLikeClientIdName(name) }));
  // Sorting a freshly built array — nothing outside this function has seen it.
  return [...matches].sort(
    (a, b) => Number(b.byName) - Number(a.byName) || a.name.localeCompare(b.name),
  );
}

/**
 * Pick the one client ID to rotate against, or explain why we cannot.
 *
 * Ambiguity is refused rather than guessed. Two client IDs in one `.env` is a
 * monorepo or a staging/production pair, and picking the alphabetically first
 * one there rotates a key the app in front of you does not use — the failure
 * mode is silent and lands in whichever environment was not being watched.
 */
async function chooseClientId(ctx: ResolvedContext, nonTty?: boolean): Promise<ClientIdCandidate> {
  const candidates = findClientIdCandidates(ctx.localPlaintext);

  if (candidates.length === 0) {
    console.error(`\n  No WorkOS client ID found in .env on branch ${ctx.branch}.`);
    console.error('  A WorkOS API key belongs to one environment, and the client ID is what');
    console.error(`  says which. Capy looked for a variable holding a ${B('client_…')} value`);
    console.error(`  (conventionally ${B(CLIENT_ID_VAR)}). Add it, run ${B('capy')} to sync, then connect.\n`);
    process.exit(1);
  }

  const named = candidates.filter((c) => c.byName);
  const unambiguous = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;

  if (unambiguous) {
    // Say which variable was used whenever it is not the conventional name, so
    // a fuzzy match is never a silent one.
    if (unambiguous.name !== CLIENT_ID_VAR) {
      console.log(`  Using ${B(unambiguous.name)} as the WorkOS client ID.`);
    }
    return unambiguous;
  }

  // Genuinely ambiguous: a monorepo, or a staging/production pair in one file.
  // Ask, because the user knows which app this directory is and Capy does not.
  if (!isInteractive(nonTty)) {
    refuseNonInteractive(
      'more than one WorkOS client ID is present and picking one is ambiguous without a prompt',
      `Candidates: ${candidates.map((c) => c.name).join(', ')}. Leave only the one this project uses.`,
    );
  }

  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    {
      type: 'list',
      name: 'picked',
      message: 'Which variable holds the WorkOS client ID for this project?',
      choices: candidates.map((c) => ({
        name: `${c.name}  ${DIM(c.value)}`,
        value: c.name,
      })),
      default: candidates[0].name,
    },
  ]);
  return candidates.find((c) => c.name === picked) ?? candidates[0];
}

/**
 * Join the `.env` client ID against the team's environments.
 *
 * Exits rather than guessing when the join misses. A client ID the signed-in
 * account cannot see means one of two things — the wrong WorkOS account, or a
 * client ID belonging to an environment that was deleted — and both are
 * resolved by a human looking at it, not by falling back to a default. The
 * default in this shape is "some other environment's production key".
 */
async function resolveTarget(
  ctx: ResolvedContext,
  token: string,
  nonTty?: boolean,
): Promise<ResolvedTarget> {
  const { name: clientIdVar, value: clientId } = await chooseClientId(ctx, nonTty);
  const environments = await fetchEnvironments(token);
  const match = environments.find((e) => e.clientId === clientId);
  if (!match) {
    console.error(`\n  No WorkOS environment matches ${B(clientIdVar)} (${clientId}).`);
    console.error('  Either the signed-in WorkOS account is not the one that owns this');
    console.error(`  environment, or the environment no longer exists. Check with ${B('workos auth status')}.\n`);
    process.exit(1);
  }
  return {
    environmentId: match.id,
    environmentName: match.name ?? match.id,
    sandbox: match.sandbox ?? false,
    clientId,
  };
}

/**
 * The key the project is actually using, found by matching `.env`'s value
 * against the environment's keys.
 *
 * Matching on the value rather than trusting a recorded key id is what makes
 * `rotate` safe to run against an environment somebody has edited in the
 * dashboard since `connect`. If the id we recorded was deleted there, this
 * misses and the caller refuses, instead of expiring whatever now sits at that
 * position.
 */
export function findKeyByValue(keys: readonly WorkOSKey[], value: string): WorkOSKey | undefined {
  return keys.find((k) => k.displayValue === value);
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

/**
 * `connect` RECORDS A LINK AND WRITES NO VALUE.
 *
 * The variable keeps whatever it already held. Returning a `value` here would
 * make `connect` overwrite the user's key with whatever WorkOS happens to list
 * first — a credential operation on a command whose name promises an
 * association. That is `rotate`'s job, and the interface's `ConnectResult.value`
 * doc says so at length after Stripe learned it the hard way.
 */
async function connect(ctx: ResolvedContext, opts: ConnectOpts): Promise<ConnectResult> {
  const varName = await chooseApiKeyVar(ctx, opts);

  if (!(varName in ctx.localPlaintext)) {
    console.error(`\n  ${B(varName)} is not in .env on branch ${ctx.branch}.`);
    console.error('  `connect` links an existing variable to a provider; it does not create one.');
    console.error(`  Add ${B(varName)} to .env, run ${B('capy')} to sync, then connect it.\n`);
    process.exit(1);
  }

  const creds = readStoredCredentials();
  if (!creds) {
    console.error(`\n  ${WORKOS_NOT_LOGGED_IN.title}`);
    console.error(`  Run ${B(WORKOS_NOT_LOGGED_IN.remedy!)} and try again.\n`);
    process.exit(1);
  }
  const token = await ensureFreshToken(creds, opts.nonTty);
  const target = await resolveTarget(ctx, token, opts.nonTty);

  const current = ctx.localPlaintext[varName];
  const keys = await fetchKeys(token, target.environmentId);
  const matched = findKeyByValue(keys, current);

  if (!matched) {
    // Not fatal. The link is still worth recording: the value in `.env` may be
    // a production key whose plaintext WorkOS will not return (it is shown
    // once, at creation), and a connector that refused those would refuse
    // exactly the variables most worth rotating.
    console.log(`\n  Linked ${B(varName)} to WorkOS (${target.environmentName}).`);
    console.log('  Capy could not match the current value against a key WorkOS will show,');
    console.log('  which is expected for a production key. Rotation will mint a new key');
    console.log('  in this environment and expire the one it replaces.\n');
  } else {
    console.log(`\n  Linked ${B(varName)} to WorkOS (${target.environmentName}).\n`);
  }

  return {
    varName,
    entry: {
      provider: 'workos',
      source: 'cli',
      mode: target.sandbox ? 'sandbox' : 'production',
      account_id: target.environmentId,
      created_at: Math.floor(Date.now() / 1000),
      fingerprint: fingerprint(current),
      ...(keyTypePrefix(current) ? { key_prefix: keyTypePrefix(current) as string } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

async function rotate(
  ctx: ResolvedContext,
  varName: string,
  previous: ConnectorMetadata,
  opts: RotateOpts,
): Promise<RotateResult> {
  const creds = readStoredCredentials();
  if (!creds) {
    console.error(`\n  ${WORKOS_NOT_LOGGED_IN.title}`);
    console.error(`  Run ${B(WORKOS_NOT_LOGGED_IN.remedy!)} and try again.\n`);
    process.exit(1);
  }
  const token = await ensureFreshToken(creds, opts.nonTty);

  // Re-resolve from `.env` rather than trusting `previous.account_id`. The
  // client ID is the source of truth and the user may have repointed the app
  // at a different environment since `connect` — in which case the recorded
  // environment is stale and rotating against it would mint a key nothing
  // uses while leaving the live one alone.
  const target = await resolveTarget(ctx, token, opts.nonTty);
  if (previous.account_id && previous.account_id !== target.environmentId) {
    console.log(`\n  ${B(CLIENT_ID_VAR)} now points at ${target.environmentName}.`);
    console.log('  Rotating there, and updating the recorded environment.\n');
  }

  const current = ctx.localPlaintext[varName];
  const keys = await fetchKeys(token, target.environmentId);
  const outgoing = current ? findKeyByValue(keys, current) : undefined;

  // Which application to mint into. The outgoing key's application when we
  // could identify it, so the new key lands beside the one it replaces;
  // otherwise the environment's sole application. Two applications and no
  // match is genuinely ambiguous, and guessing would put the key on the wrong
  // one.
  const applicationId = resolveApplicationId(keys, outgoing);
  if (!applicationId) {
    console.error(`\n  Could not tell which WorkOS application ${B(varName)} belongs to.`);
    console.error(`  ${target.environmentName} has several, and the current value did not match`);
    console.error('  any key Capy can read. Rotate this one in the WorkOS dashboard.\n');
    process.exit(1);
  }

  const created = await createKey(token, target.environmentId, applicationId, rotationKeyName());
  if (!created) {
    console.error(`\n  WorkOS did not create a new key for ${B(varName)}.`);
    console.error('  Nothing was changed. Try again, or check the WorkOS dashboard.\n');
    process.exit(1);
  }

  // Expire the old key AFTER the new one exists, and on a delay. Order and
  // delay are both load-bearing: expiring first would leave the app with no
  // working key if creation then failed, and expiring immediately would break
  // it in the window between `.env` being written and the deploy that reads it.
  const expiredOutgoing = outgoing ? await expireKey(token, outgoing.id, new Date(Date.now() + OVERLAP_MS)) : false;

  console.log(`\n  Rotated ${B(varName)} in ${target.environmentName}.`);
  if (expiredOutgoing) {
    console.log(`  The previous key stops working in 1 hour — deploy before then.`);
  } else if (outgoing) {
    console.log(`  Heads up: the new key is live, but Capy could not schedule the previous`);
    console.log(`  one (${outgoing.id}) to expire. Revoke it in the WorkOS dashboard.`);
  } else {
    console.log(`  Capy could not identify the previous key, so nothing was expired.`);
    console.log(`  Revoke the old key in the WorkOS dashboard once the new one is deployed.`);
  }
  console.log('');

  return {
    value: created.value,
    entry: {
      ...previous,
      mode: target.sandbox ? 'sandbox' : 'production',
      account_id: target.environmentId,
      rotated_at: Math.floor(Date.now() / 1000),
      fingerprint: fingerprint(created.value),
      ...(keyTypePrefix(created.value) ? { key_prefix: keyTypePrefix(created.value) as string } : {}),
    },
  };
}

export function resolveApplicationId(
  keys: readonly WorkOSKey[],
  outgoing: WorkOSKey | undefined,
): string | undefined {
  if (outgoing?.applicationId) return outgoing.applicationId;
  const distinct = [...new Set(keys.flatMap((k) => (k.applicationId ? [k.applicationId] : [])))];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * A name the user will recognize in the dashboard six months from now. Dated
 * rather than serialized, because a rotation is an event with a date and the
 * dashboard sorts by creation time anyway.
 */
export function rotationKeyName(): string {
  return `capy-rotated-${new Date().toISOString().slice(0, 10)}`;
}

interface CreatedKey {
  readonly id: string;
  readonly value: string;
}

async function createKey(
  token: string,
  environmentId: string,
  applicationId: string,
  name: string,
): Promise<CreatedKey | undefined> {
  const data = await graphql<{
    createKey: {
      __typename: string;
      key?: { key: { id: string }; value: string } | null;
    };
  }>(token, 'createKey', CREATE_KEY_MUTATION, {
    input: { environmentId, applicationId, name },
  });
  // Branch on the union member, not on any message. `KeyCreated` is the only
  // success shape; anything else is a refusal the server named.
  if (data.createKey.__typename !== 'KeyCreated') return undefined;
  const created = data.createKey.key;
  if (!created?.value) return undefined;
  return { id: created.key.id, value: created.value };
}

async function expireKey(token: string, keyId: string, expiredAt: Date): Promise<boolean> {
  try {
    const data = await graphql<{ expireKey: { __typename: string } }>(
      token,
      'expireKey',
      EXPIRE_KEY_MUTATION,
      { input: { keyId, expiredAt: expiredAt.toISOString() } },
    );
    // `KeyNotFound` is the documented miss. Treat every non-success typename
    // as a failure to schedule rather than assuming the shape of the rest.
    return data.expireKey.__typename !== 'KeyNotFound';
  } catch {
    // A failed expiry is not a failed rotation: the new key is already live
    // and written. The caller says so and points at the dashboard.
    return false;
  }
}

export const workosConnector: ConnectorModule = {
  name: 'workos',
  description: 'WorkOS environment API key (sandbox or production)',
  // No `requiresAuth`. Rotation runs unattended against the session the WorkOS
  // CLI already holds — there is no browser hand-off to warn anyone about.
  requiresTool: 'workos',
  toolInstalled: workosCliInstalled,
  toolMissing: WORKOS_CLI_MISSING,
  precheck: ensureWorkOSCliInstalled,
  connect,
  rotate,
};
