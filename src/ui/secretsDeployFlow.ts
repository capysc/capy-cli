// The deploy flow of the `capy secrets` TUI (CAP-704): press `ctrl+d` on a row (or `d` in its
// details), see what would be deployed, confirm, watch it run, then see what happened.
//
// Pure, like the edit flow (`secretsEditFlow.ts`): `stepDeploy(flow, key, dryRun)` takes the
// flow state and one key token and returns the next state plus (at most) one effect for the
// driver to perform; `renderDeploy` draws a state. Nothing here touches stdin, stdout, the
// network or git. A deploy takes no value (it ships what Capy holds); the plan step does hold the
// row's value, only to show it (masked, `r` reveals) on that one screen. It is dropped when the
// run starts or the flow ends, and it is never in the exit text, a note, a log or any JSON.
//
// Steps:  planning -> plan -> running -> done
//   planning  reads the repos' deploy.json from GitHub (no key is opened, nothing is written).
//             Esc cancels.
//   plan      the row's value (masked), then a checkbox list of the targets (location, target,
//             provider, vars), all ticked at first, and the skipped locations greyed below it
//             (with their reason). Space ticks, `a` ticks all / none, `r` shows or hides the
//             value, Enter deploys ONLY the ticked targets (nothing ticked: Enter does nothing),
//             Esc / `n` cancels. A plan with nothing to deploy says so and only Esc works.
//             Under `--dry-run` Enter shows what would happen for the ticked targets and
//             changes nothing: no effect is ever started.
//   running   Ctrl+C / Esc stop: no further target is started, every one in flight finishes.
//   done      the result; only Esc leaves it. `c` copies the PR links to the clipboard (and the screen
//             stays), so they can also be selected and copied by hand first.

import type { SecretIndexRow } from '../service/serviceClient';
import { BatchPhase, BatchPlan, BatchProgress, BatchResult, restrictPlan, targetKeyOf } from '../deploy/batchDeploy';
import {
  DRY_RUN_DEPLOY_NOTE,
  PLAN_HEADINGS,
  deployTitle,
  planLines,
  renderBatchResult,
  skippedRows,
  targetRows,
  unreadableLines,
} from '../commands/secretsDeployText';
import { CANCELLED_NOTHING, STOPPING_NOW, stoppingAfter, TERMINAL_STYLE } from '../commands/secretsSetText';
import { TableColumn, clipLine, pickerTableLines } from './pickerTable';
import { CheckboxState, initialCheckboxState, stepCheckboxKey } from './searchableCheckbox';
import { toCheckboxKey } from './secretsEditFlow';
import { ValueState, renderValueLine } from './valueDisplay';
import { COPY_HINT_PAIR, CopyEffect, CopyOutcome, copiedLine, copyEffectFor, isCopyKey, uniqueUrls } from './copyPrLinks';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;

const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const KEY_CTRL_C = '\x03';

// ── State ────────────────────────────────────────────────────────────────────

export type DeployFlow =
  | { readonly step: 'planning'; readonly row: SecretIndexRow }
  | {
      readonly step: 'plan';
      readonly row: SecretIndexRow;
      readonly plan: BatchPlan;
      /** Which targets (indices into `plan.targets`) are ticked, and where the cursor is. All ticked at first. */
      readonly box: CheckboxState;
      /** The row's value, for the `value` line only. Fetched once the plan is shown (the details view's own fetch). */
      readonly value: ValueState;
      /** The value is shown in full (`r`); masked otherwise. */
      readonly revealed: boolean;
    }
  | {
      readonly step: 'running';
      readonly row: SecretIndexRow;
      readonly plan: BatchPlan;
      /** Live progress of the run (set as items complete). */
      readonly progress?: BatchProgress;
      /** A stop was asked for in this phase, this many times (Ctrl+C / Esc). */
      readonly stop?: { readonly phase: BatchPhase; readonly count: number };
    }
  | {
      readonly step: 'done';
      readonly text: string;
      /** The PR links of the result, from its own url fields (never read back from `text`). Empty: `c` does nothing. */
      readonly prUrls: readonly string[];
      /** What the last `c` did; absent until it was pressed. */
      readonly copied?: CopyOutcome;
    };

export type DeployEffect =
  /** Copy the PR links (newline-joined) to the clipboard; the driver reports back with `applyDeployCopied`. */
  | CopyEffect
  | { readonly type: 'loadDeployPlan'; readonly row: SecretIndexRow }
  /** Stop: `planning` kills the GitHub reads; `pushing` / `prs` start nothing new and wait for every item in flight. */
  | { readonly type: 'cancelDeploy'; readonly phase: 'planning' | BatchPhase }
  | { readonly type: 'runDeploy'; readonly plan: BatchPlan };

export interface DeployStep {
  /** `null`: the flow is over and the list is back. */
  readonly flow: DeployFlow | null;
  readonly effect: DeployEffect | null;
  /** A short dim note for the list the flow left (e.g. that it was cancelled). */
  readonly note?: string;
  /** Leave the whole screen and print this after the alt screen is gone. */
  readonly exitText?: string;
}

export function startDeploy(row: SecretIndexRow): { readonly flow: DeployFlow; readonly effect: DeployEffect } {
  return { flow: { step: 'planning', row }, effect: { type: 'loadDeployPlan', row } };
}

export const isDeployRunning = (flow: DeployFlow | null): boolean => flow !== null && flow.step === 'running';

// ── Keys ─────────────────────────────────────────────────────────────────────

const isEsc = (token: string): boolean => token === KEY_ESC || token === KEY_ESC_ESC;
const stay = (flow: DeployFlow): DeployStep => ({ flow, effect: null });

/** What a dry run would do, on screen. Counts and names only. */
export function dryRunDeployText(plan: BatchPlan): string {
  return [
    DRY_RUN_DEPLOY_NOTE,
    `Would deploy to ${plan.targets.length} target${plan.targets.length === 1 ? '' : 's'}.`, // COPY-FLAG
    ...plan.targets.map((t) => `  ${t.repo.owner}/${t.repo.name} (${t.base}) · ${t.config.name}`), // COPY-FLAG
  ].join('\n');
}

/** The plan restricted to the ticked targets: what Enter deploys. */
export const selectedPlan = (flow: Extract<DeployFlow, { step: 'plan' }>): BatchPlan =>
  restrictPlan(flow.plan, flow.box.checked.map((i) => targetKeyOf(flow.plan.targets[i])));

/** The keys of the list: up / down, space and `a` (the edit flow's own, same select-all rule). No filter: nothing else types. */
const LIST_KEYS: readonly string[] = ['up', 'down', 'space', 'a'];

function stepList(flow: Extract<DeployFlow, { step: 'plan' }>, key: string): DeployStep {
  const ckey = toCheckboxKey(key, false);
  if (ckey === null || !LIST_KEYS.includes(ckey.name)) return stay(flow);
  const step = stepCheckboxKey(flow.box, flow.plan.targets.map(targetKeyOf), ckey);
  return stay(step.kind === 'state' ? { ...flow, box: step.state } : flow);
}

function stepPlan(flow: Extract<DeployFlow, { step: 'plan' }>, key: string, dryRun: boolean): DeployStep {
  if (isEsc(key) || key === 'n' || key === 'N') return { flow: null, effect: null, note: CANCELLED_NOTHING };
  if (flow.plan.targets.length === 0) return stay(flow);
  if (key === 'r' || key === 'R') return stay({ ...flow, revealed: !flow.revealed });
  if (key !== '\r') return stepList(flow, key);
  if (flow.box.checked.length === 0) return stay(flow);
  const plan = selectedPlan(flow);
  // A dry run never starts the run: it shows what would happen.
  if (dryRun) return stay({ step: 'done', text: dryRunDeployText(plan), prUrls: [] });
  return { flow: { step: 'running', row: flow.row, plan }, effect: { type: 'runDeploy', plan } };
}

/**
 * Ctrl+C and Esc work while running (they never leave the screen hanging):
 *  - pushing: start no further target and wait for every push in flight (a Dokploy write is never cut in half);
 *  - opening PRs: start no further PR and wait for every PR in flight.
 * Every other key is ignored.
 */
function stepRunning(flow: Extract<DeployFlow, { step: 'running' }>, key: string): DeployStep {
  if (!isEsc(key) && key !== KEY_CTRL_C) return stay(flow);
  const phase = flow.progress?.phase ?? 'pushing';
  const count = (flow.stop !== undefined && flow.stop.phase === phase ? flow.stop.count : 0) + 1;
  return { flow: { ...flow, stop: { phase, count } }, effect: { type: 'cancelDeploy', phase } };
}

/** One key token applied to the flow. */
export function stepDeploy(flow: DeployFlow, key: string, dryRun: boolean = false): DeployStep {
  if (flow.step === 'planning') {
    return isEsc(key) ? { flow: null, effect: { type: 'cancelDeploy', phase: 'planning' }, note: CANCELLED_NOTHING } : stay(flow);
  }
  if (flow.step === 'plan') return stepPlan(flow, key, dryRun);
  if (flow.step === 'running') return stepRunning(flow, key);
  return stepDone(flow, key);
}

/** The result screen: Esc leaves it; `c` copies the PR links and stays (no links: nothing to copy); every other key does nothing. */
function stepDone(flow: Extract<DeployFlow, { step: 'done' }>, key: string): DeployStep {
  if (isEsc(key)) return { flow: null, effect: null, exitText: flow.text };
  if (isCopyKey(key) && flow.prUrls.length > 0) return { flow, effect: copyEffectFor(flow.prUrls) };
  return stay(flow);
}

// ── Results coming back ─────────────────────────────────────────────────────

export type DeployPlanLoaded =
  | { readonly ok: true; readonly plan: BatchPlan }
  | { readonly ok: false; readonly code: string };

/** The plan arrived. Dropped (the flow is returned unchanged) unless the flow is still waiting for it. */
export function applyDeployPlanLoaded(flow: DeployFlow | null, loaded: DeployPlanLoaded): DeployFlow | null {
  if (flow === null || flow.step !== 'planning') return flow;
  return loaded.ok
    ? {
        step: 'plan',
        row: flow.row,
        plan: loaded.plan,
        box: initialCheckboxState(loaded.plan.targets.map(() => ({ checked: true }))),
        value: { status: 'loading' },
        revealed: false,
      }
    : { step: 'done', text: `✗ Could not read the deploy targets. (${loaded.code})`, prUrls: [] }; // COPY-FLAG
}

/** The plan step has targets: the row's value is worth fetching, to show it on this screen. */
export const wantsValue = (flow: DeployFlow | null): flow is Extract<DeployFlow, { step: 'plan' }> =>
  flow !== null && flow.step === 'plan' && flow.plan.targets.length > 0;

/**
 * The row's value arrived (or could not be read). Dropped (the flow is returned unchanged) unless
 * the flow is on the plan step for that same row (name and value hash): the guard the details
 * view and the edit dialog use.
 */
export function applyDeployValue(
  flow: DeployFlow | null,
  forRow: { readonly name: string; readonly value_hash: string },
  result: ValueState,
): DeployFlow | null {
  if (flow === null || flow.step !== 'plan') return flow;
  if (flow.row.name !== forRow.name || flow.row.value_hash !== forRow.value_hash) return flow;
  return { ...flow, value: result };
}

/** The run reported progress. Dropped unless the flow is still running. A stop asked for in an earlier phase does not carry over. */
export function applyDeployProgress(flow: DeployFlow | null, progress: BatchProgress): DeployFlow | null {
  if (flow === null || flow.step !== 'running') return flow;
  const stop = flow.stop !== undefined && flow.stop.phase === progress.phase ? flow.stop : undefined;
  return { ...flow, progress, stop };
}

/** The PR links of a finished batch: every delivered target's own `pr_url` (a target that needed no PR has none), once each. */
export const prUrlsOf = (result: BatchResult): readonly string[] =>
  uniqueUrls(result.targets.flatMap((t) => (t.kind === 'delivered' && t.pr_url !== null ? [t.pr_url] : [])));

export type DeployFinished =
  | { readonly ok: true; readonly result: BatchResult }
  | { readonly ok: false; readonly code: string };

/** The run finished. Dropped unless the flow is still running. */
export function applyDeployFinished(flow: DeployFlow | null, finished: DeployFinished): DeployFlow | null {
  if (flow === null || flow.step !== 'running') return flow;
  return {
    step: 'done',
    text: finished.ok ? renderBatchResult(finished.result, TERMINAL_STYLE) : `✗ ${flow.row.name} was not deployed. (${finished.code})`, // COPY-FLAG
    prUrls: finished.ok ? prUrlsOf(finished.result) : [],
  };
}

/** The copy the `copyToClipboard` effect started finished. Dropped unless the flow is still on the result. */
export function applyDeployCopied(flow: DeployFlow | null, ok: boolean): DeployFlow | null {
  if (flow === null || flow.step !== 'done') return flow;
  return { ...flow, copied: { ok, count: flow.prUrls.length } };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The one live line of the running step. */
export function deployRunningLine(flow: Extract<DeployFlow, { step: 'running' }>): string {
  const p = flow.progress;
  if (flow.stop !== undefined) return p !== undefined && p.inFlight > 0 ? stoppingAfter(p.inFlight) : STOPPING_NOW;
  if (p === undefined) return `Deploying ${flow.row.name} to ${plural(flow.plan.targets.length, 'target')}…`; // COPY-FLAG
  if (p.phase === 'pushing') return `Deploying ${flow.row.name}… ${p.done} of ${plural(p.total, 'target')}`; // COPY-FLAG
  if (p.phase === 'recording') return 'Recording deliveries…'; // COPY-FLAG
  return `Opening pull requests… ${p.done} of ${p.total}`; // COPY-FLAG
}

const hint = (...pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.map(([key, what]) => `${BOLD}${key}${RESET}${DIM} ${what}${RESET}`).join(`${DIM} · ${RESET}`);

// COPY-FLAG: the table headings are the plan's own; only the two long ones may be cut when narrow.
const PLAN_COLUMNS: readonly TableColumn[] = PLAN_HEADINGS.map((heading, i) => ({ heading, shrink: i < 2 }));
const VALUE_LABEL = 'value'; // COPY-FLAG (the details view's word)

/** The plan step: title, value line, the checkbox list with the skipped rows greyed under it, and its keys. */
function renderPlan(
  flow: Extract<DeployFlow, { step: 'plan' }>,
  width: number,
  height: number,
): { readonly lines: readonly string[]; readonly footer: string } {
  const maxWidth = Math.max(20, width - 3);
  const names = [flow.row.name];
  if (flow.plan.targets.length === 0) {
    const lines = planLines(flow.plan, names).map((l) => clipLine(l, maxWidth));
    return { lines: [`${BOLD}${lines[0]}${RESET}`, ...lines.slice(1)], footer: hint(['esc', 'back']) }; // COPY-FLAG
  }
  const skipped = skippedRows(flow.plan);
  const unreadable = unreadableLines(flow.plan);
  const title = clipLine(deployTitle(names, flow.box.checked.length, flow.plan.targets.length), maxWidth);
  const labelWidth = VALUE_LABEL.length + 2;
  const valueLine = `${DIM}${VALUE_LABEL}${RESET}  ${renderValueLine(flow.value, flow.revealed, 0, Math.max(10, maxWidth - labelWidth))}`;
  // Screen chrome: header and its gap, title, value, gap, heading, gap and footer; then what sits under the list.
  const size = Math.max(3, height - 9 - skipped.length - (unreadable.length === 0 ? 0 : unreadable.length + 1));
  return {
    lines: [
      `${BOLD}${title}${RESET}`,
      clipLine(valueLine, maxWidth),
      '',
      ...pickerTableLines({
        columns: PLAN_COLUMNS,
        rows: targetRows(flow.plan),
        labels: flow.plan.targets.map(targetKeyOf),
        box: flow.box,
        size,
        maxWidth,
        inert: skipped,
      }),
      ...(unreadable.length === 0 ? [] : ['', ...unreadable.map((l) => clipLine(l, maxWidth))]),
    ],
    footer: hint(
      ['space', 'select'],
      ['a', 'all'],
      ['r', flow.revealed ? 'hide' : 'reveal'],
      ...(flow.box.checked.length === 0 ? [] : ([['enter', 'deploy']] as const)),
      ['esc', 'cancel'],
    ), // COPY-FLAG
  };
}

/** Body lines (no margin) and the footer for the flow, for `width` x `height`. */
export function renderDeploy(
  flow: DeployFlow,
  width: number,
  height: number = 24,
): { readonly lines: readonly string[]; readonly footer: string } {
  if (flow.step === 'planning') {
    return { lines: [`${DIM}Reading deploy targets…${RESET}`], footer: hint(['esc', 'cancel']) }; // COPY-FLAG
  }
  if (flow.step === 'plan') return renderPlan(flow, width, height);
  if (flow.step === 'running') {
    return { lines: [`${DIM}${deployRunningLine(flow)}${RESET}`], footer: flow.stop === undefined ? hint(['ctrl+c', 'stop']) : '' }; // COPY-FLAG
  }
  return {
    lines: [
      ...flow.text.split('\n').map((l) => (l.startsWith('✗') ? `${RED}${l}${RESET}` : l)),
      ...(flow.copied === undefined ? [] : ['', `${flow.copied.ok ? DIM : RED}${copiedLine(flow.copied)}${RESET}`]),
    ],
    footer: hint(...(flow.prUrls.length > 0 ? [COPY_HINT_PAIR] : []), ['esc', 'exit']), // COPY-FLAG
  };
}
