// Thin imperative shell for the `capy secrets` TUI (CAP-675). Owns every
// side effect the screen needs — raw stdin, the alt-screen ANSI dance, and
// dispatching the pure reducer's `fetchValue` effect to the injected
// decryptor — and nothing else. All actual behavior (what a keypress does,
// what a row/popup renders as) lives in the pure `secretsScreen.ts`; this
// file never computes any of it, it only calls in and draws the result.
//
// Every binding in this file is declared const; nothing is ever reassigned.
// A raw-mode stdin is an inherently callback-driven Node API — keypresses,
// terminal resizes, SIGINT/SIGTERM, effect results, and scheduled draws are
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
  type SecretsScreenEffect,
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
  readonly run: (
    plan: BatchPlan,
    onProgress?: (progress: BatchProgress) => void,
    /** The decisions made for conflicts found by an earlier run, with the fingerprints they were made against (CAP-714). */
    decisions?: Extract<DeployEffect, { type: 'runDeploy' }>['decisions'],
  ) => Promise<DeployFinished>;
  /** Stops what is in flight: `planning` kills the GitHub reads; `pushing` / `prs` start nothing new and wait for every item in flight. */
  readonly cancel: (phase: Extract<DeployEffect, { type: 'cancelDeploy' }>['phase']) => void;
}

/** What a key press, or an effect's result, does to a screen: the next state and the side effect it asks for. */
export interface ScreenStep<S, X> {
  readonly state: S;
  readonly effect: SecretsScreenEffect | X | null;
}

/**
 * A full-screen TUI the driver below can run: a pure reducer and renderer, plus
 * where its embedded `capy secrets` screen lives (edit, deploy and value
 * results apply there). `capy secrets` is the screen itself; `capy projects`
 * embeds one per project. `X` is the screen's own effects, which `performOwn`
 * starts; their results come back as a state change through `done`.
 */
export interface ScreenModel<S, X extends { readonly type: string }> {
  readonly handleKey: (state: S, key: string) => ScreenStep<S, X>;
  readonly render: (state: S, width: number, height: number) => string;
  readonly isQuit: (state: S) => boolean;
  readonly exitTextOf: (state: S) => string | null;
  /** The state a quit signal leaves when nothing is running. */
  readonly quitNow: (state: S) => S;
  /** The embedded secrets screen, or `null` when there is none right now (its results are then dropped). */
  readonly secretsOf: (state: S) => SecretsScreenState | null;
  readonly withSecrets: (state: S, secrets: SecretsScreenState) => S;
  /** Whether `effect` is one of the screen's own (not a secrets effect). */
  readonly isOwnEffect: (effect: NonNullable<SecretsScreenEffect> | X) => effect is X;
  readonly performOwn: (effect: X, done: (apply: (state: S) => ScreenStep<S, X>) => void) => void;
}

type DriverAction<S, X> =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'draw' }
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
  | { readonly kind: 'copied'; readonly ok: boolean }
  | { readonly kind: 'own'; readonly apply: (state: S) => ScreenStep<S, X> };

/** Puts text on the clipboard; true when it got there. Injected so tests never touch the real one. */
export type CopyText = (text: string) => Promise<boolean>;

function draw<S, X extends { readonly type: string }>(model: ScreenModel<S, X>, state: S): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  // render() already clears the rest of every line. Clear below its last
  // line too, so a shorter frame erases anything the previous one left there.
  // One synchronized write keeps the terminal from showing a partial frame;
  // terminals without synchronized-output support ignore the mode switches.
  process.stdout.write(`\x1b[?2026h${MOVE_HOME}${model.render(state, width, height)}\x1b[J\x1b[?2026l`);
}

/** Everything the loop and `perform` need besides the state: fixed for one run of a screen. */
interface DriverContext<S, X extends { readonly type: string }> {
  readonly model: ScreenModel<S, X>;
  readonly actions: AsyncIterator<[DriverAction<S, X>]>;
  readonly decryptAt: LocationDecryptor;
  readonly edit: SecretsEditActions | undefined;
  readonly bus: EventEmitter;
  readonly deploy: SecretsDeployActions | undefined;
  readonly copy: CopyText;
}

/** `state` with `apply` run on its embedded secrets screen; unchanged when there is none. */
function onSecrets<S, X extends { readonly type: string }>(
  model: ScreenModel<S, X>,
  state: S,
  apply: (secrets: SecretsScreenState) => SecretsScreenState,
): S {
  const secrets = model.secretsOf(state);
  return secrets === null ? state : model.withSecrets(state, apply(secrets));
}

/** Like `onSecrets`, for a result that may ask for a follow-up effect. */
function stepSecrets<S, X extends { readonly type: string }>(
  model: ScreenModel<S, X>,
  state: S,
  apply: (secrets: SecretsScreenState) => { readonly state: SecretsScreenState; readonly effect: SecretsScreenEffect },
): ScreenStep<S, X> {
  const secrets = model.secretsOf(state);
  if (secrets === null) return { state, effect: null };
  const stepped = apply(secrets);
  return { state: model.withSecrets(state, stepped.state), effect: stepped.effect };
}

/** A follow-up effect computed from the embedded secrets screen, or `null` when there is none. */
function secretsEffect<S, X extends { readonly type: string }>(
  model: ScreenModel<S, X>,
  state: S,
  pick: (secrets: SecretsScreenState) => SecretsScreenEffect,
): SecretsScreenEffect {
  const secrets = model.secretsOf(state);
  return secrets === null ? null : pick(secrets);
}

/** The next state for one result action (everything but key, draw, resize and quit), with any follow-up effect. */
function applyResult<S, X extends { readonly type: string }>(model: ScreenModel<S, X>, state: S, action: DriverAction<S, X>): ScreenStep<S, X> {
  const plain = (next: S): ScreenStep<S, X> => ({ state: next, effect: null });
  if (action.kind === 'deployPlan') {
    // The plan is up; the row's value is fetched next (the details view's own fetch) for its `value` line.
    const planned = onSecrets(model, state, (s) => applyDeployPlan(s, action.loaded));
    return { state: planned, effect: secretsEffect(model, planned, pendingDeployValueEffect) };
  }
  if (action.kind === 'deployProgress') return plain(onSecrets(model, state, (s) => applyDeployRunProgress(s, action.progress)));
  if (action.kind === 'deployRan') return plain(onSecrets(model, state, (s) => applyDeployRunDone(s, action.finished)));
  if (action.kind === 'copied') return plain(onSecrets(model, state, (s) => applyCopied(s, action.ok)));
  if (action.kind === 'progress') return plain(onSecrets(model, state, (s) => applyRunProgress(s, action.progress)));
  if (action.kind === 'value') return plain(onSecrets(model, state, (s) => applyValueResult(s, action.row, action.result)));
  if (action.kind === 'repos') {
    // The table is up now; BASE is read next, and the keys already work.
    const shown = onSecrets(model, state, (s) => applyRepos(s, action.result));
    return { state: shown, effect: secretsEffect(model, shown, pendingBasesEffect) };
  }
  if (action.kind === 'bases') return stepSecrets(model, state, (s) => applyBases(s, action.bases));
  if (action.kind === 'ran') return plain(onSecrets(model, state, (s) => applyRunDone(s, action.finished)));
  if (action.kind === 'own') return action.apply(state);
  return plain(state);
}

/**
 * Consumes one `DriverAction` per recursive call and returns once `state`
 * says to quit. `bus` is where a fetch this call kicks off re-emits its
 * result, so it can rejoin the SAME sequential stream `actions` is already
 * reading from — never a second, competing "current state" of its own.
 */
async function loop<S, X extends { readonly type: string }>(
  state: S,
  ctx: DriverContext<S, X>,
  drawPending: boolean = false,
): Promise<string | null> {
  const { model, actions, bus } = ctx;
  if (model.isQuit(state)) return model.exitTextOf(state);

  const { value } = await actions.next();
  const [action] = value;
  const next = (s: S) => {
    // Reduce every key and start its effects immediately, but paint only
    // after this tick's queued actions have drained. The pending flag travels
    // with the immutable state, so a burst schedules just one draw action.
    if (!model.isQuit(s) && !drawPending) setImmediate(() => bus.emit('action', { kind: 'draw' }));
    return loop(s, ctx, true);
  };
  const stepTo = (step: ScreenStep<S, X>) => {
    if (step.effect) perform(step.effect, ctx);
    return next(step.state);
  };

  if (action.kind === 'draw') {
    draw(model, state);
    return loop(state, ctx);
  }

  // A push in flight is never abandoned halfway: a quit signal waits for it.
  if (action.kind === 'quit') {
    // A quit signal while an edit runs is a stop request, like Ctrl-C: it never cuts a push in half.
    const secrets = model.secretsOf(state);
    if (!isRunning(secrets?.edit ?? null) && !isDeployRunning(secrets?.deploy ?? null)) return next(model.quitNow(state));
    return stepTo(model.handleKey(state, '\x03'));
  }
  if (action.kind === 'resize') return next(state);
  if (action.kind === 'key') return stepTo(model.handleKey(state, action.key));
  return stepTo(applyResult(model, state, action));
}

/**
 * Starts the side effect the reducer asked for. Fired and forgotten: each one
 * re-emits its result onto `bus`, where the reducer's own guards drop a result
 * that arrives after its step has moved on.
 */
function perform<S, X extends { readonly type: string }>(effect: NonNullable<SecretsScreenEffect> | X, ctx: DriverContext<S, X>): void {
  const { model, decryptAt, edit, bus, deploy, copy } = ctx;
  if (model.isOwnEffect(effect)) {
    model.performOwn(effect, (apply) => bus.emit('action', { kind: 'own', apply }));
    return;
  }
  performSecrets(effect, decryptAt, edit, bus, deploy, copy);
}

/** Starts one of the embedded secrets screen's effects. */
function performSecrets(
  effect: NonNullable<SecretsScreenEffect>,
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
      ? deploy.run(effect.plan, (progress) => bus.emit('action', { kind: 'deployProgress', progress }), effect.decisions)
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

/** `capy secrets` as a `ScreenModel`: the secrets screen is the whole screen, and it has no effects of its own. */
const SECRETS_MODEL: ScreenModel<SecretsScreenState, { readonly type: never }> = {
  handleKey,
  render,
  isQuit: (state) => state.quit,
  exitTextOf: (state) => state.exitText,
  quitNow: (state) => ({ ...state, quit: true }),
  secretsOf: (state) => state,
  withSecrets: (_state, secrets) => secrets,
  isOwnEffect: (_effect): _effect is { readonly type: never } => false,
  performOwn: () => {},
};

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
  await runScreen(SECRETS_MODEL, initialSecretsScreenState(rows, dryRun), decryptAt, edit, deploy, copy);
}

/**
 * Runs any `ScreenModel` to completion (until it quits), with the terminal
 * handling `capy secrets` has always had. Always restores the terminal —
 * cursor shown, alt screen exited, raw mode off — even if a fetch/decrypt or
 * a render throws, via try/finally.
 */
export async function runScreen<S, X extends { readonly type: string }>(
  model: ScreenModel<S, X>,
  initial: S,
  decryptAt: LocationDecryptor,
  edit: SecretsEditActions | undefined,
  deploy: SecretsDeployActions | undefined,
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
  const actions = on(bus, 'action') as AsyncIterator<[DriverAction<S, X>]>;

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_BRACKETED_PASTE);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.on('SIGWINCH', onResize);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const exitText = await (async () => {
    try {
      draw(model, initial);
      return await loop(initial, { model, actions, decryptAt, edit, bus, deploy, copy });
    } finally {
      process.stdout.write(DISABLE_BRACKETED_PASTE + SHOW_CURSOR + EXIT_ALT_SCREEN);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.removeListener('SIGWINCH', onResize);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      const closable = actions as AsyncIterator<[DriverAction<S, X>]> & { return?: (v?: unknown) => Promise<unknown> };
      if (typeof closable.return === 'function') await closable.return();
    }
  })();
  // After the alt screen is gone, so it stays in the scrollback.
  if (exitText !== null) console.log(exitText);
}
