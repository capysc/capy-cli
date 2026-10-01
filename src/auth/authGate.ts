/**
 * Shared handling for `AuthService#authenticate()`'s `AUTH_NEEDS_TTY`
 * refusal (CAP-520 / CAP-659).
 *
 * The gate itself lives in ONE place — `AuthService#authenticate()` throws
 * this coded error instead of starting an interactive browser sign-in when
 * there is no TTY (see its own doc). Everything in this file is the OTHER
 * half: turning that one thrown error into the same coded exit, no matter
 * which of the many commands that fall through to interactive auth caught
 * it. Never re-typed, never re-worded per command (cardinal Rule: never
 * branch on message text — callers check `err.code`, this module is the
 * only place that decides the exit code and the output shape).
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';

/** One-line hint for a human. Stderr only — stdout must stay pure JSON under `--json`. */
export const AUTH_NEEDS_TTY_HINT = 'Run `capy` in a terminal to sign in.'; // COPY-FLAG

/** True for the exact `CapyError` `AuthService#authenticate()` throws when it refuses to open a browser non-interactively. */
export function isAuthNeedsTty(err: unknown): err is CapyError {
  return err instanceof CapyError && err.code === ERROR_CODES.AUTH_NEEDS_TTY;
}

/**
 * Exit `EXIT_NEEDS_INPUT` (3): under `--json`, a single `{ok:false,
 * code:'AUTH_NEEDS_TTY'}` object on stdout — nothing else on stdout, same
 * shape every other coded refusal in this CLI prints. Otherwise, the hint on
 * stderr. Never prints prose on stdout either way.
 */
export function exitAuthNeedsTty(json: boolean): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, code: ERROR_CODES.AUTH_NEEDS_TTY }, null, 2));
  } else {
    console.error(AUTH_NEEDS_TTY_HINT);
  }
  process.exit(EXIT_NEEDS_INPUT);
}

/**
 * Run `fn`, which may reach `AuthService#authenticate()`'s non-interactive
 * refusal (directly, or several calls down through `resolveContext()` /
 * `resolveOrgContext()`). Converts exactly that one error into the coded
 * exit above; every other error — or a successful result — passes through
 * completely unchanged, so wrapping a call site with this never changes its
 * behavior for any OTHER failure.
 */
export async function withAuthNeedsTtyExit<T>(fn: () => Promise<T>, json: boolean): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAuthNeedsTty(err)) exitAuthNeedsTty(json);
    throw err;
  }
}
