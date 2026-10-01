/**
 * Create the Vercel token for `capy connect vercel` from the Vercel CLI's own
 * sign-in, so nobody has to make (or paste) one by hand.
 *
 * Vercel has no organization-owned key: every token belongs to a user. What it
 * does have is a team-scoped token — `POST /v3/user/tokens?teamId=<id>` makes
 * one that sees ONE team only. This file asks the user's installed `vercel`
 * program to make that call with the user's sign-in (the CLI handles its own
 * sign-in refresh), checks the answer really is scoped to exactly the chosen
 * team, and hands the value to a `save` function. The value:
 *
 *   - never appears on a command line (it is only ever READ from a child's
 *     stdout, captured in memory),
 *   - is never printed, logged, or put in an error message or a report,
 *   - is not kept anywhere here: it goes to `save`, and to the caller that
 *     needs it for its next request, nowhere else.
 *
 * Commands run (every one is argv, never a shell string; stderr is dropped;
 * `VERCEL_TOKEN` is removed from the child's environment so the sign-in is the
 * only identity; `CI=1` keeps a logged-out CLI from opening a browser):
 *
 *   vercel whoami                                   exit status 0 = signed in
 *   vercel api /v2/teams?limit=100                  JSON on stdout: { teams: [{ id, slug }] }
 *   vercel api /v3/user/tokens -X POST \
 *          -f name=<name> [-F expiresAt=<ms>] \
 *          --scope <team slug>                      JSON on stdout: { bearerToken, token: {…} }
 *   vercel tokens rm <token id>                     removes a token
 *   vercel logout                                   signs the CLI out
 *
 * Facts read from the installed Vercel CLI (53.1.0) source:
 *   - `--scope <slug>` sets the CLI's current team; `vercel api` then adds
 *     `teamId=<id>` to the request (so it also reaches POST /v3/user/tokens).
 *   - `-f key=value` is a string field; `-F` parses numbers, so `expiresAt`
 *     goes out as a JSON number. A request with fields and no `-X` would be a
 *     POST, so a GET with a query string puts the query in the path.
 *   - A failed request exits 1 with its message on stderr; success exits 0
 *     with the JSON on stdout. Nothing here reads that message.
 *   - `vercel tokens add` sends no team (`useCurrentTeam: false`), so it can
 *     only make a user-wide token; it is NOT used.
 *   - Not signed in: a CLI started by an AI agent (or on a terminal) begins its
 *     login flow and waits, so every call here has a time limit.
 *   - The Vercel CLI itself says a sign-in made by `vercel login` is an OAuth
 *     session that Vercel may refuse to create tokens with (HTTP 403). The
 *     refusal reaches this file only as a non-zero exit, so that case is
 *     reported as `VERCEL_TOKEN_CREATE_FAILED` with the token page as the way
 *     out.
 */
import { execFile } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, join } from 'path';
import { ERROR_CODES } from '../types/index';
import { VERCEL_CONNECTOR_SECRET_NAME, VercelTeam, resolveTeam } from './vercelApi';
import { VERCEL_TOKEN_PAGE_URL } from './keyHelp';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VercelCliRunResult {
  /** The child's exit status; `null` when it never ran, was killed, or timed out. */
  status: number | null;
  stdout: string;
}

export type VercelCliRunner = (args: readonly string[], timeoutMs: number) => Promise<VercelCliRunResult>;

export interface VercelCliDeps {
  /** Source of `PATH` for finding the binary, and the child's environment. */
  env: Record<string, string | undefined>;
  /** Defaults to really running `vercel` with `env`. Injected by tests. */
  run?: VercelCliRunner;
  /** Whether the `vercel` binary can be found. Defaults to a `PATH` search of `env`. */
  hasBinary?: () => boolean;
  now?: () => number;
}

/** A refusal. Branch on `code`; `message` is for people. */
export interface TokenFailure {
  ok: false;
  code: string;
  message: string;
  link?: { label: string; url: string };
  remedy?: string;
  /** Set when a created token could not be removed: the id (never the value) a human can remove. */
  tokenId?: string;
}

/** What a created token looks like in a report. Never the value. */
export interface TokenCreatedReport {
  name: string;
  id: string;
  team: { id: string; slug: string };
  /** ISO time the token expires; absent for no expiry. */
  expiresAt?: string;
  /** Which system store entry holds it. */
  secretName: string;
  /** True when that entry already held a value and was replaced. */
  replacedExisting: boolean;
  /** What happened to the Vercel CLI's sign-in. */
  cliSignOut: 'done' | 'declined' | 'failed' | 'not_offered';
  /** The command that signs the CLI out, when it is still signed in. */
  next?: string;
}

/** What `prepare` hands back once it has checked the save target is usable. */
export interface MintTarget {
  ok: true;
  /** Saves the value (to the system store). Throws a coded error on failure. */
  save: (bearer: string) => Promise<void>;
  /** True when that store entry already held a value (for the report). */
  replacedExisting: boolean;
}

export interface MintRequest {
  /** `--team`: slug or id. */
  team?: string;
  /** `--token-expires-days`, already validated. */
  expiresDays?: number;
  /** Asks which team when several and this run can ask; `null` when it cannot. */
  pickTeam: ((teams: readonly VercelTeam[]) => Promise<string>) | null;
  /**
   * Runs after the CLI and team are settled and BEFORE anything is created:
   * opens the system store, which is where a non-admin is refused — so a
   * token is never made for a caller who could not save it.
   */
  prepare: () => Promise<MintTarget | TokenFailure>;
  /** Asks "sign the Vercel CLI out now?" (default yes); `null` when this run cannot ask — it then never signs out. */
  askSignOut: ((message: string, defaultValue: boolean) => Promise<boolean>) | null;
  /** The store entry the value is saved to. Defaults to `_CONNECTOR_VERCEL_TOKEN`. */
  secretName?: string;
}

export type MintOutcome =
  | { ok: true; report: TokenCreatedReport; bearer: string }
  | TokenFailure;

// ── Constants ────────────────────────────────────────────────────────────────

const VERCEL_CLI_INSTALL_URL = 'https://vercel.com/docs/cli';
const WHOAMI_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A token id goes on a command line: refuse anything that could be read as a flag or a second argument. */
const SAFE_TOKEN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

// ── Running the Vercel CLI ───────────────────────────────────────────────────

/** The environment the child sees: the caller's, minus `VERCEL_TOKEN`, with `CI=1`. */
function childEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const { VERCEL_TOKEN: _dropped, ...rest } = env;
  return { ...rest, CI: '1' };
}

function realRunner(env: Record<string, string | undefined>): VercelCliRunner {
  return (args, timeoutMs) =>
    new Promise<VercelCliRunResult>((resolve) => {
      const child = execFile(
        'vercel',
        [...args],
        { env: childEnv(env), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (err, stdout) => {
          const code = (err as { code?: unknown } | null)?.code;
          const status = err === null ? 0 : typeof code === 'number' ? code : null;
          resolve({ status, stdout: typeof stdout === 'string' ? stdout : '' });
        },
      );
      child.stdin?.end();
    });
}

/** Whether an executable called `vercel` is on `env.PATH`. */
export function vercelBinaryOnPath(env: Record<string, string | undefined>): boolean {
  const names = process.platform === 'win32' ? ['vercel.cmd', 'vercel.exe', 'vercel'] : ['vercel'];
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  return dirs.some((dir) =>
    names.some((name) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export function hasVercelCli(deps: VercelCliDeps): boolean {
  return (deps.hasBinary ?? (() => vercelBinaryOnPath(deps.env)))();
}

const runner = (deps: VercelCliDeps): VercelCliRunner => deps.run ?? realRunner(deps.env);

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

/** The binary is there and the CLI is signed in (its own `whoami` exits 0), else a coded refusal. */
export async function checkVercelCli(deps: VercelCliDeps): Promise<{ ok: true } | TokenFailure> {
  if (!hasVercelCli(deps)) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_CLI_MISSING,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: 'The Vercel CLI (`vercel`) is not installed.',
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      link: { label: 'Install the Vercel CLI', url: VERCEL_CLI_INSTALL_URL },
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      remedy: 'Install the Vercel CLI, run `vercel login`, then run this again.',
    };
  }
  const who = await runner(deps)(['whoami'], WHOAMI_TIMEOUT_MS);
  if (who.status !== 0) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_CLI_NOT_SIGNED_IN,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: 'The Vercel CLI is not signed in.',
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      remedy: 'Run `vercel login`, then run this again.',
    };
  }
  return { ok: true };
}

/** The teams the CLI's sign-in sees. */
export async function listCliTeams(deps: VercelCliDeps): Promise<{ ok: true; teams: readonly VercelTeam[] } | TokenFailure> {
  const res = await runner(deps)(['api', '/v2/teams?limit=100'], API_TIMEOUT_MS);
  const body = res.status === 0 ? parseJsonObject(res.stdout) : null;
  if (!body || !Array.isArray(body.teams)) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_API_ERROR,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: 'Could not list the Vercel teams through the Vercel CLI.',
    };
  }
  const teams = body.teams.flatMap((t): readonly VercelTeam[] => {
    const rec = t !== null && typeof t === 'object' ? (t as Record<string, unknown>) : {};
    return typeof rec.id === 'string' && rec.id !== '' && typeof rec.slug === 'string' && rec.slug !== ''
      ? [{ id: rec.id, slug: rec.slug, ...(typeof rec.name === 'string' ? { name: rec.name } : {}) }]
      : [];
  });
  return { ok: true, teams };
}

/** A team token can only belong to a team: pick one (flag, the only one, a pick) or refuse. */
export async function chooseTokenTeam(
  teams: readonly VercelTeam[],
  requested: string | undefined,
  pick: ((teams: readonly VercelTeam[]) => Promise<string>) | null,
): Promise<{ ok: true; team: { id: string; slug: string } } | TokenFailure> {
  if (teams.length === 0) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_TEAM_REQUIRED,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: 'The Vercel CLI sign-in sees no team. A team token needs a team.',
    };
  }
  const resolved = await resolveTeam(teams, requested, pick);
  if (!resolved.ok) return resolved;
  const team = teams.find((t) => t.id === resolved.teamId);
  return team ? { ok: true, team: { id: team.id, slug: team.slug } } : { ok: false, code: ERROR_CODES.VERCEL_TEAM_NOT_FOUND, message: 'No such Vercel team.' };
}

// ── Create / delete ──────────────────────────────────────────────────────────

/** `--token-expires-days`: a whole number of days, 1 or more. */
export function parseExpiryDays(raw: string | number | undefined): { ok: true; days: number | undefined } | TokenFailure {
  if (raw === undefined) return { ok: true, days: undefined };
  const text = String(raw).trim();
  const days = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_TOKEN_EXPIRY_INVALID,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: '--token-expires-days must be a whole number of days, 1 to 3650.',
    };
  }
  return { ok: true, days };
}

interface CreatedToken {
  bearer: string;
  id: string;
  name: string;
  scopes: readonly unknown[];
  expiresAtMs?: number;
}

function parseCreated(stdout: string): CreatedToken | null {
  const body = parseJsonObject(stdout);
  const token = body?.token !== null && typeof body?.token === 'object' ? (body?.token as Record<string, unknown>) : null;
  if (!body || !token) return null;
  const bearer = body.bearerToken;
  const id = token.id;
  if (typeof bearer !== 'string' || bearer === '' || typeof id !== 'string' || id === '') return null;
  return {
    bearer,
    id,
    name: typeof token.name === 'string' ? token.name : '',
    scopes: Array.isArray(token.scopes) ? token.scopes : [],
    ...(typeof token.expiresAt === 'number' ? { expiresAtMs: token.expiresAt } : {}),
  };
}

/** Exactly one scope, and it is the chosen team. A `user` scope, another team, or extra scopes all fail. */
export function scopesAreExactlyTeam(scopes: readonly unknown[], teamId: string): boolean {
  if (scopes.length !== 1) return false;
  const only = scopes[0];
  const rec = only !== null && typeof only === 'object' ? (only as Record<string, unknown>) : {};
  return rec.type === 'team' && rec.teamId === teamId;
}

async function deleteCliToken(deps: VercelCliDeps, id: string): Promise<boolean> {
  if (!SAFE_TOKEN_ID.test(id)) return false;
  const res = await runner(deps)(['tokens', 'rm', id], API_TIMEOUT_MS);
  return res.status === 0;
}

/** Removes a token that must not be kept; if that fails too, refuses with the id so a human can remove it. */
async function removeOrReport(deps: VercelCliDeps, id: string, because: TokenFailure): Promise<TokenFailure> {
  if (await deleteCliToken(deps, id)) return because;
  return {
    ok: false,
    code: ERROR_CODES.VERCEL_TOKEN_CLEANUP_FAILED,
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    message: `A Vercel token (id ${id}) was created and could not be removed. Remove it at the Vercel token page.`,
    link: { label: 'Vercel token page', url: VERCEL_TOKEN_PAGE_URL },
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    remedy: `Remove the token with id ${id} on the Vercel token page, or run \`vercel tokens rm ${id}\`.`,
    tokenId: id,
  };
}

function storeCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : ERROR_CODES.SERVICE_ERROR;
}

async function trySave(save: (bearer: string) => Promise<void>, bearer: string): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await save(bearer);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: storeCode(err) };
  }
}

async function signOutStep(
  deps: VercelCliDeps,
  ask: MintRequest['askSignOut'],
): Promise<{ cliSignOut: TokenCreatedReport['cliSignOut']; next?: string }> {
  const NEXT = 'vercel logout';
  if (!ask) return { cliSignOut: 'not_offered', next: NEXT };
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const yes = await ask('Sign the Vercel CLI out now?', true);
  if (!yes) return { cliSignOut: 'declined', next: NEXT };
  const res = await runner(deps)(['logout'], WHOAMI_TIMEOUT_MS);
  return res.status === 0 ? { cliSignOut: 'done' } : { cliSignOut: 'failed', next: NEXT };
}

/**
 * The whole sequence: CLI present and signed in → team → create the token →
 * check its scope → save it → (interactive only) offer to sign the CLI out.
 *
 * A token that fails the scope check, or cannot be saved, is deleted again
 * straight away.
 */
export async function mintTeamToken(deps: VercelCliDeps, req: MintRequest): Promise<MintOutcome> {
  const checked = await checkVercelCli(deps);
  if (!checked.ok) return checked;

  const listed = await listCliTeams(deps);
  if (!listed.ok) return listed;
  const chosen = await chooseTokenTeam(listed.teams, req.team, req.pickTeam);
  if (!chosen.ok) return chosen;
  const { team } = chosen;

  const target = await req.prepare();
  if (!target.ok) return target;

  const now = (deps.now ?? (() => Date.now()))();
  const expiresAtMs = req.expiresDays === undefined ? undefined : now + req.expiresDays * DAY_MS;
  const name = `capy-${team.slug}-import`; // COPY-FLAG: token name shown in Vercel.
  const args: readonly string[] = [
    'api',
    '/v3/user/tokens',
    '-X',
    'POST',
    '-f',
    `name=${name}`,
    ...(expiresAtMs === undefined ? [] : ['-F', `expiresAt=${expiresAtMs}`]),
    '--scope',
    team.slug,
  ];
  const created = await runner(deps)(args, API_TIMEOUT_MS);
  const token = created.status === 0 ? parseCreated(created.stdout) : null;
  if (!token) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_TOKEN_CREATE_FAILED,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: 'The Vercel CLI could not create a token. Vercel may not allow a `vercel login` sign-in to create tokens.',
      link: { label: 'Vercel token page', url: VERCEL_TOKEN_PAGE_URL },
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      remedy: `Create a token at the link and save it with \`capy system set ${req.secretName ?? VERCEL_CONNECTOR_SECRET_NAME}\`.`,
    };
  }

  if (!scopesAreExactlyTeam(token.scopes, team.id)) {
    return removeOrReport(deps, token.id, {
      ok: false,
      code: ERROR_CODES.VERCEL_TOKEN_SCOPE_UNEXPECTED,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: `The new Vercel token was not scoped to only the team ${team.slug}. It was deleted.`,
    });
  }

  const secretName = req.secretName ?? VERCEL_CONNECTOR_SECRET_NAME;
  const saved = await trySave(target.save, token.bearer);
  if (!saved.ok) {
    return removeOrReport(deps, token.id, {
      ok: false,
      code: saved.code,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: `Could not save ${secretName}. The new Vercel token was deleted.`,
    });
  }

  const signOut = await signOutStep(deps, req.askSignOut);
  const finalExpiry = token.expiresAtMs ?? expiresAtMs;
  return {
    ok: true,
    bearer: token.bearer,
    report: {
      name: token.name || name,
      id: token.id,
      team,
      ...(finalExpiry === undefined ? {} : { expiresAt: new Date(finalExpiry).toISOString() }),
      secretName,
      replacedExisting: target.replacedExisting,
      ...signOut,
    },
  };
}

/** Human lines for a created-token report. Never the value. */
export function describeTokenCreated(report: TokenCreatedReport): readonly string[] {
  // COPY-FLAG: new user-facing strings, minimal/neutral wording.
  return [
    `  ✓ Created Vercel token ${report.name} (id ${report.id}) for team ${report.team.slug}, saved as ${report.secretName}${report.replacedExisting ? ' (replaced the previous value)' : ''}.`,
    ...(report.expiresAt ? [`  Expires ${report.expiresAt}.`] : []),
    ...(report.cliSignOut === 'done' ? ['  Signed the Vercel CLI out.'] : []),
    ...(report.next ? [`  You can sign the Vercel CLI out with \`${report.next}\`.`] : []),
  ];
}
