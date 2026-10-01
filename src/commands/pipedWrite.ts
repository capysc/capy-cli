/**
 * The write half of piped mode, shared by `capy edit NAME` and `capy add NAME`:
 * take an already-read value, set it through the one single-variable save path
 * (`resolveContext()` + `writeAndSync()`, the same pair `add` and `connect`
 * use), and report what happened. There is no third copy of the save logic.
 *
 * Never prompts, never opens a browser, never records an edit-session save (so
 * no exit-time PR flow). `keep.lock` is left modified in the working tree, same
 * as `capy add`.
 *
 * The value is only ever an argument to `writeAndSync`. It is not logged, not
 * placed in `process.env`, not written to a temp file, and not part of any
 * error this file raises.
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { hashValue } from './statusCommand';
import { resolveContext, writeAndSync, type ResolvedContext } from './connectors/shared';
import { refusePiped, reportPipedSuccess, type PipedAction } from './pipedValue';

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidVarName(name: string): boolean {
  return VAR_RE.test(name);
}

/**
 * What a write of `value` would be, derived in-process from the pinned
 * `value_hash` in keep.lock and the decrypted `.env`. The hash is compared and
 * dropped; it is never output.
 *
 *  - `unchanged`: the pinned hash equals the new value's AND `.env` already holds
 *    it. (Hash-equal with a drifted `.env` is not unchanged: the write repairs `.env`.)
 *  - `updated`: the variable already exists (pinned or in `.env`).
 *  - `created`: it does not.
 */
export function classifyPipedWrite(ctx: ResolvedContext, name: string, value: string): PipedAction {
  const pinnedHash = ctx.keep.variables[name]?.find((e) => e.branch === ctx.branch)?.value_hash;
  const heldLocally = name in ctx.localPlaintext;
  if (pinnedHash !== undefined && pinnedHash === hashValue(value) && ctx.localPlaintext[name] === value) {
    return 'unchanged';
  }
  return pinnedHash !== undefined || heldLocally ? 'updated' : 'created';
}

/** True when `name` already exists on the active branch (pinned in keep.lock or present in `.env`). */
export function variableExists(ctx: ResolvedContext, name: string): boolean {
  const pinned = ctx.keep.variables[name]?.some((e) => e.branch === ctx.branch) === true;
  return pinned || name in ctx.localPlaintext;
}

export interface PipedWriteOpts {
  readonly json: boolean;
  readonly push: boolean;
  readonly devMode: boolean;
  /**
   * Called once the context is resolved and before anything is written. Return
   * a refusal `{ code, error }` to stop (e.g. `capy add` without `--force` on an
   * existing name); `undefined` to go on.
   */
  readonly gate?: (ctx: ResolvedContext) => { readonly code: string; readonly error: string } | undefined;
}

/** Turns anything thrown into a code and a sentence that cannot contain the value. */
function describeFailure(err: unknown): { code: string; error: string } {
  if (err instanceof CapyError) return { code: err.code, error: err.message };
  return { code: ERROR_CODES.SERVICE_ERROR, error: 'The write did not complete. Nothing was confirmed.' }; // COPY-FLAG
}

async function writeOrFail(
  ctx: ResolvedContext,
  name: string,
  value: string,
  push: boolean,
): Promise<{ code: string; error: string } | undefined> {
  try {
    await writeAndSync(ctx, name, value, { push });
    return undefined;
  } catch (err) {
    return describeFailure(err);
  }
}

/** Sets `name` to `value` and reports the outcome (JSON or one stderr line). Exits on any refusal. */
export async function runPipedWrite(name: string, value: string, opts: PipedWriteOpts): Promise<void> {
  const ctx = await resolveContext({
    devMode: opts.devMode,
    // Never the browser sign-in: a piped run has no one to sign in.
    interactive: false,
    refuse: (code, message) => refusePiped(opts.json, code, message),
  });

  const refused = opts.gate?.(ctx);
  if (refused) refusePiped(opts.json, refused.code, refused.error);

  const action = classifyPipedWrite(ctx, name, value);
  if (action === 'unchanged') {
    reportPipedSuccess(opts.json, { name, branch: ctx.branch, action, pushed: false });
    return;
  }

  const failure = await writeOrFail(ctx, name, value, opts.push);
  if (failure) refusePiped(opts.json, failure.code, failure.error);

  reportPipedSuccess(opts.json, { name, branch: ctx.branch, action, pushed: opts.push });
}
