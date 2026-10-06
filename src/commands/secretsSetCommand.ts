/**
 * `capy secrets set NAME` (CAP-698, agent mode): change one secret to a new value
 * in several locations at once and open the keep.lock PRs. NEVER prompts and
 * never opens a browser; the value comes in on stdin only (commands/pipedValue.ts,
 * its caps and refusals unchanged), there is no value argument.
 *
 *     <cmd> | capy secrets set NAME --all-rows --dry-run --json     # plan, changes nothing
 *     <cmd> | capy secrets set NAME --all-rows --confirm <plan_id> --json
 *
 * The flow an agent follows: look rows up (`capy secrets --name NAME --json`),
 * show the human a table, let the HUMAN pick the row(s) (never pick one yourself),
 * dry run, get approval, then run with `--confirm <plan_id>`.
 *
 * Selection
 *   NAME matches rows (one per distinct value). Several rows and neither
 *   `--row <row_id>` (repeatable) nor `--all-rows`: refused `SECRET_AMBIGUOUS`
 *   (exit 3) with the candidates in `unanswered`.
 *   `--exclude <project>:<branch>` (repeatable) drops locations.
 *   `--no-pr-for <owner/name>` (repeatable) or `--no-pr` drops PRs.
 *
 * The plan and `plan_id`
 *   `--dry-run` prints the plan and changes nothing. `plan_id` is a hash of the
 *   exact (row_id, project, branch) set plus the per-repo PR set (repo, base,
 *   keep.lock paths). A real run REQUIRES `--confirm <plan_id>`; without it the
 *   refusal (exit 3) carries the plan, and a plan that moved since is refused
 *   `PLAN_CHANGED` (exit 1) with nothing done.
 *
 * Output never carries the value or any part or hash of it. Failures are codes.
 */
import { createHash } from 'crypto';
import { AuthService, silentAuthFailureMessage } from '../auth/authService';
import { ProjectManager } from '../core/projectManager';
import { ServiceClient } from '../service/serviceClient';
import type { OrgRepoLink, SecretIndexRow } from '../service/serviceClient';
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { mostRecentChangedAt } from '../ui/secretsScreen';
import { MAX_PIPED_BYTES, PipedValueResult, readPipedValue, refuseInvalidName, exitCodeForRefusal } from './pipedValue';
import { isValidVarName } from './pipedWrite';
import { rowIdOf } from './secretsRowId';
import {
  LocationRef,
  RepoTarget,
  SetEnv,
  SetLocation,
  createSetEnv,
  keepLockPathOf,
  locationRef,
  planRepos,
  previewDivergence,
  PR_CONCURRENCY,
  previewLocations,
  repoKey,
  repoLabel,
  resolveBases,
  runSecretSet,
} from './secretsSet';
import { renderSecretSetConfirmation, stoppingAfter, TERMINAL_STYLE } from './secretsSetText';
import { PoolItem, runPool } from '../utils/pool';

export interface SecretsSetOpts {
  readonly json?: boolean;
  /** `--dry-run` (the program-level flag): print the plan, change nothing. */
  readonly dryRun?: boolean;
  /** `--confirm <plan_id>` */
  readonly confirm?: string;
  /** `--row <row_id>` (repeatable) */
  readonly row?: readonly string[];
  /** `--all-rows` */
  readonly allRows?: boolean;
  /** `--exclude <project>:<branch>` (repeatable) */
  readonly exclude?: readonly string[];
  /** `--no-pr-for <owner/name>` (repeatable) */
  readonly noPrFor?: readonly string[];
  /** `--no-pr` */
  readonly noPr?: boolean;
}

/** Injectable seam: tests pass fakes for the service, GitHub and stdin. */
export interface SecretsSetIo {
  readonly orgId: string;
  readonly client: Pick<ServiceClient, 'getSecretIndex' | 'getOrgRepos'>;
  readonly env: SetEnv;
  readonly stdinIsTTY: boolean;
  /** The whole of stdin as one piped value (the real, uncapped-wait read). */
  readonly readStdin: () => Promise<PipedValueResult>;
  /**
   * Cancel signals (SIGINT in the real command). `planning`: kill the default-branch read.
   * `pushes`: start no further location pushes (those in flight finish). `prs`: start no further PRs.
   */
  readonly control?: { readonly planning?: AbortSignal; readonly pushes?: AbortSignal; readonly prs?: AbortSignal };
  /** A bounded look at stdin for `--dry-run`: `undefined` when nothing arrives in time. */
  readonly peekStdin: () => Promise<PipedValueResult | undefined>;
}

// ── Output shapes ───────────────────────────────────────────────────────────

interface PlanLocation extends LocationRef {
  readonly action: 'update' | 'unchanged';
}

interface PlanPr {
  readonly repo: string;
  readonly base: string | null;
  readonly keep_lock_paths: readonly string[];
  readonly keep_lock_diverged: boolean;
}

export interface SetPlanBody {
  readonly name: string;
  readonly locations: readonly PlanLocation[];
  readonly prs: readonly PlanPr[];
  readonly not_linked: readonly string[];
  /** Present only when the repo links could not be read (e.g. `REPO_LINKS_UNSUPPORTED`): no PR can be planned. */
  readonly repos_unavailable?: string;
}

export interface SetPlan extends SetPlanBody {
  readonly plan_id: string;
}

// ── Refusals ────────────────────────────────────────────────────────────────

const CODE_EXIT: Readonly<Record<string, number>> = {
  [ERROR_CODES.SECRET_AMBIGUOUS]: EXIT_NEEDS_INPUT,
  [ERROR_CODES.PLAN_CONFIRM_REQUIRED]: EXIT_NEEDS_INPUT,
};

/** Refuses and exits: pure JSON on stdout under `--json`, the sentence on stderr otherwise. Never carries a value. */
export function refuse(json: boolean, code: string, error: string, extra: object = {}): never {
  if (json) console.log(JSON.stringify({ ok: false, code, error, ...extra }, null, 2));
  else console.error(error);
  return process.exit(CODE_EXIT[code] ?? exitCodeForRefusal(code));
}

export function describe(err: unknown): { readonly code: string; readonly message: string } {
  return err instanceof CapyError
    ? { code: err.code, message: err.message }
    : { code: ERROR_CODES.SERVICE_ERROR, message: 'The service request failed.' }; // COPY-FLAG
}

// ── Selection ───────────────────────────────────────────────────────────────

interface Located extends SetLocation {
  readonly row_id: string;
}

const withRowId = (row: SecretIndexRow): readonly Located[] => {
  const row_id = rowIdOf(row.name, row.value_hash);
  return row.locations.map((l) => ({
    project_id: l.project_id,
    project_name: l.project_name,
    branch: l.branch,
    protected: l.protected,
    row_id,
  }));
};

export function candidatesOf(rows: readonly SecretIndexRow[]) {
  return rows.map((r) => ({
    row_id: rowIdOf(r.name, r.value_hash),
    locations: r.locations.map((l) => ({ project: l.project_name, branch: l.branch, protected: l.protected })),
    last_changed: mostRecentChangedAt(r) ?? null,
  }));
}

/** The rows the run is about, or a refusal. */
function selectRows(rows: readonly SecretIndexRow[], name: string, opts: SecretsSetOpts, json: boolean): readonly SecretIndexRow[] {
  const named = rows.filter((r) => r.name === name);
  if (named.length === 0) refuse(json, ERROR_CODES.SECRET_NOT_FOUND, 'No secret has that name.'); // COPY-FLAG
  const wanted = opts.row ?? [];
  if (wanted.length > 0 && opts.allRows === true) {
    refuse(json, ERROR_CODES.INVALID_FORMAT, '--row and --all-rows cannot be used together.'); // COPY-FLAG
  }
  if (opts.allRows === true) return named;
  if (wanted.length > 0) {
    const known = new Set(named.map((r) => rowIdOf(r.name, r.value_hash)));
    if (wanted.some((id) => !known.has(id))) {
      refuse(json, ERROR_CODES.SECRET_NOT_FOUND, 'A --row id matches no row of that name.', { unanswered: ambiguousStop(named) }); // COPY-FLAG
    }
    return named.filter((r) => wanted.includes(rowIdOf(r.name, r.value_hash)));
  }
  if (named.length > 1) {
    refuse(
      json,
      ERROR_CODES.SECRET_AMBIGUOUS,
      'That name has more than one value. Choose --row <row_id> (repeatable) or --all-rows.', // COPY-FLAG
      { unanswered: ambiguousStop(named) },
    );
  }
  return named;
}

/** Shaped like `capy agents`' `unanswered`: the stop, the flag(s) that answer it, and what to choose between. */
const ambiguousStop = (named: readonly SecretIndexRow[]) => [
  { id: 'row', flag: '--row', alternative: '--all-rows', candidates: candidatesOf(named) },
];

export function excludeLocations<L extends { readonly project_name: string; readonly branch: string }>(
  located: readonly L[],
  exclude: readonly string[],
  json: boolean,
): readonly L[] {
  const parsed = exclude.map((token) => {
    const at = token.indexOf(':');
    return { token, project: at === -1 ? token : token.slice(0, at), branch: at === -1 ? '' : token.slice(at + 1) };
  });
  const matches = (l: L, e: { project: string; branch: string }) => l.project_name === e.project && l.branch === e.branch;
  const unmatched = parsed.filter((e) => !located.some((l) => matches(l, e)));
  if (unmatched.length > 0) {
    refuse(json, ERROR_CODES.INVALID_FORMAT, `--exclude names no selected location: ${unmatched.map((e) => e.token).join(', ')}`); // COPY-FLAG
  }
  return located.filter((l) => !parsed.some((e) => matches(l, e)));
}

function narrowRepos(
  targets: readonly RepoTarget[],
  noPrFor: readonly string[],
  noPr: boolean,
  json: boolean,
): readonly RepoTarget[] {
  if (noPr) return [];
  const drop = noPrFor.map((s) => s.trim().toLowerCase());
  const keyOf = (t: RepoTarget) => repoLabel(t).toLowerCase();
  const unmatched = drop.filter((d) => !targets.some((t) => keyOf(t) === d));
  if (unmatched.length > 0) {
    refuse(json, ERROR_CODES.INVALID_FORMAT, `--no-pr-for names no repo in this plan: ${unmatched.join(', ')}`); // COPY-FLAG
  }
  return targets.filter((t) => !drop.includes(keyOf(t)));
}

// ── The plan ────────────────────────────────────────────────────────────────

const PLAN_DOMAIN = 'capy:secrets:plan:v1';

export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A hash over the exact (row_id, project, branch) set and the per-repo PR set
 * (repo, base, keep.lock paths), each sorted so order never matters. Opaque: it
 * carries no value and no value hash (row_id is itself a domain-separated hash).
 */
export function planIdOf(
  name: string,
  locations: ReadonlyArray<{ readonly row_id: string; readonly project: string; readonly branch: string }>,
  prs: ReadonlyArray<{ readonly repo: string; readonly base: string | null; readonly keep_lock_paths: readonly string[] }>,
): string {
  const canonical = JSON.stringify({
    name,
    locations: locations.map((l) => [l.row_id, l.project, l.branch].join('\u0000')).sort(byText),
    prs: prs
      .map((p) => [p.repo.toLowerCase(), p.base ?? '', [...p.keep_lock_paths].sort(byText).join('\u0001')].join('\u0000'))
      .sort(byText),
  });
  return createHash('sha256').update(`${PLAN_DOMAIN}\u0000${canonical}`).digest('hex').slice(0, 16);
}

/** What a plan is computed from (everything but the row ids that `plan_id` needs). */
export interface PlanInput {
  readonly name: string;
  readonly located: readonly SetLocation[];
  readonly targets: readonly RepoTarget[];
  readonly notLinked: readonly string[];
  readonly bases: Readonly<Record<string, string>>;
  readonly reposUnavailable?: string;
}

interface Selection extends PlanInput {
  readonly located: readonly Located[];
}

const pathsOf = (t: RepoTarget): readonly string[] =>
  [...new Set(t.files.map((f) => keepLockPathOf(f.path)))].sort(byText);

const planIdFor = (sel: Selection): string =>
  planIdOf(
    sel.name,
    sel.located.map((l) => ({ row_id: l.row_id, project: l.project_name, branch: l.branch })),
    sel.targets.map((t) => ({ repo: repoLabel(t), base: sel.bases[repoKey(t)] ?? null, keep_lock_paths: pathsOf(t) })),
  );

/**
 * The plan, without its id. Reads only (never writes): previews each location
 * (needs a value to know `unchanged`) and GitHub's keep.lock for divergence.
 * The one planner: `capy secrets set --dry-run` and the `capy --dry-run secrets` screen both use it.
 */
export async function describePlanBody(sel: PlanInput, env: SetEnv, value: string | undefined): Promise<SetPlanBody> {
  // ONE unlock, then the reads `LOCATION_CONCURRENCY` at a time (and the repos `PR_CONCURRENCY` at a time).
  const previews = await previewLocations(env, sel.located, sel.name, value);
  const github = env.github();
  const prs = (
    await runPool({
      items: sel.targets,
      limit: PR_CONCURRENCY,
      run: async (t): Promise<PoolItem<PlanPr>> => {
        const base = sel.bases[repoKey(t)];
        const mine = sel.located
          .map((l, i) => ({ location: l as SetLocation, serverKeep: previews[i].serverKeep }))
          .filter((p) => t.files.some((f) => f.project_id === p.location.project_id));
        return {
          result: {
            repo: repoLabel(t),
            base: base ?? null,
            keep_lock_paths: pathsOf(t),
            keep_lock_diverged: await previewDivergence(github, t, base, sel.name, mine),
          },
        };
      },
    })
  ).results;
  return {
    name: sel.name,
    locations: sel.located.map((l, i) => ({ ...locationRef(l), action: previews[i].action })),
    prs,
    not_linked: sel.notLinked,
    ...(sel.reposUnavailable === undefined ? {} : { repos_unavailable: sel.reposUnavailable }),
  };
}

/** The plan with its `plan_id`. */
async function describePlan(sel: Selection, io: SecretsSetIo, value: string | undefined): Promise<SetPlan> {
  return { plan_id: planIdFor(sel), ...(await describePlanBody(sel, io.env, value)) };
}

/** Human text for a plan. */
export function renderPlanText(plan: SetPlan): string {
  const locations = plan.locations.map(
    (l) => `  ${l.project} · ${l.branch}${l.protected ? '  protected' : ''}  ${l.action}`, // COPY-FLAG
  );
  const prs = plan.prs.map(
    (p) => `  ${p.repo}  ${p.base ?? '(default branch)'}  ${p.keep_lock_paths.join(', ')}${p.keep_lock_diverged ? '  keep.lock differs' : ''}`, // COPY-FLAG
  );
  return [
    `Plan ${plan.plan_id} for ${plan.name}`, // COPY-FLAG
    'Locations:', // COPY-FLAG
    ...locations,
    ...(prs.length > 0 ? ['Pull requests:', ...prs] : []), // COPY-FLAG
    ...(plan.not_linked.length > 0 ? [`Not linked (no PR): ${plan.not_linked.join(', ')}`] : []), // COPY-FLAG
    ...(plan.repos_unavailable === undefined ? [] : [`Repo links unavailable (${plan.repos_unavailable}).`]), // COPY-FLAG
  ].join('\n');
}

// ── The command ─────────────────────────────────────────────────────────────

export interface LoadedLinks {
  readonly links: readonly OrgRepoLink[];
  /** Set when the service has no repo links to give (it predates them): a reason, not a failure. */
  readonly unavailable?: string;
}

export async function loadLinks(io: Pick<SecretsSetIo, 'orgId' | 'client'>, json: boolean): Promise<LoadedLinks> {
  try {
    return { links: (await io.client.getOrgRepos(io.orgId)).repos };
  } catch (err) {
    const { code, message } = describe(err);
    return code === ERROR_CODES.REPO_LINKS_UNSUPPORTED ? { links: [], unavailable: code } : refuse(json, code, message);
  }
}

export async function readSecretIndex(io: Pick<SecretsSetIo, 'orgId' | 'client'>, json: boolean): Promise<readonly SecretIndexRow[]> {
  try {
    return (await io.client.getSecretIndex(io.orgId)).rows;
  } catch (err) {
    const { code, message } = describe(err);
    return refuse(json, code, message);
  }
}

/** The value for a real run, from stdin only. A terminal on stdin is "nothing was piped". */
async function requireValue(io: SecretsSetIo, json: boolean): Promise<string> {
  const piped: PipedValueResult = io.stdinIsTTY
    ? { ok: false, code: ERROR_CODES.STDIN_EMPTY, error: 'No value was piped in. Nothing was written.' } // COPY-FLAG
    : await io.readStdin();
  if (!piped.ok) return refuse(json, piped.code, piped.error);
  return piped.value;
}

/** The value, when one was piped in time (a dry run does not need one). */
async function optionalValue(io: SecretsSetIo): Promise<string | undefined> {
  if (io.stdinIsTTY) return undefined;
  const piped = await io.peekStdin();
  return piped !== undefined && piped.ok ? piped.value : undefined;
}

/**
 * Runs `capy secrets set NAME`. Returns the exit code (0 when nothing failed,
 * 1 on a partial failure); a refusal exits the process itself.
 */
export async function runSecretsSet(name: string, opts: SecretsSetOpts, io: SecretsSetIo): Promise<number> {
  const json = opts.json === true;
  if (!isValidVarName(name)) return refuseInvalidName(json);

  const rows = selectRows(await readSecretIndex(io, json), name, opts, json);
  const located = excludeLocations(rows.flatMap(withRowId), opts.exclude ?? [], json);
  if (located.length === 0) {
    refuse(json, ERROR_CODES.SECRETS_NOTHING_SELECTED, 'No location is left to change.'); // COPY-FLAG
  }

  const noPr = opts.noPr === true;
  const loaded: LoadedLinks = noPr ? { links: [] } : await loadLinks(io, json);
  const planning = noPr ? { targets: [], notLinked: [] } : planRepos(located, loaded.links);
  const targets = narrowRepos(planning.targets, opts.noPrFor ?? [], noPr, json);
  const bases = await resolveBases(targets.length > 0 ? io.env.github() : undefined, targets, io.control?.planning);
  const sel: Selection = { name, located, targets, notLinked: planning.notLinked, bases, reposUnavailable: loaded.unavailable };

  if (opts.dryRun === true) {
    const plan = await describePlan(sel, io, await optionalValue(io));
    if (json) console.log(JSON.stringify({ ok: true, dry_run: true, ...plan }, null, 2));
    else console.log(renderPlanText(plan));
    return 0;
  }

  const planId = planIdFor(sel);
  if (opts.confirm === undefined) {
    const plan = await describePlan(sel, io, undefined);
    return refuse(
      json,
      ERROR_CODES.PLAN_CONFIRM_REQUIRED,
      `A real run needs --confirm ${planId}. Run with --dry-run to see the plan.`, // COPY-FLAG
      { plan_id: planId, plan, unanswered: [{ id: 'confirm', flag: '--confirm', value: planId }] },
    );
  }
  if (opts.confirm !== planId) {
    const plan = await describePlan(sel, io, undefined);
    return refuse(
      json,
      ERROR_CODES.PLAN_CHANGED,
      'The plan is not the one that was confirmed. Nothing was changed.', // COPY-FLAG
      { plan_id: planId, plan },
    );
  }

  const value = await requireValue(io, json);
  const result = await runSecretSet({ name, value, locations: located, repos: targets, bases }, io.env, {
    stopPushes: io.control?.pushes,
    stopPrs: io.control?.prs,
    // Said once per phase when a stop is noticed with items still running; silent when nothing is in progress.
    onStopping: ({ inFlight }) => (json || inFlight === 0 ? undefined : console.error(stoppingAfter(inFlight))),
  });
  const cancelled = result.cancelled ?? [];
  // A stopped run is partial too: what was done is real, the rest is listed as cancelled.
  const failed = result.failed.length > 0 || cancelled.length > 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: !failed,
          ...(failed ? { code: ERROR_CODES.SECRETS_PARTIAL } : {}),
          name,
          plan_id: planId,
          updated: result.updated,
          unchanged: result.unchanged,
          prs: result.prs,
          no_pr: result.no_pr,
          ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
          failed: result.failed,
          ...(cancelled.length > 0 ? { cancelled } : {}),
          not_linked: planning.notLinked,
          ...(loaded.unavailable === undefined ? {} : { repos_unavailable: loaded.unavailable }),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderSecretSetConfirmation(result, process.stdout.isTTY ? TERMINAL_STYLE : undefined));
  }
  return failed ? 1 : 0;
}

// ── Real dependencies ───────────────────────────────────────────────────────

/** How long `--dry-run` waits for a piped value it does not need. */
const DRY_RUN_PEEK_MS = 1000;

/** The silent session a non-interactive command runs under: the org, the user and a client. */
export interface SilentContext {
  readonly orgId: string;
  readonly userId: string;
  readonly client: ServiceClient;
}

export type SilentContextResult =
  | { readonly ok: true; readonly context: SilentContext }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Silent auth only: never a prompt, never a browser. The org is the cwd keep.lock's, else the session's.
 * Returns the refusal instead of exiting, so a caller that owns its own output (`capy deploy dokploy --discover`)
 * can reuse it.
 */
export async function resolveSilentContext(devMode: boolean): Promise<SilentContextResult> {
  const state = await new ProjectManager().detectProjectState().catch(() => undefined);
  const authService = new AuthService(undefined, devMode, state?.userId);
  const client = new ServiceClient(undefined, devMode);
  client.setTokenProvider(() => authService.getValidToken());
  const forOrg = await authService.authenticateSilent(state?.organizationId);
  const auth = forOrg.success ? forOrg : await authService.authenticateSilent();
  if (!auth.success || !auth.user_id) {
    return { ok: false, code: ERROR_CODES.AUTH_FAILED, message: silentAuthFailureMessage(auth) };
  }
  const orgs = auth.organizations ?? [];
  const orgId = state?.organizationId ?? auth.organization_id ?? (orgs.length === 1 ? orgs[0].id : undefined);
  if (orgId === undefined) {
    return {
      ok: false,
      code: ERROR_CODES.ORG_NOT_FOUND,
      message: 'No organization could be chosen without a prompt. Run from a project folder.', // COPY-FLAG
    };
  }
  return { ok: true, context: { orgId, userId: auth.user_id as string, client } };
}

export async function silentContext(devMode: boolean, json: boolean): Promise<SilentContext> {
  const resolved = await resolveSilentContext(devMode);
  return resolved.ok ? resolved.context : refuse(json, resolved.code, resolved.message);
}

/**
 * Runs `fn` with cancel signals wired to SIGINT: the first one starts no new location or PR and
 * waits for every one in flight; a second also stops the PRs. A push is never cut in
 * half. The handler is removed when `fn` ends.
 */
export async function withSigintControl<T>(
  fn: (control: NonNullable<SecretsSetIo['control']>) => Promise<T>,
  onFirst: () => void = () => undefined,
): Promise<T> {
  const planning = new AbortController();
  const pushes = new AbortController();
  const prs = new AbortController();
  const onSigint = (): void => {
    if (pushes.signal.aborted) {
      prs.abort();
      return;
    }
    onFirst();
    planning.abort();
    pushes.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    return await fn({ planning: planning.signal, pushes: pushes.signal, prs: prs.signal });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** `capy secrets set NAME`: builds the real service client, `gh` and stdin, then runs. */
export async function secretsSetCommand(name: string, opts: SecretsSetOpts, devMode: boolean = false): Promise<number> {
  const json = opts.json === true;
  // Checked before any auth or network call.
  if (!isValidVarName(name)) return refuseInvalidName(json);
  const { orgId, userId, client } = await silentContext(devMode, json);
  const io: SecretsSetIo = {
    orgId,
    client,
    env: createSetEnv(orgId, userId, client),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () => readPipedValue(process.stdin, MAX_PIPED_BYTES),
    peekStdin: () =>
      Promise.race([
        readPipedValue(process.stdin, MAX_PIPED_BYTES),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), DRY_RUN_PEEK_MS);
          timer.unref?.();
        }),
      ]),
  };
  return withSigintControl((control) => runSecretsSet(name, opts, { ...io, control }));
}
