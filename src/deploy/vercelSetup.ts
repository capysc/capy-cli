/**
 * `capy deploy`'s Vercel target setup — API mode only, modeled on Dokploy's
 * one-question setup (`resolveDokployServiceOptions` in `commands/deployCommand.ts`):
 *
 *  1. One question: the project's dashboard link (or its name).
 *  2. The token resolves like Dokploy's key does (`_TARGET_VERCEL_TOKEN`, a
 *     one-level reference to `_CONNECTOR_VERCEL_TOKEN`, then `$VERCEL_TOKEN`).
 *     No token: say so, with the instructions for making one, and save the
 *     answer as entered.
 *  3. The project is checked live. A 404 is a coded refusal
 *     (`VERCEL_PROJECT_NOT_FOUND`), shown, and the question is asked again.
 *     Any other API problem is shown with its code and the answer is saved as
 *     entered.
 *  4. The project is named back for a yes/no; no asks again.
 *  5. Environment: production, preview, development, plus the project's custom
 *     environments. Preview asks an optional git branch.
 *
 * It needs no `vercel` program, no `.vercel/project.json` and no `vercel link`:
 * every request is the REST API with the token.
 *
 * Vercel dashboard links look like `https://vercel.com/<team slug>/<project>`
 * (more path may follow: `/settings`, `/deployments`, …).
 */
import inquirer from 'inquirer';
import { ERROR_CODES } from '../types/index';
import {
  VercelApiError,
  VercelFetchLike,
  VercelProject,
  VercelTeam,
  availableEnvironments,
  createVercelClient,
  mapVercelApiError,
  resolveTeam,
} from './vercelApi';
import {
  GetVercelStoreSecret,
  VERCEL_TARGET_SECRET_NAME,
  getVercelTargetSecretFromStore,
  resolveVercelTargetToken,
} from './vercelTargetApi';
import { formatKeyHelp, vercelKeyHelp } from './keyHelp';

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ── Parsing the one answer ──────────────────────────────────────────────────

export type VercelProjectInput =
  | { kind: 'link'; team: string; project: string }
  | { kind: 'name'; project: string };

export type ParsedVercelProjectInput =
  | { ok: true; input: VercelProjectInput }
  | { ok: false; code: string; reason: string };

/** First path segments on vercel.com that are not a team's slug. */
const NOT_A_TEAM_SEGMENT: ReadonlySet<string> = new Set([
  'account',
  'dashboard',
  'docs',
  'login',
  'new',
  'pricing',
  'signup',
  'teams',
]);

const PROJECT_NAME = /^[A-Za-z0-9._-]+$/;

function invalid(reason: string): ParsedVercelProjectInput {
  return { ok: false, code: ERROR_CODES.VERCEL_URL_INVALID, reason };
}

function asUrl(answer: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(answer) ? answer : /^(www\.)?vercel\.com\//i.test(answer) ? `https://${answer}` : null;
  if (withScheme === null) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * The answer as a dashboard link (`https://vercel.com/<team>/<project>[/…]`)
 * or a bare project name/id. A link that is not a project's dashboard link is
 * a coded refusal, never guessed at.
 */
export function parseVercelProjectInput(raw: string): ParsedVercelProjectInput {
  const answer = raw.trim();
  const url = asUrl(answer);
  if (url) {
    if (url.protocol !== 'https:' || (url.hostname !== 'vercel.com' && url.hostname !== 'www.vercel.com')) {
      // COPY-FLAG: minimal neutral wording.
      return invalid('not a vercel.com link.');
    }
    const [team, project] = url.pathname.split('/').filter((segment) => segment !== '');
    if (!team || !project || NOT_A_TEAM_SEGMENT.has(team)) {
      // COPY-FLAG: minimal neutral wording.
      return invalid('that is not a project link (expected https://vercel.com/<team>/<project>).');
    }
    return { ok: true, input: { kind: 'link', team, project } };
  }
  if (!PROJECT_NAME.test(answer)) {
    // COPY-FLAG: minimal neutral wording.
    return invalid('that is neither a project link nor a project name.');
  }
  return { ok: true, input: { kind: 'name', project: answer } };
}

// ── The setup ───────────────────────────────────────────────────────────────

/** The terminal's question asker: `inquirer.prompt`'s shape, narrowed to what this setup uses. */
export type SetupPrompt = (questions: ReadonlyArray<Record<string, unknown>>) => Promise<Record<string, unknown>>;

const defaultPrompt: SetupPrompt = (questions) => inquirer.prompt(questions as never) as Promise<Record<string, unknown>>;

export interface VercelSetupDeps {
  /** Injectable so a test answers without a terminal. Defaults to `inquirer.prompt`. */
  prompt?: SetupPrompt;
  fetch?: VercelFetchLike;
  env?: Record<string, string | undefined>;
  /** Reads the org system store's `_TARGET_VERCEL_TOKEN`. Defaults to the real store (with its reuse offer and hidden prompt). */
  getSecret?: GetVercelStoreSecret;
}

export interface VercelSetupFlags {
  /** A dry run changes nothing: the token is only read from the store, never asked for or saved. */
  readOnly?: boolean;
  devMode?: boolean;
}

export interface VercelSetupResult {
  /** The target's API-mode options. */
  options: Record<string, unknown>;
  /** The project's production branch, when Vercel said: the default for the PR base branch. */
  productionBranch?: string;
}

interface Scope {
  teamId?: string;
  teamSlug?: string;
}

type Verified =
  | { kind: 'verified'; project: VercelProject; scope: Scope; client: ReturnType<typeof createVercelClient> }
  | { kind: 'not_found' }
  | { kind: 'unverified'; code: string; scope: Scope };

const STANDARD_ENVIRONMENTS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'Production', value: 'production' },
  { name: 'Preview', value: 'preview' },
  { name: 'Development', value: 'development' },
];

/** The code of a failed Vercel call — the typed error's own code, never its text. */
function codeOf(err: unknown): string {
  return mapVercelApiError(err).code;
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function askProjectInput(ask: SetupPrompt, existingOpts: Record<string, string>): Promise<string> {
  const ans = (await ask([
    {
      type: 'input',
      name: 'projectUrl',
      // COPY-FLAG (approved wording)
      message: 'Vercel project URL (paste the dashboard link for this project, or its name):',
      default: existingOpts.projectId,
      validate: (v: string) => (v.trim() ? true : 'required'),
      filter: (v: string) => v.trim(),
    },
  ])) as { projectUrl: string };
  return ans.projectUrl;
}

async function pickTeamPrompt(ask: SetupPrompt, teams: readonly VercelTeam[]): Promise<string> {
  const { picked } = (await ask([
    // COPY-FLAG: minimal neutral wording.
    { type: 'list', name: 'picked', message: 'Which Vercel team:', choices: teams.map((t) => ({ name: t.slug, value: t.id })) },
  ])) as { picked: string };
  return picked;
}

/** Looks the project up. A 404 is `not_found`; any other problem is `unverified`, carrying whatever scope was learned. */
async function verifyProject(
  input: VercelProjectInput,
  token: string,
  deps: VercelSetupDeps,
  ask: SetupPrompt,
): Promise<Verified> {
  const client = createVercelClient(token, { fetch: deps.fetch });
  const linkSlug = input.kind === 'link' ? { teamSlug: input.team } : {};
  const teams = await attempt(() => client.listTeams());
  if (!teams.ok) return { kind: 'unverified', code: codeOf(teams.error), scope: linkSlug };

  const scope = await scopeFor(input, teams.value, ask);
  if (!scope.ok) return { kind: 'unverified', code: scope.code, scope: linkSlug };

  const project = await attempt(() => client.getProject(input.project, scope.scope.teamId));
  if (project.ok) return { kind: 'verified', project: project.value, scope: scope.scope, client };
  if (project.error instanceof VercelApiError && project.error.code === 'not_found') return { kind: 'not_found' };
  return { kind: 'unverified', code: codeOf(project.error), scope: scope.scope };
}

/** Which team the project is under: the link's own, or — for a bare name — the only team the token sees, else a pick. */
async function scopeFor(
  input: VercelProjectInput,
  teams: readonly VercelTeam[],
  ask: SetupPrompt,
): Promise<{ ok: true; scope: Scope } | { ok: false; code: string }> {
  if (input.kind === 'link') {
    const hit = teams.find((t) => t.slug === input.team);
    return { ok: true, scope: hit ? { teamId: hit.id, teamSlug: hit.slug } : {} };
  }
  const resolved = await resolveTeam(teams, undefined, (all) => pickTeamPrompt(ask, all));
  if (!resolved.ok) return { ok: false, code: resolved.code };
  return {
    ok: true,
    scope: { ...(resolved.teamId ? { teamId: resolved.teamId } : {}), ...(resolved.teamSlug ? { teamSlug: resolved.teamSlug } : {}) },
  };
}

interface EnvironmentChoice {
  vercelEnv: string;
  customEnvironmentId?: string;
  gitBranch?: string;
}

async function askEnvironment(
  ask: SetupPrompt,
  existingOpts: Record<string, string>,
  custom: ReadonlyArray<{ id: string; slug: string }>,
): Promise<EnvironmentChoice> {
  const environments = availableEnvironments(custom);
  const choices = [
    ...STANDARD_ENVIRONMENTS,
    ...environments.filter((e) => e.kind === 'custom').map((e) => ({ name: e.name, value: e.name })),
  ];
  const { vercelEnv } = (await ask([
    {
      type: 'list',
      name: 'vercelEnv',
      message: 'Which Vercel environment should these secrets go to?',
      choices,
      default: existingOpts.vercelEnv ?? 'preview',
    },
  ])) as { vercelEnv: string };
  const customEnvironmentId = environments.find((e) => e.kind === 'custom' && e.name === vercelEnv)?.customEnvironmentId;
  const gitBranch = vercelEnv === 'preview' ? await askPreviewBranch(ask, existingOpts.gitBranch) : undefined;
  return {
    vercelEnv,
    ...(customEnvironmentId ? { customEnvironmentId } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

async function askPreviewBranch(ask: SetupPrompt, preferred: string | undefined): Promise<string | undefined> {
  const { gitBranch } = (await ask([
    {
      type: 'input',
      name: 'gitBranch',
      // COPY-FLAG: minimal neutral wording.
      message: 'Git branch for Preview (leave blank for all preview branches):',
      default: preferred,
      filter: (v: string) => v.trim(),
    },
  ])) as { gitBranch: string };
  return gitBranch === '' ? undefined : gitBranch;
}

async function confirmProject(ask: SetupPrompt, project: VercelProject, teamSlug: string | undefined): Promise<boolean> {
  const where = teamSlug ? ` (${teamSlug})` : '';
  const { confirmed } = (await ask([
    {
      type: 'confirm',
      name: 'confirmed',
      // COPY-FLAG (approved wording)
      message: `Use "${project.name}"${where} as this target?`,
      default: true,
    },
  ])) as { confirmed: boolean };
  return confirmed;
}

/** What is known without Vercel's answer: the project as typed, the team as far as it is known. */
function unverifiedOptions(input: VercelProjectInput, scope: Scope, env: EnvironmentChoice): Record<string, unknown> {
  const team = scope.teamId ? { teamId: scope.teamId } : scope.teamSlug ? { teamSlug: scope.teamSlug } : {};
  return {
    projectDir: '.',
    vercelEnv: env.vercelEnv,
    projectId: input.project,
    ...team,
    ...(env.gitBranch ? { gitBranch: env.gitBranch } : {}),
  };
}

function printTokenInstructions(team: string | undefined): void {
  console.error(formatKeyHelp(vercelKeyHelp(VERCEL_TARGET_SECRET_NAME, { team, mode: 'save' })));
}

/**
 * The whole setup: loops (a terminal only) until a project is confirmed, or
 * the project could not be checked and is saved as entered. Each pass either
 * returns or recurses on the next answer, so no loop state is reassigned.
 */
export async function resolveVercelSetup(
  existingOpts: Record<string, string>,
  orgId: string | undefined,
  flags: VercelSetupFlags = {},
  deps: VercelSetupDeps = {},
): Promise<VercelSetupResult> {
  const ask = deps.prompt ?? defaultPrompt;
  const resolve = async (): Promise<VercelSetupResult> => {
    const parsed = parseVercelProjectInput(await askProjectInput(ask, existingOpts));
    if (!parsed.ok) {
      console.error(`${RED('✗')} ${parsed.code}: ${parsed.reason}`);
      // COPY-FLAG: minimal neutral wording.
      console.error('  Paste the Vercel dashboard link for this project, or just its name.');
      return resolve();
    }
    const input = parsed.input;
    const linkTeam = input.kind === 'link' ? input.team : undefined;

    const token = await resolveVercelTargetToken({
      env: deps.env ?? process.env,
      interactive: !flags.readOnly,
      orgId,
      devMode: flags.devMode,
      getSecret: deps.getSecret ?? getVercelTargetSecretFromStore,
      ...(linkTeam ? { helpTeam: linkTeam } : {}),
    });
    if (!token.ok) {
      // COPY-FLAG: minimal neutral wording.
      const why = token.code === ERROR_CODES.VERCEL_TOKEN_MISSING ? 'no token' : token.code;
      console.log(`  ${DIM(`Could not verify against Vercel yet (${why}) — saving as entered.`)}`);
      printTokenInstructions(linkTeam);
      return savedAsEntered(input, { ...(linkTeam ? { teamSlug: linkTeam } : {}) });
    }

    const verified = await verifyProject(input, token.value, deps, ask);
    if (verified.kind === 'not_found') {
      // COPY-FLAG: minimal neutral wording.
      console.error(`${RED('✗')} ${ERROR_CODES.VERCEL_PROJECT_NOT_FOUND}: no Vercel project "${input.project}"${linkTeam ? ` in ${linkTeam}` : ''}.`);
      console.error('  Check the link and try again.');
      return resolve();
    }
    if (verified.kind === 'unverified') {
      // COPY-FLAG: minimal neutral wording.
      console.log(`  ${DIM(`Could not verify against Vercel (${verified.code}) — saving as entered.`)}`);
      if (verified.code === ERROR_CODES.VERCEL_AUTH_FAILED) printTokenInstructions(verified.scope.teamSlug ?? linkTeam);
      return savedAsEntered(input, verified.scope);
    }

    if (!(await confirmProject(ask, verified.project, verified.scope.teamSlug))) return resolve();

    const custom = await attempt(() => verified.client.listCustomEnvironments(verified.project.id, verified.scope.teamId));
    if (!custom.ok) {
      // COPY-FLAG: minimal neutral wording.
      console.log(`  ${DIM(`Could not list custom environments (${codeOf(custom.error)}) — offering the standard ones.`)}`);
    }
    const env = await askEnvironment(ask, existingOpts, custom.ok ? custom.value : []);
    const productionBranch = verified.project.link?.productionBranch;
    return {
      options: {
        projectDir: '.',
        vercelEnv: env.vercelEnv,
        projectId: verified.project.id,
        ...(verified.scope.teamId ? { teamId: verified.scope.teamId } : {}),
        ...(env.customEnvironmentId ? { customEnvironmentId: env.customEnvironmentId } : {}),
        ...(env.gitBranch ? { gitBranch: env.gitBranch } : {}),
      },
      ...(productionBranch ? { productionBranch } : {}),
    };
  };

  /** Saved as typed: the standard environments only (custom ones cannot be listed without Vercel). */
  const savedAsEntered = async (input: VercelProjectInput, scope: Scope): Promise<VercelSetupResult> => {
    const env = await askEnvironment(ask, existingOpts, []);
    return { options: unverifiedOptions(input, scope, env) };
  };

  return resolve();
}
