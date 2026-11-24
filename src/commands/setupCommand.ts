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
  /** The answers to the folder questions, as typed (`--org`, `--project`, `--name`, `--branch`, `--protected`). */
  readonly answers: Pick<SetupOptions, 'org' | 'project' | 'name' | 'branch' | 'protectedAnswer'>;
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
}

export type FolderOutcome = AgentOutcome | { readonly kind: 'sync' } | undefined;

export interface SetupDeps {
  /** Whether a pairing started on this machine is still waiting. */
  readonly pendingPair: () => boolean;
  /** Agent-mode `capy pair`: `wait` polls the pending pairing (with the code, when there is one); otherwise a new one starts. */
  readonly pair: (step: { readonly wait: boolean; readonly code?: string }) => Promise<PairAgentOutcome>;
  /** Agent-mode bare `capy`. */
  readonly folder: () => Promise<FolderOutcome>;
  readonly linked: () => Promise<LinkedFolder>;
  /** Writes the Capy block (or, with `apply` false, reports what it would write). */
  readonly agentsFiles: (apply: boolean) => readonly AgentsFileResult[];
  readonly integrations: () => readonly Integration[];
}

type Outcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly result: Readonly<Record<string, unknown>> };

const refusal = (r: Refusal): Outcome => ({ kind: 'refusal', refusal: r });

/**
 * A step's "run this next" as the `capy setup` run that does the same: the pairing wait, the pairing code, and the
 * folder answers. Anything else is left as it is.
 */
export function asSetupCommand(command: string, bin: string): string {
  if (command.startsWith(`${bin} pair --wait --code `)) return `${bin} setup --code ${command.slice(`${bin} pair --wait --code `.length)} --json`;
  if (command === `${bin} pair --wait`) return `${bin} setup --json`;
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

function linkedResult(folder: LinkedFolder): Readonly<Record<string, unknown>> {
  return {
    created: false,
    already_set_up: true,
    org: { id: folder.organizationId ?? null },
    project: { id: folder.projectId ?? null, name: folder.projectName ?? null },
    branch: { name: folder.activeBranch, protected: null },
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

async function folderStep(options: SetupCommandOptions, deps: SetupDeps, mayPair: boolean): Promise<Outcome> {
  const bin = binName(options.devMode === true);
  const folder = await deps.folder();
  if (folder === undefined) {
    return refusal({ code: ERROR_CODES.SERVICE_ERROR, message: 'This folder cannot be set up here.', exitCode: 1 }); // COPY-FLAG
  }
  if (folder.kind === 'sync') return finish(options, deps, linkedResult(await deps.linked()));
  if (folder.kind === 'done') return finish(options, deps, folder.result);
  // Nobody is signed in: pairing comes first. A dry run changes nothing, so it starts no pairing.
  if (!needsPairing(folder.refusal)) return refusal(forSetup(folder.refusal, bin));
  if (!mayPair || options.dryRun === true) return refusal(notPaired(folder.refusal, bin, options.dryRun === true));
  const paired = await deps.pair({ wait: deps.pendingPair() });
  return paired.kind === 'refusal' ? refusal(forSetup(paired.refusal, bin)) : folderStep(options, deps, false);
}

/** What `capy setup` ends with: the stop of the first step that needs the human, or the finished setup. */
export async function setupOutcome(options: SetupCommandOptions, deps: SetupDeps): Promise<Outcome> {
  const bin = binName(options.devMode === true);
  const code = options.code?.trim() || undefined;
  // A code means the person has just approved a pairing: finish that one first. Without a pending pairing the code
  // has been used already (a rerun), and the folder step says whether pairing is still needed.
  if (code !== undefined && options.dryRun !== true && deps.pendingPair()) {
    const paired = await deps.pair({ wait: true, code });
    if (paired.kind === 'refusal') return refusal(forSetup(paired.refusal, bin));
  }
  return folderStep(options, deps, true);
}

function realDeps(options: SetupCommandOptions): SetupDeps {
  const devMode = options.devMode === true;
  const setup: SetupOptions = { ...options.answers, json: true, nonTty: true, agentMode: true };
  const cliOptions: CliOptions = { envPath: options.envPath, dryRun: options.dryRun, protocol: true, setup };
  return {
    pendingPair: () => readPendingPairGrant() !== null,
    pair: async (step) => {
      const { pairAgentOutcome } = await import('./pairAgentCommand');
      return pairAgentOutcome({ json: true, wait: step.wait, code: step.code, devMode, ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }) });
    },
    folder: async () => {
      const { CapyCommand } = await import('./capyCommand');
      return new CapyCommand(cliOptions, devMode).folderSetupOutcome();
    },
    linked: async () => {
      const { ProjectManager } = await import('../core/projectManager');
      return new ProjectManager().detectProjectState();
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
