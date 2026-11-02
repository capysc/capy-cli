/**
 * Writing a confirmed plan (CAP-703): each project's `.capy/deploy.json`
 * target, as ONE pull request per repo on the repo's default branch, through
 * the GitHub API (keepLockPr's `openFilesPullRequest`: blob per file, one
 * tree, one commit, one ref, one PR). Several projects of one monorepo are
 * several files in one commit; the path is `<repo-relative project path>/.capy/deploy.json`.
 *
 * Nothing is cloned or checked out, and no value is read or sent: a target
 * holds names and ids only.
 *
 * Repos fail independently: a failure in one is its own coded result and the
 * others still go ahead. A target already in the file (the same Dokploy
 * service on the same Capy branch) is left alone, so running the same plan
 * again after its PR merged opens nothing.
 *
 * Merging into an existing file keeps every other target and every other
 * top-level field exactly as they were read.
 */
import { ERROR_CODES } from '../../types/index';
import type { TargetConfig } from '../../deploy/adapter';
import type { GithubApi, RepoRef } from '../../deploy/githubApi';
import { codeForApiFailure, openFilesPullRequest, resolveDefaultBase } from '../keepLockPr';
import { ExistingTarget, ParsedDeployJson, byText, configuredTarget, parseDeployJson, uniqueSorted } from './facts';
import { TargetToWrite, uniqueName } from './evaluate';
import { sortedCopy } from '../../deploy/dokployApi';

// COPY-FLAG: new user-facing strings, minimal and neutral.
const PR_TITLE = 'chore(capy): add Dokploy deploy targets'; // COPY-FLAG

export interface RepoPrResult {
  readonly repo: string;
  readonly pr_url: string;
  readonly base: string;
  readonly paths: readonly string[];
  readonly targets: readonly string[];
}

export interface RepoFailure {
  readonly repo: string;
  readonly code: string;
}

export interface AppliedAlready {
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly service_id: string;
  readonly target_name: string;
}

export interface ApplyResult {
  readonly prs: readonly RepoPrResult[];
  readonly failed: readonly RepoFailure[];
  /** Targets found already in the repo's deploy.json when it was read for the write. */
  readonly already_configured: readonly AppliedAlready[];
}

export interface ApplyDeps {
  readonly github: GithubApi | undefined;
  readonly branchName: () => string;
}

const repoLabel = (repo: RepoRef): string => `${repo.owner}/${repo.name}`;

/** The text of a deploy.json holding `existing` plus `added`; every other target and top-level field is carried over as read. */
export function mergeDeployJson(parsed: Extract<ParsedDeployJson, { ok: true }>, added: readonly TargetConfig[]): string {
  const base = parsed.raw ?? { version: '1', targets: {} };
  const previous = (typeof base.targets === 'object' && base.targets !== null && !Array.isArray(base.targets) ? base.targets : {}) as Record<string, unknown>;
  const targets = { ...previous, ...Object.fromEntries(added.map((t) => [t.name, t])) };
  return JSON.stringify({ ...base, version: '1', targets }, null, 2) + '\n';
}

interface WrittenTarget {
  readonly target: TargetConfig;
  readonly serviceKind: 'application' | 'compose';
  readonly serviceId: string;
}

interface FilePlan {
  readonly path: string;
  readonly content: string;
  readonly written: readonly WrittenTarget[];
  readonly already: readonly AppliedAlready[];
}

/** Reads a file at `base` and works out what to add to it. `null`: the file could not be read or is not a version-1 deploy.json. */
async function planFile(
  github: GithubApi,
  repo: RepoRef,
  base: string,
  path: string,
  targets: readonly TargetToWrite[],
): Promise<{ readonly ok: true; readonly plan: FilePlan } | { readonly ok: false; readonly code: string }> {
  const read = await github.getFile(repo, path, base);
  if (!read.ok) return { ok: false, code: codeForApiFailure(read, ERROR_CODES.KEEP_PR_READ_FAILED) };
  const parsed = parseDeployJson(read.value);
  if (!parsed.ok) return { ok: false, code: ERROR_CODES.KEEP_PR_READ_FAILED };
  const already = targets.flatMap((t): AppliedAlready[] => {
    const hit = configuredTarget(parsed.targets, t.service.service_id, t.entry.branch);
    return hit === undefined
      ? []
      : [{ repo: repoLabel(repo), path, branch: t.entry.branch, service_id: t.service.service_id, target_name: hit.name }];
  });
  const fresh = targets.filter((t) => configuredTarget(parsed.targets, t.service.service_id, t.entry.branch) === undefined);
  const named = fresh.reduce<readonly WrittenTarget[]>((acc, t) => {
    const taken = new Set([...parsed.targets.map((x: ExistingTarget) => x.name), ...acc.map((x) => x.target.name)]);
    return [
      ...acc,
      {
        target: { ...t.target, name: uniqueName(t.target.name, taken) },
        serviceKind: t.service.kind,
        serviceId: t.service.service_id,
      },
    ];
  }, []);
  return {
    ok: true,
    plan: {
      path,
      content: named.length === 0 ? '' : mergeDeployJson(parsed, named.map((w) => w.target)),
      written: named,
      already,
    },
  };
}

// COPY-FLAG: new user-facing strings (the commit message and the PR body), names and ids only.
function wording(repo: RepoRef, files: readonly FilePlan[]) {
  const lines = files.flatMap((f) =>
    f.written.map(
      (w) =>
        `- \`${w.target.name}\` in \`${f.path}\`: Capy branch \`${w.target.branch}\`, Dokploy ${w.serviceKind} \`${w.serviceId}\`, git branch \`${w.target.gitBaseBranch ?? ''}\``,
    ),
  );
  const names = files.flatMap((f) => f.written.map((w) => w.target.name));
  return {
    commitMessage: [PR_TITLE, '', `Targets: ${names.join(', ')}`].join('\n'),
    title: PR_TITLE,
    body: [
      'Adds Dokploy deploy targets to `.capy/deploy.json`.',
      '',
      ...lines,
      '',
      `Repo: \`${repoLabel(repo)}\``,
      'Names and ids only. No secret values appear in this PR.',
    ].join('\n'),
  };
}

type RepoOutcome =
  | { readonly kind: 'pr'; readonly pr: RepoPrResult; readonly already: readonly AppliedAlready[] }
  | { readonly kind: 'unchanged'; readonly already: readonly AppliedAlready[] }
  | { readonly kind: 'failed'; readonly failure: RepoFailure };

async function applyRepo(repo: RepoRef, targets: readonly TargetToWrite[], deps: ApplyDeps): Promise<RepoOutcome> {
  const label = repoLabel(repo);
  const fail = (code: string): RepoOutcome => ({ kind: 'failed', failure: { repo: label, code } });
  const { github } = deps;
  if (github === undefined) return fail(ERROR_CODES.KEEP_PR_GH_UNAVAILABLE);
  const base = await resolveDefaultBase(github, repo);
  if (!base.ok) return fail(base.code);

  const paths = uniqueSorted(targets.map((t) => t.file));
  const planned = await Promise.all(
    paths.map((path) =>
      planFile(github, repo, base.base, path, targets.filter((t) => t.file === path)),
    ),
  );
  const failedRead = planned.find((p) => !p.ok);
  if (failedRead !== undefined && !failedRead.ok) return fail(failedRead.code);
  const files = planned.flatMap((p) => (p.ok ? [p.plan] : []));
  const already = files.flatMap((f) => f.already);
  const changed = files.filter((f) => f.written.length > 0);
  if (changed.length === 0) return { kind: 'unchanged', already };

  const words = wording(repo, changed);
  const opened = await openFilesPullRequest(
    {
      repo,
      base: base.base,
      files: changed.map((f) => ({ path: f.path, content: f.content })),
      ...words,
    },
    { github, branchName: deps.branchName },
  );
  if (!opened.ok) return fail(opened.code);
  return {
    kind: 'pr',
    already,
    pr: {
      repo: label,
      pr_url: opened.pr_url,
      base: opened.base,
      paths: opened.paths,
      targets: changed.flatMap((f) => f.written.map((w) => w.target.name)),
    },
  };
}

/** One PR per repo. Sequential, so a repo's failure never depends on another's timing; each repo reports on its own. */
export async function applyTargets(targets: readonly TargetToWrite[], deps: ApplyDeps): Promise<ApplyResult> {
  const repos = uniqueSorted(targets.map((t) => t.repoKey)).map((key) => {
    const mine = targets.filter((t) => t.repoKey === key);
    return { repo: mine[0].repo, targets: mine };
  });
  const outcomes = await repos.reduce<Promise<readonly RepoOutcome[]>>(async (accPromise, r) => {
    const acc = await accPromise;
    return [...acc, await applyRepo(r.repo, r.targets, deps)];
  }, Promise.resolve([]));
  return {
    prs: outcomes.flatMap((o) => (o.kind === 'pr' ? [o.pr] : [])),
    failed: outcomes.flatMap((o) => (o.kind === 'failed' ? [o.failure] : [])),
    already_configured: sortedCopy(
      outcomes.flatMap((o) => (o.kind === 'failed' ? [] : o.already)),
      (a, b) => byText(a.repo, b.repo) || byText(a.path, b.path) || byText(a.branch, b.branch),
    ),
  };
}
