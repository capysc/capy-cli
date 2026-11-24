import type { Command } from 'commander';
import { DRY_RUN_COMMANDS } from './cliHelpDoc';

/**
 * The global `-d/--dry-run` promises "preview changes without applying". A
 * command either honors that (it is in DRY_RUN_COMMANDS: it previews, or
 * refuses the parts it cannot preview), only reads (so running it changes
 * nothing), or is refused here, before its handler runs. Before this, the
 * rest ignored the flag and did the real thing: `capy checkout x --dry-run`
 * switched branches, `capy kick a@b.c --dry-run` removed the teammate.
 */

/** Commands that only read, by path. A dry run of them is the command itself. */
const READ_ONLY: Readonly<Record<string, (opts: Record<string, unknown>) => boolean>> = {
  help: () => true,
  status: () => true,
  info: () => true,
  list: () => true,
  profile: () => true,
  'profile list': () => true,
  'profile show': () => true,
  'deploy list': () => true,
  'deploy targets': () => true,
  // `capy branch -D <name>` deletes a branch; plain `capy branch` lists them.
  branch: (opts) => opts.D === undefined,
  // Lists projects. Its interactive screen's actions (rename, delete, users) take the dry run themselves
  // (ui/projectsScreenDriver.ts), so the flag is passed through rather than refused.
  projects: () => true,
  // The interactive screen can change roles, invite, kick and grant access; `--json` only lists.
  users: (opts) => opts.json === true,
};

/** `deploy targets-remove`: the command's names from the root down, without the root's own name. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

/**
 * Why `--dry-run` cannot run this command, or undefined when it can. The root
 * (bare `capy`) is decided by CapyCommand, which previews a sync but cannot
 * preview first-time setup.
 */
export function dryRunRefusal(path: string, opts: Record<string, unknown>): string | undefined {
  if (path === '' || DRY_RUN_COMMANDS.has(path)) return undefined;
  const readOnly = READ_ONLY[path];
  if (readOnly?.(opts)) return undefined;
  if (path === 'run') {
    return "--dry-run isn't available for capy run. To pass --dry-run to your own command, put it after --: capy run -- <cmd> --dry-run. Nothing was run."; // COPY-FLAG
  }
  return `--dry-run isn't available for capy ${path}: it can't preview, and would make the change for real. Nothing was changed.`; // COPY-FLAG
}
