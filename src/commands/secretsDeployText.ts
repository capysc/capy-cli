/**
 * The words and the JSON of a `capy secrets` batch deploy. Pure: a plan or a result
 * in, text or data out. Names, counts, URLs and codes only; never a value, never a hash.
 *
 * The confirmation follows the multi-edit's look (`secretsSetText.ts`): a header, then one
 * block per pull request, then what was skipped. Where `capy deploy` already has the
 * words, they are its own ("Review and merge to deploy:") and the approved PR sentences.
 */
import { keepPrErrorMessage } from './keepLockPr';
import { BatchPlan, BatchResult, PlanSkipped, TargetRef, TargetResult } from '../deploy/batchDeploy';
import type { BatchTarget } from '../deploy/batchDeploy';
import { ConfirmationStyle } from './secretsSetText';

// COPY-FLAG: every string below is minimal and neutral unless it says it is existing copy.
const REVIEW_AND_MERGE = 'Review and merge to deploy:'; // existing: `capy deploy`
/** The two approved sentences `capy deploy` writes in a deploy PR. */
const CLOSING = [
  'The new values are already in Dokploy. The next release of this branch will use them.',
  'Merging the PR records them in keep.lock, and it starts a release if Dokploy builds on merge.',
]; // approved by Vince 2026-10-04, from the deploy PR body
const NOTHING_TO_DEPLOY = 'Nothing to deploy.'; // COPY-FLAG
const SKIPPED_HEADING = 'Skipped'; // COPY-FLAG
const FAILED_HEADING = 'Failed'; // COPY-FLAG
const CANCELLED_HEADING = 'Cancelled'; // COPY-FLAG
const NO_PR_NEEDED = 'No pull request needed: keep.lock is already up to date.'; // COPY-FLAG
const VALUES_IN_DOKPLOY = 'The values are already in Dokploy.'; // COPY-FLAG
export const DRY_RUN_DEPLOY_NOTE = 'Dry run: nothing was changed.'; // COPY-FLAG (same words as the edit's dry run)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rows as aligned columns, two spaces apart, the header first. The last column is not padded. */
export function renderTable(headings: readonly string[], rows: readonly (readonly string[])[]): readonly string[] {
  const all = [headings, ...rows];
  const widths = headings.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  return all.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join('  ').trimEnd());
}

// ── The plan ─────────────────────────────────────────────────────────────────

const location = (project: string, branch: string): string => `${project} · ${branch}`;

/** `5 vars` or `skipped NO_TARGET`, the last column of a plan line. */
const deployCell = (t: BatchTarget): string => plural(t.config.vars.length, 'var'); // COPY-FLAG
const skipCell = (s: PlanSkipped): string => `skipped ${s.code}`; // COPY-FLAG

export const PLAN_HEADINGS: readonly string[] = ['LOCATION', 'TARGET', 'PROVIDER', 'DEPLOY']; // COPY-FLAG

/** One row per target: location, target, provider, vars. */
export const targetRows = (plan: BatchPlan): readonly (readonly string[])[] =>
  plan.targets.map((t) => [location(t.project_name, t.branch), t.config.name, t.config.kind, deployCell(t)]);

/** One row per skipped location, with its reason, in the same columns as `targetRows`. */
export const skippedRows = (plan: BatchPlan): readonly (readonly string[])[] =>
  plan.skipped.map((s) => [location(s.project, s.branch), s.target ?? '—', s.provider ?? '—', skipCell(s)]); // COPY-FLAG

/** One row per target (location, target, provider, vars) and one per skipped location (with its reason). */
export const planTableRows = (plan: BatchPlan): readonly (readonly string[])[] => [...targetRows(plan), ...skippedRows(plan)];

/** `Deploy API_KEY to 2 targets`; `Nothing to deploy.` when the plan has no target at all (`total`). */
export const deployTitle = (names: readonly string[], selected: number, total: number): string =>
  total === 0 ? NOTHING_TO_DEPLOY : `Deploy ${names.join(', ')} to ${plural(selected, 'target')}`; // COPY-FLAG

/** Which repos could not be read. */
export const unreadableLines = (plan: BatchPlan): readonly string[] =>
  plan.read_failed.map((f) => `Could not read ${f.repo} (${f.code}).`); // COPY-FLAG

/** The plan as lines: its table, and which repos could not be read. */
export function planLines(plan: BatchPlan, names: readonly string[]): readonly string[] {
  const rows = planTableRows(plan);
  const unreadable = unreadableLines(plan);
  return [
    deployTitle(names, plan.targets.length, plan.targets.length),
    ...(rows.length === 0 ? [] : ['', ...renderTable(PLAN_HEADINGS, rows)]),
    ...(unreadable.length === 0 ? [] : ['', ...unreadable]),
  ];
}

/** Human text for `capy secrets deploy --dry-run` without `--json`. */
export function renderDeployPlanText(plan: BatchPlan, names: readonly string[], planId: string): string {
  return [`Plan ${planId}`, ...planLines(plan, names)].join('\n'); // COPY-FLAG
}

/** The plan as the JSON an agent reads. Counts and names only. */
export function planJsonOf(plan: BatchPlan) {
  return {
    targets: plan.targets.map((t) => ({
      project: t.project_name,
      branch: t.branch,
      target: t.config.name,
      provider: t.config.kind,
      repo: `${t.repo.owner}/${t.repo.name}`,
      path: t.path,
      base: t.base,
      vars: t.config.vars.length,
    })),
    skipped: plan.skipped,
    read_failed: plan.read_failed,
  };
}

// ── The result ───────────────────────────────────────────────────────────────

const PLAIN: ConfirmationStyle = { muted: (text) => text };

/** `✗ message (CODE)`, or `✗ CODE` for a code with no message. */
function reasonLine(code: string): string {
  const message = keepPrErrorMessage(code);
  return message === code ? `✗ ${code}` : `✗ ${message} (${code})`; // COPY-FLAG
}

const refLabel = (t: TargetRef): string => `${location(t.project, t.branch)}  ${t.target}`;

const deliveredOf = (r: BatchResult): readonly Extract<TargetResult, { kind: 'delivered' }>[] =>
  r.targets.flatMap((t) => (t.kind === 'delivered' ? [t] : []));

/** Every skip: the plan's, then those found while running (nothing to deploy), as one list. */
export function skippedOf(r: BatchResult): readonly { readonly project: string; readonly branch: string; readonly target: string | null; readonly provider: string | null; readonly code: string }[] {
  return [
    ...r.skipped,
    ...r.targets.flatMap((t) =>
      t.kind === 'skipped' ? [{ project: t.target.project, branch: t.target.branch, target: t.target.target, provider: t.target.provider, code: t.code }] : [],
    ),
  ];
}

/** The whole confirmation, without a trailing newline. `style` greys the skipped lines in a terminal. */
export function renderBatchResult(result: BatchResult, style: ConfirmationStyle = PLAIN): string {
  const delivered = deliveredOf(result);
  const failed = result.targets.flatMap((t) => (t.kind === 'failed' ? [t] : []));
  const cancelled = result.targets.flatMap((t) => (t.kind === 'cancelled' ? [t] : []));
  const skipped = skippedOf(result);
  const header =
    delivered.length > 0
      ? `✓ ${plural(delivered.length, 'target')} deployed${cancelled.length > 0 ? ' (cancelled)' : ''}.` // COPY-FLAG
      : failed.length > 0
        ? '✗ Nothing was deployed.' // COPY-FLAG
        : cancelled.length > 0
          ? 'Cancelled. Nothing was changed.' // existing: the edit's cancel line
          : NOTHING_TO_DEPLOY;
  const failedSection =
    failed.length === 0
      ? []
      : [
          '',
          FAILED_HEADING,
          ...failed.map((f) => `  ${refLabel(f.target)}  ${reasonLine(f.code)}${f.values_pushed ? `  ${VALUES_IN_DOKPLOY}` : ''}`),
        ];
  const prSection =
    delivered.length === 0
      ? []
      : [
          '',
          REVIEW_AND_MERGE,
          ...delivered.flatMap((d) => [
            '',
            `  ${d.target.repo} · ${d.target.target}`,
            `    ${d.pr_url ?? NO_PR_NEEDED}`,
            ...(d.recorded ? [] : [`    Not recorded on the Capy server (${d.record_code}).`]), // COPY-FLAG
            ...(d.missing_vars && d.missing_vars.length > 0 ? [`    Not in Capy, left out: ${d.missing_vars.join(', ')}`] : []), // COPY-FLAG
          ]),
        ];
  const skippedSection =
    skipped.length === 0
      ? []
      : ['', SKIPPED_HEADING, ...skipped.map((s) => style.muted(`  ${location(s.project, s.branch)}  ${s.target ?? '—'}  ${s.code}`))];
  const cancelledSection =
    cancelled.length === 0
      ? []
      : [
          '',
          CANCELLED_HEADING,
          ...cancelled.map((c) => `  ${refLabel(c.target)}  ${c.stage === 'push' ? 'not started' : 'no PR opened'}`), // COPY-FLAG
        ];
  const unreadable = result.read_failed.map((f) => `Could not read ${f.repo} (${f.code}).`); // COPY-FLAG
  return [
    header,
    ...failedSection,
    ...prSection,
    ...skippedSection,
    ...cancelledSection,
    ...(unreadable.length === 0 ? [] : ['', ...unreadable]),
    ...(delivered.length > 0 ? ['', ...CLOSING] : []),
  ].join('\n');
}

/** The result as the JSON an agent reads. Counts, names, URLs and codes only. */
export function resultJsonOf(result: BatchResult) {
  const ref = (t: TargetRef) => ({
    project: t.project,
    branch: t.branch,
    target: t.target,
    provider: t.provider,
    repo: t.repo,
    path: t.path,
  });
  return {
    delivered: deliveredOf(result).map((d) => ({
      ...ref(d.target),
      pr_url: d.pr_url,
      base: d.base,
      recorded: d.recorded,
      ...(d.record_code === undefined ? {} : { record_code: d.record_code }),
    })),
    skipped: skippedOf(result),
    failed: result.targets.flatMap((t) =>
      t.kind === 'failed' ? [{ ...ref(t.target), code: t.code, stage: t.stage, values_pushed: t.values_pushed }] : [],
    ),
    cancelled: result.targets.flatMap((t) => (t.kind === 'cancelled' ? [{ ...ref(t.target), stage: t.stage, values_pushed: t.values_pushed }] : [])),
    read_failed: result.read_failed,
  };
}
