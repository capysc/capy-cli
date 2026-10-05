/**
 * The words `capy secrets` edits end with. Pure: a result in, text out. Names,
 * counts, URLs and codes only; never a value, never a hash.
 *
 * The confirmation for a successful run is the APPROVED copy, verbatim:
 *
 *     ✓ ANTHROPIC_API_KEY updated in 6 locations.
 *
 *     Pull requests (merge each to update that repo's keep.lock):
 *
 *       SlideSpeak/slidespeak-monorepo
 *         https://github.com/SlideSpeak/slidespeak-monorepo/pull/8401
 *
 *     The new value is saved in Capy now. Each repo keeps using the old value
 *     until its PR is merged and pulled.
 *
 * One block per repo that got a PR, never truncated. No per-PR location line and
 * no "not changed" line. A failed repo shows `✗` and a short coded reason, and
 * the others are still listed.
 */
import { keepPrErrorMessage } from './keepLockPr';
import type { CancelledItem, FailedItem, SecretSetResult } from './secretsSet';

// COPY-FLAG: every string below that is not in the approved block above is minimal and neutral.
const HEADER_FAILED = (name: string) => `✗ ${name} was not updated.`; // COPY-FLAG
const HEADER_NOTHING_TO_DO = (name: string) =>
  `${name} already has this value in every selected location. Nothing changed.`; // COPY-FLAG
const NOT_UPDATED = 'Not updated:'; // COPY-FLAG
const SAVED_NO_PR = 'The new value is saved in Capy now.'; // COPY-FLAG
export const CANCELLED_NOTHING = 'Cancelled. Nothing was changed.'; // COPY-FLAG
/** The line after a stop: every item already running is waited for, none is started. */
export const stoppingAfter = (inFlight: number): string => `Stopping after the ${inFlight} in progress…`; // COPY-FLAG
/** The same when nothing is running right now. */
export const STOPPING_NOW = 'Stopping…'; // COPY-FLAG
export const STOPPING_AGAIN = 'Still waiting for the push in flight.'; // COPY-FLAG
const CANCELLED_LABEL = 'Cancelled:'; // COPY-FLAG
const SKIPPED_HEADING = 'Skipped'; // COPY-FLAG
const SKIPPED_DESCRIPTION = 'Nothing changed in these repos, so no pull request was opened.'; // COPY-FLAG

/** How a skipped repo is drawn: grey in a terminal, plain for agents and pipes. */
export interface ConfirmationStyle {
  readonly muted: (text: string) => string;
}

const PLAIN: ConfirmationStyle = { muted: (text) => text };
/** Grey, the same 90 the rest of the CLI uses for secondary text. */
export const TERMINAL_STYLE: ConfirmationStyle = { muted: (text) => `\x1b[90m${text}\x1b[0m` };

const plural = (n: number): string => `${n} location${n === 1 ? '' : 's'}`;

const cancelledOf = (result: SecretSetResult): readonly CancelledItem[] => result.cancelled ?? [];

function header(result: SecretSetResult): string {
  const n = result.updated.length;
  const cancelledLocations = cancelledOf(result).filter((c) => c.kind === 'location').length;
  if (cancelledLocations > 0) {
    // Stopped part way: what was done, out of everything that was asked for.
    const total = n + result.unchanged.length + result.failed.filter((f) => f.kind === 'location').length + cancelledLocations;
    return n > 0
      ? `✓ ${result.name} updated in ${n} of ${plural(total)} (cancelled).` // COPY-FLAG
      : CANCELLED_NOTHING;
  }
  if (n > 0) return `✓ ${result.name} updated in ${plural(n)}.`;
  const locationFailures = result.failed.filter((f) => f.kind === 'location');
  return locationFailures.length > 0 ? HEADER_FAILED(result.name) : HEADER_NOTHING_TO_DO(result.name);
}

/** `owner/repo` as `✗ reason (CODE)`: what a failed repo or location shows. */
function reasonLine(code: string): string {
  const message = keepPrErrorMessage(code);
  return message === code ? `✗ ${code}` : `✗ ${message} (${code})`; // COPY-FLAG
}

function failedLocationLines(failed: readonly FailedItem[]): readonly string[] {
  const locations = failed.flatMap((f) => (f.kind === 'location' ? [f] : []));
  if (locations.length === 0) return [];
  return ['', NOT_UPDATED, ...locations.map((f) => `  ${f.project} · ${f.branch}  ${reasonLine(f.code)}`)];
}

function cancelledLines(result: SecretSetResult): readonly string[] {
  const items = cancelledOf(result);
  if (items.length === 0) return [];
  return [
    '',
    CANCELLED_LABEL,
    ...items.map((c) => (c.kind === 'location' ? `  ${c.project} · ${c.branch}` : `  ${c.repo}  no PR opened`)), // COPY-FLAG
  ];
}

type RepoBlock = { readonly repo: string; readonly line: string };

/** The repos in the order they were asked for: those with a PR first-come, failed ones where they fell. */
function repoBlocks(result: SecretSetResult): readonly RepoBlock[] {
  const prs = result.prs.map((p): RepoBlock => ({ repo: p.repo, line: p.url }));
  const failed = result.failed.flatMap((f): RepoBlock[] =>
    f.kind === 'repo' ? [{ repo: f.repo, line: reasonLine(f.code) }] : [],
  );
  return [...prs, ...failed];
}

/** Repos that needed no PR: none of their values changed, or their keep.lock was already up to date. */
const skippedRepos = (result: SecretSetResult): readonly string[] => [
  ...result.no_pr.map((n) => n.repo),
  ...(result.skipped ?? []).map((n) => n.repo),
];

/** The whole confirmation, without a trailing newline. `style` greys the skipped repos in a terminal. */
export function renderSecretSetConfirmation(result: SecretSetResult, style: ConfirmationStyle = PLAIN): string {
  const blocks = repoBlocks(result);
  const prSection =
    blocks.length === 0
      ? []
      : [
          '',
          "Pull requests (merge each to update that repo's keep.lock):",
          ...blocks.flatMap((b) => ['', `  ${b.repo}`, `    ${b.line}`]),
        ];
  const skipped = skippedRepos(result);
  const skippedSection =
    skipped.length === 0
      ? []
      : ['', SKIPPED_HEADING, SKIPPED_DESCRIPTION, '', ...skipped.map((repo) => style.muted(`  ${repo}`))];
  const closing =
    result.prs.length > 0
      ? [
          '',
          'The new value is saved in Capy now. Each repo keeps using the old value',
          'until its PR is merged and pulled.',
        ]
      : result.updated.length > 0
        ? ['', SAVED_NO_PR]
        : [];
  return [header(result), ...failedLocationLines(result.failed), ...prSection, ...skippedSection, ...closing, ...cancelledLines(result)].join('\n');
}

// ── Dry run (`capy --dry-run secrets`) ──────────────────────────────────────

/** What a dry run of the edit flow would do: names, counts and base branches only. */
export interface DryRunView {
  readonly name: string;
  /** Locations that would change (unchanged ones are not counted). */
  readonly updateCount: number;
  /** Repos that would get a PR; `base` is `null` when it could not be read. */
  readonly prs: ReadonlyArray<{ readonly repo: string; readonly base: string | null; readonly diverged: boolean }>;
  /** Set when the repo links could not be read, so no PR could be planned. */
  readonly reposUnavailable?: string;
}

/** The marker every screen carries while `--dry-run` is on. */
export const DRY_RUN_LABEL = 'DRY RUN'; // COPY-FLAG

/** The plan screen, without a trailing newline. No URLs (none exist), no value, no hash. */
export function renderDryRunPlan(view: DryRunView): string {
  const prs =
    view.prs.length === 0
      ? []
      : [
          'Would open pull requests in:', // COPY-FLAG
          ...view.prs.map((p) => `  ${p.repo} (${p.base ?? 'default branch'})${p.diverged ? '  keep.lock differs' : ''}`), // COPY-FLAG
        ];
  return [
    'Dry run: nothing was changed.', // COPY-FLAG
    `Would update ${view.name} in ${plural(view.updateCount)}.`, // COPY-FLAG
    ...prs,
    ...(view.reposUnavailable === undefined ? [] : [`Repos unavailable (${view.reposUnavailable}).`]), // COPY-FLAG
  ].join('\n');
}
