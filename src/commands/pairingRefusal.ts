/**
 * Shared coded-refusal plumbing for `capy transport` and `capy pair`
 * (CAP-684) — same shape `systemCommand.ts` uses: `--json` keeps stdout pure
 * JSON, prose only ever goes to stderr, and every refusal carries a code
 * (cardinal Rule: never branch on message text).
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';

/** Pure JSON refusal on stdout — never on stderr, so `--json` output stays parseable. */
export function refuseJson(code: string, error: string, exitCode: number): never {
  console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  process.exit(exitCode);
}

/** Prose refusal on stderr — human mode only. */
export function refuseHuman(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

export function refuse(json: boolean, code: string, message: string, exitCode: number): never {
  if (json) refuseJson(code, message, exitCode);
  refuseHuman(message, exitCode);
}

/** `AUTH_NEEDS_TTY` (CAP-520/CAP-659) is the one coded refusal here that isn't a generic failure — exit 3, same as every other "needs a human" gate. */
function exitCodeFor(code: string): number {
  return code === ERROR_CODES.AUTH_NEEDS_TTY ? EXIT_NEEDS_INPUT : 1;
}

/** Every refusal either command can throw, coded and routed to the right stream. */
export function refuseError(err: unknown, json: boolean): never {
  if (err instanceof CapyError) {
    refuse(json, err.code, err.message, exitCodeFor(err.code));
  }
  const message = err instanceof Error ? err.message : String(err);
  refuse(json, ERROR_CODES.SERVICE_ERROR, message, 1);
}
