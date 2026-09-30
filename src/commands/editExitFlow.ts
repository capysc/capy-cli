/**
 * `capy edit` session → PR on exit.
 *
 * Replaces the old auto-commit-on-whatever-branch-you're-on behaviour (that
 * git helper is deleted entirely): keep.lock is committed only on an
 * explicit action, and always onto a separate commit branch in an isolated
 * worktree — exactly the way `capy deploy`'s CI mode
 * already does it
 * (deployCommand.ts, deploy/git.ts, deploy/keepGate.ts). This module reuses
 * those same git helpers rather than duplicating them.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import inquirer from 'inquirer';
import { KeepFile } from '../types/index';
import { serializeKeep } from '../files/fileManager';
import { EditSaveRecord, foldEditSaveIntoKeep } from '../deploy/keepGate';
import {
  isGitRepo,
  currentBranch,
  listLocalBranches,
  resolveDefaultBranch,
  fetchRemoteBranch,
  repoRelPath,
  readFileAtRef,
  worktreeAddNewBranch,
  worktreeRemove,
  deleteLocalBranch,
  stageAndCommit,
  pushBranch,
  createPr,
} from '../deploy/git';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

// COPY-FLAG: no existing string fit an edit-session PR prompt/notice, so
// these are new, minimal, neutral wording.
const PICKER_MESSAGE = 'Open a PR against which branch?';
const NOT_COMMITTED_MESSAGE = 'Saved to Keep — not committed to git (no PR opened).';
const NO_DIFF_MESSAGE = 'no keep.lock changes to commit';

/**
 * Last-resort guess when neither `origin/HEAD` nor the current branch
 * resolves: 'main' if it exists locally, else 'master' if IT exists, else
 * just 'main' anyway (the field is editable — this is only a default).
 */
function guessFallbackBranch(localBranches: readonly string[]): string {
  if (localBranches.includes('main')) return 'main';
  if (localBranches.includes('master')) return 'master';
  return 'main';
}

/**
 * Ask which branch to open the edit-session PR against. Same text-entry
 * shape as deploy's "open the deploy PR against which target branch?"
 * prompt (deployCommand.ts) — a repo can have far too many branches for a
 * list picker. Defaults to the repo's resolvable default branch
 * (`origin/HEAD`), then the current branch, then main/master.
 *
 * Returns null when the user cancels (Ctrl+C) — callers treat that exactly
 * like "not a TTY": nothing gets committed anywhere.
 */
export async function pickEditPrTargetBranch(cwd: string): Promise<string | null> {
  const fallback = resolveDefaultBranch(cwd) ?? currentBranch(cwd) ?? guessFallbackBranch(listLocalBranches(cwd));
  try {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'targetBranch',
        message: PICKER_MESSAGE,
        default: fallback,
        validate: (v: string) => (v.trim().length > 0 ? true : 'enter a branch name'),
      },
    ]);
    return (answer.targetBranch as string).trim();
  } catch (err: any) {
    if (err?.name === 'ExitPromptError') return null;
    throw err;
  }
}

/**
 * Fold + commit each save in order, onto the worktree's keep.lock. A save
 * whose fold produces no diff vs the running keep is skipped (no commit) —
 * its (variable, branch) pin was already what the target has. Recursive
 * rather than a mutable accumulator: each step threads the folded keep
 * forward as a plain argument, never reassigning or mutating anything.
 */
async function commitFoldedSaves(
  wt: string,
  relKeepPath: string,
  keep: KeepFile,
  records: readonly EditSaveRecord[],
): Promise<{ ok: boolean; commits: number; error?: string }> {
  if (records.length === 0) return { ok: true, commits: 0 };
  const [record, ...rest] = records;
  const folded = foldEditSaveIntoKeep(keep, record);
  if (serializeKeep(folded) === serializeKeep(keep)) {
    return commitFoldedSaves(wt, relKeepPath, keep, rest);
  }
  writeFileSync(join(wt, relKeepPath), serializeKeep(folded));
  const commit = stageAndCommit(wt, [relKeepPath], `chore(capy): pin ${record.branch} secrets`);
  if (!commit.ok) return { ok: false, commits: 0, error: commit.error };
  const restResult = await commitFoldedSaves(wt, relKeepPath, folded, rest);
  if (!restResult.ok) return restResult;
  return { ok: true, commits: 1 + restResult.commits };
}

function buildEditPrBody(records: readonly EditSaveRecord[], targetBranch: string): string {
  const branches = [...new Set(records.map((r) => r.branch))];
  const vars = [...new Set(records.flatMap((r) => r.entries.map((e) => e.variable)))];
  return [
    `Pins secrets changed during a \`capy edit\` session onto \`${targetBranch}\`.`,
    '',
    `- **Capy branch(es):** ${branches.map((b) => `\`${b}\``).join(', ')}`,
    `- **Variables touched:** ${vars.map((v) => `\`${v}\``).join(', ') || '(none)'}`,
    '',
    'Names and hashes only — no secret values appear in this PR.',
  ].join('\n');
}

export interface EditExitOutcome {
  opened: boolean;
  commits: number;
  prUrl?: string;
  manualHint?: string;
  branch?: string;
  base?: string;
  error?: string;
}

/** Injectable seam for tests — defaults to the real `createPr` (deploy/git.ts). */
export interface EditExitFlowDeps {
  createPr: typeof createPr;
}

const defaultDeps: EditExitFlowDeps = { createPr };

/**
 * Exactly deploy CI mode's own worktree dance (deployCommand.ts, reused via
 * deploy/git.ts): an isolated linked worktree on a new branch off
 * `origin/<targetBranch>`, one commit per session save that actually
 * changed something, pushed and opened as a PR — including deploy's
 * `gh`-missing manualHint fallback. The user's real checkout, branch and
 * working tree are never touched. Always tears the worktree + local branch
 * ref down afterwards, success or failure.
 *
 * `deps.createPr` defaults to the real thing; tests inject a fake so the
 * git side of this flow (branch, commits, push) can be verified against a
 * real local origin without a real `gh`/GitHub round-trip.
 */
export async function runEditExitFlow(
  cwd: string,
  targetBranch: string,
  records: readonly EditSaveRecord[],
  localKeep: KeepFile,
  deps: EditExitFlowDeps = defaultDeps,
): Promise<EditExitOutcome> {
  if (records.length === 0) return { opened: false, commits: 0 };

  const fetched = fetchRemoteBranch(cwd, targetBranch);
  if (!fetched.ok) {
    return { opened: false, commits: 0, error: `git fetch origin ${targetBranch}: ${fetched.error}` };
  }

  const now = new Date();
  const ts =
    now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + now.toISOString().slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  const branchName = `capy-edit-${ts}-${rand}`;
  const wt = join(tmpdir(), branchName);

  const added = worktreeAddNewBranch(cwd, wt, branchName, `origin/${targetBranch}`);
  if (!added.ok) {
    return {
      opened: false,
      commits: 0,
      error: `git worktree add (off origin/${targetBranch}): ${added.error}`,
    };
  }

  try {
    const relKeep = repoRelPath(cwd, 'keep.lock');
    const baseRaw = readFileAtRef(cwd, `origin/${targetBranch}`, relKeep);
    // Target branch has no keep.lock yet — scaffold identity from the local
    // keep with no variables, same as deploy does.
    const baseKeep: KeepFile = baseRaw ? JSON.parse(baseRaw) : { ...localKeep, variables: {} };

    const folded = await commitFoldedSaves(wt, relKeep, baseKeep, records);
    if (!folded.ok) {
      return { opened: false, commits: 0, error: folded.error };
    }
    if (folded.commits === 0) {
      return { opened: false, commits: 0 };
    }

    const push = pushBranch(wt, branchName);
    if (!push.ok) {
      return { opened: false, commits: folded.commits, error: `git push: ${push.error}` };
    }

    const title = `capy edit: pin secrets → ${targetBranch}`; // COPY-FLAG
    const body = buildEditPrBody(records, targetBranch);
    const pr = deps.createPr(wt, title, body, targetBranch);
    if (pr.ok) {
      return {
        opened: true,
        commits: folded.commits,
        prUrl: pr.url,
        branch: branchName,
        base: targetBranch,
      };
    }
    if (pr.manualHint) {
      return {
        opened: true,
        commits: folded.commits,
        manualHint: pr.manualHint,
        branch: branchName,
        base: targetBranch,
      };
    }
    return { opened: false, commits: folded.commits, error: `gh pr create: ${pr.error}` };
  } finally {
    worktreeRemove(cwd, wt);
    deleteLocalBranch(cwd, branchName);
  }
}

/**
 * Top-level exit hook for `capy edit`: asks (in the terminal, even under
 * `--web`) which branch to pin this session's saves onto, then runs
 * `runEditExitFlow`. Prints one short line either way — a PR URL/manual
 * hint on success, or a note that changes were saved to Keep but not
 * committed when there's no TTY, no git repo, the user cancels the picker,
 * or nothing actually changed.
 */
export async function concludeEditSession(
  cwd: string,
  records: readonly EditSaveRecord[],
  localKeep: KeepFile,
): Promise<void> {
  if (records.length === 0) return;

  if (!isGitRepo(cwd) || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(DIM(NOT_COMMITTED_MESSAGE));
    return;
  }

  const targetBranch = await pickEditPrTargetBranch(cwd);
  if (targetBranch === null) {
    console.error(DIM(NOT_COMMITTED_MESSAGE));
    return;
  }

  const outcome = await runEditExitFlow(cwd, targetBranch, records, localKeep);
  if (outcome.error) {
    console.error(`${YELLOW('!')} could not open the edit PR: ${outcome.error}`);
    return;
  }
  if (outcome.commits === 0) {
    console.log(`  ${DIM('·')} ${NO_DIFF_MESSAGE} vs ${targetBranch}.`);
    return;
  }
  if (outcome.opened && outcome.prUrl) {
    console.log(`  ${GREEN('✓')} PR      ${outcome.prUrl}`);
  } else if (outcome.opened && outcome.manualHint) {
    console.log(`  ${YELLOW('!')} ${outcome.manualHint}`);
  }
}
