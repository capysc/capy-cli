/**
 * Discovery mode for `capy connect vercel --discover` (CAP-696): find every
 * Vercel project whose git link matches a repo reachable from `cwd`, then run
 * the SAME init → per-environment checkout → import sequence Dokploy
 * discovery runs (`dokployDiscovery.ts#runDiscoverySequences`, reused
 * unchanged), ending in the same local, never-pushed discovery commit.
 *
 * What differs from Dokploy, and why:
 *   - Matching. A Vercel project carries `link: { type: 'github', org, repo }`
 *     and a `rootDirectory`. The repo is matched on `origin` owner/repo exactly
 *     as Dokploy's is; the folder is the normalized `rootDirectory` (null or
 *     '' = the repo root). Only GitHub links are matched: the docs show no
 *     GitLab/Bitbucket link shape, so those projects are REPORTED
 *     (`unsupported_git_provider`), never guessed at.
 *   - Nesting. A Vercel project has exactly one folder, so there is no nested-
 *     folder folding: two projects on the same repo + folder are a collision,
 *     handled by the same `detectCollisions` / `resolveCollisions` Dokploy
 *     uses.
 *   - Names only. The plan reads each project's env LIST (no values) and
 *     counts what is readable by type. No secret value is read, held, or
 *     printed until a real run's per-environment import fetches it.
 *
 * READ-ONLY on the Vercel side: `listProjects`, `listCustomEnvironments`,
 * `listEnvs` — see `deploy/vercelApi.ts`.
 */
import { existsSync } from 'node:fs';
import { sortedCopy } from '../../deploy/dokployApi';
import { join } from 'node:path';
import {
  VercelClient,
  VercelProject,
  VercelEnvironmentPlan,
  buildEnvironmentPlans,
  groupSkipped,
} from '../../deploy/vercelApi';
import {
  CandidateRepo,
  DiscoveryFolderResult,
  DiscoveryOutcome,
  DiscoveryPlan,
  DiscoveryPlanEnv,
  DiscoveryPlanFolder,
  DiscoveryUnmatched,
  PeekLocalKeep,
  ListServerBranches,
  VercelUnmatchedReason,
  detectCollisions,
  normalizeRelativeDir,
  orderEnvironments,
} from './dokployDiscovery';
import type { ConnectOpts } from './registry';
import { describeTokenCreated } from '../../deploy/vercelCliToken';

/** `listProjects`/`listCustomEnvironments`/`listEnvs` only — the read-only surface planning needs. */
export type VercelDiscoveryClient = Pick<VercelClient, 'listProjects' | 'listCustomEnvironments' | 'listEnvs'>;

interface MatchedProject {
  project: VercelProject;
  repoDir: string;
  remote: CandidateRepo['remote'];
  /** Relative to `repoDir`; '' = repo root. */
  folder: string;
  productionBranch?: string;
}

const unmatchedFrom = (project: VercelProject, reason: VercelUnmatchedReason): DiscoveryUnmatched => ({
  projectName: project.name,
  serviceName: project.name,
  serviceKind: 'vercel',
  serviceId: project.id,
  reason,
});

/**
 * One Vercel project → a local repo + folder, or the reason it did not match.
 * Checked in this order so each project gets its most specific reason:
 * no link at all, a link this connector cannot match, no local repo with that
 * `origin`, a `rootDirectory` that does not exist in the matched repo.
 */
export function matchVercelProject(
  project: VercelProject,
  repos: readonly CandidateRepo[],
  folderExists: (repoDir: string, folder: string) => boolean,
): { kind: 'matched'; value: MatchedProject } | { kind: 'unmatched'; value: DiscoveryUnmatched } {
  const link = project.link;
  if (!link) return { kind: 'unmatched', value: unmatchedFrom(project, 'no_git_link') };
  if (link.kind !== 'github') return { kind: 'unmatched', value: unmatchedFrom(project, 'unsupported_git_provider') };
  const hit = repos.find((r) => r.remote.owner === link.org.toLowerCase() && r.remote.repo === link.repo.toLowerCase());
  if (!hit) return { kind: 'unmatched', value: unmatchedFrom(project, 'no_remote_match') };
  const folder = normalizeRelativeDir(project.rootDirectory ?? '');
  if (!folderExists(hit.repoDir, folder)) return { kind: 'unmatched', value: unmatchedFrom(project, 'root_directory_missing') };
  return {
    kind: 'matched',
    value: { project, repoDir: hit.repoDir, remote: hit.remote, folder, ...(link.productionBranch ? { productionBranch: link.productionBranch } : {}) },
  };
}

const defaultFolderExists = (repoDir: string, folder: string): boolean => folder === '' || existsSync(join(repoDir, folder));

function envFromPlan(plan: VercelEnvironmentPlan, m: MatchedProject): Omit<DiscoveryPlanEnv, 'branchExists' | 'willAutoOverwrite'> {
  return {
    environmentName: plan.environment.name,
    serviceId: m.project.id,
    serviceKind: 'vercel',
    variableCount: plan.importable.length,
    skippedCount: plan.skipped.length,
    // The project's production git branch — informational only, never the Capy
    // branch (the Vercel environment is), same role as Dokploy's `gitBranch`.
    ...(m.productionBranch ? { gitBranch: m.productionBranch } : {}),
    rawEnv: null,
    skipped: plan.skipped.map((s) => ({ name: s.name, code: s.reason, ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}) })),
  };
}

interface ProjectPlan {
  matched: MatchedProject;
  envs: ReadonlyArray<Omit<DiscoveryPlanEnv, 'branchExists' | 'willAutoOverwrite'>>;
}

/** Sequential, one project at a time: deterministic call order, and gentle on Vercel's rate limit. */
async function readProjectPlans(
  client: VercelDiscoveryClient,
  teamId: string | undefined,
  matched: readonly MatchedProject[],
): Promise<readonly ProjectPlan[]> {
  return matched.reduce<Promise<readonly ProjectPlan[]>>(async (accPromise, m) => {
    const acc = await accPromise;
    const custom = await client.listCustomEnvironments(m.project.id, teamId);
    const list = await client.listEnvs(m.project.id, teamId);
    const plans = buildEnvironmentPlans(list.envs, custom);
    return [...acc, { matched: m, envs: plans.map((p) => envFromPlan(p, m)) }];
  }, Promise.resolve([]));
}

async function toPlanFolder(
  pp: ProjectPlan,
  environmentFilter: ReadonlySet<string> | undefined,
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
): Promise<DiscoveryPlanFolder | null> {
  const envs = environmentFilter ? pp.envs.filter((e) => environmentFilter.has(e.environmentName)) : pp.envs;
  if (envs.length === 0) return null;
  const { matched } = pp;
  const localKeep = peek.peekLocalKeep(matched.repoDir, matched.folder);
  const initialized = !!localKeep;
  const serverBranchNames = localKeep ? new Set((await peek.listServerBranches(localKeep.project_id)).map((b) => b.name)) : null;
  const firstName = orderEnvironments(envs)[0]?.environmentName;
  const environments: readonly DiscoveryPlanEnv[] = envs.map((e) => {
    const branchExists = serverBranchNames ? serverBranchNames.has(e.environmentName) : undefined;
    const willCreateBranch = branchExists === false || !initialized;
    const willAutoOverwrite = willCreateBranch && !(!initialized && firstName === e.environmentName);
    return { ...e, ...(branchExists !== undefined ? { branchExists } : {}), willAutoOverwrite };
  });
  return {
    repoDir: matched.repoDir,
    folder: matched.folder,
    projectName: matched.project.name,
    serviceName: matched.project.name,
    environments,
    initialized,
    remote: matched.remote,
  };
}

/**
 * Reads every project, matches against `repos`, plans a folder per matched
 * project, flags collisions. Apart from the injected client/peek this never
 * writes anything — safe under `--dry-run` as-is.
 */
export async function buildVercelDiscoveryPlan(
  client: VercelDiscoveryClient,
  teamId: string | undefined,
  repos: readonly CandidateRepo[],
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
  environmentFilter?: readonly string[],
  folderExists: (repoDir: string, folder: string) => boolean = defaultFolderExists,
): Promise<DiscoveryPlan> {
  const projects = await client.listProjects(teamId);
  const results = projects.map((p) => matchVercelProject(p, repos, folderExists));
  const matched = results.flatMap((r) => (r.kind === 'matched' ? [r.value] : []));
  const unmatchedByLink = results.flatMap((r) => (r.kind === 'unmatched' ? [r.value] : []));

  const projectPlans = await readProjectPlans(client, teamId, matched);
  const withVariables = projectPlans.filter((pp) => pp.envs.length > 0);
  const noVariables = projectPlans.filter((pp) => pp.envs.length === 0).map((pp) => unmatchedFrom(pp.matched.project, 'no_variables'));
  const allEnvironmentNames = sortedCopy([...new Set(withVariables.flatMap((pp) => pp.envs.map((e) => e.environmentName)))]);
  const filterSet = environmentFilter && environmentFilter.length > 0 ? new Set(environmentFilter) : undefined;

  const maybeFolders = await Promise.all(withVariables.map((pp) => toPlanFolder(pp, filterSet, peek)));
  const folders = maybeFolders.filter((f): f is DiscoveryPlanFolder => f !== null);
  return {
    folders,
    collisions: detectCollisions(folders),
    unmatched: [...unmatchedByLink, ...noVariables],
    unreadableRepos: [],
    allEnvironmentNames,
    ...(filterSet ? { environmentFilter: [...filterSet] } : {}),
  };
}

// ── Reporting (names and codes only — never a value) ───────────────────────

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

const projectIdOf = (f: DiscoveryPlanFolder): string => f.environments[0]?.serviceId ?? '';

function envReport(e: Extract<DiscoveryFolderResult, { ok: true }>['environments'][number]) {
  return {
    branch: e.environmentName,
    branchCreated: e.branchCreated,
    overwrote: e.overwrote,
    imported: e.outcome.imported.map((i) => i.varName),
    ...(e.outcome.replacedNames ? { replacedNames: e.outcome.replacedNames } : {}),
    ...(e.outcome.cleared ? { cleared: e.outcome.cleared } : {}),
    unchanged: e.outcome.unchanged,
    skipped: e.outcome.skipped,
    warnings: e.outcome.warnings,
  };
}

function planReport(plan: DiscoveryPlan) {
  return {
    ...(plan.team ? { team: plan.team } : {}),
    ...(plan.environmentFilter ? { environmentFilter: plan.environmentFilter } : {}),
    folders: plan.folders.map((f) => ({
      repoDir: f.repoDir,
      folder: f.folder || '.',
      vercelProject: f.projectName,
      vercelProjectId: projectIdOf(f),
      initialized: f.initialized,
      environments: f.environments.map((e) => ({
        branch: e.environmentName,
        variableCount: e.variableCount,
        skippedCount: e.skippedCount,
        skipped: groupSkipped((e.skipped ?? []).map((s) => ({ name: s.name, reason: s.code, ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}) }))),
        ...(e.branchExists !== undefined ? { branchExists: e.branchExists } : {}),
        willAutoOverwrite: e.willAutoOverwrite,
      })),
    })),
    collisions: plan.collisions.map((c) => ({
      folder: c.folder || '.',
      branch: c.environmentName,
      candidates: c.candidates.map((cand) => ({ vercelProject: cand.projectName, vercelProjectId: cand.serviceId })),
    })),
    unmatched: plan.unmatched.map((u) => ({ vercelProject: u.projectName, vercelProjectId: u.serviceId, reason: u.reason })),
    unreadableRepos: plan.unreadableRepos.map((r) => ({ repoDir: r.repoDir, code: r.code, message: r.message })),
  };
}

function appliedReport(applied: readonly DiscoveryFolderResult[]) {
  return applied.map((f) =>
    f.ok
      ? { repoDir: f.repoDir, folder: f.folder || '.', ok: true as const, projectCreated: f.projectCreated, activeBranch: f.activeBranch, environments: f.environments.map(envReport) }
      : { repoDir: f.repoDir, folder: f.folder || '.', ok: false as const, code: f.code, message: f.message, environments: f.environments.map(envReport) },
  );
}

function commitsReport(commits: NonNullable<Extract<DiscoveryOutcome, { ok: true }>['commits']>) {
  return commits.map((c) =>
    c.ok
      ? c.dryRun
        ? { repoDir: c.repoDir, ok: true as const, dryRun: true as const, branch: c.branch, wouldCommitFiles: c.wouldCommitFiles }
        : { repoDir: c.repoDir, ok: true as const, dryRun: false as const, branch: c.branch, sha: c.sha, committedFiles: c.committedFiles }
      : { repoDir: c.repoDir, ok: false as const, code: c.code, message: c.message },
  );
}

/**
 * `ConnectorModule.reportDiscovery` for Vercel: under `--json`, exactly ONE
 * JSON object on stdout (nothing else, from anything on this path); otherwise
 * the human plan. Names and codes only.
 */
export function reportVercelDiscovery(
  outcome: Extract<DiscoveryOutcome, { ok: true }>,
  opts: ConnectOpts,
  provider: string,
): { linked: boolean } {
  const plan = planReport(outcome.plan);
  const applied = outcome.applied ? appliedReport(outcome.applied) : undefined;
  const commits = outcome.commits ? commitsReport(outcome.commits) : undefined;
  const linked =
    !!outcome.applied &&
    outcome.applied.some((f) => f.environments.some((e) => e.outcome.imported.length > 0 || (e.outcome.cleared?.length ?? 0) > 0));
  // One folder failing still lets the others run, but the run as a whole did
  // not fully succeed — CI watching the exit code must see that.
  if (outcome.applied?.some((f) => !f.ok)) process.exitCode = 1;

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        provider,
        dryRun: outcome.dryRun,
        cancelled: !!outcome.cancelled,
        plan,
        ...(applied ? { applied } : {}),
        ...(commits ? { commits } : {}),
        ...(outcome.tokenCreated ? { tokenCreated: outcome.tokenCreated } : {}),
      }),
    );
    return { linked };
  }

  if (outcome.tokenCreated) describeTokenCreated(outcome.tokenCreated).forEach((l) => console.log(l));
  const lines = humanLines(outcome, plan, applied, commits);
  lines.forEach((l) => console.log(l));
  return { linked };
}

// COPY-FLAG: report lines mirror Dokploy's discovery report word for word, with Vercel substituted; nothing new invented.
function humanLines(
  outcome: Extract<DiscoveryOutcome, { ok: true }>,
  plan: ReturnType<typeof planReport>,
  applied: ReturnType<typeof appliedReport> | undefined,
  commits: ReturnType<typeof commitsReport> | undefined,
): readonly string[] {
  const filterNote = plan.environmentFilter ? ` (--environment ${plan.environmentFilter.join(',')})` : '';
  return [
    '',
    outcome.dryRun ? `  Dry run — nothing written.${filterNote}` : `  Discovery plan:${filterNote}`,
    ...(plan.unreadableRepos.length > 0
      ? ['  ⚠ Repos git could not read:', ...plan.unreadableRepos.map((r) => `    ${r.repoDir} (${r.code}): ${r.message}`)]
      : []),
    ...(plan.folders.length === 0 ? ['  No matching Vercel projects found.'] : []),
    ...plan.folders.flatMap((f) => [
      `  ${B(f.folder)}  (${f.vercelProject})${f.initialized ? '' : ' — capy (init)'}`,
      ...f.environments.flatMap((e) => [
        `    ${e.branchExists === true ? 'checkout' : 'checkout -b'} ${e.branch}: ${e.variableCount} var(s), ${e.skippedCount} skipped${e.willAutoOverwrite ? ' [auto-overwrite]' : ''}`,
        ...Object.entries(e.skipped).map(
          ([reason, items]) => `      skipped ${reason}: ${items.map((i) => (i.gitBranch ? `${i.name} (${i.gitBranch})` : i.name)).join(', ')}`,
        ),
      ]),
    ]),
    ...(plan.collisions.length > 0
      ? ['  Collisions:', ...plan.collisions.map((c) => `    ${c.folder} / ${c.branch}: ${c.candidates.map((x) => x.vercelProject).join(', ')}`)]
      : []),
    ...(plan.unmatched.length > 0 ? ['  Unmatched:', ...plan.unmatched.map((u) => `    ${u.vercelProject} (${u.reason})`)] : []),
    ...appliedLines(outcome, applied),
    ...(commits && commits.length > 0 ? ['  Commit:', ...commits.map(commitLine)] : []),
    '',
  ];
}

// COPY-FLAG: report lines mirror Dokploy's discovery report word for word, with Vercel substituted; nothing new invented.
function appliedLines(outcome: Extract<DiscoveryOutcome, { ok: true }>, applied: ReturnType<typeof appliedReport> | undefined): readonly string[] {
  if (outcome.cancelled) return ['  Cancelled — nothing written.'];
  if (!applied) return [];
  return applied.flatMap((f) => [
    `  ${B(f.folder)}${f.ok && f.projectCreated ? ' (new project)' : ''}`,
    ...f.environments.map((e) => {
      const clearedCount = e.cleared?.length ?? 0;
      return (
        `    ${e.branch}${e.branchCreated ? ' (new branch)' : ''}${e.overwrote ? ' (--overwrite)' : ''}: ` +
        `imported ${e.imported.length}, unchanged ${e.unchanged.length}, skipped ${e.skipped.length}` +
        (clearedCount > 0 ? `, cleared ${clearedCount}` : '')
      );
    }),
    ...(f.ok ? (f.activeBranch ? [`    folder is on branch ${f.activeBranch}`] : []) : [`    ✗ ${f.code}: ${f.message}`]),
  ]);
}

// COPY-FLAG: report lines mirror Dokploy's discovery report word for word, with Vercel substituted; nothing new invented.
function commitLine(c: ReturnType<typeof commitsReport>[number]): string {
  if (!c.ok) return `    ${c.repoDir}: ✗ ${c.code}: ${c.message}`;
  if (c.dryRun) return `    ${c.repoDir}: would commit ${c.wouldCommitFiles.length} file(s) onto ${c.branch}`;
  return `    ${c.repoDir}: committed ${c.committedFiles.length} file(s) onto ${c.branch} (${c.sha.slice(0, 8)})`;
}
