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
 * CAP-451: whether this process was invoked with `capy onboard
 * --broker-ceremony` — a sandboxed, agent-driven caller with no LOCAL
 * browser to send ANYTHING to, `--web` notwithstanding (broker-ceremony
 * always wins over `--web` for exactly this reason — see
 * `capyCommand.ts`'s `noWizardStops`). Same process-global shape as
 * `webMode` above, and for the same reason: `displayErrorAndExit` is reached
 * from deep inside call sites with no way to ask a command object whether
 * this run is agent-driven.
 *
 * Read by `errorScreen.ts` to skip opening a loopback error page even when
 * `isWebMode()` is true — that failure must surface as the coded
 * `blocked`/`failed` step in the flow's own JSON envelope only, never a
 * `capy:handoff-url` event pointing at a server nothing in this run can see.
 */
let brokerCeremonyMode = false;

/** Called once, from `capy onboard`'s own handler — `--broker-ceremony` is not a global program option. */
export function setBrokerCeremonyMode(on: boolean): void {
  brokerCeremonyMode = on;
}

export function isBrokerCeremonyMode(): boolean {
  return brokerCeremonyMode;
}

/**
 * Whether `capy onboard` was invoked with `--json`. `--json` is a per-command
 * option (declared per subcommand in `index.ts`, unlike `--web`), so nothing
 * upstream already tracks it as a process-global — this one exists for the
 * same reason `brokerCeremonyMode` does: `runSandboxCeremony`
 * (`flows/onboard/sandboxCeremony.ts`) is reached deep inside the flow
 * driver loop, with no command object to ask, and needs to know whether a
 * human line it's about to print (the ceremony's `user_code`, for the rare
 * case of a human running `--broker-ceremony` at a real terminal) would
 * pollute an agent's `--json` output stream.
 */
let onboardJsonMode = false;

/** Called once, from `capy onboard`'s own handler, alongside `setBrokerCeremonyMode`. */
export function setOnboardJsonMode(on: boolean): void {
  onboardJsonMode = on;
}

export function isOnboardJsonMode(): boolean {
  return onboardJsonMode;
}
