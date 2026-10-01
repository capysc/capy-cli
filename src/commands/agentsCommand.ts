/**
 * `capy agents` (CAP-681) — tells AI coding agents working in this repo how
 * to use Capy, by writing a short marked block into AGENTS.md and/or
 * CLAUDE.md. Same JSON/refusal conventions as `capy system *`
 * (src/commands/systemCommand.ts): pure JSON on stdout under `--json`, prose
 * only on stderr in human mode, every refusal carries a stable `code`.
 *
 * This is local-only file work — no org, no team, no server — so it is
 * deliberately NOT in LOCAL_ONLY_DISABLED_COMMANDS (see src/core/localGate.ts)
 * and works the same whether or not the active profile has an organization.
 *
 * Non-interactive (CAP-659): write and `--remove` both confirm before
 * touching a file, and without a TTY there is no way to answer that prompt —
 * `--yes` is the flag that answers it, the same convention as `capy remove`
 * and `capy system rm`. `--non-tty` is accepted too (same meaning as every
 * other command's flag of that name: never prompt, even on a real TTY).
 * Without either, the refusal is coded `AGENTS_SETUP_NEEDS_TTY`, exits
 * `EXIT_NEEDS_INPUT` (3), and under `--json` names the flag that would answer
 * it via `unanswered`.
 */
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { CapyError, ERROR_CODES } from '../types/index';
import {
  AGENTS_BLOCK,
  hasCurrentBlock,
  removeAgentsBlock,
  upsertAgentsBlock,
} from '../core/agentsBlockPlan';

export interface AgentsCommandOpts {
  print?: boolean;
  remove?: boolean;
  json?: boolean;
  /** Skip the confirm prompt for write/`--remove` — required to run either headless. */
  yes?: boolean;
  /** Same meaning as every other command's `--non-tty`: never prompt, even if stdin happens to be a TTY. */
  nonTty?: boolean;
  /** Report what write / `--remove` would change; touch no file and never prompt. */
  dryRun?: boolean;
}

export interface AgentsFileResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'removed' | 'absent';
}

const AGENTS_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Repo root: `git rev-parse --show-toplevel`, or `cwd` when not a git repo (or git isn't installed). */
export function resolveRepoRoot(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return top.length > 0 ? top : cwd;
}

/**
 * True when `path` doesn't exist yet (nothing to escape through — creating a
 * brand new regular file is always safe) or exists and resolves (through any
 * symlinks) to somewhere inside `root`'s own resolved path.
 */
function isInsideRoot(root: string, path: string): boolean {
  if (!existsSync(path)) return true;
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  return realPath === realRoot || realPath.startsWith(realRoot + sep);
}

/** Refuses (coded `AGENTS_FILE_OUTSIDE_REPO`) before any read/write through a file that escapes `root` via a symlink. */
function assertInsideRoot(root: string, path: string, name: string): void {
  if (isInsideRoot(root, path)) return;
  throw new CapyError(
    `${name} resolves outside this repo (through a symlink) — refusing to read or write through it.`, // COPY-FLAG
    ERROR_CODES.AGENTS_FILE_OUTSIDE_REPO,
  );
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** True when AGENTS.md or CLAUDE.md at `root` already carries the current block — used to skip the first-run prompt. Silently skips (never throws) a file that resolves outside `root`. */
export function agentsBlockAlreadyPresent(root: string): boolean {
  return AGENTS_FILE_NAMES.some((name) => {
    const path = join(root, name);
    if (!isInsideRoot(root, path)) return false;
    const content = readIfExists(path);
    return content !== null && hasCurrentBlock(content);
  });
}

function existingAgentsFileNames(root: string): string[] {
  return AGENTS_FILE_NAMES.filter((name) => existsSync(join(root, name)));
}

/** Which file(s) a write targets: whichever of AGENTS.md/CLAUDE.md exist; if neither exists, AGENTS.md only. */
function writeTargetFileNames(root: string): string[] {
  const existing = existingAgentsFileNames(root);
  return existing.length > 0 ? existing : ['AGENTS.md'];
}

function malformedError(name: string): CapyError {
  return new CapyError(
    `${name} has a malformed capy:agents marker pair — one marker without its match, or duplicates. Fix or remove them by hand, then re-run.`, // COPY-FLAG
    ERROR_CODES.AGENTS_BLOCK_MALFORMED,
  );
}

/**
 * Writes/updates the block into every write-target file at `root`. Throws a
 * coded `CapyError` — `AGENTS_BLOCK_MALFORMED` for a hand-edited marker pair,
 * `AGENTS_FILE_OUTSIDE_REPO` if the target resolves (via a symlink) outside
 * `root` — before touching that file; files already handled remain written
 * (each file's write is independent and idempotent, so a partial run is
 * always safe to re-run).
 */
export function writeAgentsBlock(root: string, apply = true): AgentsFileResult[] {
  return writeTargetFileNames(root).map((name) => {
    const path = join(root, name);
    assertInsideRoot(root, path, name);
    const existing = readIfExists(path);
    const result = upsertAgentsBlock(existing);
    if (!result.ok) throw malformedError(name);
    if (apply && result.action !== 'unchanged') {
      writeFileSync(path, result.content, 'utf-8');
    }
    return { path: name, action: result.action };
  });
}

/**
 * Removes the block from every AGENTS.md/CLAUDE.md that currently exists at
 * `root`. A file left EXACTLY empty by the removal — i.e. it held nothing
 * but the block Capy itself put there, byte for byte — is deleted rather
 * than left behind as a clutter file. Anything merely whitespace-only (a
 * blank line or two survives, but the file isn't literally empty) is kept:
 * that whitespace came from the file's own surrounding content, not from
 * Capy, and deleting a file on a fuzzy "looks blank" guess is not this
 * command's call to make.
 */
export function removeAgentsBlockFromFiles(root: string, apply = true): AgentsFileResult[] {
  return existingAgentsFileNames(root).map((name) => {
    const path = join(root, name);
    assertInsideRoot(root, path, name);
    const existing = readFileSync(path, 'utf-8');
    const result = removeAgentsBlock(existing);
    if (!result.ok) throw malformedError(name);
    if (apply && result.action === 'removed') {
      if (result.content.length === 0) {
        unlinkSync(path);
      } else {
        writeFileSync(path, result.content, 'utf-8');
      }
    }
    return { path: name, action: result.action };
  });
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * `unanswered` names the one stop a flag could have settled — `--yes` — in
 * the same shape `capy remove`/`capy system rm` spread onto a coded refusal
 * (`CapyError`'s `details`), so an agent parsing this refusal finds the exact
 * flag to retry with instead of guessing from the prose.
 */
function refuseNeedsTty(json: boolean): never {
  const message = '`capy agents` needs a terminal to confirm a write. Pass --yes to skip the prompt, or run `capy agents --print` to see the block without writing anything.'; // COPY-FLAG
  if (json) {
    printJson({
      ok: false,
      code: ERROR_CODES.AGENTS_SETUP_NEEDS_TTY,
      error: message,
      unanswered: [{ id: 'confirm', flag: '--yes' }],
    });
  } else {
    console.error(`\n  ${message}\n`);
  }
  process.exit(EXIT_NEEDS_INPUT);
}

/** Refuses on any coded `CapyError` thrown while touching a file — malformed markers, a symlink outside the repo, or the like. */
function refuseCapyError(err: CapyError, json: boolean): never {
  if (json) {
    printJson({ ok: false, code: err.code, error: err.message });
  } else {
    console.error(`\n  ${err.message}\n`);
  }
  process.exit(1);
}

function actionLabel(action: AgentsFileResult['action'], removedVerb: string): string {
  if (action === 'created') return 'Created';
  if (action === 'updated') return 'Updated';
  if (action === 'removed') return removedVerb;
  if (action === 'unchanged') return 'Already up to date:';
  return 'No Capy section in';
}

function reportHuman(files: AgentsFileResult[], removedVerb = 'Removed the Capy section from'): void {
  if (files.length === 0) {
    console.log('No AGENTS.md or CLAUDE.md found in this repo.'); // COPY-FLAG
    return;
  }
  for (const file of files) {
    console.log(`${actionLabel(file.action, removedVerb)} ${file.path}`); // COPY-FLAG
  }
}

function dryRunLabel(action: AgentsFileResult['action']): string {
  if (action === 'created') return 'Would create';
  if (action === 'updated') return 'Would update';
  if (action === 'removed') return 'Would remove the Capy section from';
  if (action === 'unchanged') return 'Already up to date:';
  return 'No Capy section in';
}

/**
 * `--dry-run`: runs the same plan as the real write / `--remove` (same files,
 * same malformed-marker and symlink refusals) with `apply` off, so nothing is
 * written or deleted. Never prompts, so it works without a TTY and without
 * `--yes`.
 */
function previewChanges(root: string, remove: boolean, json: boolean): void {
  try {
    const files = remove ? removeAgentsBlockFromFiles(root, false) : writeAgentsBlock(root, false);
    if (json) {
      printJson({ ok: true, dry_run: true, files });
      return;
    }
    if (files.length === 0) {
      console.log('No AGENTS.md or CLAUDE.md found in this repo.'); // COPY-FLAG
      return;
    }
    for (const file of files) {
      console.log(`${dryRunLabel(file.action)} ${file.path}`); // COPY-FLAG
    }
    console.log('Dry run: nothing was changed.'); // COPY-FLAG
  } catch (err) {
    if (err instanceof CapyError) refuseCapyError(err, json);
    throw err;
  }
}

/** `capy agents --print`: the block to stdout. No writes, works without a TTY. `--json` wraps it as `{ok:true, block}` so stdout stays parseable JSON instead of raw markdown. */
function printBlock(json: boolean): void {
  if (json) {
    printJson({ ok: true, block: AGENTS_BLOCK });
    return;
  }
  console.log(AGENTS_BLOCK);
}

/**
 * Under `--json`, stdout must stay pure JSON — so the confirm prompt (there
 * IS a terminal, or we'd already have refused) renders to stderr instead.
 * Mirrors `promptModuleFor` in systemCommand.ts.
 */
function promptModuleFor(json: boolean): typeof inquirer.prompt {
  return json ? inquirer.createPromptModule({ output: process.stderr }) : inquirer.prompt;
}

async function confirmWrite(json: boolean): Promise<boolean> {
  const { confirmed } = await promptModuleFor(json)([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Tell AI coding agents in this repo how to use Capy? This adds a short section to AGENTS.md / CLAUDE.md.', // COPY-FLAG (verbatim, spec-approved)
      default: true,
    },
  ]);
  return confirmed === true;
}

async function confirmRemove(json: boolean): Promise<boolean> {
  const { confirmed } = await promptModuleFor(json)([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Remove the Capy section from AGENTS.md / CLAUDE.md in this repo?', // COPY-FLAG — wording not spec-approved, confirm with Vince
      default: false,
    },
  ]);
  return confirmed === true;
}

/**
 * The one extra prompt `capy` (first-run init) offers at the very end of a
 * successful run — see capyCommand.ts. TTY only, asked at most once per run,
 * skipped entirely if the block is already set up. Never throws: a failure
 * writing an unrelated doc file must not turn a successful `capy init` into
 * a failed one.
 */
export async function offerAgentsSetupAfterInit(): Promise<void> {
  if (!isInteractive()) return;
  try {
    const root = resolveRepoRoot(process.cwd());
    if (agentsBlockAlreadyPresent(root)) return;
    const confirmed = await confirmWrite(false);
    if (!confirmed) return;
    const files = writeAgentsBlock(root);
    // Write-path actions are only ever 'created' | 'updated' | 'unchanged'
    // (see UpsertAction in agentsBlockPlan.ts) — actionLabel's 'removed'
    // branch never fires here, so no removedVerb override is needed.
    reportHuman(files);
  } catch {
    // Best-effort: init already succeeded: never let this follow-up fail the command.
  }
}

export async function agentsCommand(opts: AgentsCommandOpts): Promise<void> {
  const json = opts.json === true;

  if (opts.print) {
    printBlock(json);
    return;
  }

  const root = resolveRepoRoot(process.cwd());

  if (opts.dryRun) {
    previewChanges(root, opts.remove === true, json);
    return;
  }

  if (opts.remove) {
    if (!opts.yes && !isInteractive(opts.nonTty)) refuseNeedsTty(json);
    const confirmed = opts.yes === true || (await confirmRemove(json));
    if (!confirmed) {
      if (json) printJson({ ok: false, code: ERROR_CODES.CANCELLED, error: 'Cancelled.' });
      else console.log('Cancelled.'); // COPY-FLAG
      return;
    }
    try {
      const files = removeAgentsBlockFromFiles(root);
      if (json) {
        printJson({ ok: true, files });
        return;
      }
      reportHuman(files, 'Removed the Capy section from');
    } catch (err) {
      if (err instanceof CapyError) refuseCapyError(err, json);
      throw err;
    }
    return;
  }

  // Default mode: write/update.
  if (!opts.yes && !isInteractive(opts.nonTty)) refuseNeedsTty(json);
  const confirmed = opts.yes === true || (await confirmWrite(json));
  if (!confirmed) {
    if (json) printJson({ ok: false, code: ERROR_CODES.CANCELLED, error: 'Cancelled.' });
    else console.log('Cancelled.'); // COPY-FLAG
    return;
  }
  try {
    const files = writeAgentsBlock(root);
    if (json) {
      printJson({ ok: true, files });
      return;
    }
    // See the write-path note above offerAgentsSetupAfterInit's own write:
    // action here is never 'removed', so no removedVerb override is needed.
    reportHuman(files);
  } catch (err) {
    if (err instanceof CapyError) refuseCapyError(err, json);
    throw err;
  }
}
