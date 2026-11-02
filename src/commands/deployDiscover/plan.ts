/**
 * The plan file of `capy deploy dokploy --discover --plan <file>` (CAP-703):
 * parsing it, normalizing it, and the `plan_id` that ties a `--confirm` to the
 * exact plan a `--dry-run` showed.
 *
 *     { "version": 1, "entries": [ { project_id, branch, service_id, git_branch, vars } ] }
 *
 * IDs and names only. The schema is published in `capy help --json`
 * (`schemas.deploy_dokploy_plan`).
 *
 * Errors are PATH-PRECISE and coded: `{ path: "entries[3].service_id", code: "INVALID_FORMAT" }`.
 * A path says where, a code says what; nothing is ever decided from a sentence.
 */
import { createHash } from 'crypto';
import { ERROR_CODES } from '../../types/index';
import { isValidVarName } from '../pipedWrite';
import { PlanEntry } from './discovery';
import { byText, uniqueSorted } from './facts';
import { sortedCopy } from '../../deploy/dokployApi';

export interface PlanError {
  readonly path: string;
  readonly code: string;
}

export interface Plan {
  readonly version: 1;
  readonly entries: readonly PlanEntry[];
}

/** More entries than this is a mistake, not a plan. */
export const MAX_PLAN_ENTRIES = 500;

const ENTRY_KEYS = ['project_id', 'branch', 'service_id', 'git_branch', 'vars'] as const;

const invalid = (path: string): PlanError => ({ path, code: ERROR_CODES.INVALID_FORMAT });

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A non-empty string with no leading or trailing space. */
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;

function entryErrors(raw: unknown, i: number): readonly PlanError[] {
  const at = `entries[${i}]`;
  const entry = asObject(raw);
  if (entry === undefined) return [invalid(at)];
  const unknownKeys = Object.keys(entry).filter((k) => !(ENTRY_KEYS as readonly string[]).includes(k));
  const idErrors = (['project_id', 'branch', 'service_id', 'git_branch'] as const).filter((k) => !isId(entry[k])).map((k) => invalid(`${at}.${k}`));
  const vars = entry.vars;
  const varErrors: readonly PlanError[] =
    !Array.isArray(vars) || vars.length === 0
      ? [invalid(`${at}.vars`)]
      : vars.flatMap((v, j) => (typeof v === 'string' && isValidVarName(v) ? [] : [invalid(`${at}.vars[${j}]`)]));
  return [...unknownKeys.map((k) => invalid(`${at}.${k}`)), ...idErrors, ...varErrors];
}

/** The plan's SHAPE, before anything is looked up. Errors name the path. */
export function planShapeErrors(raw: unknown): readonly PlanError[] {
  const plan = asObject(raw);
  if (plan === undefined) return [invalid('')];
  const topKeys = Object.keys(plan).filter((k) => k !== 'version' && k !== 'entries');
  const versionErrors = plan.version === 1 ? [] : [invalid('version')];
  const entries = plan.entries;
  const entriesErrors: readonly PlanError[] =
    !Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PLAN_ENTRIES
      ? [invalid('entries')]
      : entries.flatMap((e, i) => entryErrors(e, i));
  return [...topKeys.map((k) => invalid(k)), ...versionErrors, ...entriesErrors];
}

/** The entries of a plan that passed `planShapeErrors`, in file order, with each entry's vars exactly as written. */
export function planEntriesOf(raw: unknown): readonly PlanEntry[] {
  const entries = (asObject(raw)?.entries ?? []) as ReadonlyArray<Record<string, unknown>>;
  return entries.map((e) => ({
    project_id: e.project_id as string,
    branch: e.branch as string,
    service_id: e.service_id as string,
    git_branch: e.git_branch as string,
    vars: e.vars as readonly string[],
  }));
}

/** Entries sorted by (project, branch, service) with each entry's vars sorted and de-duplicated, keys in a fixed order. */
export function normalizePlan(entries: readonly PlanEntry[]): Plan {
  const normalized = entries.map(
    (e): PlanEntry => ({
      project_id: e.project_id,
      branch: e.branch,
      service_id: e.service_id,
      git_branch: e.git_branch,
      vars: uniqueSorted(e.vars),
    }),
  );
  return {
    version: 1,
    entries: sortedCopy(
      normalized,
      (a, b) => byText(a.project_id, b.project_id) || byText(a.branch, b.branch) || byText(a.service_id, b.service_id),
    ),
  };
}

const PLAN_DOMAIN = 'capy:deploy-dokploy:plan:v1';

/**
 * A hash of the normalized plan and the Dokploy base URL it will be written
 * with. Opaque, and the same for the same plan however its entries or vars
 * were ordered. It carries no value: a plan has none.
 */
export function planIdOf(plan: Plan, baseUrl: string): string {
  const canonical = JSON.stringify({ base_url: baseUrl, version: plan.version, entries: plan.entries });
  return createHash('sha256').update(`${PLAN_DOMAIN}\u0000${canonical}`).digest('hex').slice(0, 16);
}

/** First four characters and an ellipsis, so a person can tell services apart at a glance. */
const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 4)}…` : id);

/** One line a person reads. The agent relays these verbatim. */
export function summaryLine(args: {
  readonly project_name: string;
  readonly kind: 'application' | 'compose';
  readonly entry: PlanEntry;
}): string {
  const { project_name, kind, entry } = args;
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  return `${project_name} · ${entry.branch} → Dokploy ${kind} ${shortId(entry.service_id)} (${entry.git_branch}), ${entry.vars.length} vars`;
}

/** The line for an entry that needs nothing done. */
export function alreadyConfiguredLine(args: { readonly project_name: string; readonly entry: PlanEntry; readonly target_name: string }): string {
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  return `${args.project_name} · ${args.entry.branch}: already configured (${args.target_name}), nothing to do`;
}
