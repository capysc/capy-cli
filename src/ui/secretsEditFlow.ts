// The edit flow of the `capy secrets` TUI (CAP-698): press `e` on a row, type a
// new value, pick the locations to push it to, pick the repos to open a PR in,
// then see what happened.
//
// Pure, like the rest of the screen: `stepEdit(flow, key)` takes the flow state
// and one key token and returns the next state plus (at most) one effect for the
// driver to perform; `renderEdit` draws a state. Nothing here touches stdin,
// stdout, the network or git. The VALUE lives only in the flow state; no render
// ever contains it (the dialog shows a mask), and no effect other than `runSet`
// carries it.
//
// Steps:  value -> locations -> (loading) -> repos -> running -> done
//   value      Old value (Ctrl+R reveals it, on screen only) and a hidden New value
//              input. Enter next, Esc cancels. Layout shared with capy edit (valueDialog.ts).
//   locations  the row's project/branch locations, ALL selected (protected too,
//              each labelled `protected`). Same keys as `capy deploy`'s picker:
//              space, a (toggle all), i (invert), / (filter), enter, and Esc back.
//   repos      the repos to open a PR in, with the approved prompt, all selected.
//   running    keys are ignored: a push in flight is never abandoned halfway.
//   done       the confirmation; only Esc leaves it. `c` copies the PR links to the clipboard (and the
//              screen stays), so they can also be selected and copied by hand first.

import { CheckboxKey, CheckboxState, initialCheckboxState, stepCheckboxKey } from './searchableCheckbox';
import { isRevealKey, stepEditBuffer } from './editBuffer';
import { OldValueView, canReveal, revealHint, valueDialogRows } from './valueDialog';
import type { ValueState } from './secretsScreen';
import { sanitizePastedText } from './editScreen';
import { CONFIRM_MESSAGE } from '../commands/keepLockPr';
import { CANCELLED_NOTHING, STOPPING_AGAIN, STOPPING_NOW, stoppingAfter, DryRunView, renderDryRunPlan, renderSecretSetConfirmation, TERMINAL_STYLE } from '../commands/secretsSetText';
import { RepoTarget, RunProgress, SecretSetResult, SetLocation, planRepos, repoKey, repoLabel } from '../commands/secretsSet';
import { TableColumn, clipLine, pickerTableLines } from './pickerTable';
import { COPY_HINT_PAIR, CopyEffect, CopyOutcome, copiedLine, copyEffectFor, isCopyKey, uniqueUrls } from './copyPrLinks';
import type { OrgRepoLink, SecretIndexRow } from '../service/serviceClient';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;
const INVERSE = `${ESC}[7m`;

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Which row's current value the dialog shows, and what is known of it. It is
 * fetched once when the dialog opens (the same decrypt path the details view
 * uses) and carried through every step, so going back to the value restores it.
 */
interface OldRef {
  readonly rowName: string;
  readonly rowHash: string;
  readonly old: ValueState;
}

/** What every step after the value carries. */
interface Carried extends OldRef {
  readonly name: string;
  readonly value: string;
  readonly locations: readonly SetLocation[];
}

export type EditFlow =
  | ({
      readonly step: 'value';
      readonly name: string;
      readonly locations: readonly SetLocation[];
      readonly buffer: string;
      readonly pasting: boolean;
      /** Ctrl+R: the old value is shown on screen. */
      readonly revealed: boolean;
    } & OldRef)
  | ({ readonly step: 'locations'; readonly box: CheckboxState } & Carried)
  | ({
      readonly step: 'loading';
      readonly box: CheckboxState;
      readonly chosen: readonly SetLocation[];
    } & Carried)
  | ({
      readonly step: 'repos';
      readonly box: CheckboxState;
      readonly locationsBox: CheckboxState;
      readonly chosen: readonly SetLocation[];
      readonly targets: readonly RepoTarget[];
      readonly notLinked: readonly string[];
      /** Set when the repo list could not be read (a code, never a message). */
      readonly unavailable: string | undefined;
      /**
       * Each repo's default branch (the PR base), by `repoKey`; a repo missing here has
       * none known. `undefined`: still being read (the table is already up, BASE shows `…`).
       */
      readonly bases: Readonly<Record<string, string>> | undefined;
    } & Carried)
  | ({
      readonly step: 'running';
      readonly count: number;
      /** Enter was pressed while the bases were still loading: the run starts when they arrive (no second read). */
      readonly pending?: RunRequest;
      /** Live progress of the run (set as items complete). */
      readonly progress?: RunProgress;
      /** A stop was asked for in this phase, this many times (Ctrl+C / Esc). */
      readonly stop?: { readonly phase: RunProgress['phase']; readonly count: number };
    } & Carried)
  | {
      readonly step: 'done';
      readonly text: string;
      /** The PR links of the result, from its own url fields (never read back from `text`). Empty: `c` does nothing. */
      readonly prUrls: readonly string[];
      /** What the last `c` did; absent until it was pressed. */
      readonly copied?: CopyOutcome;
    };

export interface RunRequest {
  readonly name: string;
  readonly value: string;
  readonly locations: readonly SetLocation[];
  readonly repos: readonly RepoTarget[];
  /** Why the repo list was empty, when it could not be read. */
  readonly reposUnavailable?: string;
  /** The PR base of each repo, already read for the repo step; absent: read again. */
  readonly bases?: Readonly<Record<string, string>>;
}

export type EditEffect =
  /** Copy the PR links (newline-joined) to the clipboard; the driver reports back with `applyEditCopied`. */
  | CopyEffect
  | { readonly type: 'loadRepos'; readonly projectIds: readonly string[] }
  /** Read the default branches of these repos (one batched call): the BASE column. */
  | { readonly type: 'loadBases'; readonly targets: readonly RepoTarget[] }
  /** Stop: `planning` kills the default-branch read; `pushing` / `prs` start nothing new and wait for every item in flight. */
  | { readonly type: 'cancelRun'; readonly phase: 'planning' | RunProgress['phase'] }
  | { readonly type: 'runSet'; readonly request: RunRequest };

export interface EditStep {
  /** `null`: the flow is over and the list is back. */
  readonly flow: EditFlow | null;
  readonly effect: EditEffect | null;
  /** A short dim note for the list the flow left (e.g. that it was cancelled). */
  readonly note?: string;
  /** Leave the whole screen and print this after the alt screen is gone. */
  readonly exitText?: string;
}

export function locationsOf(row: SecretIndexRow): readonly SetLocation[] {
  return row.locations.map((l) => ({
    project_id: l.project_id,
    project_name: l.project_name,
    branch: l.branch,
    protected: l.protected,
  }));
}

export function startEdit(row: SecretIndexRow): EditFlow {
  return {
    step: 'value',
    name: row.name,
    locations: locationsOf(row),
    buffer: '',
    pasting: false,
    revealed: false,
    rowName: row.name,
    rowHash: row.value_hash,
    old: { status: 'loading' },
  };
}

const oldOf = (flow: OldRef): OldRef => ({ rowName: flow.rowName, rowHash: flow.rowHash, old: flow.old });

/**
 * The old value arrived (or could not be read). Dropped (the flow is returned
 * unchanged) unless it is for the row this flow is editing.
 */
export function applyOldValue(
  flow: EditFlow | null,
  forRow: { readonly name: string; readonly value_hash: string },
  result: ValueState,
): EditFlow | null {
  if (flow === null || flow.step === 'done') return flow;
  if (flow.rowName !== forRow.name || flow.rowHash !== forRow.value_hash) return flow;
  return { ...flow, old: result };
}

function oldView(old: ValueState): OldValueView {
  if (old.status === 'ok') return { kind: 'value', value: old.value };
  return old.status === 'loading' ? { kind: 'loading' } : { kind: 'unavailable', code: old.code };
}

export const isRunning = (flow: EditFlow | null): boolean => flow !== null && flow.step === 'running';

// ── Locations and repos as checkbox lists ───────────────────────────────────

const PROTECTED_LABEL = 'protected';

/** What the location filter matches: project, branch, and the word `protected` for protected ones. */
export const locationLabel = (l: SetLocation): string =>
  `${l.project_name} ${l.branch}${l.protected ? ` ${PROTECTED_LABEL}` : ''}`;

/** The projects of `target` that have a chosen location: the ones this PR is about. */
const projectsOf = (target: RepoTarget, chosen: readonly SetLocation[]): readonly string[] => [
  ...new Set(chosen.filter((l) => target.files.some((f) => f.project_id === l.project_id)).map((l) => l.project_name)),
];

/** keep.lock entries (project x branch) the PR for `target` would change: the chosen locations in its projects. */
export const changesIn = (target: RepoTarget, chosen: readonly SetLocation[]): number =>
  chosen.filter((l) => target.files.some((f) => f.project_id === l.project_id)).length;

/** `backend, worker (3 changes)` */
const projectsCell = (target: RepoTarget, chosen: readonly SetLocation[]): string => {
  const n = changesIn(target, chosen);
  return `${projectsOf(target, chosen).join(', ')} (${n} change${n === 1 ? '' : 's'})`; // COPY-FLAG
};

/** What the repo filter matches: `owner/name` and the project names. */
export const repoChoiceLabel = (t: RepoTarget, chosen: readonly SetLocation[] = []): string =>
  `${repoLabel(t)} ${projectsOf(t, chosen).join(' ')}`;

/** Every choice ticked: the default for both lists. */
const allChecked = (count: number): CheckboxState =>
  initialCheckboxState(Array.from({ length: count }, () => ({ checked: true })));

const names = (flow: { readonly locations: readonly SetLocation[] }): readonly string[] => flow.locations.map(locationLabel);

// ── Keys ─────────────────────────────────────────────────────────────────────

/** A raw key token as the key the shared checkbox state machine reads; `null` for tokens it has no use for. */
export function toCheckboxKey(token: string, searching: boolean): CheckboxKey | null {
  if (token === '\r') return { name: 'return', ctrl: false, sequence: '\r' };
  if (token === KEY_UP) return { name: 'up', ctrl: false, sequence: token };
  if (token === KEY_DOWN) return { name: 'down', ctrl: false, sequence: token };
  if (token === ' ') return { name: 'space', ctrl: false, sequence: ' ' };
  if (token === '\x7f' || token === '\b') return { name: 'backspace', ctrl: false, sequence: token };
  if ((token === KEY_ESC || token === KEY_ESC_ESC) && searching) return { name: 'escape', ctrl: false, sequence: KEY_ESC };
  const printable = token.length === 1 && token >= ' ' && token !== '\x7f';
  return printable ? { name: token.toLowerCase(), ctrl: false, sequence: token } : null;
}

const isEsc = (token: string): boolean => token === KEY_ESC || token === KEY_ESC_ESC;

const stay = (flow: EditFlow): EditStep => ({ flow, effect: null });

function stepValue(flow: Extract<EditFlow, { step: 'value' }>, key: string): EditStep {
  if (isRevealKey(key)) return stay(canReveal(oldView(flow.old), flow.buffer) ? { ...flow, revealed: !flow.revealed } : flow);
  if (key === PASTE_START) return stay({ ...flow, pasting: true });
  if (key === PASTE_END) return stay({ ...flow, pasting: false, buffer: sanitizePastedText(flow.buffer) });
  if (flow.pasting) {
    // Inside a bracketed paste every character is value text, line breaks included.
    const text = key === '\r' || key === '\n' || key === '\t' ? key : stepEditBuffer('', key);
    return stay({ ...flow, buffer: flow.buffer + text });
  }
  if (isEsc(key)) return { flow: null, effect: null };
  if (key === '\r') {
    if (flow.buffer === '') return stay(flow);
    return stay({
      step: 'locations',
      name: flow.name,
      value: flow.buffer,
      locations: flow.locations,
      box: allChecked(flow.locations.length),
      ...oldOf(flow),
    });
  }
  if (key === '\n') return stay(flow);
  return stay({ ...flow, buffer: stepEditBuffer(flow.buffer, key) });
}

const chosenFrom = (flow: Carried, box: CheckboxState): readonly SetLocation[] => box.checked.map((i) => flow.locations[i]);

function stepLocations(flow: Extract<EditFlow, { step: 'locations' }>, key: string): EditStep {
  if (isEsc(key) && !flow.box.searching) {
    return stay({ step: 'value', name: flow.name, locations: flow.locations, buffer: flow.value, pasting: false, revealed: false, ...oldOf(flow) });
  }
  const ckey = toCheckboxKey(key, flow.box.searching);
  if (ckey === null) return stay(flow);
  const step = stepCheckboxKey(flow.box, names(flow), ckey);
  if (step.kind === 'state') return stay({ ...flow, box: step.state });
  const chosen = chosenFrom(flow, flow.box);
  if (chosen.length === 0) return stay(flow);
  return {
    flow: { step: 'loading', name: flow.name, value: flow.value, locations: flow.locations, box: flow.box, chosen, ...oldOf(flow) },
    effect: { type: 'loadRepos', projectIds: [...new Set(chosen.map((l) => l.project_id))] },
  };
}

function stepLoading(flow: Extract<EditFlow, { step: 'loading' }>, key: string): EditStep {
  return isEsc(key)
    ? stay({ step: 'locations', name: flow.name, value: flow.value, locations: flow.locations, box: flow.box, ...oldOf(flow) })
    : stay(flow);
}

const targetNames = (flow: Extract<EditFlow, { step: 'repos' }>): readonly string[] => flow.targets.map((t) => repoChoiceLabel(t, flow.chosen));

function stepRepos(flow: Extract<EditFlow, { step: 'repos' }>, key: string): EditStep {
  if (isEsc(key) && !flow.box.searching) {
    return {
      flow: { step: 'locations', name: flow.name, value: flow.value, locations: flow.locations, box: flow.locationsBox, ...oldOf(flow) },
      // Leaving while the default branches are still being read: stop that read.
      effect: flow.bases === undefined && flow.targets.length > 0 ? { type: 'cancelRun', phase: 'planning' } : null,
    };
  }
  const ckey = toCheckboxKey(key, flow.box.searching);
  if (ckey === null) return stay(flow);
  const step = stepCheckboxKey(flow.box, targetNames(flow), ckey);
  if (step.kind === 'state') return stay({ ...flow, box: step.state });
  const request: RunRequest = {
    name: flow.name,
    value: flow.value,
    locations: flow.chosen,
    repos: flow.box.checked.map((i) => flow.targets[i]),
    ...(flow.unavailable === undefined ? {} : { reposUnavailable: flow.unavailable }),
  };
  const running = { step: 'running', name: flow.name, value: flow.value, locations: flow.locations, count: flow.chosen.length, ...oldOf(flow) } as const;
  // Enter while the bases are still loading is fine: the run waits for that same read, it does not start another.
  return flow.bases === undefined
    ? { flow: { ...running, pending: request }, effect: null }
    : { flow: running, effect: { type: 'runSet', request: { ...request, bases: flow.bases } } };
}

/** The effect that reads the BASE column, once the repo table is up and its bases are not known yet. */
export function basesEffectFor(flow: EditFlow | null): EditEffect | null {
  return flow !== null && flow.step === 'repos' && flow.bases === undefined && flow.targets.length > 0
    ? { type: 'loadBases', targets: flow.targets }
    : null;
}

/**
 * The bases arrived: the table fills BASE in (a single re-render), or, when Enter
 * was already pressed, the waiting run starts with them. Dropped (the flow is
 * returned unchanged) for any other step.
 */
export function applyBasesLoaded(flow: EditFlow | null, bases: Readonly<Record<string, string>>): EditStep {
  if (flow === null) return { flow, effect: null };
  if (flow.step === 'repos' && flow.bases === undefined) return { flow: { ...flow, bases }, effect: null };
  if (flow.step === 'running' && flow.pending !== undefined) {
    const { pending, ...rest } = flow;
    return { flow: rest, effect: { type: 'runSet', request: { ...pending, bases } } };
  }
  return { flow, effect: null };
}

/**
 * Ctrl+C and Esc work while running (they never leave the screen hanging):
 *  - still waiting for the default branches: nothing has been touched, so go back at once;
 *  - pushing: start no further location and wait for every push in flight (a push is never cut in half);
 *  - opening PRs: start no further PR and wait for every PR in flight.
 * Every other key is ignored.
 */
function stepRunning(flow: Extract<EditFlow, { step: 'running' }>, key: string): EditStep {
  if (!isEsc(key) && key !== '\x03') return stay(flow);
  if (flow.pending !== undefined) {
    return { flow: null, effect: { type: 'cancelRun', phase: 'planning' }, note: CANCELLED_NOTHING };
  }
  const phase = flow.progress?.phase ?? 'pushing';
  const count = (flow.stop !== undefined && flow.stop.phase === phase ? flow.stop.count : 0) + 1;
  return { flow: { ...flow, stop: { phase, count } }, effect: { type: 'cancelRun', phase } };
}

/** The run reported progress. Dropped unless the flow is still running. A stop asked for in an earlier phase does not carry over. */
export function applyProgress(flow: EditFlow | null, progress: RunProgress): EditFlow | null {
  if (flow === null || flow.step !== 'running') return flow;
  const stop = flow.stop !== undefined && flow.stop.phase === progress.phase ? flow.stop : undefined;
  return { ...flow, progress, stop };
}

/** One key token applied to the flow. */
export function stepEdit(flow: EditFlow, key: string): EditStep {
  if (flow.step === 'value') return stepValue(flow, key);
  if (flow.step === 'locations') return stepLocations(flow, key);
  if (flow.step === 'loading') return stepLoading(flow, key);
  if (flow.step === 'repos') return stepRepos(flow, key);
  if (flow.step === 'running') return stepRunning(flow, key);
  return stepDone(flow, key);
}

/** The result screen: Esc leaves it; `c` copies the PR links and stays (no links: nothing to copy); every other key does nothing. */
function stepDone(flow: Extract<EditFlow, { step: 'done' }>, key: string): EditStep {
  if (isEsc(key)) return { flow: null, effect: null, exitText: flow.text };
  if (isCopyKey(key) && flow.prUrls.length > 0) return { flow, effect: copyEffectFor(flow.prUrls) };
  return stay(flow);
}

// ── Results coming back ─────────────────────────────────────────────────────

export type ReposLoaded =
  /** `bases` absent: the default branches are read separately (`loadBases`) and BASE shows `…` meanwhile. */
  | { readonly ok: true; readonly links: readonly OrgRepoLink[]; readonly bases?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: string };

/** The repo list arrived. Dropped (the flow is returned unchanged) unless the flow is still waiting for it. */
export function applyReposLoaded(flow: EditFlow | null, result: ReposLoaded): EditFlow | null {
  if (flow === null || flow.step !== 'loading') return flow;
  const planning = result.ok ? planRepos(flow.chosen, result.links) : { targets: [], notLinked: [] };
  return {
    step: 'repos',
    name: flow.name,
    value: flow.value,
    locations: flow.locations,
    ...oldOf(flow),
    locationsBox: flow.box,
    chosen: flow.chosen,
    targets: planning.targets,
    notLinked: planning.notLinked,
    unavailable: result.ok ? undefined : result.code,
    // Nothing to read when there is no repo (or the list could not be read): then there is nothing to wait for.
    bases: result.ok && planning.targets.length > 0 ? result.bases : {},
    box: allChecked(planning.targets.length),
  };
}

export type RunFinished =
  | { readonly ok: true; readonly result: SecretSetResult }
  /** A dry run: what would happen. Nothing was changed. */
  | { readonly ok: true; readonly plan: DryRunView }
  | { readonly ok: false; readonly code: string };

/** The PR links of a finished run: each PR's own `url` (a dry run, a failure and a repo that needed no PR have none), once each. */
export const prUrlsOf = (finished: RunFinished): readonly string[] =>
  finished.ok && 'result' in finished ? uniqueUrls(finished.result.prs.map((p) => p.url)) : [];

function finishedText(name: string, finished: RunFinished): string {
  if (!finished.ok) return `✗ ${name} was not updated. (${finished.code})`; // COPY-FLAG
  return 'plan' in finished ? renderDryRunPlan(finished.plan) : renderSecretSetConfirmation(finished.result, TERMINAL_STYLE);
}

/** The run finished. Dropped unless the flow is still running. */
export function applyRunFinished(flow: EditFlow | null, finished: RunFinished): EditFlow | null {
  if (flow === null || flow.step !== 'running') return flow;
  return { step: 'done', text: finishedText(flow.name, finished), prUrls: prUrlsOf(finished) };
}

/** The copy the `copyToClipboard` effect started finished. Dropped unless the flow is still on the result. */
export function applyEditCopied(flow: EditFlow | null, ok: boolean): EditFlow | null {
  if (flow === null || flow.step !== 'done') return flow;
  return { ...flow, copied: { ok, count: flow.prUrls.length } };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The one live line of the running step. */
export function runningLine(flow: Extract<EditFlow, { step: 'running' }>, dryRun: boolean): string {
  const p = flow.progress;
  if (flow.pending !== undefined) return 'Reading default branches…'; // COPY-FLAG
  if (flow.stop !== undefined) {
    const line = p !== undefined && p.inFlight > 0 ? stoppingAfter(p.inFlight) : STOPPING_NOW;
    return flow.stop.phase === 'pushing' && flow.stop.count > 1 ? `${line} ${STOPPING_AGAIN}` : line;
  }
  if (dryRun) return `Planning ${flow.name} for ${flow.count} location${flow.count === 1 ? '' : 's'}…`; // COPY-FLAG
  if (p === undefined) return `Updating ${flow.name} in ${flow.count} location${flow.count === 1 ? '' : 's'}…`; // COPY-FLAG
  return p.phase === 'pushing'
    ? `Updating ${flow.name}… ${p.done} of ${p.total} location${p.total === 1 ? '' : 's'}` // COPY-FLAG
    : `Opening pull requests… ${p.done} of ${p.total}`; // COPY-FLAG
}

// COPY-FLAG: the table headings, minimal and neutral.
const LOCATION_COLUMNS: readonly TableColumn[] = [
  { heading: 'PROJECT', shrink: true },
  { heading: 'BRANCH', shrink: true },
  { heading: 'PROTECTED', shrink: false },
];
const REPO_COLUMNS: readonly TableColumn[] = [
  { heading: 'REPO', shrink: true },
  { heading: 'PROJECTS', shrink: true },
  { heading: 'BASE', shrink: false },
];

const hint = (...pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.map(([key, what]) => `${BOLD}${key}${RESET}${DIM} ${what}${RESET}`).join(`${DIM} · ${RESET}`);

function pickerHint(searching: boolean, next: string): string {
  return searching
    ? hint(['esc', 'stop filtering'], ['space', 'select'], ['enter', next]) // COPY-FLAG
    : hint(['space', 'select'], ['a', 'toggle all'], ['i', 'invert'], ['/', 'filter'], ['enter', next], ['esc', 'back']);
}

/** Body lines (no margin) and the footer for the flow, for `width` x `height`. */
export function renderEdit(
  flow: EditFlow,
  width: number,
  height: number,
  dryRun: boolean = false,
): { readonly lines: readonly string[]; readonly footer: string } {
  const size = Math.max(3, height - 10);
  // The screen adds a 2-column margin; keep one column spare so nothing wraps.
  const maxWidth = Math.max(20, width - 3);
  if (flow.step === 'value') {
    return {
      lines: [
        `${BOLD}Edit ${flow.name}${RESET}`, // COPY-FLAG
        '',
        ...valueDialogRows({ old: oldView(flow.old), revealed: flow.revealed, buffer: flow.buffer, width }),
      ],
      footer: hint(
        ['enter', 'next'],
        ...(canReveal(oldView(flow.old), flow.buffer) ? ([['ctrl+r', flow.revealed ? 'hide' : 'reveal']] as const) : []),
        ['esc', 'cancel'],
      ), // COPY-FLAG
    };
  }
  if (flow.step === 'locations' || flow.step === 'loading') {
    const box = flow.box;
    return {
      lines: [
        `${BOLD}${flow.name}${RESET} ${DIM}· ${box.checked.length} of ${flow.locations.length} locations${RESET}`, // COPY-FLAG
        '',
        ...pickerTableLines({
          columns: LOCATION_COLUMNS,
          rows: flow.locations.map((l) => [l.project_name, l.branch, l.protected ? 'yes' : '']), // COPY-FLAG
          labels: names(flow),
          box,
          size,
          maxWidth,
        }),
        ...(flow.step === 'loading' ? ['', `${DIM}Loading repos…${RESET}`] : []), // COPY-FLAG
      ],
      footer: pickerHint(box.searching, 'next'),
    };
  }
  if (flow.step === 'repos') {
    return {
      lines: [
        `${BOLD}${CONFIRM_MESSAGE}${RESET}`,
        '',
        ...(flow.targets.length === 0
          ? [`${DIM}${flow.unavailable === undefined ? 'No linked repos.' : `Repos unavailable (${flow.unavailable}).`}${RESET}`] // COPY-FLAG
          : pickerTableLines({
              columns: REPO_COLUMNS,
              rows: flow.targets.map((t) => [repoLabel(t), projectsCell(t, flow.chosen), flow.bases === undefined ? '…' : (flow.bases[repoKey(t)] ?? '—')]), // COPY-FLAG
              labels: targetNames(flow),
              box: flow.box,
              size,
              maxWidth,
            })),
        ...(flow.notLinked.length > 0
          ? ['', `${DIM}No linked repo, so no PR: ${flow.notLinked.join(', ')}${RESET}`] // COPY-FLAG
          : []),
      ],
      footer: pickerHint(flow.box.searching, 'run'),
    };
  }
  if (flow.step === 'running') {
    return { lines: [`${DIM}${runningLine(flow, dryRun)}${RESET}`], footer: flow.stop === undefined ? hint(['ctrl+c', 'stop']) : '' }; // COPY-FLAG
  }
  return {
    lines: [
      ...flow.text.split('\n').map((l) => (l.startsWith('✗') ? `${RED}${l}${RESET}` : l)),
      ...(flow.copied === undefined ? [] : ['', `${flow.copied.ok ? DIM : RED}${copiedLine(flow.copied)}${RESET}`]),
    ],
    footer: hint(...(flow.prUrls.length > 0 ? [COPY_HINT_PAIR] : []), ['esc', 'exit']), // COPY-FLAG
  };
}

