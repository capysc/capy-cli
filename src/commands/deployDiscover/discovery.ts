/**
 * `capy deploy dokploy --discover`: the discovery document (CAP-703).
 *
 * The CLI gathers FACTS and CHECKS; an agent applies judgement; the human
 * approves. This module is the facts-and-checks half, as a pure function: it
 * is handed everything already read (the Dokploy services, the Capy repo
 * links and secret NAME index, GitHub's default branches and the repos'
 * `.capy/deploy.json` files) and reads nothing itself, so a run makes one
 * round of calls and the matching can be tested without any network.
 *
 * What it matches: repo (host/owner/name) + REPO-RELATIVE path + branch, on
 * both sides. A local filesystem path appears nowhere.
 *
 * Names and ids only. A Dokploy env value or a Capy value never reaches this
 * module: the inputs it is given carry names (`ServiceFacts.env_var_names`,
 * `CapyProjectFacts.var_names_by_branch`) and nothing else.
 *
 * Confidence is per field: `certain` or `needs_review`. Anything weak is
 * `needs_review`: no exact repo + path match, a var overlap under half of the
 * service's variables, a branch that needed a fallback, several candidates.
 */
import { createHash } from 'crypto';
import type { OrgRepoLink } from '../../service/serviceClient';
import { sortedCopy } from '../../deploy/dokployApi';
import { PLAN_SCHEMA_REF } from './schema';
import {
  CapyProjectFacts,
  ExistingTarget,
  RepoOut,
  ServiceFacts,
  bestLink,
  byText,
  configuredTarget,
  conflictingTarget,
  isSameOrAncestorPath,
  linksOnRepo,
  relPathOf,
  repoKey,
  uniqueSorted,
} from './facts';

/** A variable overlap below this share of the service's own variables is `needs_review`. */
export const VAR_OVERLAP_MIN_RATIO = 0.5;

export type Confidence = 'certain' | 'needs_review';

export type UnresolvedReason =
  | 'NO_MATCHING_PROJECT'
  | 'AMBIGUOUS'
  | 'BRANCH_UNMAPPED'
  | 'NO_REPO_LINK'
  | 'SERVICE_HAS_NO_GIT_SOURCE';

/** One entry of the plan file (`--plan`). IDs and names only. */
export interface PlanEntry {
  readonly project_id: string;
  readonly branch: string;
  readonly service_id: string;
  readonly git_branch: string;
  readonly vars: readonly string[];
}

export interface ProposalTarget {
  readonly kind: 'dokploy';
  readonly baseUrl: string;
  readonly applicationId?: string;
  readonly composeId?: string;
  /** The Capy branch the target ships from. */
  readonly branch: string;
  readonly gitBaseBranch: string;
  readonly mode: 'ci';
  readonly vars: readonly string[];
}

export interface VarOverlap {
  readonly shared: number;
  readonly only_in_service: readonly string[];
  readonly only_in_project: readonly string[];
}

export interface Proposal {
  readonly proposal_id: string;
  readonly service_id: string;
  readonly project_id: string;
  /** The Capy branch. */
  readonly branch: string;
  readonly git_branch: string;
  readonly target: ProposalTarget;
  readonly evidence: {
    readonly repo_match: boolean;
    readonly path_match: boolean;
    readonly branch_match: boolean;
    readonly var_overlap: VarOverlap;
    /** The name of an existing Dokploy target on this project branch that points at a DIFFERENT service (a plan entry for it is refused `TARGET_EXISTS`), else `null`. */
    readonly conflicting_target: string | null;
  };
  readonly confidence: {
    readonly project: Confidence;
    readonly branch: Confidence;
    readonly vars: Confidence;
  };
  /** Other proposals that claim the same project + Capy branch. */
  readonly competing_proposal_ids: readonly string[];
  /** The exact plan entry to copy into the plan file if this proposal is accepted as it stands. */
  readonly plan_entry: PlanEntry;
}

export interface UnresolvedCandidate {
  readonly project_id?: string;
  readonly project_name?: string;
  readonly path?: string;
  readonly branch?: string;
}

export interface Unresolved {
  readonly reason: UnresolvedReason;
  readonly service_id?: string;
  readonly project_id?: string;
  readonly candidates: readonly UnresolvedCandidate[];
}

export interface AlreadyConfigured {
  readonly project_id: string;
  readonly branch: string;
  readonly service_id: string;
  readonly target_name: string;
}

export interface ProjectOut {
  readonly project_id: string;
  readonly project_name: string;
  readonly repos: ReadonlyArray<RepoOut & { readonly path: string }>;
  readonly branches: readonly string[];
  readonly var_names_by_branch: Readonly<Record<string, readonly string[]>>;
  readonly existing_targets: readonly ExistingTarget[];
  /** `false`: the repo's deploy.json could not be read (no `gh`, or the read failed), so `existing_targets` is not known. */
  readonly existing_targets_read: boolean;
}

export type NextStep =
  | { readonly action: 'review'; readonly proposal_ids: readonly string[] }
  | { readonly action: 'resolve'; readonly service_ids: readonly string[] }
  | { readonly action: 'write_plan'; readonly schema: typeof PLAN_SCHEMA_REF }
  | { readonly run: string };

export interface Notice {
  readonly code: string;
  readonly detail?: string;
}

export interface DeployDiscovery {
  readonly base_url: string;
  readonly services: readonly ServiceFacts[];
  readonly projects: readonly ProjectOut[];
  readonly proposals: readonly Proposal[];
  readonly already_configured: readonly AlreadyConfigured[];
  readonly unresolved: readonly Unresolved[];
  readonly next_steps: readonly NextStep[];
  readonly plan_schema_ref: typeof PLAN_SCHEMA_REF;
  readonly notices: readonly Notice[];
}

/** Everything discovery reads, already read. */
export interface DiscoveryInput {
  readonly baseUrl: string;
  readonly services: readonly ServiceFacts[];
  readonly projects: ReadonlyMap<string, CapyProjectFacts>;
  /** By `repoKey`: the repo's default branch. Absent / `null`: not known. */
  readonly defaultBranches: Readonly<Record<string, string | null>>;
  /** By project id: the targets in the project's deploy.json files. Absent: not read. */
  readonly existingTargets: Readonly<Record<string, readonly ExistingTarget[]>>;
  readonly notices?: readonly Notice[];
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface Matched {
  readonly projects: readonly CapyProjectFacts[];
  /** True when the match is the exact folder; false when a folder ABOVE the service's. */
  readonly exactPath: boolean;
}

type Match = { readonly kind: 'matched'; readonly matched: Matched } | { readonly kind: 'unresolved'; readonly unresolved: Unresolved };

const candidateOf = (link: OrgRepoLink): UnresolvedCandidate => ({
  project_id: link.project_id,
  project_name: link.project_name,
  path: relPathOf(link.path),
});

function projectsOfLinks(links: readonly OrgRepoLink[], all: ReadonlyMap<string, CapyProjectFacts>): readonly CapyProjectFacts[] {
  return uniqueSorted(links.map((l) => l.project_id)).flatMap((id) => {
    const project = all.get(id);
    return project === undefined ? [] : [project];
  });
}

/** Which Capy projects a service's repo + path point at. */
function matchService(service: ServiceFacts, links: readonly OrgRepoLink[], all: ReadonlyMap<string, CapyProjectFacts>): Match {
  if (service.repo === null || service.path === null) {
    return { kind: 'unresolved', unresolved: { reason: 'SERVICE_HAS_NO_GIT_SOURCE', service_id: service.service_id, candidates: [] } };
  }
  const servicePath = service.path;
  const key = repoKey(service.repo);
  const onRepo = links.filter((l) => repoKey(l) === key);
  if (onRepo.length === 0) {
    return { kind: 'unresolved', unresolved: { reason: 'NO_REPO_LINK', service_id: service.service_id, candidates: [] } };
  }
  const exact = onRepo.filter((l) => relPathOf(l.path) === servicePath);
  if (exact.length > 0) return { kind: 'matched', matched: { projects: projectsOfLinks(exact, all), exactPath: true } };
  const above = onRepo.filter((l) => isSameOrAncestorPath(relPathOf(l.path), servicePath));
  const deepest = Math.max(0, ...above.map((l) => relPathOf(l.path).length));
  const nearest = above.filter((l) => relPathOf(l.path).length === deepest);
  if (nearest.length > 0) return { kind: 'matched', matched: { projects: projectsOfLinks(nearest, all), exactPath: false } };
  return {
    kind: 'unresolved',
    unresolved: { reason: 'NO_MATCHING_PROJECT', service_id: service.service_id, candidates: onRepo.map(candidateOf) },
  };
}

// ── Branch mapping ───────────────────────────────────────────────────────────

interface BranchChoice {
  readonly branch: string;
  /** The standard mapping (the repo's default branch is `production`, any other branch its own name). */
  readonly standard: boolean;
}

/**
 * The Capy branch for a git branch. The repo's default branch maps to
 * `production`, any other branch to the same-named Capy branch. When the
 * project has no such branch: the git branch itself (for a default branch),
 * then the Dokploy environment's name (which is what `capy connect dokploy
 * --discover` names its branches) - both `needs_review`.
 *
 * The Dokploy environment outranks the standard mapping when the two name
 * DIFFERENT Capy branches: a repo whose default branch is `develop` deploys
 * `develop` to a `staging` environment, and calling that `production` would
 * point a staging service at production values. That choice is `needs_review`.
 */
function chooseCapyBranch(
  gitBranch: string | null,
  defaultBranch: string | null | undefined,
  environment: string,
  projectBranches: readonly string[],
): BranchChoice | null {
  const has = (b: string): boolean => projectBranches.includes(b);
  const standardName = gitBranch === null ? null : defaultBranch !== null && defaultBranch !== undefined && gitBranch === defaultBranch ? 'production' : gitBranch;
  const standardHas = standardName !== null && has(standardName);
  if (standardHas && has(environment) && standardName !== environment) return { branch: environment, standard: false };
  if (standardHas) return { branch: standardName, standard: true };
  const fallbacks = [...(gitBranch === null ? [] : [gitBranch]), environment].filter(has);
  return fallbacks.length > 0 ? { branch: fallbacks[0], standard: false } : null;
}

// ── Variables ────────────────────────────────────────────────────────────────

function overlapOf(serviceNames: readonly string[], projectNames: readonly string[]): VarOverlap {
  const inProject = new Set(projectNames);
  const inService = new Set(serviceNames);
  return {
    shared: serviceNames.filter((n) => inProject.has(n)).length,
    only_in_service: serviceNames.filter((n) => !inProject.has(n)),
    only_in_project: projectNames.filter((n) => !inService.has(n)),
  };
}

const sharedNames = (serviceNames: readonly string[], projectNames: readonly string[]): readonly string[] => {
  const inProject = new Set(projectNames);
  return serviceNames.filter((n) => inProject.has(n));
};

const varsConfidence = (overlap: VarOverlap, serviceVarCount: number): Confidence =>
  overlap.shared > 0 && overlap.shared / Math.max(1, serviceVarCount) >= VAR_OVERLAP_MIN_RATIO ? 'certain' : 'needs_review';

// ── Proposals ────────────────────────────────────────────────────────────────

const proposalIdOf = (serviceId: string, projectId: string, branch: string): string =>
  `prop_${createHash('sha256').update([serviceId, projectId, branch].join('\u0000')).digest('hex').slice(0, 10)}`;

function targetOf(baseUrl: string, service: ServiceFacts, branch: string, gitBranch: string, vars: readonly string[]): ProposalTarget {
  return {
    kind: 'dokploy',
    baseUrl,
    ...(service.kind === 'compose' ? { composeId: service.service_id } : { applicationId: service.service_id }),
    branch,
    gitBaseBranch: gitBranch,
    mode: 'ci',
    vars,
  };
}

/** A proposal before the competing ones are known. */
type Draft = Omit<Proposal, 'competing_proposal_ids'>;

type ForProject =
  | { readonly kind: 'proposal'; readonly draft: Draft }
  | { readonly kind: 'configured'; readonly configured: AlreadyConfigured }
  | { readonly kind: 'unresolved'; readonly unresolved: Unresolved };

function forProject(
  input: DiscoveryInput,
  service: ServiceFacts,
  project: CapyProjectFacts,
  matched: Matched,
): ForProject {
  const repo = service.repo as RepoOut;
  const defaultBranch = input.defaultBranches[repoKey(repo)];
  const choice = chooseCapyBranch(service.branch, defaultBranch, service.environment, project.branches);
  if (choice === null || service.branch === null) {
    return {
      kind: 'unresolved',
      unresolved: {
        reason: 'BRANCH_UNMAPPED',
        service_id: service.service_id,
        project_id: project.project_id,
        candidates: project.branches.map((branch) => ({ project_id: project.project_id, branch })),
      },
    };
  }
  const gitBranch = service.branch;
  const existing = configuredTarget(input.existingTargets[project.project_id] ?? [], service.service_id, choice.branch);
  if (existing !== undefined) {
    return {
      kind: 'configured',
      configured: { project_id: project.project_id, branch: choice.branch, service_id: service.service_id, target_name: existing.name },
    };
  }
  const conflict = conflictingTarget(input.existingTargets[project.project_id] ?? [], service.service_id, choice.branch);
  const projectNames = project.var_names_by_branch[choice.branch] ?? [];
  const overlap = overlapOf(service.env_var_names, projectNames);
  const vars = sharedNames(service.env_var_names, projectNames);
  const draft: Draft = {
    proposal_id: proposalIdOf(service.service_id, project.project_id, choice.branch),
    service_id: service.service_id,
    project_id: project.project_id,
    branch: choice.branch,
    git_branch: gitBranch,
    target: targetOf(input.baseUrl, service, choice.branch, gitBranch, vars),
    evidence: {
      repo_match: true,
      path_match: matched.exactPath,
      branch_match: choice.standard,
      var_overlap: overlap,
      conflicting_target: conflict?.name ?? null,
    },
    confidence: {
      project: matched.exactPath && matched.projects.length === 1 && conflict === undefined ? 'certain' : 'needs_review',
      branch: choice.standard && typeof defaultBranch === 'string' ? 'certain' : 'needs_review',
      vars: varsConfidence(overlap, service.env_var_names.length),
    },
    plan_entry: { project_id: project.project_id, branch: choice.branch, service_id: service.service_id, git_branch: gitBranch, vars },
  };
  return { kind: 'proposal', draft };
}

interface ServiceResult {
  readonly drafts: readonly Draft[];
  readonly configured: readonly AlreadyConfigured[];
  readonly unresolved: readonly Unresolved[];
}

function resolveService(input: DiscoveryInput, service: ServiceFacts, links: readonly OrgRepoLink[]): ServiceResult {
  const match = matchService(service, links, input.projects);
  if (match.kind === 'unresolved') return { drafts: [], configured: [], unresolved: [match.unresolved] };
  const { matched } = match;
  const perProject = matched.projects.map((project) => forProject(input, service, project, matched));
  const ambiguous: readonly Unresolved[] =
    matched.projects.length > 1
      ? [
          {
            reason: 'AMBIGUOUS',
            service_id: service.service_id,
            candidates: matched.projects.map((p) => ({
              project_id: p.project_id,
              project_name: p.project_name,
              path: relPathOf(bestLink(linksOnRepo(p, service.repo as RepoOut), service.path as string)?.path),
            })),
          },
        ]
      : [];
  return {
    drafts: perProject.flatMap((r) => (r.kind === 'proposal' ? [r.draft] : [])),
    configured: perProject.flatMap((r) => (r.kind === 'configured' ? [r.configured] : [])),
    unresolved: [...ambiguous, ...perProject.flatMap((r) => (r.kind === 'unresolved' ? [r.unresolved] : []))],
  };
}

/** A proposal's final form: the other proposals on the same project + branch make its project assignment `needs_review`. */
function withCompeting(drafts: readonly Draft[]): readonly Proposal[] {
  return drafts.map((draft): Proposal => {
    const competing = drafts
      .filter((d) => d.project_id === draft.project_id && d.branch === draft.branch && d.proposal_id !== draft.proposal_id)
      .map((d) => d.proposal_id);
    return {
      ...draft,
      competing_proposal_ids: competing,
      confidence: { ...draft.confidence, project: competing.length > 0 ? 'needs_review' : draft.confidence.project },
    };
  });
}

const needsReview = (p: Proposal): boolean =>
  p.confidence.project === 'needs_review' || p.confidence.branch === 'needs_review' || p.confidence.vars === 'needs_review';

function nextStepsOf(proposals: readonly Proposal[], unresolved: readonly Unresolved[]): readonly NextStep[] {
  const review = proposals.filter(needsReview).map((p) => p.proposal_id);
  const unresolvedServices = uniqueSorted(unresolved.flatMap((u) => (u.service_id === undefined ? [] : [u.service_id])));
  return [
    ...(review.length > 0 ? [{ action: 'review' as const, proposal_ids: review }] : []),
    ...(unresolvedServices.length > 0 ? [{ action: 'resolve' as const, service_ids: unresolvedServices }] : []),
    { action: 'write_plan' as const, schema: PLAN_SCHEMA_REF },
    { run: 'capy deploy dokploy --discover --plan <file> --dry-run' },
  ];
}

function projectOut(project: CapyProjectFacts, input: DiscoveryInput): ProjectOut {
  const existing = input.existingTargets[project.project_id];
  return {
    project_id: project.project_id,
    project_name: project.project_name,
    repos: project.links.map((l) => ({ host: l.host, owner: l.owner, name: l.name, path: relPathOf(l.path) })),
    branches: project.branches,
    var_names_by_branch: project.var_names_by_branch,
    existing_targets: existing ?? [],
    existing_targets_read: existing !== undefined,
  };
}

/** The whole discovery document. Pure. */
export function buildDeployDiscovery(input: DiscoveryInput): DeployDiscovery {
  const links = [...input.projects.values()].flatMap((p) => p.links);
  const results = input.services.map((service) => resolveService(input, service, links));
  const proposals = withCompeting(results.flatMap((r) => r.drafts));
  const unresolved = results.flatMap((r) => r.unresolved);
  return {
    base_url: input.baseUrl,
    services: input.services,
    projects: sortedCopy(
      [...input.projects.values()].filter((p) => p.links.length > 0).map((p) => projectOut(p, input)),
      (a, b) => byText(a.project_name, b.project_name) || byText(a.project_id, b.project_id),
    ),
    proposals,
    already_configured: results.flatMap((r) => r.configured),
    unresolved,
    next_steps: nextStepsOf(proposals, unresolved),
    plan_schema_ref: PLAN_SCHEMA_REF,
    notices: input.notices ?? [],
  };
}
