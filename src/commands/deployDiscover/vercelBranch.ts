/**
 * Which git branch a Vercel environment deploys from (CAP-730), as pure functions.
 *
 * Production is the project's production branch, always. The all-branches
 * PREVIEW environment is usually fed from another branch (a repo whose default
 * branch is `develop` and whose production branch is `main`), so it is judged
 * from three signals, and a custom environment from its branch rule:
 *
 *   1. RECENT_PREVIEW_DEPLOYMENTS  the branch most recent preview deployments built from
 *   2. BRANCH_SCOPED_VARIABLES     the branch most preview variables are scoped to
 *   3. GITHUB_DEFAULT_BRANCH       the repo's default branch, when it is not the production branch
 *
 * Signals agree (every signal names the same single branch): that branch,
 * `certain`. They disagree: the strongest signal wins, in the order above
 * (what was actually deployed outranks what is configured, which outranks a
 * repo-wide default), and the choice is `needs_review` with every signal
 * listed. No signal: the production branch, `needs_review`.
 *
 * Names, ids and counts only. Nothing in here ever holds a variable value.
 */
import { sortedCopy } from '../../deploy/dokployApi';
import type { VercelBranchMatcher, VercelDeployment } from '../../deploy/vercelApi';
import type { BranchSignal, BranchSignalCode, GitBranchBasis, ServiceFacts, VercelServiceFacts } from './facts';
import { byText, uniqueSorted } from './facts';

/** The order signals outrank each other when they disagree. */
export const BRANCH_SIGNAL_ORDER: readonly BranchSignalCode[] = ['RECENT_PREVIEW_DEPLOYMENTS', 'BRANCH_SCOPED_VARIABLES', 'GITHUB_DEFAULT_BRANCH'];

export interface BranchInference {
  readonly branch: string | null;
  readonly confidence: 'certain' | 'needs_review';
  readonly basis: GitBranchBasis;
}

const byWeightThenName = (a: { readonly branch: string; readonly weight: number }, b: { readonly branch: string; readonly weight: number }): number =>
  b.weight - a.weight || byText(a.branch, b.branch);

/** A signal's branches, strongest first. */
const rankedBranches = (branches: BranchSignal['branches']): BranchSignal['branches'] => sortedCopy(branches, byWeightThenName);

/** The branches tied for the strongest weight in a signal (one branch when there is a clear leader). */
export function leadersOf(signal: BranchSignal): readonly string[] {
  const top = Math.max(0, ...signal.branches.map((b) => b.weight));
  return uniqueSorted(signal.branches.filter((b) => b.weight === top).map((b) => b.branch));
}

/** A signal that names at least one branch. */
const names = (signal: BranchSignal): boolean => signal.branches.length > 0;

// ── The signals ──────────────────────────────────────────────────────────────

/** Branch counts over a project's recent preview deployments. A deployment with no git branch (a CLI deploy) counts for none. */
export function deploymentsSignal(deployments: readonly VercelDeployment[]): BranchSignal | null {
  const branches = uniqueSorted(deployments.flatMap((d) => (d.gitBranch === undefined ? [] : [d.gitBranch])));
  return branches.length === 0
    ? null
    : {
        code: 'RECENT_PREVIEW_DEPLOYMENTS',
        branches: rankedBranches(branches.map((branch) => ({ branch, weight: deployments.filter((d) => d.gitBranch === branch).length }))),
      };
}

/** The branches preview variables are scoped to, with the names under each (and the ones the all-branches preview shadows). */
export function scopedVariablesSignal(
  scoped: ReadonlyArray<{ readonly branch: string; readonly names: readonly string[] }>,
  allBranchesNames: readonly string[],
): BranchSignal | null {
  return scoped.length === 0
    ? null
    : {
        code: 'BRANCH_SCOPED_VARIABLES',
        branches: rankedBranches(
          scoped.map(({ branch, names: scopedNames }) => ({
            branch,
            weight: scopedNames.length,
            names: scopedNames,
            shadows: scopedNames.filter((n) => allBranchesNames.includes(n)),
          })),
        ),
      };
}

/** The repo's default branch, but only when it says something the production branch does not. */
export function defaultBranchSignal(defaultBranch: string | null | undefined, productionBranch: string | null): BranchSignal | null {
  return typeof defaultBranch === 'string' && defaultBranch !== '' && defaultBranch !== productionBranch
    ? { code: 'GITHUB_DEFAULT_BRANCH', branches: [{ branch: defaultBranch, weight: 1 }] }
    : null;
}

/** A custom environment's branch matcher. Only `equals` names one branch; a prefix or suffix rule is carried as the rule alone. */
export function customRuleSignal(matcher: VercelBranchMatcher | undefined): BranchSignal | null {
  return matcher === undefined
    ? null
    : {
        code: 'CUSTOM_ENVIRONMENT_RULE',
        branches: matcher.type === 'equals' ? [{ branch: matcher.pattern, weight: 1 }] : [],
        rule: { type: matcher.type, pattern: matcher.pattern },
      };
}

// ── The choice ───────────────────────────────────────────────────────────────

const rankOf = (signal: BranchSignal): number => {
  const at = BRANCH_SIGNAL_ORDER.indexOf(signal.code);
  return at === -1 ? BRANCH_SIGNAL_ORDER.length : at;
};

/** Every signal names the same single branch. */
function agreement(active: readonly BranchSignal[]): string | null {
  const leaders = active.map(leadersOf);
  const first = leaders[0]?.[0];
  return first !== undefined && leaders.every((l) => l.length === 1 && l[0] === first) ? first : null;
}

/**
 * The strongest signal wins; a tie inside it is broken by the next signal down
 * (when it names one of the tied branches), then by branch name.
 */
function strongest(active: readonly BranchSignal[]): string {
  const ordered = sortedCopy(active, (a, b) => rankOf(a) - rankOf(b));
  const narrowed = ordered.slice(1).reduce<readonly string[]>((candidates, signal) => {
    const common = leadersOf(signal).filter((b) => candidates.includes(b));
    return common.length > 0 ? common : candidates;
  }, leadersOf(ordered[0]));
  return sortedCopy(narrowed, byText)[0];
}

/** The git branch of an all-branches preview from its signals. */
export function inferPreviewBranch(signals: readonly BranchSignal[], productionBranch: string | null): BranchInference {
  const active = signals.filter(names);
  if (active.length === 0) return { branch: productionBranch, confidence: 'needs_review', basis: 'no_signals' };
  const agreed = agreement(active);
  if (agreed !== null) return { branch: agreed, confidence: 'certain', basis: 'signals_agree' };
  return { branch: strongest(active), confidence: 'needs_review', basis: 'strongest_signal' };
}

/** The git branch of a custom environment from its rule: an exact rule names the branch; a pattern names none. */
export function inferCustomBranch(signals: readonly BranchSignal[], productionBranch: string | null): BranchInference | null {
  const rule = signals.find((s) => s.code === 'CUSTOM_ENVIRONMENT_RULE');
  if (rule === undefined) return null;
  const exact = rule.branches[0];
  return exact === undefined
    ? { branch: productionBranch, confidence: 'needs_review', basis: 'custom_environment_pattern' }
    : { branch: exact.branch, confidence: 'certain', basis: 'custom_environment_rule' };
}

// ── Applying it to a service ─────────────────────────────────────────────────

const asVercel = (service: ServiceFacts): VercelServiceFacts => service as VercelServiceFacts;

const isAllBranchesPreview = (v: VercelServiceFacts): boolean => v.environment === 'preview' && v.git_branch_scope === null;

/**
 * A service with its git branch settled. Only the all-branches preview and a
 * custom environment with a rule are judged; every other service (production,
 * `development`, a branch-scoped preview) is returned as it is. The default
 * branch is the repo's, from GitHub, and joins the signals here because it is
 * read after the Vercel side.
 */
export function withGitBranch(service: ServiceFacts, defaultBranch: string | null | undefined): ServiceFacts {
  const v = asVercel(service);
  if (v.git_branch_signals === undefined) return service;
  if (isAllBranchesPreview(v)) {
    const defaultSignal = defaultBranchSignal(defaultBranch, v.branch);
    const signals = [...v.git_branch_signals, ...(defaultSignal === null ? [] : [defaultSignal])];
    const inferred = inferPreviewBranch(signals, v.branch);
    return { ...v, branch: inferred.branch, git_branch_signals: signals, git_branch_basis: inferred.basis, git_branch_confidence: inferred.confidence };
  }
  const custom = inferCustomBranch(v.git_branch_signals, v.branch);
  return custom === null
    ? service
    : { ...v, branch: custom.branch, git_branch_basis: custom.basis, git_branch_confidence: custom.confidence };
}
