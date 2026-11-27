/**
 * `capy setup` (CAP-891): the one command an agent runs to set a folder up with Capy.
 *
 * It runs the steps that exist already, in order, and stops at the first one that needs the human:
 *   1. Pair: `capy pair` in agent mode (the link, the wait, the one-time code Keep shows).
 *   2. Folder: bare `capy` in agent mode (organization, project, first branch).
 *   3. Agent instructions: the Capy block in AGENTS.md / CLAUDE.md.
 *   4. Pre-discovery: the integrations the folder shows signs of, and the next command for each (`core/preDiscovery.ts`).
 *
 * Every stop is the step's own coded refusal, with its elicitation unchanged except for the command to run next, which
 * names `capy setup` so the agent keeps running one command. Running it again is always safe: a step that is done is
 * skipped. It always answers in JSON and never prompts.
 *
 * The steps are injected (`SetupDeps`), so the order and the rewriting are tested without a network.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { readPendingPairGrant } from '../auth/pairing/pendingGrant';
import { isLocalOnly } from '../config/profileConfig';
import { preDiscover, type Integration } from '../core/preDiscovery';
import { FileManager } from '../files/fileManager';
import { ERROR_CODES, type CliOptions, type SetupOptions } from '../types/index';
import type { AgentOutcome } from './agentSetup';
import { resolveRepoRoot, writeAgentsBlock, type AgentsFileResult } from './agentsCommand';
import { binName } from './binName';
import type { PairAgentOutcome } from './pairAgentCommand';
import { refusalFor } from './projectLifecycleCommand';
import { refuse, settle, type Refusal } from './refusal';

export interface SetupCommandOptions {
  /** `--code`: the one-time code Keep showed the person who approved the pairing. */
  readonly code?: string;
  /** The answers to the folder questions, as typed (`--folder`, `--org`, `--project`, `--name`, `--branch`, `--protected`, `--share-setup`). */
  readonly answers: FolderAnswers;
  readonly envPath?: string;
  readonly dryRun?: boolean;
  readonly devMode?: boolean;
  readonly apiUrl?: string;
}

/** The folder as it stands when it is a Capy project already. */
export interface LinkedFolder {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly activeBranch: string | null;
  /** The first branch of a setup of this folder that stopped half way, when its marker is still there. */
  readonly pendingSetup?: { readonly branch: string; readonly protected: boolean };
}

export type FolderAnswers = Pick<SetupOptions, 'org' | 'project' | 'name' | 'branch' | 'protectedAnswer' | 'shareAnswer' | 'folder'>;

export type FolderOutcome = AgentOutcome | { readonly kind: 'sync'; readonly ignoredFlags?: readonly string[] } | undefined;

/** `waiting`: a pairing started on this machine can still be approved. `expired`: its link has run out. */
export type PendingPair = 'none' | 'waiting' | 'expired';

export interface SetupDeps {
  /** Whether the active profile is local-only: no organization and no server, so there is nothing to set up against. */
  readonly localOnly: () => boolean;
  readonly pendingPair: () => PendingPair;
  /** Agent-mode `capy pair`: `wait` polls the pending pairing (with the code, when there is one); otherwise a new one starts. */
  readonly pair: (step: { readonly wait: boolean; readonly code?: string; readonly noRenew?: boolean }) => Promise<PairAgentOutcome>;
  /** Agent-mode bare `capy`, with the answers that were typed, or with `answers` in their place. */
  readonly folder: (answers?: FolderAnswers) => Promise<FolderOutcome>;
  readonly linked: () => Promise<LinkedFolder>;
  /** The refusal when nobody is signed in (for `orgId`, when the folder names one); undefined when someone is. Never a browser. */
  readonly session: (orgId: string | undefined) => Promise<Refusal | undefined>;
  /** Writes the Capy block (or, with `apply` false, reports what it would write). */
  readonly agentsFiles: (apply: boolean) => readonly AgentsFileResult[];
  readonly integrations: () => readonly Integration[];
}

type Outcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly result: Readonly<Record<string, unknown>> };

const refusal = (r: Refusal): Outcome => ({ kind: 'refusal', refusal: r });

/**
 * A step's "run this next" as the `capy setup` run that does the same: the pairing wait, the pairing code, a new
 * pairing, and the folder answers. Anything else is left as it is.
 */
export function asSetupCommand(command: string, bin: string): string {
  if (command.startsWith(`${bin} pair --wait --code `)) return `${bin} setup --code ${command.slice(`${bin} pair --wait --code `.length)} --json`;
  if (command === `${bin} pair --wait`) return `${bin} setup --json`;
  // CAP-913: starting again after the last link expired is setup again, which starts a new pairing when signed out.
  if (command === `${bin} pair --json`) return `${bin} setup --json`;
  if (command.startsWith(`${bin} -`)) return `${bin} setup ${command.slice(bin.length + 1)}`;
  return command;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal with the commands of its elicitation's `answer` rewritten to `capy setup`. */
export function forSetup(r: Refusal, bin: string): Refusal {
  const elicitation = r.extra?.elicitation;
  if (!isRecord(elicitation) || !isRecord(elicitation.answer)) return r;
  const answer = Object.fromEntries(
    Object.entries(elicitation.answer).map(([key, value]) => [key, typeof value === 'string' ? asSetupCommand(value, bin) : value]),
  );
  return { ...r, extra: { ...r.extra, elicitation: { ...elicitation, answer } } };
}

/** Whether the folder step stopped only because nobody is signed in and pairing is the way in. */
function needsPairing(r: Refusal): boolean {
  return r.code === ERROR_CODES.AUTH_FAILED && typeof r.extra?.next_command === 'string';
}

/** Not signed in, and this run starts no pairing: the same refusal, pointing at `capy setup` instead of `capy pair`. */
function notPaired(r: Refusal, bin: string, dryRun: boolean): Refusal {
  return {
    ...r,
    message: dryRun
      ? `Not signed in. A dry run starts no pairing: run \`${bin} setup --json\` to pair.` // COPY-FLAG
      : `Still not signed in after pairing. Run \`${bin} setup --json\` again.`, // COPY-FLAG
    extra: { ...r.extra, next_command: `${bin} setup --json` },
  };
}

function linkedResult(folder: LinkedFolder, ignoredFlags: readonly string[], bin: string, dryRun: boolean): Readonly<Record<string, unknown>> {
  return {
    created: false,
    already_set_up: true,
    org: { id: folder.organizationId ?? null },
    project: { id: folder.projectId ?? null, name: folder.projectName ?? null },
    branch: { name: folder.activeBranch, protected: null },
    ...(ignoredFlags.length === 0 ? {} : { ignored_flags: ignoredFlags }),
    // Setup links and reports; it does not sync. Bare `capy` brings the folder's variables up to date.
    ...(dryRun ? {} : { next: `${bin} --json` }),
  };
}

/** Steps 3 and 4, once the folder is a project: the agent instructions and the integrations. */
async function finish(options: SetupCommandOptions, deps: SetupDeps, folder: Readonly<Record<string, unknown>>): Promise<Outcome> {
  const dryRun = options.dryRun === true;
  const files = await settle(async () => deps.agentsFiles(!dryRun));
  if (!files.ok) return refusal(refusalFor(files.error));
  const { ok: _ok, dry_run: _dryRun, ...rest } = folder;
  return {
    kind: 'done',
    result: {
      ok: true,
      setup: dryRun ? 'dry_run' : 'complete',
      ...rest,
      agents_files: files.value,
      integrations: deps.integrations(),
    },
  };
}

/** Where a run is: whether it may still pair, and whether it has already picked a half-finished setup back up. */
interface Progress {
  readonly mayPair: boolean;
  readonly resumed: boolean;
}

/** Nobody is signed in: pairing comes first, then the folder again. A dry run changes nothing, so it starts no pairing. */
async function pairThenFolder(options: SetupCommandOptions, deps: SetupDeps, signedOut: Refusal, progress: Progress): Promise<Outcome> {
  const bin = binName(options.devMode === true);
  if (!needsPairing(signedOut)) return refusal(forSetup(signedOut, bin));
  if (!progress.mayPair || options.dryRun === true) return refusal(notPaired(signedOut, bin, options.dryRun === true));
  // A pairing that is waiting is waited on, and one whose link ran out is renewed by that wait; a second one never starts beside it.
  const paired = await deps.pair({ wait: deps.pendingPair() !== 'none' });
  return paired.kind === 'refusal' ? refusal(forSetup(paired.refusal, bin)) : folderStep(options, deps, { ...progress, mayPair: false });
}

/**
 * The folder is linked to a project already. That alone is not "set up": this machine may never have been paired, and
 * an earlier setup may have stopped after the project was created. Both are settled before anything is written.
 */
async function linkedStep(options: SetupCommandOptions, deps: SetupDeps, progress: Progress, ignoredFlags: readonly string[]): Promise<Outcome> {
  const state = await deps.linked();
  const signedOut = await deps.session(state.organizationId);
  if (signedOut !== undefined) return pairThenFolder(options, deps, signedOut, progress);
  const pending = state.pendingSetup;
  if (pending !== undefined && state.projectName !== undefined && !progress.resumed) {
    // The answers are the ones the human gave to the run that stopped; the folder kept them.
    const again = await deps.folder({ ...options.answers, name: state.projectName, branch: pending.branch, protectedAnswer: pending.protected ? 'yes' : 'no' });
    return afterFolder(options, deps, again, { ...progress, resumed: true });
  }
  return finish(options, deps, linkedResult(state, ignoredFlags, binName(options.devMode === true), options.dryRun === true));
}

async function afterFolder(options: SetupCommandOptions, deps: SetupDeps, folder: FolderOutcome, progress: Progress): Promise<Outcome> {
  if (folder === undefined) {
    return refusal({ code: ERROR_CODES.SERVICE_ERROR, message: 'This folder cannot be set up here.', exitCode: 1 }); // COPY-FLAG
  }
  if (folder.kind === 'sync') return linkedStep(options, deps, progress, folder.ignoredFlags ?? []);
  if (folder.kind === 'done') return finish(options, deps, folder.result);
  return pairThenFolder(options, deps, folder.refusal, progress);
}

async function folderStep(options: SetupCommandOptions, deps: SetupDeps, progress: Progress): Promise<Outcome> {
  return afterFolder(options, deps, await deps.folder(), progress);
}

/** What `capy setup` ends with: the stop of the first step that needs the human, or the finished setup. */
export async function setupOutcome(options: SetupCommandOptions, deps: SetupDeps): Promise<Outcome> {
  const bin = binName(options.devMode === true);
  // Before any step: a linked folder would otherwise reach the pairing start, which local-only mode never allows.
  if (deps.localOnly()) {
    return refusal({ code: ERROR_CODES.SERVICE_ERROR, message: `\`${bin} setup\` is disabled in local-only mode: there is no organization or server to set up against.`, exitCode: 1 }); // COPY-FLAG
  }
  const code = options.code?.trim() || undefined;
  // A code means the person has just approved a pairing: finish that one first, even when its link ran out on this
  // machine's clock, since the service may still hold the approval (CAP-902); the service decides. With no pairing
  // pending the code has been used already (a rerun), and the folder step says whether pairing is still needed.
  const pending = deps.pendingPair();
  if (code !== undefined && options.dryRun !== true && pending !== 'none') {
    // A pairing that ran out locally is not renewed here: someone may be signed in already. If the service says it is
    // gone, it is dropped and the folder step decides, starting a new pairing only when nobody is signed in.
    const paired = await deps.pair({ wait: true, code, ...(pending === 'expired' ? { noRenew: true } : {}) });
    const gone = pending === 'expired' && paired.kind === 'refusal' && paired.refusal.code === ERROR_CODES.PAIR_EXPIRED;
    if (paired.kind === 'refusal' && !gone) return refusal(forSetup(paired.refusal, bin));
  }
  return folderStep(options, deps, { mayPair: true, resumed: false });
}

function realDeps(options: SetupCommandOptions): SetupDeps {
  const devMode = options.devMode === true;
  const setup: SetupOptions = { ...options.answers, json: true, nonTty: true, agentMode: true };
  const cliOptions: CliOptions = { envPath: options.envPath, dryRun: options.dryRun, protocol: true, setup };
  return {
    localOnly: () => isLocalOnly(),
    pendingPair: () => {
      const grant = readPendingPairGrant();
      if (grant === null) return 'none';
      return Date.now() < Date.parse(grant.expiresAt) ? 'waiting' : 'expired';
    },
    pair: async (step) => {
      const { pairAgentOutcome } = await import('./pairAgentCommand');
      return pairAgentOutcome({ json: true, wait: step.wait, code: step.code, noRenew: step.noRenew, devMode, ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }) });
    },
    folder: async (answers) => {
      const { CapyCommand } = await import('./capyCommand');
      const withAnswers: CliOptions = answers === undefined ? cliOptions : { ...cliOptions, setup: { ...answers, json: true, nonTty: true, agentMode: true } };
      return new CapyCommand(withAnswers, devMode).folderSetupOutcome();
    },
    linked: async () => {
      const { CapyCommand } = await import('./capyCommand');
      return new CapyCommand(cliOptions, devMode).linkedFolder();
    },
    session: async (orgId) => {
      const { CapyCommand } = await import('./capyCommand');
      return new CapyCommand(cliOptions, devMode).signedOutRefusal(orgId);
    },
    agentsFiles: (apply) => writeAgentsBlock(resolveRepoRoot(process.cwd()), apply),
    integrations: () => {
      const envNames = namesOrNone(() => Object.keys(new FileManager().readEnvFile(options.envPath)));
      return preDiscover({
        exists: (relativePath) => existsSync(join(process.cwd(), relativePath)),
        envNames,
        envIsSet: (name) => (process.env[name] ?? '') !== '',
        bin: binName(devMode),
      });
    },
  };
}

/** The names, or none when the `.env` cannot be read: pre-discovery is a hint and never fails setup. */
function namesOrNone(names: () => readonly string[]): readonly string[] {
  try {
    return names();
  } catch {
    return [];
  }
}

/** `capy setup`. The outcome is computed first and printed after; stdout is only ever the one JSON object. */
export async function setupCommand(options: SetupCommandOptions, deps: SetupDeps = realDeps(options)): Promise<void> {
  const settled = await settle(() => setupOutcome(options, deps));
  const outcome: Outcome = settled.ok ? settled.value : refusal(refusalFor(settled.error));
  if (outcome.kind === 'refusal') return refuse(true, outcome.refusal);
  console.log(JSON.stringify(outcome.result, null, 2));
}
