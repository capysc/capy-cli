/**
 * `capy secrets deploy NAME...` (CAP-704, agent mode): deploy the Dokploy targets of the
 * chosen secrets, with no project folder, and open one keep.lock PR per target. It mirrors
 * `capy secrets set`: it NEVER prompts, never opens a browser, and takes no value (it
 * deploys what Capy holds now).
 *
 *     capy secrets deploy NAME --all-rows --dry-run --json            # plan, changes nothing
 *     capy secrets deploy NAME --all-rows --confirm <plan_id> --json
 *
 * The flow an agent follows: look the rows up (`capy secrets --name NAME --json`), show the
 * human a table, let the HUMAN pick the row(s) (never pick one yourself), dry run, get
 * approval, then run with `--confirm <plan_id>`.
 *
 * What "deploy" means: exactly what `capy deploy <target>` does for a Dokploy target in CI
 * mode (see `deploy/batchDeploy.ts`). Other targets are listed in `skipped` with a code.
 *
 * Selection
 *   Each NAME matches rows (one per distinct value). A NAME with several rows and neither
 *   `--row <row_id>` (repeatable) nor `--all-rows`: refused `SECRET_AMBIGUOUS` (exit 3) with the
 *   candidates in `unanswered`. `--exclude <project>:<branch>` (repeatable) drops locations.
 *
 * The plan and `plan_id`
 *   `--dry-run` prints the plan and changes nothing (it reads the service and GitHub only,
 *   and unlocks nothing). `plan_id` is a hash of the exact (row_id, project, branch) set and
 *   of the targets (project, repo, folder, PR base, target, variables). A real run REQUIRES
 *   `--confirm <plan_id>`; without it the refusal (exit 3) carries the plan, and a plan that
 *   moved since is refused `PLAN_CHANGED` (exit 1) with nothing done.
 *
 * Output never carries a value or any hash of one. Failures are codes.
 */
import { createHash } from 'crypto';
import type { OrgRepoLink, SecretIndexRow, ServiceClient } from '../service/serviceClient';
import { ERROR_CODES } from '../types/index';
import { isValidVarName } from './pipedWrite';
import { refuseInvalidName } from './pipedValue';
import { rowIdOf } from './secretsRowId';
import {
  BatchEnv,
  BatchPlan,
  BatchResult,
  DeployLocation,
  batchSucceeded,
  createBatchEnv,
  deployLocationsOf,
  planBatchDeploy,
  runBatchDeploy,
} from '../deploy/batchDeploy';
import { targetRefFor } from '../deploy/deliveryRecord';
import type { SecretsSetIo } from './secretsSetCommand';
import {
  byText,
  candidatesOf,
  excludeLocations,
  loadLinks,
  readSecretIndex,
  refuse,
  silentContext,
  withSigintControl,
} from './secretsSetCommand';
import { renderBatchResult, renderDeployPlanText, planJsonOf, resultJsonOf } from './secretsDeployText';
import { TERMINAL_STYLE, stoppingAfter } from './secretsSetText';

export interface SecretsDeployOpts {
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
}

/** Injectable seam: tests pass fakes for the service, GitHub and Dokploy. */
export interface SecretsDeployIo {
  readonly orgId: string;
  readonly client: Pick<ServiceClient, 'getSecretIndex' | 'getOrgRepos'>;
  readonly env: BatchEnv;
  /** Cancel signals (SIGINT in the real command), the same three the edit has. */
  readonly control?: SecretsSetIo['control'];
}

// ── Selection ───────────────────────────────────────────────────────────────

interface Located extends DeployLocation {
  readonly row_id: string;
}

const locatedOf = (row: SecretIndexRow): readonly Located[] => {
  const row_id = rowIdOf(row.name, row.value_hash);
  return deployLocationsOf(row).map((l) => ({ ...l, row_id }));
};

const ambiguousStop = (named: readonly SecretIndexRow[]) => [
  { id: 'row', flag: '--row', alternative: '--all-rows', candidates: candidatesOf(named) },
];

/** The rows the run is about, or a refusal. Several names: each name is chosen on its own. */
function selectRows(rows: readonly SecretIndexRow[], names: readonly string[], opts: SecretsDeployOpts, json: boolean): readonly SecretIndexRow[] {
  const byName = names.map((name) => ({ name, rows: rows.filter((r) => r.name === name) }));
  const missing = byName.find((n) => n.rows.length === 0);
  if (missing !== undefined) refuse(json, ERROR_CODES.SECRET_NOT_FOUND, 'No secret has that name.'); // COPY-FLAG
  const wanted = opts.row ?? [];
  if (wanted.length > 0 && opts.allRows === true) {
    refuse(json, ERROR_CODES.INVALID_FORMAT, '--row and --all-rows cannot be used together.'); // COPY-FLAG
  }
  if (opts.allRows === true) return byName.flatMap((n) => n.rows);
  const named = byName.flatMap((n) => n.rows);
  const known = new Set(named.map((r) => rowIdOf(r.name, r.value_hash)));
  if (wanted.some((id) => !known.has(id))) {
    refuse(json, ERROR_CODES.SECRET_NOT_FOUND, 'A --row id matches no row of those names.', { unanswered: ambiguousStop(named) }); // COPY-FLAG
  }
  const chosen = byName.map((n) => {
    const picked = n.rows.filter((r) => wanted.includes(rowIdOf(r.name, r.value_hash)));
    return { ...n, picked: picked.length > 0 ? picked : n.rows.length === 1 ? n.rows : [] };
  });
  const unresolved = chosen.filter((c) => c.picked.length === 0);
  if (unresolved.length > 0) {
    refuse(
      json,
      ERROR_CODES.SECRET_AMBIGUOUS,
      'A name has more than one value. Choose --row <row_id> (repeatable) or --all-rows.', // COPY-FLAG
      { unanswered: ambiguousStop(unresolved.flatMap((u) => u.rows)) },
    );
  }
  return chosen.flatMap((c) => c.picked);
}

// ── The plan ────────────────────────────────────────────────────────────────

const PLAN_DOMAIN = 'capy:secrets:deploy-plan:v1';

/**
 * A hash over the exact (row_id, project, branch) set and the targets to deploy
 * (project, repo, folder, PR base, target, kind, Capy branch, service, variables), each sorted
 * so order never matters. Opaque: it carries no value and no value hash.
 */
export function deployPlanIdOf(
  names: readonly string[],
  locations: ReadonlyArray<{ readonly row_id: string; readonly project: string; readonly branch: string }>,
  plan: BatchPlan,
): string {
  const canonical = JSON.stringify({
    names: [...names].sort(byText),
    locations: locations.map((l) => [l.row_id, l.project, l.branch].join('\u0000')).sort(byText),
    targets: plan.targets
      .map((t) =>
        [
          t.project_id,
          `${t.repo.owner}/${t.repo.name}`.toLowerCase(),
          t.path,
          t.base,
          t.config.name,
          t.config.kind,
          t.branch,
          JSON.stringify(targetRefFor(t.config) ?? {}),
          [...t.config.vars].sort(byText).join('\u0001'),
        ].join('\u0000'),
      )
      .sort(byText),
  });
  return createHash('sha256').update(`${PLAN_DOMAIN}\u0000${canonical}`).digest('hex').slice(0, 16);
}

interface Selection {
  readonly names: readonly string[];
  readonly located: readonly Located[];
}

const planIdFor = (sel: Selection, plan: BatchPlan): string =>
  deployPlanIdOf(
    sel.names,
    sel.located.map((l) => ({ row_id: l.row_id, project: l.project_name, branch: l.branch })),
    plan,
  );

async function readPlan(sel: Selection, io: SecretsDeployIo, links: readonly OrgRepoLink[]): Promise<BatchPlan> {
  return planBatchDeploy(io.env.github(), { names: sel.names, locations: sel.located }, links, io.control?.planning);
}

// ── The command ─────────────────────────────────────────────────────────────

/**
 * Runs `capy secrets deploy NAME...`. Returns the exit code (0 when nothing failed, 1 on a
 * partial failure); a refusal exits the process itself.
 */
export async function runSecretsDeploy(names: readonly string[], opts: SecretsDeployOpts, io: SecretsDeployIo): Promise<number> {
  const json = opts.json === true;
  if (names.length === 0 || !names.every(isValidVarName)) return refuseInvalidName(json);

  const rows = selectRows(await readSecretIndex(io, json), names, opts, json);
  const located = excludeLocations(rows.flatMap(locatedOf), opts.exclude ?? [], json);
  if (located.length === 0) {
    refuse(json, ERROR_CODES.SECRETS_NOTHING_SELECTED, 'No location is left to deploy.'); // COPY-FLAG
  }
  const loaded = await loadLinks(io, json);
  const sel: Selection = { names, located };
  const plan = await readPlan(sel, io, loaded.links);
  const planId = planIdFor(sel, plan);
  const planBody = { names, ...planJsonOf(plan), ...(loaded.unavailable === undefined ? {} : { repos_unavailable: loaded.unavailable }) };

  if (opts.dryRun === true) {
    if (json) console.log(JSON.stringify({ ok: true, dry_run: true, plan_id: planId, ...planBody }, null, 2));
    else console.log(renderDeployPlanText(plan, names, planId));
    return 0;
  }

  if (plan.targets.length === 0) {
    return refuse(json, ERROR_CODES.DEPLOY_NOTHING_TO_DEPLOY, 'No Dokploy target is left to deploy.', { plan_id: planId, plan: planBody }); // COPY-FLAG
  }
  if (opts.confirm === undefined) {
    return refuse(
      json,
      ERROR_CODES.PLAN_CONFIRM_REQUIRED,
      `A real run needs --confirm ${planId}. Run with --dry-run to see the plan.`, // COPY-FLAG
      { plan_id: planId, plan: planBody, unanswered: [{ id: 'confirm', flag: '--confirm', value: planId }] },
    );
  }
  if (opts.confirm !== planId) {
    return refuse(
      json,
      ERROR_CODES.PLAN_CHANGED,
      'The plan is not the one that was confirmed. Nothing was changed.', // COPY-FLAG
      { plan_id: planId, plan: planBody },
    );
  }

  const result: BatchResult = await runBatchDeploy(plan, io.env, {
    stopPushes: io.control?.pushes,
    stopPrs: io.control?.prs,
    // Said once per phase when a stop is noticed with items still running; silent when nothing is in progress.
    onStopping: ({ inFlight }) => (json || inFlight === 0 ? undefined : console.error(stoppingAfter(inFlight))),
  });
  const ok = batchSucceeded(result);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok,
          ...(ok ? {} : { code: ERROR_CODES.DEPLOY_BATCH_PARTIAL }),
          plan_id: planId,
          names,
          ...resultJsonOf(result),
          ...(loaded.unavailable === undefined ? {} : { repos_unavailable: loaded.unavailable }),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderBatchResult(result, process.stdout.isTTY ? TERMINAL_STYLE : undefined));
  }
  return ok ? 0 : 1;
}

/** `capy secrets deploy NAME...`: builds the real service client, `gh`, key store and Dokploy adapter, then runs. */
export async function secretsDeployCommand(names: readonly string[], opts: SecretsDeployOpts, devMode: boolean = false): Promise<number> {
  const json = opts.json === true;
  // Checked before any auth or network call.
  if (names.length === 0 || !names.every(isValidVarName)) return refuseInvalidName(json);
  const { orgId, userId, client } = await silentContext(devMode, json);
  const io: SecretsDeployIo = { orgId, client, env: createBatchEnv(orgId, userId, client, devMode) };
  return withSigintControl((control) => runSecretsDeploy(names, opts, { ...io, control }));
}
