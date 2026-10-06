/**
 * Checking a plan against the world (CAP-703): `capy deploy dokploy --discover
 * --plan <file> --dry-run` and the same checks again before `--confirm` writes.
 *
 * Two pure steps around the reads:
 *   1. `resolveEntries`  - everything knowable from the Dokploy services and
 *      the Capy projects: the service exists, the project exists and the
 *      caller can see it, the Capy branch holds every named variable, the
 *      project is linked to the service's repo, nothing is assigned twice.
 *   2. `evaluatePlan`    - with GitHub read (the repo's branches, each
 *      deploy.json): the git branch exists, and the project branch has no
 *      conflicting Dokploy target.
 *
 * Every error is `{ path, code }`, path-precise. A project the caller cannot
 * see is `PROJECT_NOT_FOUND`: the repo-link and secret-index endpoints only
 * list what the caller may read, so existence and access are one question.
 */
import type { OrgRepoLink } from '../../service/serviceClient';
import { ERROR_CODES } from '../../types/index';
import type { TargetConfig } from '../../deploy/adapter';
import { sortedCopy } from '../../deploy/dokployApi';
import type { RepoRef } from '../../deploy/githubApi';
import { GITHUB_HOST } from '../secretsSet';
import { PlanEntry } from './discovery';
import {
  CapyProjectFacts,
  ExistingTarget,
  ServiceFacts,
  bestLink,
  byText,
  configuredTarget,
  conflictingTarget,
  deployJsonPathOf,
  linksOnRepo,
  repoKey,
  uniqueSorted,
} from './facts';
import { PlanError } from './plan';

export interface ResolvedEntry {
  readonly index: number;
  /** As written in the plan file (vars in file order). */
  readonly entry: PlanEntry;
  readonly service?: ServiceFacts;
  readonly project?: CapyProjectFacts;
  /** The project link whose repo the deploy.json PR goes to. */
  readonly link?: OrgRepoLink;
  readonly errors: readonly PlanError[];
}

const at = (index: number, field?: string): string => (field === undefined ? `entries[${index}]` : `entries[${index}].${field}`);
const err = (path: string, code: string): PlanError => ({ path, code });

/** The repo a link names, as a GitHub ref. */
export const repoRefOf = (link: { readonly owner: string; readonly name: string }): RepoRef => ({ owner: link.owner, name: link.name });

function resolveEntry(
  entry: PlanEntry,
  index: number,
  services: ReadonlyMap<string, ServiceFacts>,
  projects: ReadonlyMap<string, CapyProjectFacts>,
): ResolvedEntry {
  const service = services.get(entry.service_id);
  const project = projects.get(entry.project_id);
  const serviceErrors = service === undefined ? [err(at(index, 'service_id'), ERROR_CODES.SERVICE_NOT_FOUND)] : [];
  const projectErrors = project === undefined ? [err(at(index, 'project_id'), ERROR_CODES.PROJECT_NOT_FOUND)] : [];
  const branchNames = project?.var_names_by_branch[entry.branch];
  const branchErrors =
    project !== undefined && branchNames === undefined ? [err(at(index, 'branch'), ERROR_CODES.BRANCH_NOT_FOUND)] : [];
  const varErrors =
    branchNames === undefined
      ? []
      : entry.vars.flatMap((v, j) => (branchNames.includes(v) ? [] : [err(`${at(index, 'vars')}[${j}]`, ERROR_CODES.VAR_NOT_FOUND)]));
  const githubLinks = project?.links.filter((l) => l.host.toLowerCase() === GITHUB_HOST) ?? [];
  const noLink = project !== undefined && githubLinks.length === 0 ? [err(at(index, 'project_id'), ERROR_CODES.NO_REPO_LINK)] : [];
  const onServiceRepo =
    project !== undefined && service?.repo != null && githubLinks.length > 0
      ? linksOnRepo({ ...project, links: githubLinks }, service.repo)
      : [];
  const mismatch =
    project !== undefined && service !== undefined && githubLinks.length > 0 && onServiceRepo.length === 0
      ? [err(at(index, 'service_id'), ERROR_CODES.REPO_MISMATCH)]
      : [];
  return {
    index,
    entry,
    service,
    project,
    link: service?.path != null ? bestLink(onServiceRepo, service.path) : undefined,
    errors: [...serviceErrors, ...projectErrors, ...branchErrors, ...varErrors, ...noLink, ...mismatch],
  };
}

/** Step 1: what the Dokploy services and Capy projects alone settle. */
export function resolveEntries(
  entries: readonly PlanEntry[],
  services: ReadonlyMap<string, ServiceFacts>,
  projects: ReadonlyMap<string, CapyProjectFacts>,
): readonly ResolvedEntry[] {
  return entries.map((entry, index) => {
    const resolved = resolveEntry(entry, index, services, projects);
    const duplicate = entries.slice(0, index).some((e) => e.project_id === entry.project_id && e.branch === entry.branch);
    return duplicate ? { ...resolved, errors: [...resolved.errors, err(at(index), ERROR_CODES.DUPLICATE_ENTRY)] } : resolved;
  });
}

// ── GitHub reads ─────────────────────────────────────────────────────────────

export const fileKeyOf = (link: { readonly host: string; readonly owner: string; readonly name: string; readonly path: string }): string =>
  `${repoKey(link)}\u0000${deployJsonPathOf(link.path)}`;

/** What a plan needs read from GitHub: each repo's branches once, each deploy.json once. */
export function githubNeeds(resolved: readonly ResolvedEntry[]): {
  /** Each repo once, with the `repoKey` the reads are filed under. */
  readonly repos: ReadonlyArray<{ readonly repo: RepoRef; readonly key: string }>;
  readonly files: ReadonlyArray<{ readonly repo: RepoRef; readonly path: string; readonly key: string }>;
} {
  const links = resolved.flatMap((r) => (r.link === undefined ? [] : [r.link]));
  const repoKeys = uniqueSorted(links.map(repoKey));
  const fileKeys = uniqueSorted(links.map(fileKeyOf));
  return {
    repos: repoKeys.map((k) => ({ repo: repoRefOf(links.find((l) => repoKey(l) === k) as OrgRepoLink), key: k })),
    files: fileKeys.map((key) => {
      const link = links.find((l) => fileKeyOf(l) === key) as OrgRepoLink;
      return { repo: repoRefOf(link), path: deployJsonPathOf(link.path), key };
    }),
  };
}

export type ReadFailure = { readonly code: string };

export interface GithubReads {
  /** By `repoKey`: the repo's branch names, or why they could not be read. */
  readonly branches: ReadonlyMap<string, ReadonlySet<string> | ReadFailure>;
  /** By `fileKeyOf`: the targets already in that deploy.json, or why it could not be read. */
  readonly deployJson: ReadonlyMap<string, readonly ExistingTarget[] | ReadFailure>;
}

const isFailure = (value: unknown): value is ReadFailure =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Set) && 'code' in value;

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface EvaluatedEntry {
  readonly resolved: ResolvedEntry & { readonly service: ServiceFacts; readonly project: CapyProjectFacts; readonly link: OrgRepoLink };
  /** `already_configured`: the project branch already has this service's target; nothing to write. */
  readonly status: 'write' | 'already_configured';
  readonly existingTargetName?: string;
}

export interface Evaluation {
  readonly errors: readonly PlanError[];
  readonly entries: readonly EvaluatedEntry[];
}

function githubErrors(r: ResolvedEntry, reads: GithubReads): readonly PlanError[] {
  if (r.link === undefined) return [];
  const branches = reads.branches.get(repoKey(r.link));
  const branchErrors: readonly PlanError[] =
    branches === undefined
      ? [err(at(r.index, 'git_branch'), ERROR_CODES.KEEP_PR_READ_FAILED)]
      : isFailure(branches)
        ? [err(at(r.index, 'git_branch'), branches.code)]
        : branches.has(r.entry.git_branch)
          ? []
          : [err(at(r.index, 'git_branch'), ERROR_CODES.BRANCH_NOT_FOUND)];
  const targets = reads.deployJson.get(fileKeyOf(r.link));
  const targetErrors: readonly PlanError[] =
    targets === undefined
      ? [err(at(r.index, 'project_id'), ERROR_CODES.KEEP_PR_READ_FAILED)]
      : isFailure(targets)
        ? [err(at(r.index, 'project_id'), targets.code)]
        : conflictingTarget(targets, r.entry.service_id, r.entry.branch) !== undefined
          ? [err(at(r.index, 'branch'), ERROR_CODES.TARGET_EXISTS)]
          : [];
  return [...branchErrors, ...targetErrors];
}

/** Step 2: the plan against GitHub's branches and the repos' deploy.json files. */
export function evaluatePlan(resolved: readonly ResolvedEntry[], reads: GithubReads): Evaluation {
  const errors = resolved.flatMap((r) => [...r.errors, ...githubErrors(r, reads)]);
  const entries = resolved.flatMap((r): EvaluatedEntry[] => {
    if (r.service === undefined || r.project === undefined || r.link === undefined) return [];
    const targets = reads.deployJson.get(fileKeyOf(r.link));
    const existing = targets === undefined || isFailure(targets) ? undefined : configuredTarget(targets, r.entry.service_id, r.entry.branch);
    return [
      {
        resolved: { ...r, service: r.service, project: r.project, link: r.link },
        status: existing === undefined ? 'write' : 'already_configured',
        ...(existing === undefined ? {} : { existingTargetName: existing.name }),
      },
    ];
  });
  return { errors, entries };
}

// ── The targets to write ─────────────────────────────────────────────────────

/** `dokploy-<capy branch>`, restricted to the characters a target name allows. */
export function targetBaseName(branch: string): string {
  const cleaned = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'dokploy' : `dokploy-${cleaned}`;
}

/** `base`, or `base-2`, `base-3`, … when `taken` already has it. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const numbered = (n: number): string => (taken.has(`${base}-${n}`) ? numbered(n + 1) : `${base}-${n}`);
  return taken.has(base) ? numbered(2) : base;
}

/** The deploy target `capy deploy` writes today for a Dokploy service: CI mode, no tokenEnv (the org system store holds the key). */
export function dokployTargetOf(args: {
  readonly name: string;
  readonly entry: PlanEntry;
  readonly service: ServiceFacts;
  readonly baseUrl: string;
  readonly knownVars: readonly string[];
}): TargetConfig {
  const { name, entry, service, baseUrl, knownVars } = args;
  return {
    name,
    kind: 'dokploy',
    branch: entry.branch,
    vars: [...uniqueSorted(entry.vars)],
    knownVars: [...knownVars],
    options: { baseUrl, ...(service.kind === 'compose' ? { composeId: service.service_id } : { applicationId: service.service_id }) },
    mode: 'ci',
    gitBaseBranch: entry.git_branch,
  };
}

export interface TargetToWrite {
  readonly repo: RepoRef;
  readonly repoKey: string;
  /** Repo-relative path of the deploy.json. */
  readonly file: string;
  readonly fileKey: string;
  readonly projectName: string;
  readonly entry: PlanEntry;
  readonly service: ServiceFacts;
  readonly target: TargetConfig;
}

/**
 * Every target a confirmed plan writes, named. Entries are taken in the
 * normalized order (project, branch, service) so the names never depend on how
 * the plan file was ordered; a name already in that deploy.json, or taken by an
 * earlier target of the same file, gets a numeric suffix.
 */
export function targetsToWrite(
  evaluated: readonly EvaluatedEntry[],
  reads: GithubReads,
  baseUrl: string,
): readonly TargetToWrite[] {
  const pending = sortedCopy(
    evaluated.filter((e) => e.status === 'write'),
    (a, b) =>
      byText(a.resolved.entry.project_id, b.resolved.entry.project_id) ||
      byText(a.resolved.entry.branch, b.resolved.entry.branch) ||
      byText(a.resolved.entry.service_id, b.resolved.entry.service_id),
  );
  return pending.reduce<readonly TargetToWrite[]>((acc, e) => {
    const { entry, service, project, link } = e.resolved;
    const key = fileKeyOf(link);
    const existingNames = (() => {
      const read = reads.deployJson.get(key);
      return read === undefined || isFailure(read) ? [] : read.map((t) => t.name);
    })();
    const taken = new Set([...existingNames, ...acc.filter((t) => t.fileKey === key).map((t) => t.target.name)]);
    const name = uniqueName(targetBaseName(entry.branch), taken);
    const target = dokployTargetOf({
      name,
      entry: { ...entry, vars: uniqueSorted(entry.vars) },
      service,
      baseUrl,
      knownVars: project.var_names_by_branch[entry.branch] ?? [],
    });
    return [
      ...acc,
      {
        repo: repoRefOf(link),
        repoKey: repoKey(link),
        file: deployJsonPathOf(link.path),
        fileKey: key,
        projectName: project.project_name,
        entry,
        service,
        target,
      },
    ];
  }, []);
}
