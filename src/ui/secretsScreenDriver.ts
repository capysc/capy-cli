// Thin imperative shell for the `capy secrets` TUI (CAP-675). Owns every
// side effect the screen needs — raw stdin, the alt-screen ANSI dance, and
// dispatching the pure reducer's `fetchValue` effect to the injected
// decryptor — and nothing else. All actual behavior (what a keypress does,
// what a row/popup renders as) lives in the pure `secretsScreen.ts`; this
// file never computes any of it, it only calls in and draws the result.
//
// Every binding in this file is declared const; nothing is ever reassigned.
// A raw-mode stdin is an inherently callback-driven Node API — keypresses,
// terminal resizes, SIGINT/SIGTERM, and a value fetch resolving are four
// independent, asynchronously-arriving event sources that all have to feed
// into ONE sequential stream of immutable states. Rather than holding a
// mutable "current state" cell, every source re-emits onto a single local
// `EventEmitter` as one `DriverAction`; `node:events`' `on()` turns that
// into one async-iterable sequence (its own internal bookkeeping is the
// runtime's, not this module's), and `loop()` below consumes it with
// recursion — `state` is a plain function parameter, replaced by a
// brand-new value on every recursive call, never mutated in place.

import { EventEmitter, on } from 'node:events';
import {
  SecretsScreenState,
  SECRETS_SCREEN_ANSI,
  initialSecretsScreenState,
  handleKey,
  applyValueResult,
  applyBases,
  applyRepos,
  applyRunProgress,
  applyDeployPlan,
  applyDeployRunProgress,
  applyDeployRunDone,
  pendingBasesEffect,
  pendingDeployValueEffect,
  applyRunDone,
  applyCopied,
  resolveSecretValue,
  render,
  tokenizeKeys,
  LocationDecryptor,
  ValueState,
} from './secretsScreen';
import type { SecretIndexRow } from '../service/serviceClient';
import { isRunning, type EditEffect, type ReposLoaded, type RunFinished } from './secretsEditFlow';
import type { RunProgress } from '../commands/secretsSet';
import { isDeployRunning, type DeployEffect, type DeployFinished, type DeployPlanLoaded } from './secretsDeployFlow';
import { copyToClipboard } from './clipboard';
import type { BatchPlan, BatchProgress } from '../deploy/batchDeploy';

const {
  HIDE_CURSOR,
  SHOW_CURSOR,
  MOVE_HOME,
  CLEAR_SCREEN,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} = SECRETS_SCREEN_ANSI;

/**
 * What the edit flow (CAP-698) needs from the outside world. Optional: without
 * it the screen is read-only and the edit keys do nothing useful.
 */
export interface SecretsEditActions {
  /** The repo links for these projects' org (`GET /orgs/:id/repos`). Never rejects. */
  readonly loadRepos: (projectIds: readonly string[]) => Promise<ReposLoaded>;
  /** The default branch of each repo, by `repoKey`, in one batched read (the BASE column). Never rejects; a repo it cannot read is left out. */
  readonly loadBases: (targets: Extract<EditEffect, { type: 'loadBases' }>['targets']) => Promise<Readonly<Record<string, string>>>;
  /** Pushes the value and opens the PRs, reporting progress as items complete. Never rejects. */
  readonly run: (
    request: Extract<EditEffect, { type: 'runSet' }>['request'],
    onProgress?: (progress: RunProgress) => void,
  ) => Promise<RunFinished>;
  /** Stops what is in flight: `planning` kills the default-branch read; `pushing` / `prs` start nothing new and wait for every item in flight. */
  readonly cancel: (phase: Extract<EditEffect, { type: 'cancelRun' }>['phase']) => void;
}

/**
 * What the deploy flow (CAP-704) needs from the outside world. Optional: without it
 * the deploy keys do nothing useful. A dry run only ever calls `loadPlan` (reads).
 */
export interface SecretsDeployActions {
  /** The Dokploy targets of this row, from GitHub (reads only: nothing is unlocked or written). Never rejects. */
  readonly loadPlan: (row: SecretIndexRow) => Promise<DeployPlanLoaded>;
  /** Pushes the values, records the deliveries and opens the PRs, reporting progress as items complete. Never rejects. */
  readonly run: (plan: BatchPlan, onProgress?: (progress: BatchProgress) => void) => Promise<DeployFinished>;
  /** Stops what is in flight: `planning` kills the GitHub reads; `pushing` / `prs` start nothing new and wait for every item in flight. */
  readonly cancel: (phase: Extract<DeployEffect, { type: 'cancelDeploy' }>['phase']) => void;
}

type DriverAction =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'resize' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'value'; readonly row: SecretIndexRow; readonly result: ValueState }
  | { readonly kind: 'repos'; readonly result: ReposLoaded }
  | { readonly kind: 'bases'; readonly bases: Readonly<Record<string, string>> }
  | { readonly kind: 'ran'; readonly finished: RunFinished }
  | { readonly kind: 'progress'; readonly progress: RunProgress }
  | { readonly kind: 'deployPlan'; readonly loaded: DeployPlanLoaded }
  | { readonly kind: 'deployProgress'; readonly progress: BatchProgress }
  | { readonly kind: 'deployRan'; readonly finished: DeployFinished }
  | { readonly kind: 'copied'; readonly ok: boolean };

/** Puts text on the clipboard; true when it got there. Injected so tests never touch the real one. */
export type CopyText = (text: string) => Promise<boolean>;

function draw(state: SecretsScreenState): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  process.stdout.write(CLEAR_SCREEN + MOVE_HOME + render(state, width, height));
}

/**
 * Consumes one `DriverAction` per recursive call and returns once `state`
 * says to quit. `bus` is where a fetch this call kicks off re-emits its
 * result, so it can rejoin the SAME sequential stream `actions` is already
 * reading from — never a second, competing "current state" of its own.
 */
async function loop(
  state: SecretsScreenState,
  actions: AsyncIterator<[DriverAction]>,
  decryptAt: LocationDecryptor,
  edit: SecretsEditActions | undefined,
  bus: EventEmitter,
  deploy: SecretsDeployActions | undefined,
  copy: CopyText,
): Promise<string | null> {
  if (state.quit) return state.exitText;
  draw(state);

  const { value } = await actions.next();
  const [action] = value;
  const next = (s: SecretsScreenState) => loop(s, actions, decryptAt, edit, bus, deploy, copy);

  // A push in flight is never abandoned halfway: a quit signal waits for it.
  if (action.kind === 'quit') {
    // A quit signal while an edit runs is a stop request, like Ctrl-C: it never cuts a push in half.
    if (!isRunning(state.edit) && !isDeployRunning(state.deploy)) return next({ ...state, quit: true });
    const stopped = handleKey(state, '\x03');
    if (stopped.effect) perform(stopped.effect, decryptAt, edit, bus, deploy, copy);
    return next(stopped.state);
  }
  if (action.kind === 'deployPlan') {
    // The plan is up; the row's value is fetched next (the details view's own fetch) for its `value` line.
    const planned = applyDeployPlan(state, action.loaded);
    const valueEffect = pendingDeployValueEffect(planned);
    if (valueEffect) perform(valueEffect, decryptAt, edit, bus, deploy, copy);
    return next(planned);
  }
  if (action.kind === 'deployProgress') return next(applyDeployRunProgress(state, action.progress));
  if (action.kind === 'deployRan') return next(applyDeployRunDone(state, action.finished));
  if (action.kind === 'copied') return next(applyCopied(state, action.ok));
  if (action.kind === 'progress') return next(applyRunProgress(state, action.progress));
  if (action.kind === 'resize') return next(state);
  if (action.kind === 'value') return next(applyValueResult(state, action.row, action.result));
  if (action.kind === 'repos') {
    // The table is up now; BASE is read next, and the keys already work.
    const shown = applyRepos(state, action.result);
    const basesEffect = pendingBasesEffect(shown);
    if (basesEffect) perform(basesEffect, decryptAt, edit, bus, deploy, copy);
    return next(shown);
  }
  if (action.kind === 'bases') {
    const filled = applyBases(state, action.bases);
    if (filled.effect) perform(filled.effect, decryptAt, edit, bus, deploy, copy);
    return next(filled.state);
  }
  if (action.kind === 'ran') return next(applyRunDone(state, action.finished));

  const { state: nextState, effect } = handleKey(state, action.key);
  if (effect) perform(effect, decryptAt, edit, bus, deploy, copy);
  return next(nextState);
}

/**
 * Starts the side effect the reducer asked for. Fired and forgotten: each one
 * re-emits its result onto `bus`, where the reducer's own guards drop a result
 * that arrives after its step has moved on.
 */
function perform(
  effect: NonNullable<ReturnType<typeof handleKey>['effect']>,
  decryptAt: LocationDecryptor,
  edit: SecretsEditActions | undefined,
  bus: EventEmitter,
  deploy: SecretsDeployActions | undefined,
  copy: CopyText,
): void {
  if (effect.type === 'copyToClipboard') {
    // A rejected copy is a failed copy: the screen shows it, it never crashes the loop.
    void copy(effect.text).then(
      (ok) => bus.emit('action', { kind: 'copied', ok }),
      () => bus.emit('action', { kind: 'copied', ok: false }),
    );
    return;
  }
  if (effect.type === 'loadDeployPlan') {
    const loaded = deploy ? deploy.loadPlan(effect.row) : Promise.resolve<DeployPlanLoaded>({ ok: false, code: 'UNAVAILABLE' });
    void loaded.then((result) => bus.emit('action', { kind: 'deployPlan', loaded: result }));
    return;
  }
  if (effect.type === 'cancelDeploy') {
    deploy?.cancel(effect.phase);
    return;
  }
  if (effect.type === 'runDeploy') {
    const ran = deploy
      ? deploy.run(effect.plan, (progress) => bus.emit('action', { kind: 'deployProgress', progress }))
      : Promise.resolve<DeployFinished>({ ok: false, code: 'UNAVAILABLE' });
    void ran.then((finished) => bus.emit('action', { kind: 'deployRan', finished }));
    return;
  }
  if (effect.type === 'fetchValue') {
    void resolveSecretValue(effect.row, decryptAt).then((result) => {
      bus.emit('action', { kind: 'value', row: effect.row, result });
    });
    return;
  }
  if (effect.type === 'loadRepos') {
    const loaded = edit ? edit.loadRepos(effect.projectIds) : Promise.resolve<ReposLoaded>({ ok: false, code: 'UNAVAILABLE' });
    void loaded.then((result) => bus.emit('action', { kind: 'repos', result }));
    return;
  }
  if (effect.type === 'cancelRun') {
    edit?.cancel(effect.phase);
    return;
  }
  if (effect.type === 'loadBases') {
    const loaded = edit ? edit.loadBases(effect.targets) : Promise.resolve<Readonly<Record<string, string>>>({});
    void loaded.then((bases) => bus.emit('action', { kind: 'bases', bases }));
    return;
  }
  const finished = edit
    ? edit.run(effect.request, (progress) => bus.emit('action', { kind: 'progress', progress }))
    : Promise.resolve<RunFinished>({ ok: false, code: 'UNAVAILABLE' });
  void finished.then((result) => bus.emit('action', { kind: 'ran', finished: result }));
}

/**
 * Runs the interactive screen to completion (until the user quits). Always
 * restores the terminal — cursor shown, alt screen exited, raw mode off —
 * even if a fetch/decrypt or a render throws, via try/finally.
 */
export async function runSecretsScreen(
  rows: readonly SecretIndexRow[],
  decryptAt: LocationDecryptor,
  edit?: SecretsEditActions,
  /** `capy --dry-run secrets`: every screen is marked and the edit flow only plans. */
  dryRun: boolean = false,
  /** The deploy flow's side effects (CAP-704); absent: the deploy keys do nothing useful. */
  deploy?: SecretsDeployActions,
  /** Puts text on the clipboard (the `c` key of the result screens); the real clipboard by default. */
  copy: CopyText = copyToClipboard,
): Promise<void> {
  const bus = new EventEmitter();
  // A single `data` chunk can carry more than one keypress (a paste, fast
  // typing, or piped/scripted input) — `tokenizeKeys` splits it into
  // individual tokens first, and each becomes its own action, so all of
  // them reach the reducer in order instead of the chunk being handled (or
  // silently dropped) as if it were one key.
  const onData = (data: Buffer): void => {
    for (const key of tokenizeKeys(data.toString())) bus.emit('action', { kind: 'key', key });
  };
  const onResize = (): boolean => bus.emit('action', { kind: 'resize' });
  const onSignal = (): boolean => bus.emit('action', { kind: 'quit' });
  const actions = on(bus, 'action') as AsyncIterator<[DriverAction]>;

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_BRACKETED_PASTE);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.on('SIGWINCH', onResize);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const exitText = await (async () => {
    try {
      return await loop(initialSecretsScreenState(rows, dryRun), actions, decryptAt, edit, bus, deploy, copy);
    } finally {
      process.stdout.write(DISABLE_BRACKETED_PASTE + SHOW_CURSOR + EXIT_ALT_SCREEN);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.removeListener('SIGWINCH', onResize);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      const closable = actions as AsyncIterator<[DriverAction]> & { return?: (v?: unknown) => Promise<unknown> };
      if (typeof closable.return === 'function') await closable.return();
    }
  })();
  // After the alt screen is gone, so it stays in the scrollback.
  if (exitText !== null) console.log(exitText);
}
