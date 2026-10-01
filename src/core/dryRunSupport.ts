/**
 * CAP-659 Phase 1 — "stop the silent ignore".
 *
 * One table decides what `--dry-run` does for every Commander command this
 * CLI registers: run normally (`read_only`), run the command's own
 * already-safe preview path (`preview`), or refuse before the action runs
 * at all (`unsupported`). `src/index.ts`'s `preAction` guard is the only
 * caller that matters at runtime — `resolveDryRunSupport` is what it asks.
 *
 * Phase 1 marks ONLY CAP-659's Group A (read-only commands) as `read_only`.
 * Every other registered command is `unsupported` for now, including the
 * `deploy` token path and bare `capy` (closes the CAP-412 harm). Phase 2/3
 * flip commands to `preview` as each one grows a real, no-write preview —
 * never by widening this file alone; the command's own code has to build
 * the plan first (see CAP-659 "How to build it", point 4).
 *
 * This file intentionally knows nothing about Commander's `Command` beyond
 * the plain path strings it hands back to callers — `dryRunCommandPaths`
 * (the coverage-test helper) is the one function that reads a real program.
 */
import type { Command } from 'commander';

export type DryRunSupportLevel = 'read_only' | 'preview' | 'unsupported';

/**
 * Sentinel path for the bare root command (`capy` with no subcommand).
 * Never an empty subcommand name — Commander's own paths are always
 * non-empty, so `''` can't collide with a real one.
 */
export const ROOT_COMMAND_PATH = '';

/**
 * Bare parent commands with no action of their own — Commander dispatches
 * `capy profile` / `capy system` straight to `--help` without ever
 * reaching a `preAction` hook, so they need (and have) no table entry.
 * `capy help --json` still lists them, since that doc describes the whole
 * tree for a human/agent; this set is the documented reconciliation the
 * coverage test uses to tell "no entry because nothing can run" apart from
 * "missing entry, which is a bug."
 */
export const KNOWN_ACTIONLESS_PARENT_PATHS: ReadonlySet<string> = new Set(['profile', 'system']);

/**
 * Every invocable command path on the real CLI, current as of capy-cli
 * `main` (CAP-659 was written against a later `onboarding` branch with
 * extra commands — `setup`, `sync`, `doctor`, `doors`, `device-key`,
 * `flow` — none of which exist here yet; they'll need entries, and the
 * coverage test will fail until they have them, when that branch merges).
 * `agents`, `system *`, `projects`, `secrets` and the bare `remove` don't
 * appear in CAP-659's own command grid either — they shipped after the
 * ticket was written (CAP-681, CAP-664, CAP-686) — so their level below is
 * this builder's judgment call, not a line lifted from the ticket.
 *
 * `deploy`, `connect` and `branch` are overridden below: each is one
 * Commander path whose actual two modes have different write behavior, so
 * a single literal can't describe it (see `resolveDryRunSupport`). Their
 * table value here is the conservative baseline the override only ever
 * loosens with hard structural evidence, never tightens past.
 */
export const COMMAND_DRY_RUN_SUPPORT: ReadonlyMap<string, DryRunSupportLevel> = new Map([
  // Bare `capy` — first run inits/adopts a project and pushes; later runs
  // sync. Both are real writes today, and the flag is read nowhere
  // (CAP-412). Refusing here is what stops that harm.
  [ROOT_COMMAND_PATH, 'unsupported'],

  // --- Group A (CAP-659): read-only today, dry run runs it as normal ---
  ['status', 'read_only'],
  ['help', 'read_only'],
  ['info', 'read_only'],
  ['list', 'read_only'],
  ['users', 'read_only'],
  ['deploy list', 'read_only'],
  ['deploy targets', 'read_only'],
  ['profile list', 'read_only'],
  ['profile show', 'read_only'],
  // `branch` (no `-D`) lists + offers a switch — Group A. `-D` deletes a
  // branch and every secret on it (Group D); the override below tightens
  // to `unsupported` for that case rather than reaching the still-real
  // inquirer confirm a dry run should never get to.
  ['branch', 'read_only'],

  // --- Not in CAP-659's grid (shipped after the ticket); read-only by code
  // inspection — list/show only, no write call in their command class ---
  ['projects', 'read_only'],
  ['secrets', 'read_only'],
  ['system list', 'read_only'],

  // --- Everything else: unsupported for now (Phase 2/3 build real previews) ---
  ['run', 'unsupported'],
  ['edit', 'unsupported'],
  ['checkout', 'unsupported'],
  ['push', 'unsupported'],
  // CAP-659 Phase 2: both routes `deploy` can take now preview — see
  // `resolveDeploySupport`'s override below, which no longer distinguishes
  // target mode from the token+docs picker (both build a real, no-write
  // preview before anything is minted, authenticated, or written).
  ['deploy', 'preview'],
  // CAP-659 Phase 2: previews (which token; `reversible: false`), revokes nothing.
  ['deploy revoke', 'preview'],
  // CAP-659 Phase 2: previews (what would be stripped/revoked/removed), changes nothing.
  ['deploy targets-remove', 'preview'],
  ['logout', 'unsupported'],
  ['byoc', 'unsupported'],
  ['use', 'unsupported'],
  ['profile remove', 'unsupported'],
  // The CAP-659 repro: removes the Capy block from git hooks today under
  // `--dry-run`. Phase 1's headline fix.
  ['cleanup', 'unsupported'],
  ['agents', 'unsupported'],
  ['invite', 'unsupported'],
  ['redeem', 'unsupported'],
  ['transport', 'unsupported'],
  ['pair', 'unsupported'],
  ['kick', 'unsupported'],
  ['system set', 'unsupported'],
  ['system rm', 'unsupported'],
  ['org', 'unsupported'],
  ['grant-branch', 'unsupported'],
  ['revoke-branch', 'unsupported'],
  ['decrypt', 'unsupported'],
  ['end-recover', 'unsupported'],
  ['recover', 'unsupported'],
  ['add', 'unsupported'],
  ['remove', 'unsupported'],
  // Default mode pairs with a provider and may push — doesn't read
  // `--dry-run` at all outside the Dokploy import/discover path. The
  // override loosens to `read_only` only when no provider was given at
  // all (verified listing, Group A).
  ['connect', 'unsupported'],
  ['rotate', 'unsupported'],
  ['lock', 'unsupported'],
]);

/**
 * What the invoked command's own, locally-declared options and positional
 * arguments looked like at `preAction` time — `actionCommand.opts()` and
 * `actionCommand.args`, never `optsWithGlobals()` (which would hand back
 * the root's shadowed `--dry-run` instead of this command's own flags; see
 * CAP-659's note on Commander 11 and doubly-declared options).
 */
export interface DryRunOverrideContext {
  readonly opts: Readonly<Record<string, unknown>>;
  readonly args: readonly string[];
}

const NO_OVERRIDE_CONTEXT: DryRunOverrideContext = { opts: {}, args: [] };

/**
 * `deploy [target]` routes to target mode exactly when `src/index.ts`'s own
 * action does: `--target`, `--connect`, or a positional target; anything
 * else is the token+docs picker. CAP-659 Phase 1 refused the picker route
 * (it ignored `--dry-run` entirely and could mint a live token) — Phase 2
 * gave it a real preview too (`DeployCommand#execute` in
 * `deployTokenCommand.ts`: describes the platform/mode route, reports the
 * mint it would make, never authenticates or writes `.capy/config`). Both
 * routes preview now; kept as an explicit function (rather than folded into
 * the flat table) because the TWO routes still build their preview very
 * differently, not because the levels differ.
 */
function resolveDeploySupport(_ctx: DryRunOverrideContext): DryRunSupportLevel {
  return 'preview';
}

/**
 * `connect [provider]` with no provider lists providers (Group A) —
 * `connect <provider>` pairs with one and may push, and today ignores
 * `--dry-run` outside the Dokploy import/discover path. Phase 1 leaves the
 * provider case `unsupported` and only loosens to `read_only` when the
 * positional `provider` argument is structurally absent.
 */
function resolveConnectSupport(ctx: DryRunOverrideContext): DryRunSupportLevel {
  return ctx.args.length > 0 ? 'unsupported' : 'read_only';
}

/**
 * `branch` lists (Group A) — `branch -D <name>` deletes the branch and
 * every secret on it behind an inquirer confirm a person could mistake for
 * a preview (CAP-659). Tightens to `unsupported` whenever `-D` was given.
 */
function resolveBranchSupport(ctx: DryRunOverrideContext): DryRunSupportLevel {
  return ctx.opts.D ? 'unsupported' : 'read_only';
}

const OVERRIDES: ReadonlyMap<string, (ctx: DryRunOverrideContext) => DryRunSupportLevel> = new Map([
  ['deploy', resolveDeploySupport],
  ['connect', resolveConnectSupport],
  ['branch', resolveBranchSupport],
]);

/**
 * The one function the `preAction` guard calls. Looks up `path`'s override
 * first (a handful of commands whose level depends on the invocation, not
 * just the path), then falls back to the flat table. `undefined` means the
 * path has no entry at all — the guard treats that as `unsupported` too
 * (never silently lets an unmapped command through), and the coverage test
 * below is what should catch a missing entry long before that matters.
 */
export function resolveDryRunSupport(
  path: string,
  ctx: DryRunOverrideContext = NO_OVERRIDE_CONTEXT,
): DryRunSupportLevel | undefined {
  const override = OVERRIDES.get(path);
  if (override) return override(ctx);
  return COMMAND_DRY_RUN_SUPPORT.get(path);
}

/** Commander has no public getter for "this command has its own `.action()`
 * handler" as opposed to a bare parent that only dispatches to subcommands
 * (`profile`, `system`) — `._actionHandler` is the only signal, the same
 * internal-field pattern `cliHelpDoc.ts` already uses for `._hidden`. A
 * parent with no action of its own can never run anything under
 * `--dry-run`: Commander prints its help and exits before any `preAction`
 * hook fires, so it needs no entry in the support table at all. */
function hasOwnAction(cmd: Command): boolean {
  return (cmd as unknown as { _actionHandler: unknown })._actionHandler !== null;
}

function collectCommandPaths(cmd: Command, parentPath: string): readonly string[] {
  const path = parentPath ? `${parentPath} ${cmd.name()}` : cmd.name();
  const ownPath = hasOwnAction(cmd) ? [path] : [];
  const childPaths = cmd.commands.flatMap((child) => collectCommandPaths(child, path));
  return [...ownPath, ...childPaths];
}

/**
 * Every invocable command path on `program` — hidden commands included
 * (unlike `buildCliHelpDoc`, which exists to describe the CLI to a human or
 * agent and deliberately leaves hidden ones out). The bare root is
 * `ROOT_COMMAND_PATH`; everything else is the Commander-registered,
 * space-joined path. This is the coverage test's one source of truth for
 * "what commands actually exist" — never a hand-maintained list that could
 * drift from `src/index.ts`.
 */
export function dryRunCommandPaths(program: Command): readonly string[] {
  const rootPath = hasOwnAction(program) ? [ROOT_COMMAND_PATH] : [];
  const subPaths = program.commands.flatMap((cmd) => collectCommandPaths(cmd, ''));
  return [...rootPath, ...subPaths];
}
