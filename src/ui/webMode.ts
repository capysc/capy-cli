/**
 * Whether this process was invoked with `--web`.
 *
 * Process-global, and legitimately so: `--web` is declared once on the root
 * program, so it is a property of the invocation rather than of any command.
 * A `preAction` hook records it before any handler runs, which is why nothing
 * downstream has to be handed it.
 *
 * WHY IT EXISTS AT ALL. `displayErrorAndExit` is reached from eighteen call
 * sites, most of them inside a `catch` several layers below the handler that
 * parsed the flag — a key resolver, a service client, a crypto path. Threading
 * a boolean down all of those to answer one question ("is anybody reading a
 * terminal right now?") would touch every signature between here and there,
 * and would be forgotten on the nineteenth.
 *
 * NOT a substitute for the flag itself. Anything that takes `--web` as a
 * PARAMETER — every command that decides whether to open a browser for a
 * question — keeps reading `command.optsWithGlobals().web`, because that is a
 * decision the command makes about its own flow. This is only for the code
 * that has no way to ask.
 */
let webMode = false;

/** Called once, from the root program's `preAction` hook. */
export function setWebMode(on: boolean): void {
  webMode = on;
}

/** True when this run should render to a browser rather than a terminal. */
export function isWebMode(): boolean {
  return webMode;
}

/**
 * A line meant for a human reading a terminal.
 *
 * Historically this diverged from `console.log` under the (now-deleted)
 * onboard flow's `--json` mode, routing to stderr so an agent capturing
 * stdout never got terminal prose mixed into its JSON envelope. That mode is
 * gone, but the call sites (`capyCommand.ts`'s `runInitialization`,
 * `reconcileBranchConflict`, etc.) keep using this name rather than a bare
 * `console.log` — it still marks "this line is for a human," which is worth
 * keeping distinct even with a single implementation.
 */
export function human(...args: unknown[]): void {
  console.log(...args);
}
