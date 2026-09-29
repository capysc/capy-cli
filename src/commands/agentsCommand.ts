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
export function writeAgentsBlock(root: string): AgentsFileResult[] {
  return writeTargetFileNames(root).map((name) => {
    const path = join(root, name);
    assertInsideRoot(root, path, name);
    const existing = readIfExists(path);
    const result = upsertAgentsBlock(existing);
    if (!result.ok) throw malformedError(name);
    if (result.action !== 'unchanged') {
      writeFileSync(path, result.content, 'utf-8');
    }
    return { path: name, action: result.action };
  });
}

/**
 * Removes the block from every AGENTS.md/CLAUDE.md that currently exists at
 * `root`. A file whose content is empty or whitespace-only once the block is
 * gone — i.e. the file held nothing but the block Capy itself put there — is
 * deleted rather than left behind as clutter.
 */
export function removeAgentsBlockFromFiles(root: string): AgentsFileResult[] {
  return existingAgentsFileNames(root).map((name) => {
    const path = join(root, name);
    assertInsideRoot(root, path, name);
    const existing = readFileSync(path, 'utf-8');
    const result = removeAgentsBlock(existing);
    if (!result.ok) throw malformedError(name);
    if (result.action === 'removed') {
      if (result.content.trim().length === 0) {
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

function refuseNeedsTty(json: boolean): never {
  const message = '`capy agents` needs a terminal to confirm a write. Run `capy agents --print` to see the block without writing anything.'; // COPY-FLAG
  if (json) {
    printJson({ ok: false, code: ERROR_CODES.AGENTS_SETUP_NEEDS_TTY, error: message });
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

function reportHuman(files: AgentsFileResult[], removedVerb: string): void {
  if (files.length === 0) {
    console.log('No AGENTS.md or CLAUDE.md found in this repo.'); // COPY-FLAG
    return;
  }
  for (const file of files) {
    console.log(`${actionLabel(file.action, removedVerb)} ${file.path}`); // COPY-FLAG
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
    reportHuman(files, 'Removed');
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

  if (opts.remove) {
    if (!isInteractive()) refuseNeedsTty(json);
    const confirmed = await confirmRemove(json);
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
  if (!isInteractive()) refuseNeedsTty(json);
  const confirmed = await confirmWrite(json);
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
    reportHuman(files, 'Removed');
  } catch (err) {
    if (err instanceof CapyError) refuseCapyError(err, json);
    throw err;
  }
}
