/**
 * The facts `capy deploy dokploy --discover` (CAP-703) reasons about, as plain
 * data: what a Dokploy service tracks, what a Capy project is linked to, and
 * what a repo's `.capy/deploy.json` already holds.
 *
 * Names and ids only. Nothing in here ever holds a variable VALUE: the only
 * thing read out of a Dokploy env is each entry's NAME (`envVarNamesOf`), and
 * the Capy side is the secret NAME index, which carries no value at all.
 *
 * Matching is repo-based and folder-agnostic: a repo (host/owner/name), a
 * REPO-RELATIVE path (`.` for the root) and a branch, on both sides. A local
 * filesystem path appears nowhere.
 */
import { posix } from 'node:path';
import type { OrgRepoLink, SecretIndexRow } from '../../service/serviceClient';
import { listImportableEntries, sortedCopy } from '../../deploy/dokployApi';
import { ServiceDetail, hasGitSource, normalizeRelativeDir } from '../connectors/dokployDiscovery';
import { GITHUB_HOST, repoKey } from '../secretsSet';

export { repoKey };

export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const uniqueSorted = (items: readonly string[]): readonly string[] => sortedCopy([...new Set(items)], byText);

// ── Paths ───────────────────────────────────────────────────────────────────

/** A repo-relative directory, forward-slashed, `.` for the repo root. */
export function relPathOf(raw: string | undefined | null): string {
  const normalized = normalizeRelativeDir(raw ?? '');
  return normalized === '' ? '.' : normalized;
}

/** `<project path>/.capy/deploy.json`, repo-relative (`.capy/deploy.json` at the root). */
export function deployJsonPathOf(projectPath: string): string {
  const rel = relPathOf(projectPath);
  return rel === '.' ? '.capy/deploy.json' : `${rel}/.capy/deploy.json`;
}

/** Is `ancestor` the same folder as `path`, or a folder above it? `.` is above everything. */
export function isSameOrAncestorPath(ancestor: string, path: string): boolean {
  return ancestor === '.' || ancestor === path || path.startsWith(`${ancestor}/`);
}

/** The repo-relative build/compose directory of a Dokploy service. A compose service's is its compose file's folder. */
export function servicePathOf(detail: Pick<ServiceDetail, 'serviceKind' | 'composePath' | 'buildPath'>): string {
  if (detail.serviceKind === 'application') return relPathOf(detail.buildPath);
  const composePath = normalizeRelativeDir(detail.composePath ?? '');
  return relPathOf(posix.dirname(composePath === '' ? '.' : composePath));
}

// ── Dokploy side ────────────────────────────────────────────────────────────

export interface RepoOut {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export interface ServiceFacts {
  readonly service_id: string;
  readonly kind: 'application' | 'compose';
  readonly name: string;
  readonly dokploy_project: string;
  readonly environment: string;
  readonly repo: RepoOut | null;
  readonly branch: string | null;
  /** Repo-relative build/compose directory, `.` for the root. `null` for a service with no git source. */
  readonly path: string | null;
  /** Names only: never a value. */
  readonly env_var_names: readonly string[];
}

/** The NAMES in a Dokploy env text (the Capy-managed block and Capy's own runtime pair left out). The parsed values are dropped on the spot. */
export function envVarNamesOf(rawEnv: string | null): readonly string[] {
  return uniqueSorted(listImportableEntries(rawEnv).map((entry) => entry.name));
}

/**
 * What a Dokploy service tracks. A service with a git source is reported on
 * `github.com`: the Dokploy fields read for it are the GitHub-provider ones
 * (`owner`, `repository`, `branch`), the same ones `capy connect dokploy
 * --discover` already matches on.
 */
export function serviceFactsOf(detail: ServiceDetail): ServiceFacts {
  const git = hasGitSource(detail);
  return {
    service_id: detail.serviceId,
    kind: detail.serviceKind,
    name: detail.serviceName,
    dokploy_project: detail.projectName,
    environment: detail.environmentName,
    repo: git ? { host: GITHUB_HOST, owner: detail.owner as string, name: detail.repository as string } : null,
    branch: git && detail.branch ? detail.branch : null,
    path: git ? servicePathOf(detail) : null,
    env_var_names: envVarNamesOf(detail.rawEnv),
  };
}

// ── Capy side ───────────────────────────────────────────────────────────────

export interface CapyProjectFacts {
  readonly project_id: string;
  readonly project_name: string;
  /** Every repo link (CAP-697) of this project; `path` is `.` for the repo root. */
  readonly links: readonly OrgRepoLink[];
  /** Branches that hold at least one variable (the secret NAME index lists no others). */
  readonly branches: readonly string[];
  /** Variable NAMES per branch. */
  readonly var_names_by_branch: Readonly<Record<string, readonly string[]>>;
}

/** Every Capy project the caller can see, from its repo links and the secret NAME index. Names only: the index's value hashes are never read. */
export function capyProjectsOf(
  links: readonly OrgRepoLink[],
  indexRows: readonly SecretIndexRow[],
): ReadonlyMap<string, CapyProjectFacts> {
  const located = indexRows.flatMap((row) =>
    row.locations.map((l) => ({ project_id: l.project_id, project_name: l.project_name, branch: l.branch, name: row.name })),
  );
  const ids = uniqueSorted([...links.map((l) => l.project_id), ...located.map((l) => l.project_id)]);
  return new Map(
    ids.map((id): [string, CapyProjectFacts] => {
      const mine = located.filter((l) => l.project_id === id);
      const myLinks = links.filter((l) => l.project_id === id);
      const branches = uniqueSorted(mine.map((l) => l.branch));
      return [
        id,
        {
          project_id: id,
          project_name: myLinks[0]?.project_name ?? mine[0]?.project_name ?? id,
          links: myLinks,
          branches,
          var_names_by_branch: Object.fromEntries(
            branches.map((branch) => [branch, uniqueSorted(mine.filter((l) => l.branch === branch).map((l) => l.name))]),
          ),
        },
      ];
    }),
  );
}

/** The links of `project` on the same repo as `repo`. */
export function linksOnRepo(project: CapyProjectFacts, repo: RepoOut): readonly OrgRepoLink[] {
  const key = repoKey(repo);
  return project.links.filter((l) => repoKey(l) === key);
}

/** The best link of a project for a service path: the exact folder, else the deepest folder above it, else the first. */
export function bestLink(links: readonly OrgRepoLink[], servicePath: string): OrgRepoLink | undefined {
  const exact = links.find((l) => relPathOf(l.path) === servicePath);
  if (exact !== undefined) return exact;
  const above = links.filter((l) => isSameOrAncestorPath(relPathOf(l.path), servicePath));
  const deepest = sortedCopy(above, (a, b) => relPathOf(b.path).length - relPathOf(a.path).length)[0];
  return deepest ?? sortedCopy(links, (a, b) => byText(relPathOf(a.path), relPathOf(b.path)))[0];
}

// ── deploy.json side ────────────────────────────────────────────────────────

/** One target already in a `.capy/deploy.json`. */
export interface ExistingTarget {
  readonly name: string;
  readonly kind: string;
  readonly branch: string;
  /** The Dokploy service the target points at (`composeId` / `applicationId`), when it is a Dokploy target. */
  readonly service_id: string | null;
}

export type ParsedDeployJson =
  | { readonly ok: true; readonly targets: readonly ExistingTarget[]; readonly raw: Record<string, unknown> | null }
  | { readonly ok: false };

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Reads a `.capy/deploy.json` text. `null` (no file) is a valid, empty answer; anything that does not parse as a version-1 file is `ok: false`. */
export function parseDeployJson(content: string | null): ParsedDeployJson {
  if (content === null) return { ok: true, targets: [], raw: null };
  try {
    const parsed = asObject(JSON.parse(content));
    if (parsed === undefined || parsed.version !== '1') return { ok: false };
    const targets = asObject(parsed.targets) ?? {};
    return {
      ok: true,
      raw: parsed,
      targets: Object.entries(targets).flatMap(([name, value]): ExistingTarget[] => {
        const target = asObject(value);
        if (target === undefined) return [];
        const options = asObject(target.options) ?? {};
        const serviceId = options.composeId ?? options.applicationId;
        return [
          {
            name,
            kind: typeof target.kind === 'string' ? target.kind : '',
            branch: typeof target.branch === 'string' ? target.branch : '',
            service_id: typeof serviceId === 'string' ? serviceId : null,
          },
        ];
      }),
    };
  } catch {
    return { ok: false };
  }
}

/** Is there already a Dokploy target for this service on this Capy branch? */
export function configuredTarget(targets: readonly ExistingTarget[], serviceId: string, branch: string): ExistingTarget | undefined {
  return targets.find((t) => t.kind === 'dokploy' && t.branch === branch && t.service_id === serviceId);
}

/** A Dokploy target on this Capy branch that points at a DIFFERENT service. */
export function conflictingTarget(targets: readonly ExistingTarget[], serviceId: string, branch: string): ExistingTarget | undefined {
  return targets.find((t) => t.kind === 'dokploy' && t.branch === branch && t.service_id !== serviceId);
}
