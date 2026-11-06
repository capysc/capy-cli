/**
 * Which git branch a Vercel environment deploys from (CAP-730), as pure functions.
 *
 * Production is the project's production branch, always. The all-branches
 * PREVIEW environment's branch is the deploy PR base, so it must be a
 * LONG-LIVED branch. The candidates are ONLY:
 *
 *   - the project's production branch
 *   - the repo's GitHub default branch
 *   - a branch that preview variables are scoped to
 *
 * (a custom environment's `equals` rule names its own branch). Recent preview
 * deployments never add a candidate: a feature branch, or a one-off import
 * branch, was deployed once and is gone. Deployments only RANK the candidates.
 *
 * With one candidate (the production branch) that is the answer, `certain`.
 * With several, they are ranked by deployments on each, then by scoped
 * variables, then by being the default branch (then by name). The winner is
 * `certain` only when every signal that names a candidate names the winner and
 * only the winner; otherwise it is `needs_review`. Every signal is listed.
 *
 * Names, ids and counts only. Nothing in here ever holds a variable value.
 */
import { sortedCopy } from '../../deploy/dokployApi';
import type { VercelBranchMatcher, VercelDeployment } from '../../deploy/vercelApi';
import type { BranchSignal, BranchSignalCode, GitBranchBasis, ServiceFacts, VercelServiceFacts } from './facts';
import { byText, uniqueSorted } from './facts';

/** The order the criteria rank the candidates in (see `inferPreviewBranch`). */
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

const signalOf = (signals: readonly BranchSignal[], code: BranchSignalCode): BranchSignal | undefined => signals.find((s) => s.code === code);

const weightOf = (signals: readonly BranchSignal[], code: BranchSignalCode, branch: string): number =>
  signalOf(signals, code)?.branches.find((b) => b.branch === branch)?.weight ?? 0;

/** The long-lived branches a preview may deploy from: production, the default branch, the scoped branches. Never a deployed-from branch. */
export function previewCandidates(signals: readonly BranchSignal[], productionBranch: string | null): readonly string[] {
  const named = [signalOf(signals, 'BRANCH_SCOPED_VARIABLES'), signalOf(signals, 'GITHUB_DEFAULT_BRANCH')].flatMap((s) =>
    s === undefined ? [] : s.branches.map((b) => b.branch),
  );
  return uniqueSorted([...(productionBranch === null ? [] : [productionBranch]), ...named]);
}

/** Candidates best first: deployments, then scoped variables, then the default branch, then name. */
function rankCandidates(candidates: readonly string[], signals: readonly BranchSignal[]): readonly string[] {
  const score = (branch: string): readonly number[] => [
    weightOf(signals, 'RECENT_PREVIEW_DEPLOYMENTS', branch),
    weightOf(signals, 'BRANCH_SCOPED_VARIABLES', branch),
    weightOf(signals, 'GITHUB_DEFAULT_BRANCH', branch),
  ];
  return sortedCopy(candidates, (a, b) => {
    const [sa, sb] = [score(a), score(b)];
    return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2] || byText(a, b);
  });
}

/** What a signal names among the candidates: its strongest candidate(s); none when it names no candidate. */
function votesOf(signal: BranchSignal, candidates: readonly string[]): readonly string[] {
  const mine = signal.branches.filter((b) => candidates.includes(b.branch) && b.weight > 0);
  const top = Math.max(0, ...mine.map((b) => b.weight));
  return uniqueSorted(mine.filter((b) => b.weight === top).map((b) => b.branch));
}

export interface PreviewInference extends BranchInference {
  readonly candidates: readonly string[];
}

/** The git branch of an all-branches preview from its signals. */
export function inferPreviewBranch(signals: readonly BranchSignal[], productionBranch: string | null): PreviewInference {
  const candidates = previewCandidates(signals, productionBranch);
  if (candidates.length === 0) return { branch: productionBranch, confidence: 'needs_review', basis: 'no_signals', candidates };
  if (candidates.length === 1 && candidates[0] === productionBranch) {
    return { branch: productionBranch, confidence: 'certain', basis: 'production_branch_only', candidates };
  }
  const winner = rankCandidates(candidates, signals)[0];
  const votes = signals.map((s) => votesOf(s, candidates)).filter((v) => v.length > 0);
  const agreed = votes.every((v) => v.length === 1 && v[0] === winner);
  return { branch: winner, confidence: agreed ? 'certain' : 'needs_review', basis: agreed ? 'signals_agree' : 'strongest_signal', candidates };
}

/**
 * The deployments signal for output: counts for the candidate branches only, and one total for every other branch, so
 * the evidence is not a list of every feature branch that was ever deployed.
 */
export function deploymentsForOutput(signal: BranchSignal, candidates: readonly string[]): BranchSignal {
  const mine = signal.branches.filter((b) => candidates.includes(b.branch));
  return {
    ...signal,
    branches: mine,
    other_branches: signal.branches.filter((b) => !candidates.includes(b.branch)).reduce((total, b) => total + b.weight, 0),
  };
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
    return {
      ...v,
      branch: inferred.branch,
      git_branch_signals: signals.map((s) => (s.code === 'RECENT_PREVIEW_DEPLOYMENTS' ? deploymentsForOutput(s, inferred.candidates) : s)),
      git_branch_basis: inferred.basis,
      git_branch_confidence: inferred.confidence,
    };
  }
  const custom = inferCustomBranch(v.git_branch_signals, v.branch);
  return custom === null
    ? service
    : { ...v, branch: custom.branch, git_branch_basis: custom.basis, git_branch_confidence: custom.confidence };
}
