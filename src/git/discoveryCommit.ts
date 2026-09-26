/**
 * `capy connect dokploy --discover`'s own commit step (CAP-657 follow-up
 * decision #9, 2026-09-26): after a REAL (non-dry-run) run finishes, the
 * keep.lock/.gitignore files IT ITSELF wrote get committed onto a NEW git
 * branch, in the repo they live in — never `.env`, never anything else,
 * and never pushed. Mirrors `autoCommitKeep.ts`'s own pattern (decide by
 * git's EXIT STATUS alone, never by reading its stderr/stdout text; a
 * failure here is reported with a code, never thrown past this module).
 *
 * The refusal codes are checked in order, before any git-mutating command
 * runs, so a refusal always leaves the repo exactly as it was:
 *   - `DOKPLOY_COMMIT_WOULD_MIX`: one of the candidate paths was ALREADY
 *     dirty (per a snapshot taken BEFORE discovery wrote anything) —
 *     committing it now would silently sweep up someone else's uncommitted
 *     change along with discovery's own.
 *   - `DOKPLOY_COMMIT_BRANCH_INVALID`: the branch name fails
 *     `git check-ref-format --branch` (spaces, `a..b`, a leading `-`, empty,
 *     …) — checked by exit status alone, never by reading git's own error
 *     text.
 *   - `DOKPLOY_COMMIT_BRANCH_EXISTS`: the branch name is already taken.
 *   - `DOKPLOY_GIT_IDENTITY_MISSING`: this repo has no configured
 *     `user.name`/`user.email` — checked directly via `git config`, never
 *     inferred from a failed commit's own message.
 *
 * A failed `git commit` (e.g. a rejecting pre-commit hook) rolls back
 * fully: `git reset` the staged paths BEFORE switching back (checkout alone
 * can leave a newly-`add`ed path staged on the ORIGINAL branch — it only
 * touches what differs between the two branches' trees, not every index
 * entry), then checkout back to the original branch, then delete the new
 * branch. The working-tree FILES themselves are never touched by the
 * rollback — only the index entries and the branch/HEAD state.
 */
import { execFileSync } from 'node:child_process';

function git(repoRoot: string, args: readonly string[]): string {
  // `env: process.env` explicitly: Bun's `execFileSync` (unlike Node's)
  // snapshots the environment at process START when `env` is omitted,
  // silently ignoring any later `process.env` change (e.g. a test
  // isolating HOME to prove `DOKPLOY_GIT_IDENTITY_MISSING` without relying
  // on this machine's own git identity). Passing it explicitly makes this
  // read the LIVE environment, matching Node's behavior and every other
  // git helper in this codebase.
  return execFileSync('git', [...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env });
}

/** Runs a git command, converting a thrown (nonzero exit) into `{ok:false}` — never reads WHY it failed from stderr text; only ever branches on whether it threw at all. */
function tryGit(repoRoot: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false } {
  try {
    return { ok: true, stdout: git(repoRoot, args) };
  } catch {
    return { ok: false };
  }
}

/**
 * `git status --porcelain -- <paths>` for each of `paths` (relative to
 * `repoRoot`) — read-only. Called BEFORE discovery writes anything, so
 * `commitDiscoveryChanges` can tell "this file is new/changed because of
 * THIS run" apart from "this file already had an uncommitted change before
 * this run started" (see `DOKPLOY_COMMIT_WOULD_MIX`).
 */
export function snapshotPathStatus(repoRoot: string, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return new Set();
  const result = tryGit(repoRoot, ['status', '--porcelain', '--', ...paths]);
  if (!result.ok) return new Set();
  const dirty = result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return new Set(dirty);
}

/** `capy/dokploy-import-<YYYYMMDD-HHMM>` — the default branch name, used whenever nothing asked for (or answered) a different one. */
export function defaultDiscoveryCommitBranchName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `capy/dokploy-import-${stamp}`;
}

/**
 * Whether `name` is a syntactically valid git branch name
 * (`git check-ref-format --branch <name>`) — a pure syntax check, no repo
 * required. Exit status only — never inspects git's own error text. Used
 * both by `commitDiscoveryChanges` itself (the authoritative, zero-
 * mutation-guaranteed check) and by the interactive ask's own `validate`
 * (re-asking before ever reaching this function at all).
 */
export function isValidDiscoveryCommitBranchName(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env });
    return true;
  } catch {
    return false;
  }
}

export type DiscoveryCommitOutcome =
  | { ok: true; dryRun: false; branch: string; sha: string; committedFiles: readonly string[] }
  | { ok: true; dryRun: true; branch: string; wouldCommitFiles: readonly string[] }
  | {
      ok: false;
      /** Stable refusal code — branch on this, never on `message`. */
      code:
        | 'DOKPLOY_COMMIT_WOULD_MIX'
        | 'DOKPLOY_COMMIT_BRANCH_INVALID'
        | 'DOKPLOY_COMMIT_BRANCH_EXISTS'
        | 'DOKPLOY_GIT_IDENTITY_MISSING'
        | 'DOKPLOY_COMMIT_FAILED';
      message: string;
    };

/**
 * Commits `paths` (relative to `repoRoot` — the keep.lock/.gitignore files
 * a real discovery run itself wrote, and NOTHING else) onto a new branch
 * created from the current HEAD, using the repo's own configured git
 * identity (no overrides). `--dry-run` (`opts.dryRun`) shows the branch
 * name and the files that WOULD be committed, and runs no git-mutating
 * command at all. An empty `paths` (nothing succeeded, or nothing changed)
 * is a no-op — `{ok:true, dryRun:true, wouldCommitFiles:[]}` regardless of
 * `opts.dryRun`, since there is nothing to commit either way.
 */
export function commitDiscoveryChanges(
  repoRoot: string,
  paths: readonly string[],
  beforeStatus: ReadonlySet<string>,
  opts: { branchName: string; dryRun: boolean; summaryLines: readonly string[] },
): DiscoveryCommitOutcome {
  if (paths.length === 0) {
    return { ok: true, dryRun: true, branch: opts.branchName, wouldCommitFiles: [] };
  }

  const mixedFiles = paths.filter((p) => beforeStatus.has(p));
  if (mixedFiles.length > 0) {
    return {
      ok: false,
      code: 'DOKPLOY_COMMIT_WOULD_MIX',
      message: `${mixedFiles.join(', ')} already had uncommitted changes before this run — refusing to mix them into an automatic commit.`,
    };
  }

  if (!isValidDiscoveryCommitBranchName(opts.branchName)) {
    return { ok: false, code: 'DOKPLOY_COMMIT_BRANCH_INVALID', message: `"${opts.branchName}" is not a valid git branch name.` };
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, branch: opts.branchName, wouldCommitFiles: paths };
  }

  const branchExists = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branchName}`]);
  if (branchExists.ok) {
    return { ok: false, code: 'DOKPLOY_COMMIT_BRANCH_EXISTS', message: `Branch "${opts.branchName}" already exists.` };
  }

  const identityName = tryGit(repoRoot, ['config', '--get', 'user.name']);
  const identityEmail = tryGit(repoRoot, ['config', '--get', 'user.email']);
  if (!identityName.ok || !identityName.stdout.trim() || !identityEmail.ok || !identityEmail.stdout.trim()) {
    return {
      ok: false,
      code: 'DOKPLOY_GIT_IDENTITY_MISSING',
      message: 'git has no configured identity in this repo — set user.name and user.email, then re-run.',
    };
  }

  const created = tryGit(repoRoot, ['checkout', '-b', opts.branchName]);
  if (!created.ok) {
    return { ok: false, code: 'DOKPLOY_COMMIT_FAILED', message: `Could not create branch "${opts.branchName}".` };
  }

  const added = tryGit(repoRoot, ['add', '--', ...paths]);
  const messageArgs = ['-m', 'chore(capy): import Dokploy environments', ...(opts.summaryLines.length > 0 ? ['-m', opts.summaryLines.join('\n')] : [])];
  const committed = added.ok ? tryGit(repoRoot, ['commit', ...messageArgs, '--', ...paths]) : { ok: false as const };
  if (!committed.ok) {
    // Never leaves the repo stranded on a half-made branch after a failed
    // commit (e.g. a rejecting pre-commit hook) — nor with `paths` left
    // STAGED on the ORIGINAL branch. `reset` (index only, working tree
    // untouched) runs BEFORE the checkout back: `checkout` alone only
    // resets index entries for paths that differ between the two
    // branches' trees, so a newly-`add`ed path can otherwise survive the
    // switch still staged.
    tryGit(repoRoot, ['reset', '-q', '--', ...paths]);
    tryGit(repoRoot, ['checkout', '-']);
    tryGit(repoRoot, ['branch', '-D', opts.branchName]);
    return { ok: false, code: 'DOKPLOY_COMMIT_FAILED', message: 'git commit failed.' };
  }

  const sha = tryGit(repoRoot, ['rev-parse', 'HEAD']);
  return { ok: true, dryRun: false, branch: opts.branchName, sha: sha.ok ? sha.stdout.trim() : '', committedFiles: paths };
}
