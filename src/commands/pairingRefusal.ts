/**
 * Shared coded-refusal plumbing for `capy transport` and `capy pair`
 * (CAP-684) — same shape `systemCommand.ts` uses: `--json` keeps stdout pure
 * JSON, prose only ever goes to stderr, and every refusal carries a code
 * (cardinal Rule: never branch on message text).
 */
import { CapyError, ERROR_CODES } from '../types/index';

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

/** Every refusal either command can throw, coded and routed to the right stream. */
export function refuseError(err: unknown, json: boolean): never {
  if (err instanceof CapyError) {
    refuse(json, err.code, err.message, 1);
  }
  const message = err instanceof Error ? err.message : String(err);
  refuse(json, ERROR_CODES.SERVICE_ERROR, message, 1);
}
