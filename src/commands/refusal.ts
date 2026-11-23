/**
 * The shared refusal: one coded stop, on the right stream. `projectLifecycleCommand.ts` and `pairAgentCommand.ts`
 * both end through it, so an elicitation rides in the same `{ok:false, code, error, ...extra}` object everywhere.
 */

export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  /** Extra structured fields for `--json` (the token list, the ambiguous ids). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Extra prose lines for the human refusal. */
  readonly lines?: readonly string[];
}

/** The refusal on the right stream: JSON on stdout under `--json`, prose on stderr otherwise. Never returns. */
export function refuse(json: boolean, r: Refusal): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, code: r.code, error: r.message, ...(r.extra ?? {}) }, null, 2));
  } else {
    console.error(r.message);
    (r.lines ?? []).forEach((l) => console.error(l));
  }
  return process.exit(r.exitCode);
}

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Runs `fn` and returns what it threw as a value, so a refusal's `process.exit` is never caught by the code that raised it. */
export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  return fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
