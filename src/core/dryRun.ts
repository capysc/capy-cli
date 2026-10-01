/**
 * CAP-659 — the shared `--dry-run` result shape, printers and exit-code
 * rule. Pure functions only: no Commander, no filesystem, no network — a
 * Phase 2/3 command builds one `DryRunResult` from the same plan it would
 * otherwise travel, and this module is the only place that turns it into
 * stdout/stderr output or an exit code. Not wired into any command's real
 * action yet — `src/index.ts`'s guard uses the refusal half for
 * `DRY_RUN_UNSUPPORTED`; everything else here is for Phase 2 to build on
 * top of, proven here by unit test rather than by a live command.
 */
import { EXIT_NEEDS_INPUT } from '../ui/interactive';

/**
 * Where a change would land, per CAP-659: `local_file` (`.env`, `keep.lock`,
 * `.capy/`, `~/.capy`), `git` (a hook, a commit, a branch), `capy_service`
 * (a Keep write), `third_party` (Vercel/Cloudflare/AWS/GitHub/Stripe/
 * WorkOS/Dokploy), `keychain`, `process` (a child process started), or
 * `browser` (a tab opened).
 */
export type DryRunChangeLocation =
  | 'local_file'
  | 'git'
  | 'capy_service'
  | 'third_party'
  | 'keychain'
  | 'process'
  | 'browser';

/** One change the real run would make. `reversible: false` only where verified (CAP-659: e.g. `kick`, a branch delete, a provider rotation) — every other change defaults to reversible rather than guessed either way. */
export interface DryRunChange {
  readonly where: DryRunChangeLocation;
  readonly action: string;
  readonly target: string;
  readonly reversible: boolean;
}

/** A choice no flag settled yet, and the flag that would settle it. */
export interface DryRunUnanswered {
  readonly id: string;
  readonly flag: string;
}

export interface DryRunOkResult {
  readonly ok: true;
  readonly dry_run: true;
  readonly command: string;
  readonly changes: readonly DryRunChange[];
  readonly unanswered: readonly DryRunUnanswered[];
}

/** The real run would refuse — same `code` it would exit with for real. */
export interface DryRunRefusedResult {
  readonly ok: false;
  readonly dry_run: true;
  readonly command: string;
  readonly code: string;
}

export type DryRunResult = DryRunOkResult | DryRunRefusedResult;

export function dryRunOk(
  command: string,
  changes: readonly DryRunChange[] = [],
  unanswered: readonly DryRunUnanswered[] = [],
): DryRunOkResult {
  return { ok: true, dry_run: true, command, changes, unanswered };
}

export function dryRunRefused(command: string, code: string): DryRunRefusedResult {
  return { ok: false, dry_run: true, command, code };
}

/** Exit codes, matching the real run (CAP-659): 0 would proceed, 1 refuse, 3 a flag must answer a choice first. */
export const DRY_RUN_EXIT_PROCEED = 0;
export const DRY_RUN_EXIT_REFUSE = 1;
export const DRY_RUN_EXIT_NEEDS_INPUT = EXIT_NEEDS_INPUT;

/** `0` when the real run would go ahead, `3` when a choice is still unanswered, `1` on refusal. Decided on `result.ok`/`unanswered.length` — never on any printed text. */
export function dryRunExitCode(result: DryRunResult): number {
  if (!result.ok) return DRY_RUN_EXIT_REFUSE;
  return result.unanswered.length > 0 ? DRY_RUN_EXIT_NEEDS_INPUT : DRY_RUN_EXIT_PROCEED;
}

/** Stdout carries exactly one JSON object — this is the only thing that should ever be written to stdout under `--dry-run --json`. */
export function printDryRunResultJson(result: DryRunResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Minimal, neutral wording pending copy approval (CAP-659 decision 6) —
 * every line here is a placeholder, not approved user-facing copy.
 */
// COPY-FLAG: wording below needs approval (CAP-659 decision 6); minimal/neutral until then.
export function formatDryRunResultHuman(result: DryRunResult): string {
  if (!result.ok) {
    return `Dry run: refused (${result.code}).`;
  }
  if (result.changes.length === 0 && result.unanswered.length === 0) {
    return 'Dry run: no changes.';
  }
  const changeLines = result.changes.map(
    (c) => `  - ${c.action} ${c.target} (${c.where}${c.reversible ? '' : ', not reversible'})`,
  );
  const unansweredLines = result.unanswered.map((u) => `  - ${u.id}: pass ${u.flag}`);
  return [
    'Dry run — would change:',
    ...changeLines,
    ...(unansweredLines.length > 0 ? ['Needs an answer:', ...unansweredLines] : []),
  ].join('\n');
}

/** Refusal prose goes to stderr (same stream `refuse()`-style helpers elsewhere use); a non-refusal preview is the command's normal output, so it goes to stdout. */
export function printDryRunResultHuman(result: DryRunResult): void {
  const text = formatDryRunResultHuman(result);
  if (!result.ok) {
    console.error(text);
    return;
  }
  console.log(text);
}
