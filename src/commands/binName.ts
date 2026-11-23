/** The binary this process was invoked as (`capy`, `capy-dev`, `capy-staging`): what a command an agent must run has to start with. */
export function binName(devMode: boolean = false): string {
  return process.env.CAPY_BIN_NAME ?? (devMode ? 'capy-dev' : 'capy');
}
