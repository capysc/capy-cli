/**
 * `capy setup` (CAP-891): the one command an agent runs to set a folder up with Capy.
 *
 * It runs the steps that exist already, in order, and stops at the first one that needs the human:
 *   1. Pair: `capy pair` in agent mode (the link, the wait, the one-time code Keep shows).
 *   2. Folder: bare `capy` in agent mode (organization, project, first branch).
 *   3. Agent instructions: the Capy block in AGENTS.md / CLAUDE.md.
 *   4. Discovery: the services and deployment targets the folder shows signs of, from names and files only, and the
 *      next command for each (`core/discovery/scan.ts`, spec 3k section 7).
 *
 * Every stop is the step's own coded refusal, with its elicitation unchanged except for the command to run next, which
 * names `capy setup` so the agent keeps running one command. Running it again is always safe: a step that is done is
 * skipped. It always answers in JSON and never prompts.
 *
 * The steps are injected (`SetupDeps`), so the order and the rewriting are tested without a network.
 */
import { readPendingPairGrant } from '../auth/pairing/pendingGrant';
import { isLocalOnly } from '../config/profileConfig';
import { CATALOG, discover, type Discovery } from '../core/discovery/scan';
import { walkFolder } from '../core/discovery/walk';
import { FileManager } from '../files/fileManager';
import { ERROR_CODES, type CliOptions, type SetupOptions } from '../types/index';
import type { AgentOutcome } from './agentSetup';
import { resolveRepoRoot, writeAgentsBlock, type AgentsFileResult } from './agentsCommand';
import { binName } from './binName';
import { shellWord } from './setupForm';
import type { PairAgentOutcome } from './pairAgentCommand';
import { refusalFor } from './projectLifecycleCommand';
import { refuse, settle, type Refusal } from './refusal';

export interface SetupCommandOptions {
  /** `--code`: the one-time code Keep showed the person who approved the pairing. */
  readonly code?: string;
  /** `--title` / `--description`: the agent's intent, which Keep shows on the unlock request a new pairing makes (CAP-925). */
  readonly intent?: SetupIntent;
  /** The answers to the folder questions, as typed (`--folder`, `--org`, `--project`, `--name`, `--branch`, `--protected`, `--share-setup`). */
  readonly answers: FolderAnswers;
  readonly envPath?: string;
  readonly dryRun?: boolean;
  readonly devMode?: boolean;
  readonly apiUrl?: string;
}

/** The agent's own words for what it is doing, as typed. Keep shows them to the human who approves the pairing. */
export interface SetupIntent {
  readonly title?: string;
  readonly description?: string;
}

/** Placeholders for a rerun that still needs the agent's intent. The agent writes both; they are never the human's answers. */
const INTENT_PLACEHOLDERS = '--title <title> --description <description>';

/** The folder answers that were typed, as flags, so a command handed back repeats them. */
function typedFlags(answers: FolderAnswers): readonly string[] {
  const typed: ReadonlyArray<readonly [string, string | undefined]> = [
    ['--folder', answers.folder],
    ['--org', answers.org],
    ['--project', answers.project],
    ['--name', answers.name],
    ['--branch', answers.branch],
    ['--protected', answers.protectedAnswer],
    ['--share-setup', answers.shareAnswer],
    ['--encrypt-env', answers.encryptAnswer],
  ];
  return typed.flatMap(([flag, value]) => (value === undefined ? [] : [flag, shellWord(value)]));
}

/** `command` (a `capy setup` run) with the intent's flags, unless it has them already. */
function withIntent(command: string, bin: string, intent: SetupIntent | undefined): string {
  const prefix = `${bin} setup`;
  if (intent === undefined || / --title | --description /.test(command) || !(command === prefix || command.startsWith(`${prefix} `))) return command;
  const words = [
    ...(intent.title === undefined ? [] : ['--title', shellWord(intent.title)]),
    ...(intent.description === undefined ? [] : ['--description', shellWord(intent.description)]),
  ];
  return `${prefix} ${words.join(' ')}${command.slice(prefix.length)}`;
}

/**
 * A pairing refusal as `capy setup` hands it back. When every link ran out (PAIR_EXPIRED), the saved pairing and its
 * intent are gone, so the human's yes to starting again carries the intent the pairing was started with.
 */
function pairRefusal(r: Refusal, bin: string, folder: string | undefined, intent: SetupIntent | undefined): Refusal {
  const back = forSetup(r, bin, folder);
  const elicitation = back.extra?.elicitation;
  if (back.code !== ERROR_CODES.PAIR_EXPIRED || !isRecord(elicitation) || !isRecord(elicitation.answer) || typeof elicitation.answer.yes !== 'string') return back;
  const answer = { ...elicitation.answer, yes: withIntent(elicitation.answer.yes, bin, intent) };
  return { ...back, extra: { ...back.extra, elicitation: { ...elicitation, answer } } };
}

/** The trimmed intent, or undefined when neither part says anything. */
function intentOf(intent: SetupIntent | undefined): SetupIntent | undefined {
  const title = intent?.title?.trim();
  const description = intent?.description?.trim();
  if (!title && !description) return undefined;
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/**
 * A new pairing needs the agent's intent: Keep's unlock request shows it to the human, who approves only what they can
 * see described (Vincent, 2026-11-27). Asked of the agent, never of the human, so this is a plain refusal, not an
 * elicitation. A pairing already waiting keeps the intent it was started with.
 */
function intentRequired(bin: string, answers: FolderAnswers): Refusal {
  const rerun = [`${bin} setup`, ...typedFlags(answers), INTENT_PLACEHOLDERS, '--json'].join(' ');
  return {
    code: ERROR_CODES.SETUP_INTENT_REQUIRED,
    message: `Setup is about to ask the human to approve an unlock request in Keep. Describe it in your own words: what you are setting up and why (--title, at most 120 characters), and what you will do once it is approved (--description, at most 600 characters). Then run \`${rerun}\`.`, // COPY-FLAG
    exitCode: 1,
    extra: { next_command: rerun, fields: ['title', 'description'] },
  };
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

export type FolderAnswers = Pick<SetupOptions, 'org' | 'project' | 'name' | 'branch' | 'protectedAnswer' | 'shareAnswer' | 'encryptAnswer' | 'folder'>;

export type FolderOutcome = AgentOutcome | { readonly kind: 'sync'; readonly ignoredFlags?: readonly string[] } | undefined;

/** `waiting`: a pairing started on this machine can still be approved. `expired`: its link has run out. */
export type PendingPair = 'none' | 'waiting' | 'expired';

export interface SetupDeps {
  /** Whether the active profile is local-only: no organization and no server, so there is nothing to set up against. */
  readonly localOnly: () => boolean;
  readonly pendingPair: () => PendingPair;
  /** The intent the pending pairing was started with, if any (read before a wait, which may delete it). */
  readonly pendingIntent?: () => SetupIntent | undefined;
  /** Agent-mode `capy pair`: `wait` polls the pending pairing (with the code, when there is one); otherwise a new one starts. */
  readonly pair: (step: { readonly wait: boolean; readonly code?: string; readonly noRenew?: boolean; readonly intent?: SetupIntent }) => Promise<PairAgentOutcome>;
  /** Agent-mode bare `capy`, with the answers that were typed, or with `answers` in their place. */
  readonly folder: (answers?: FolderAnswers) => Promise<FolderOutcome>;
  readonly linked: () => Promise<LinkedFolder>;
  /** The refusal when nobody is signed in (for `orgId`, when the folder names one); undefined when someone is. Never a browser. */
  readonly session: (orgId: string | undefined) => Promise<Refusal | undefined>;
  /** Writes the Capy block (or, with `apply` false, reports what it would write). */
  readonly agentsFiles: (apply: boolean) => readonly AgentsFileResult[];
  /** Discovery over the folder (names and files only; never fails setup). */
  readonly discovery: () => Discovery;
}

type Outcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly result: Readonly<Record<string, unknown>> };

const refusal = (r: Refusal): Outcome => ({ kind: 'refusal', refusal: r });

/**
 * A step's "run this next" as the `capy setup` run that does the same: the pairing wait, the pairing code, a new
 * pairing, and the folder answers. Anything else is left as it is.
 */
export function asSetupCommand(command: string, bin: string, folder?: string): string {
  return withFolder(asSetupCommandIn(command, bin), bin, folder);
}

/**
 * A `--folder` the human answered is repeated on every command handed back, so a run that pairs first (whose wait and
 * code commands name no folder of their own) carries on in the folder they chose instead of asking again.
 */
export function withFolder(command: string, bin: string, folder: string | undefined): string {
  if (folder === undefined || / --folder /.test(command)) return command;
  for (const prefix of [`${bin} setup`, bin]) {
    if (command === prefix || command.startsWith(`${prefix} -`)) return `${prefix} --folder ${shellWord(folder)}${command.slice(prefix.length)}`;
  }
  return command;
}

function asSetupCommandIn(command: string, bin: string): string {
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
export function forSetup(r: Refusal, bin: string, folder?: string): Refusal {
  const next = r.extra?.next_command;
  const withNext = folder === undefined || typeof next !== 'string' ? r : { ...r, extra: { ...r.extra, next_command: asSetupCommand(next, bin, folder) } };
  const elicitation = withNext.extra?.elicitation;
  if (!isRecord(elicitation) || !isRecord(elicitation.answer)) return withNext;
  const answer = Object.fromEntries(
    Object.entries(elicitation.answer).map(([key, value]) => [key, typeof value === 'string' ? asSetupCommand(value, bin, folder) : value]),
  );
  return { ...withNext, extra: { ...withNext.extra, elicitation: { ...elicitation, answer } } };
}

/** Whether the folder step stopped only because nobody is signed in and pairing is the way in. */
function needsPairing(r: Refusal): boolean {
  return r.code === ERROR_CODES.AUTH_FAILED && typeof r.extra?.next_command === 'string';
}

/** Not signed in, and this run starts no pairing: the same refusal, pointing at `capy setup` instead of `capy pair`. */
function notPaired(r: Refusal, bin: string, dryRun: boolean, folder: string | undefined): Refusal {
  // A run that pairs needs the agent's intent for the unlock request, so a dry run hands back the command with its placeholders.
  const again = withFolder(dryRun ? `${bin} setup ${INTENT_PLACEHOLDERS} --json` : `${bin} setup --json`, bin, folder);
  return {
    ...r,
    message: dryRun
      ? `Not signed in. A dry run starts no pairing: run \`${again}\` to pair.` // COPY-FLAG
      : `Still not signed in after pairing. Run \`${again}\` again.`, // COPY-FLAG
    extra: { ...r.extra, next_command: again },
  };
}

function linkedResult(folder: LinkedFolder, ignoredFlags: readonly string[], bin: string, dryRun: boolean, typedFolder?: string): Readonly<Record<string, unknown>> {
  return {
    created: false,
    already_set_up: true,
    org: { id: folder.organizationId ?? null },
    project: { id: folder.projectId ?? null, name: folder.projectName ?? null },
    branch: { name: folder.activeBranch, protected: null },
    ...(ignoredFlags.length === 0 ? {} : { ignored_flags: ignoredFlags }),
    // Setup links and reports; it does not sync. Bare `capy` brings the folder's variables up to date.
    ...(dryRun ? {} : { next: withFolder(`${bin} --json`, bin, typedFolder) }),
  };
}

/** Steps 3 and 4, once the folder is a project: the agent instructions and discovery. */
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
      discovery: discoveryOrNone(deps),
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
  const folder = options.answers.folder;
  if (!needsPairing(signedOut)) return refusal(forSetup(signedOut, bin, folder));
  if (!progress.mayPair || options.dryRun === true) return refusal(notPaired(signedOut, bin, options.dryRun === true, folder));
  // A pairing that is waiting is waited on, and one whose link ran out is renewed by that wait; a second one never starts beside it.
  const wait = deps.pendingPair() !== 'none';
  const intent = intentOf(options.intent);
  if (!wait && intent === undefined) return refusal(intentRequired(bin, options.answers));
  const started = wait ? intentOf(deps.pendingIntent?.()) : intent;
  const paired = await deps.pair(wait ? { wait } : { wait, intent });
  return paired.kind === 'refusal' ? refusal(pairRefusal(paired.refusal, bin, folder, started)) : folderStep(options, deps, { ...progress, mayPair: false });
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
  return finish(options, deps, linkedResult(state, ignoredFlags, binName(options.devMode === true), options.dryRun === true, options.answers.folder));
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
    const started = intentOf(deps.pendingIntent?.());
    const paired = await deps.pair({ wait: true, code, ...(pending === 'expired' ? { noRenew: true } : {}) });
    const gone = pending === 'expired' && paired.kind === 'refusal' && paired.refusal.code === ERROR_CODES.PAIR_EXPIRED;
    if (paired.kind === 'refusal' && !gone) return refusal(pairRefusal(paired.refusal, bin, options.answers.folder, started));
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
    pendingIntent: () => {
      const renew = readPendingPairGrant()?.renew;
      return renew === undefined ? undefined : { title: renew.intentTitle, description: renew.intentDescription };
    },
    pair: async (step) => {
      const { pairAgentOutcome } = await import('./pairAgentCommand');
      return pairAgentOutcome({ json: true, wait: step.wait, code: step.code, noRenew: step.noRenew, ...(step.intent ?? {}), devMode, ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }) });
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
    discovery: () => {
      const envNames = namesOrNone(() => Object.keys(new FileManager().readEnvFile(options.envPath)));
      const walk = walkOrNone(() => walkFolder(process.cwd()));
      return discover({
        files: walk.files,
        truncated: walk.truncated,
        envNames,
        envIsSet: (name) => (process.env[name] ?? '') !== '',
        bin: binName(devMode),
      });
    },
  };
}

/** Discovery is a hint and never fails setup: anything it throws gives an empty result. */
function discoveryOrNone(deps: SetupDeps): Discovery {
  try {
    return deps.discovery();
  } catch {
    return { catalog_version: CATALOG.version, services: [], unmapped: [], infrastructure: [], scanned: { files: 0, truncated: false, names_capped: false } };
  }
}

/** The folder's files, or none when it cannot be walked: discovery is a hint and never fails setup. */
function walkOrNone(walk: () => ReturnType<typeof walkFolder>): ReturnType<typeof walkFolder> {
  try {
    return walk();
  } catch {
    return { files: [], truncated: false };
  }
}

/** The names, or none when the `.env` cannot be read: discovery is a hint and never fails setup. */
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
